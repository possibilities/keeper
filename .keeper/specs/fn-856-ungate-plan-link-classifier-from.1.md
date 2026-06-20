## Description

**Size:** M
**Files:** src/plan-classifier.ts, src/reducer.ts, src/db.ts, keeper/api.py, test/plan-classifier.test.ts, test/fixtures/plan_classifier_cases.jsonl, test/reducer-links.test.ts, README.md

Remove the time-window machinery from the plan-link classifier so every
epic-mutating session links to its epic regardless of `/plan:plan` timing, then
bump the schema and force a from-scratch re-fold so existing epics repopulate.
This is ONE atomic change: the classifier signature change ripples into the
reducer and both frozen migration backfills (won't compile otherwise), and the
golden fixtures + schema bump must co-land for tests to pass.

### Approach

Resolved decisions (do not re-open):
- **Creator-suppression scope → per-session.** Replace the per-window
  `seenWindowCreators` / `seenJobCreators` sets (keyed `${winIdx} ${target}`)
  with per-session sets keyed on target/epic only. A session that both scaffolds
  AND later refines the same epic emits ONE `creator` edge, not creator+refiner.
  Cross-session edges are NEVER suppressed (different `job_id`s coexist).
- **Two-kind taxonomy unchanged.** `creator` = op in {create, scaffold} with an
  epic-shaped `parsePlanRef(target).kind === 'epic'`; else `refiner` if the op
  names an epic (`epic_id` resolves). `/plan:defer` rides the scaffold→creator
  path; `/plan:next`/queue-jump and all other mutations → refiner. No new kinds.
- **KEEP the read-only gate** (`subject_present === false` → skip,
  `plan-classifier.ts:279` / `:429`). It is the ONLY gate that survives.
- **Sort is a total order.** The existing `valid.sort((a,b)=>a.ts-b.ts)` is not a
  total order on `ts` ties; with per-window keys gone, the creator-suppression
  outcome must not depend on tie order. Add an explicit stable tiebreak (carry an
  `event_id`/sequence on `ClassifierInvocation` and break ties on it, or prove +
  test that the stable sort over deterministic event_id-ASC input suffices). A
  from-scratch re-fold MUST reproduce byte-identical rows.

Ordered steps:
1. **Classifier** (`src/plan-classifier.ts`): drop the `windows` param from
   `deriveEpicLinks` and `windowsBySession` from `deriveJobLinks`; delete the
   `windows.length===0` early-outs (`:250`, `:403`), the `winIdx` advance loops,
   and the `ts<winStart` drops (`:295`, `:442`). Rewrite suppression per-session.
   Delete `computePlanWindows` (`:179`) and `MAX_TS_SENTINEL` (`:75`) once no
   callers remain. Keep `normalizePlanctlOp`, the defensive null/non-finite
   filters (never-throw), and the `{kind,target}`/`{kind,job_id}` return shapes.
   Rewrite the module JSDoc (`:1-57`) to describe the windowless linker — delete
   the "Python source of truth" / "Unit divergence" / "Window opener input shape"
   sections (this intentionally retires the jobctl windowing parity).
2. **Reducer** (`src/reducer.ts` `syncPlanctlLinks`, ~`:5462`): remove the two
   `skill_name='plan:plan'` opener queries (~`:5527`, ~`:5640`), the
   `computePlanWindows` calls, and the `windowsBySession` map; pass only
   invocations to the derivers. KEEP the commit-trailer UNION
   (`loadAllCommitTrailerFacts`/`commitTrailerInvocationsFor`/
   `commitTrailerSessionsForEpics`) and the touched-epics sweep. The
   `created_by_closer_of` derivation (`:5677-5702`) is unchanged — it now fires
   because closers finally emit creator edges. Feed the derivers event_id-ASC
   deterministic input for the total-order requirement above.
3. **Migration** (`src/db.ts`): bump `SCHEMA_VERSION` 76→77 (`:50`). Add a
   version-guarded v77 step that, in ONE `BEGIN IMMEDIATE`, does
   `UPDATE reducer_state SET last_event_id = 0` + `DELETE FROM` the canonical
   13-table wipe list (copy verbatim from the v41→v42 block at `:2936-2954`) so
   the corrected derive repopulates everything. Update BOTH frozen historical
   backfills (`:1953-1984` v13→v14 and `:2260-2290` v19→v20) to the new
   windowless signatures together — their recomputed output is overwritten by the
   v77 wipe+re-fold, so the migrated-vs-refold end state stays byte-identical.
   Never update one backfill without the other.
4. **keeper-py** (`keeper/api.py`): add `77` to `SUPPORTED_SCHEMA_VERSIONS`
   (~`:371`) with a matching `# v77 ...` doc-comment, SAME commit.
5. **Docs** (`README.md`): rewrite the Architecture prose (~`:2198-2207`) that
   describes "classified against its `/plan:plan` windows" → unconditional
   classification (preserve the commit-trailer UNION sentence); append a `schema
   v77` changelog block after the v76 block (~`:2142`) following the v76 template.

### Investigation targets

**Required** (read before coding):
- src/plan-classifier.ts:246-350 — `deriveEpicLinks`; window gate + per-window suppression to remove; KEEP `subject_present` gate at :279.
- src/plan-classifier.ts:393-492 — `deriveJobLinks`; symmetric machinery (early-out at :403 IS the bug).
- src/plan-classifier.ts:1-57 — module JSDoc to rewrite; :75 `MAX_TS_SENTINEL`; :107 `normalizePlanctlOp` (reuse); :179-207 `computePlanWindows` to delete.
- src/reducer.ts:5462-5567 + 5610-5663 — `syncPlanctlLinks` opener queries / windowsBySession / deriver calls.
- src/reducer.ts:5677-5702 — `created_by_closer_of` derivation (downstream beneficiary; queries jobs WHERE plan_verb='close').
- src/db.ts:50 (SCHEMA_VERSION); :1953-1984 + :2260-2290 (frozen backfills); :2936-2954 (canonical wipe list + cursor-reset pattern); :3756 (meta stamp).
- keeper/api.py:325-371 — SUPPORTED_SCHEMA_VERSIONS + the v75/v76 doc-comment template.
- test/plan-classifier.test.ts:101,113,171,177 — window-specific tests to prune; test/fixtures/plan_classifier_cases.jsonl — frozen golden, HAND-EDIT (no generator exists).
- test/reducer-links.test.ts:869 (planPlanOpener helper), :982/:1012 (window tests), :1144-1252 (per-window suppression), :1933+ (v29 closer tests that currently inject an opener to make edges appear).

**Optional** (reference as needed):
- src/derivers.ts `parsePlanRef` — epic-shape source of truth (reuse, never re-copy).
- cli/board.ts:266-300 + 473-490, src/board-render.ts:417-421 — render path (confirm no change needed).
- README.md:2125-2142 — v76 changelog template.

### Risks

- **Golden-fixture rubber-stamping.** `plan_classifier_cases.jsonl` is hand-edited
  (no generator). Prove each new `expected` array by independent hand-computation
  from the case's event log — do NOT paste "what the code now emits." Diff old vs
  new edge-by-edge and sanity-check the count growth for over-linking.
- **Re-fold determinism is sacred.** Stable total-order sort (event_id tiebreak),
  sorted-array (not Set/Map) serialization, no wall-clock/env/fs in the fold. A
  migrated DB and a from-scratch re-fold must yield byte-identical rows.
- **Backfill drift.** Updating only one of the two frozen backfills, or letting
  them diverge from the live reducer, breaks determinism. Move both together.
- **Edge-set shrink on existing epics.** Per-session creator-suppression means a
  session that touched one epic in two windows now emits `[creator]` not
  `[creator, refiner]` (see reducer-links.test.ts:1012) — intended; update that test.

### Test notes

- Prune/convert window-only unit tests (plan-classifier.test.ts:101/113/171/177);
  drop the dead `windows`/`windows_by_session` fixture keys.
- Add a unit test: two same-`ts` ops of the same epic differing in kind →
  deterministic creator-suppression outcome (locks the total-order requirement).
- Add a live-fold test (test/reducer-links.test.ts): a closer session with NO
  `/plan:plan` opener now produces the `creator` edge AND populates
  `created_by_closer_of` end-to-end — the headline win. Simplify the v29 closer
  tests that currently inject `planPlanOpener` to make edges appear.
- `bun run test:full` is mandatory (db/reducer/fold paths). Poll, don't sleep.

## Acceptance

- [ ] `deriveEpicLinks` / `deriveJobLinks` emit edges for every mutating op with no window dependence; `subject_present=false` ops still excluded; `computePlanWindows`/`MAX_TS_SENTINEL` removed (no remaining callers).
- [ ] Per-session creator-suppression: a session that scaffolds and later refines the same epic emits exactly one `creator` edge; cross-session edges are never suppressed.
- [ ] Classifier sort is a total order (event_id tiebreak); a dedicated test proves deterministic suppression on a `ts` tie.
- [ ] `syncPlanctlLinks` no longer reads `/plan:plan` openers/windows; commit-trailer UNION and touched-epics sweep intact; `created_by_closer_of` populates for closers.
- [ ] `SCHEMA_VERSION`=77; v77 migration resets the cursor + wipes the canonical projection list in one `BEGIN IMMEDIATE`; both frozen backfills updated together; `keeper/api.py` lists 77 (same commit).
- [ ] New live-fold test: a closer with no `/plan:plan` opener produces the creator edge and populates `created_by_closer_of`.
- [ ] Golden fixtures hand-recomputed and verified (not code-dumped); README architecture prose + v77 changelog updated; module JSDoc rewritten windowless.
- [ ] `bun run test:full` green; a from-scratch re-fold yields byte-identical projection rows.

## Done summary

## Evidence
