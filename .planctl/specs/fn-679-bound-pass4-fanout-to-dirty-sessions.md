## Overview

keeper's GitSnapshot pass-4 fan-out loop (`projectGitStatus`, src/reducer.ts)
iterates `sortedSessions` = sessionsWithAttribution ∪ priorSessions, running a
jobs UPDATE + `syncIfPlanRef` (epic re-write for plan_ref sessions) for EVERY
session. `sessionsWithAttribution` is dominated by `allActiveSessions` — a
`SELECT DISTINCT session_id FROM file_attributions WHERE last_mutation_at >
COALESCE(last_commit_at,0)` that dumps the ENTIRE undischarged set (now 288
sessions in keeper, inflated by fn-666's non-discharging planctl attributions)
into the loop. fn-656 bounded what gets PERSISTED (the dirty>0 push guard);
it did not bound what gets ITERATED. Result: ~288 UPDATE + ~288 syncIfPlanRef
per snapshot → 4-7s folds → steady-state insert:SQLITE_BUSY hook drops
(recurring, daemon stable 18h — not bounce, not skew). The fix: iterate
`sessionDirtyCount.keys() ∪ priorSessions` — the currently-dirty attributed
set (the map already built in pass-4) plus the zero-out-transition set —
dropping `allActiveSessions` from the enumeration entirely (its only consumer
is this loop). The undischarged-set size then stops driving pass-4 latency.

## Quick commands

- `grep '\[gitfold-breakdown\]' ~/.local/state/keeper/server.stderr | tail` — nsessions should drop ~288 → currently-dirty+prior; total well under 2.4s
- `bun test test/reducer.test.ts` — fn-656 zero-out tests (:612, :768) + re-fold determinism (:3135/:2978/:2100)
- verify on a DB copy: replay the slow GitSnapshot event ids, confirm fold drops under budget + byte-identical re-fold

## Acceptance

- [ ] pass-4 enumerates `sessionDirtyCount.keys() ∪ priorSessions`; the `allActiveSessions` query is removed from the fan-out (and fully deleted, no dangling prepare)
- [ ] GitSnapshot fold latency drops well under the ~2.4s hook budget (nsessions in [gitfold-breakdown] collapses ~288 → currently-dirty+prior), verified on a live-DB copy BEFORE the live daemon is touched
- [ ] fn-656 zero-out-once invariant preserved: a dirty→clean session zeroes exactly once via priorSessions; tests :612 and :768 pass
- [ ] from-scratch re-fold reproduces byte-identical jobs/epics/git_status/file_attributions (tests :3135/:2978/:2100 pass)
- [ ] no schema bump; no decision-consumer regression (per-job git-count columns are informational-only — confirmed no readiness/board read)

## Early proof point

Task `.1` Phase 1 (make the set change + run the fn-656 + re-fold tests on a
DB copy) proves the bound preserves the zero-out invariant before touching the
live daemon. If a test fails, the bound's set (currently-dirty ∪ prior) is
missing a session the old allActiveSessions path caught — widen via priorSessions, do not restore allActiveSessions.

## References

- Evidence + root cause: `~/docs/keeper-reliability/findings.md` (2026-06-02 pass4 entry)
- The set construction: `src/reducer.ts` pass-4 ~:2010; `sessionDirtyCount` ~:2028/:2040 (currently-dirty map — the new fan-out source); `allActiveSessions` ~:2062-2072 (DROP — only consumer is the fan-out); `priorSessions` ~:2082-2103 (KEEP — zero-out source); `sessionsToFanOut` ~:2107; loop ~:2134-2164; fn-656 push guard ~:2161; `sortedSessions` sort ~:2127 (reduced set must stay sorted)
- Correctness proof (gap-analyst): the fn-656.1 dirty>0 push guard guarantees any nonzero per-session git_dirty_count was persisted → is in priorSessions → no stale-count strand. Verify `sessionDirtyCount.set` is co-populated 1:1 with the dirty part of `sessionsWithAttribution` (~:2039-2040).
- Per-job git-count columns are INFORMATIONAL-ONLY (readiness reads git_status scalars + dirty_files[].attributions[], NOT the per-job columns — readiness.ts ~:612-616, readiness-client.ts ~:1211); the narrowed broadcast is cosmetic.
- `fn-678` (decouple-dispatch-from-tab-naming, OPEN) — touches src/reducer.ts + test/reducer.test.ts in a DIFFERENT region (new Dispatched/DispatchExpired fold arms + pending_dispatches, schema v50). NOT a functional dep; coordinate by rebasing onto its reducer.ts changes if it lands first (git auto-merges disjoint regions). Do not block on it.
- Builds on fn-656 (push guard), fn-664 (worktree-oid discharge), fn-666 (planctl attribution) — all done.

## Best practices

- **Bound per-event work to event-relevant entities** (currently-dirty ∪ leaving-set), never the full accumulated set — the standard incremental-projection shape.
- **Keep priorSessions as the zero-out-transition source** (negative evidence: a session's files absent from this snapshot's dirty_files = its discharge trigger; priorSessions provides the affirmative detection).
- **Keep the BEGIN IMMEDIATE fold short** — WAL has no writer FIFO fairness; the iteration count is the lock-hold driver.
- **Complementary (NOT required here):** planctl attributions don't discharge cross-session, growing the undischarged set — but after this bound that set is no longer iterated, so its size stops driving latency. A cross-session planctl-discharge fix is deferred hygiene (DB size + count accuracy), not a drop fix.

## Docs gaps

- **README.md** (~:990-996): rewrite the fn-656.1 pass-4 description in-place to the new bound (iterate currently-dirty ∪ prior, not the union with allActiveSessions); don't append an "as of fn-N" seam.
- **CLAUDE.md** (~:129, passes-2/3/4 discharge-predicate reference): verify still byte-identical — the bound is a loop-enumeration guard, the READ predicates are unchanged; likely leave as-is.
- **test/reducer.test.ts** (~:768 comments :774/:829): rewrite the stale "kept in allActiveSessions" rationale comments to "kept via priorSessions" (assertions pass; the comments would lie).
