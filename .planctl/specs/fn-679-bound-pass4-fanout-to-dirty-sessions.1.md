## Description

**Size:** S
**Files:** src/reducer.ts, test/reducer.test.ts, README.md

### Approach

In `projectGitStatus` pass-4 (`src/reducer.ts` ~:2010-2164), change the
fan-out enumeration from `sessionsToFanOut = sessionsWithAttribution ∪
priorSessions` to `sessionDirtyCount.keys() ∪ priorSessions`, and DELETE the
`allActiveSessions` query (~:2062-2072) — grep-confirm its only consumer is
the fan-out enumeration before removing (no dangling prepared statement).
`sessionDirtyCount` (~:2028, populated ~:2040 from the pass-3 rendered +
discharge-filtered attributions of snapshot.dirty_files) is the
currently-dirty attributed set; `priorSessions` (~:2082-2103, parsed from the
prior git_status.jobs) is the zero-out-transition set and MUST be kept. Keep
the reduced set sorted (`Array.from(...).sort()` ~:2127) for determinism. The
per-session loop body (jobUpdateStmt + syncIfPlanRef + the dirty>0 push
guard) is unchanged — only the SET it iterates shrinks.

Confirm the two correctness obligations the gap-analyst identified:
(1) `sessionDirtyCount.set(a.session_id,...)` is co-populated 1:1 with the
dirty-file contribution to `sessionsWithAttribution.add(a.session_id)` in the
same loop (read ~:2039-2040), so the new set == the old set minus
allActiveSessions; (2) no session can be (undischarged, dirtyForSession==0,
NOT in priorSessions, carrying a stale nonzero git_dirty_count) — the fn-656.1
push guard (only dirty>0 → projectionJobs → git_status.jobs → priorSessions)
guarantees any nonzero count was persisted, so priorSessions always catches a
session that needs zeroing. The per-job project-wide count broadcast
(orphanCount/unattributedToLiveCount, ~:2138-2139) narrows to the bounded
set — acceptable because those columns are informational-only (no readiness/
board consumer); do not widen the broadcast back out (a wide broadcast still
iterates 288 → no latency win).

### Investigation targets

**Required** (read before coding):
- src/reducer.ts ~:2025-2047 (sessionDirtyCount + orphanCount/unattributedToLiveCount build from dirty_files), ~:2062-2072 (allActiveSessions — to delete), ~:2082-2109 (priorSessions + sessionsToFanOut), ~:2127 (sort), ~:2134-2164 (loop + push guard ~:2161), ~:2221-2236 ([gitfold-breakdown] nsessions observable)
- test/reducer.test.ts :612 (dirty→clean zeroes once), :768 (undischarged-not-dirty via priorSessions — assertion :859, stale comments :774/:829 to rewrite), :3135 / :2978 / :2100 (re-fold determinism)
- src/readiness.ts ~:612-616 + readiness-client.ts ~:1211 (per-job git columns are informational-only — confirms the broadcast-shrink is safe)

**Optional**:
- ~/docs/keeper-reliability/findings.md (2026-06-02 pass4 root-cause)

### Risks

- **Stale-count strand:** if a session can carry a nonzero git_dirty_count without having been in priorSessions, bounding strands it. The fn-656.1 push guard makes this impossible — verify the guard holds (only dirty>0 persists) and that a re-fold reproduces byte-identical.
- **Zero-out regression:** dropping priorSessions (don't) would break the dirty→clean one-time zeroing. KEEP priorSessions.
- **Set-identity slip:** if sessionDirtyCount.keys() ≠ the dirty part of sessionsWithAttribution, the bound enumerates the wrong set — verify co-population.
- **Re-fold determinism:** the bound must read only event-derived state (dirty_files + file_attributions + prior git_status.jobs); no new wall-clock/stat. Never throw (keep the priorSessions try/catch).

### Test notes

Run the fn-656 zero-out tests (:612, :768) + re-fold determinism (:3135,
:2978, :2100) — all must pass unchanged. Rewrite the stale :768 rationale
comments (:774/:829) to reference priorSessions. Add (or confirm) a test that
an undischarged-but-not-currently-dirty session (NOT in priorSessions, e.g.
its files committed >1 snapshot ago, a planctl-source attribution) is NOT
iterated and carries no stale count. VERIFY ON A DB COPY: cp the live
keeper.db, replay the slow GitSnapshot event ids (the 4-7s ones in
[gitfold-breakdown]) against the patched reducer, confirm fold latency drops
well under ~2.4s (nsessions ~288 → small) AND projection rows are correct
(counts unchanged for dirty sessions). Only touch the live daemon after the
copy verifies + bounce to deploy.

## Acceptance

- [ ] Fan-out iterates `sessionDirtyCount.keys() ∪ priorSessions`; `allActiveSessions` query deleted (no dangling prepare); reduced set sorted
- [ ] fn-656 zero-out tests (:612, :768) pass; stale allActiveSessions comments rewritten to priorSessions
- [ ] re-fold determinism tests (:3135/:2978/:2100) pass; bound reads only event-derived state
- [ ] verified on a live-DB copy: previously-slow GitSnapshot folds drop well under ~2.4s; nsessions collapses from ~288
- [ ] no schema bump; README pass-4 description rewritten in-place; committed to main staging only touched files

## Done summary
Bounded GitSnapshot pass-4 fan-out to sessionDirtyCount.keys() ∪ priorSessions (dropped allActiveSessions); verified on DB copy: prior 4-7s slow folds collapse to 9-96ms (well under the 1.5s hook budget) while preserving the fn-656.1 zero-out invariant and re-fold determinism.
## Evidence
