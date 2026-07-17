## Description

**Size:** M
**Files:** test/slow/fold-cost-bench.test.ts, scripts/test-manifest.ts, scripts/test-gate.ts, package.json, docs/testing.md

### Approach

Land a durable fold-cost benchmark behind its OWN named opt-in gate
(suggested: `test:bench-folds`) that pins the reducer's growth curves.
Deterministic synthetic corpora over the in-memory template DB (fixed
ids/ts — no Date.now/Math.random), folded via the public drain path,
timed in BULK (total ms over N folds at each size — per-fold timing sits
at clock resolution and flakes). Two curves: (a) epic-fold per-event cost
across a pinned board-size ladder (e.g. 500/2000/8000 epics) asserted
FLAT via adjacent-size ratio bands — never absolute wall-clock thresholds
— with warmup folds before timing and median-of-runs aggregation; scope
this assertion to the index-serving path, not the dep reverse fan-out
(O(consumers), deliberately unbounded here); (b) the syncPlanLinks
per-session commit-prefix curve pinned as a documented regression band
(linear allowed — the bench guards against superlinear regressions, it
does not demand a fix). Report bulk ms/event as output. Register the gate
everywhere the two existing slow gates are registered: a new phase
literal + explicit file allowlist in the test manifest, a --phase branch
in the gate runner, a package.json script, and a docs/testing.md
slow-tier row — and REVISE the slow-tier framing prose (it currently says
the tier's gates run real processes; this bench is pure in-process, so
the genre sentence needs rewording, not just a row append). The gate
never joins test:gate/test/test:full. This bench runs in-process only —
no daemon, no Worker, no subprocess — so it needs no ADR 0073 amendment
(that governs the real-process scenario set).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/test-manifest.ts:6-8, :33-37, :121 — phase literals, slow-gate file allowlists, classifyTestFile; the new gate mirrors SLOW_GIT_FILES/SLOW_DAEMON_FILES
- scripts/test-gate.ts:129-148 — --phase parsing; add the new branch + parse guard
- package.json:20-24 — the test:slow-* script shape to mirror
- docs/testing.md:56-79 — the slow-tier table and the framing prose to revise
- test/helpers/template-db.ts:113 — freshMemDb, the per-test migrated template clone the corpora build on
- src/reducer.ts drain/applyEvent exports — fold via the public path, byte-faithful to production

**Optional** (reference as needed):
- test/reducer-plan.test.ts:1517-1544 — the synthetic EpicSnapshot/TaskSnapshot event construction idiom
- test/db.test.ts:9686-9714 — the synthetic Commit-with-plan-trailer payload idiom (for the syncPlanLinks curve corpus)

### Risks

- Timing assertions are the top CI flake source — ratio bands, warmup, and median aggregation are the mitigations; if a band still flakes, widen the band and document it rather than tightening the runtime
- A corpus that accidentally reads wall-clock or randomness breaks determinism and reproducibility of the measured curve

### Test notes

The bench IS the test; its own stability matters more than its precision.
Assert curve SHAPE (adjacent-size ratios within band), report absolute
ms/event as informational output only. Verify the gate is excluded from
the correctness tiers by running the fast gates and confirming the bench
file is not collected.

## Acceptance

- [ ] A named opt-in gate runs the fold-cost bench and fails when warm epic-fold per-event cost grows materially with board size (ratio-band assertion); it passes on the memoized reducer
- [ ] The bench pins the syncPlanLinks per-session prefix curve as a regression band and reports bulk ms/event
- [ ] The correctness tiers never collect the bench file; the named-gate registration (manifest, runner, script) matches the existing slow-gate pattern
- [ ] docs/testing.md documents the gate and its framing prose correctly distinguishes real-process gates from this in-process perf bench
- [ ] The full fast correctness gates stay green

## Done summary
Added the bench-folds named opt-in gate (test/slow/fold-cost-bench.test.ts, bun run test:bench-folds), pinning the epic-fold memoized index-serving path as flat and the syncPlanLinks commit-trailer prefix cost inside a regression band, with manifest/gate-runner/package.json registration and revised docs/testing.md slow-tier framing.
## Evidence
