## Description

**Size:** S
**Files:** src/readiness.ts, scripts/board.ts, test/readiness.test.ts

OPTIONAL / nice-to-have (not load-bearing — the core fix is tasks `.1`-`.3`).
Complement to P3: make the "held by a possibly-stuck sub-agent" state
visible so a human can see WHAT is holding a gate instead of seeing a dead
autopilot. This is the projection-derived affordance (board-visible,
re-fold-safe), NOT the dispatch-ledger launched-not-fulfilled affordance
(that would be client-only/sidecar — out of scope).

**Lands after fn-637** (`project-epic-deps-onto-epic-entities`) — this task
has the most contention with it; rebase onto the post-fn-637 tree (see
Approach + Risks). Sequence after BOTH fn-636 and fn-637.4 for the board.ts
pill region.

### Approach

Add a new `RunningReason` variant (e.g. `{ kind: "sub-agent-stale" }`,
`src/readiness.ts` `RunningReason` union) surfaced when a still-`running`
`subagent_invocation`'s start age exceeds a visibility threshold related to
`MAX_STOP_YIELD_GAP_SEC` (from task `.1`), distinguishing a possibly-stuck
sub-agent from fresh sub-agent work. `formatPill` renders `running` reasons
generically (no switch to extend); add a color entry in
`colorizePillsInLine` (`scripts/board.ts:547-556`). Align the staleness
definition with `collapseSubagentsByName`'s existing client-side
stuck-orphan notion (`src/readiness-client.ts:387,:407-412`) to avoid two
divergent definitions.

**Determinism (rebased onto fn-637.1):** fn-637.1 moves the cross-epic
resolver into a new `src/epic-deps.ts` and converts it to take an INJECTED
timestamp — deleting the inline `new Date()` that used to live at
`readiness.ts:~1105`. Follow that SAME injected-`now` pattern here: thread
the staleness reference time in as an explicit parameter supplied by the
live client (board); do NOT reintroduce a `Date.now()` inside the pure
`computeReadiness` pass. Document why this is a client computation distinct
from the reducer fold.

**Rebase notes (fn-637 lands first):**
- fn-637.4 reshapes predicate 9 to read the projected `resolved_epic_deps`
  and DELETES the `completedEpics` param from `computeReadiness`. The new
  `RunningReason` variant is orthogonal (predicate 5/6 area), so this is
  line-drift + signature adjacency, not a design conflict — re-locate the
  union/`formatPill`/predicate sites after rebase rather than trusting the
  pre-fn-637 line numbers below.
- fn-637.1/.4 rewrite the board summary-pill block (`scripts/board.ts:778-799`)
  to read the projection and rebase fn-636's assertions onto it. This
  task's colorize/pill edit (`:547-556` + render sites) is a different
  region but the same file — land it after fn-637.4 to avoid a render-block
  collision.

### Investigation targets

(Line numbers predate fn-637 + fn-636 landing — re-locate after rebase.)

**Required** (read before coding):
- src/readiness.ts — `RunningReason`/`Verdict` unions; `anyEmbeddedJobHasRunningSubagent` producers; `formatPill` (generic running-reason render)
- src/epic-deps.ts (created by fn-637.1) — the injected-timestamp resolver pattern to mirror for the stale-check's `now` parameter
- scripts/board.ts — `colorizePillsInLine` (~547-556); `formatPill` render sites; the projection-backed summary-pill block fn-637.4 leaves behind
- src/readiness-client.ts — `collapseSubagentsByName` stuck semantics (~387-421)

### Risks

- Determinism: the "age" must derive from a threaded `now` parameter / snapshot data, never a `Date.now()` buried in the pure `computeReadiness` path — mirror fn-637.1's injected-timestamp resolver.
- **Overlap with fn-636 AND fn-637.4** on `scripts/board.ts` pill rendering: fn-636 is done; fn-637.4 rewrites the summary-pill block. Land this task after fn-637.4 to avoid a render-block edit collision.
- Optional task — if it slips, the core fix (`.1`-`.3`) is unaffected.

### Test notes

readiness.test.ts: a running sub-agent past the staleness threshold →
assert the `sub-agent-stale` `RunningReason`; within threshold → assert
plain `sub-agent-running`. Confirm the pill renders and colorizes. Drive
the stale check with an explicit injected `now` to keep the test
deterministic.

## Acceptance

- [ ] New `RunningReason` variant fires for a sufficiently-old still-running sub-agent and renders as a distinct board pill (with color)
- [ ] Staleness derives from a threaded `now`/snapshot data — no `Date.now()` in the pure readiness pass; re-fold/recompute determinism preserved
- [ ] Staleness definition aligned with `collapseSubagentsByName`
- [ ] Rebased onto fn-637 (post-stopgap `computeReadiness` signature, projection-backed predicate 9 + board summary pill); landed after fn-636 and fn-637.4 (no render-block collision)

## Done summary

## Evidence
