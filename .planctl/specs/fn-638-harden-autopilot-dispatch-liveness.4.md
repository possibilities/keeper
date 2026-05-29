## Description

**Size:** S
**Files:** src/readiness.ts, scripts/board.ts, test/readiness.test.ts

OPTIONAL / nice-to-have (not load-bearing — the core fix is tasks `.1`-`.3`).
Complement to P3: make the "held by a possibly-stuck sub-agent" state
visible so a human can see WHAT is holding a gate instead of seeing a dead
autopilot. This is the projection-derived affordance (board-visible,
re-fold-safe), NOT the dispatch-ledger launched-not-fulfilled affordance
(that would be client-only/sidecar — out of scope).

### Approach

Add a new `RunningReason` variant (e.g. `{ kind: "sub-agent-stale" }`,
`src/readiness.ts:166-175`) surfaced when a still-`running`
`subagent_invocation`'s start age exceeds a visibility threshold related to
`MAX_STOP_YIELD_GAP_SEC` (from task `.1`), distinguishing a possibly-stuck
sub-agent from fresh sub-agent work. `formatPill` (`:1263-1274`) renders
`running` reasons generically (no switch to extend); add a color entry in
`colorizePillsInLine` (`scripts/board.ts:547-556`). Align the staleness
definition with `collapseSubagentsByName`'s existing client-side
stuck-orphan notion (`src/readiness-client.ts:387,:407-412`) to avoid two
divergent definitions. **Determinism nuance:** `computeReadiness` must not
bury a `Date.now()` in the pure pass — thread the staleness "now" in as an
explicit parameter supplied by the live client (mirroring how the
`diagnostics` side-channel handles time at `readiness.ts:~1105`), and
document why this is a client computation distinct from the reducer fold.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:166-175 — `RunningReason`/`Verdict` unions
- src/readiness.ts:444, :665-670 — `anyEmbeddedJobHasRunningSubagent` producers
- src/readiness.ts:1263-1274 — `formatPill` (generic running-reason render)
- scripts/board.ts:547-556 — `colorizePillsInLine`; :853/875/882 — `formatPill` sites
- src/readiness-client.ts:387-421 — `collapseSubagentsByName` stuck semantics

### Risks

- Determinism: the "age" must derive from a threaded `now` parameter / snapshot data, never a `Date.now()` buried in the pure `computeReadiness` path.
- **Overlap with fn-636** on `scripts/board.ts` `renderEpicBlock`/`colorizePillsInLine`: fn-636's sole task is already done and effectively on main, but rebase/sequence this task after fn-636's board.ts changes are committed to avoid a render-block edit collision. Advisory — not a hard dep.

### Test notes

readiness.test.ts: a running sub-agent past the staleness threshold →
assert the `sub-agent-stale` `RunningReason`; within threshold → assert
plain `sub-agent-running`. Confirm the pill renders and colorizes.

## Acceptance

- [ ] New `RunningReason` variant fires for a sufficiently-old still-running sub-agent and renders as a distinct board pill (with color)
- [ ] Staleness derives from threaded `now`/snapshot data — no `Date.now()` in the pure readiness pass; re-fold/recompute determinism preserved
- [ ] Staleness definition aligned with `collapseSubagentsByName`
- [ ] Sequenced after fn-636's board.ts changes land (no render-block collision)

## Done summary

## Evidence
