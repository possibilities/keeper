## Overview

`projectGitStatus` (`src/reducer.ts`) ratchets: its pass-4 fan-out loop
pushes EVERY enumerated session into `git_status.jobs` even when
`dirty == 0`, so once a session has ever had a dirty file it is
re-persisted forever, becomes the next snapshot's `priorSessions`, and is
re-fanned on every GitSnapshot fold. Measured on the live DB: keeper's
`git_status` has `dirty_count=0` yet 259 entries in `git_status.jobs`, all
`dirty=0`, 161 carrying `plan_ref` (161 no-op `syncJobIntoEpic` epic
re-writes per snapshot). This is the dominant `fanout` pass (1000-1500ms)
in `[gitfold-breakdown]`, pushing GitSnapshot folds to 2.3-3.3s — over the
~2.4s hook write budget and the predicted next `insert:SQLITE_BUSY` drop
wave. The fix bounds the persisted set to `dirty > 0`; steady-state
fan-out collapses to the currently-dirty set (0-5). End state: a session
zeroes out exactly once (the transition snapshot where it is still in
`priorSessions`, gets its clearing UPDATE + `syncIfPlanRef`), then drops
from `git_status.jobs` and is never re-fanned.

## Quick commands

- `bun test test/reducer.test.ts` — reducer + re-fold determinism suite
- `cp ~/.local/state/keeper/keeper.db /tmp/verify.db && rm -f /tmp/verify.db-wal /tmp/verify.db-shm` — make a DB copy to verify folds offline
- `grep '\[gitfold-breakdown\]' ~/.local/state/keeper/server.stderr | tail` — confirm fanout/total drop after deploy

## Acceptance

- [ ] `git_status.jobs` retains only `dirty > 0` sessions; the ratchet is gone
- [ ] re-fold determinism preserved (existing + new tests pass)
- [ ] GitSnapshot fold latency drops well under the ~2.4s hook budget, verified on a live-DB copy BEFORE the live daemon is touched
- [ ] CLAUDE.md + README.md invariant prose states the `dirty > 0` retention rule; no schema bump

## Early proof point

Task that proves the approach: `.1`. If it fails (determinism diverges or
retract regresses): revert the one-line guard; the fix is isolated to the
`projectionJobs.push` site, so rollback is trivial.

## References

- Root-cause writeup: `~/docs/keeper-reliability/findings.md` (2026-05-31 entry)
- Bug site: `src/reducer.ts` fan-out loop (~:2032-2048, push ~:2047), retract `~:2152-2192`
- `git_status.jobs` is wire-shipped (`src/collections.ts` ~:348) but parsed-for-`job_id` ONLY by `retractGitStatus`; `readiness.ts` reads scalar columns + per-job `jobs.git_*`

## Best practices

- **Zero-before-remove (same transaction):** a session's `jobs.git_dirty_count` must be 0 at the same moment it leaves `git_status.jobs`, else the retract path won't re-zero it. The clearing UPDATE + `syncIfPlanRef` already run unconditionally for all `sortedSessions` — guard ONLY the `push`, never the UPDATE or `syncIfPlanRef`.
- **Keep `priorSessions` in the union:** it is what guarantees a session that just zeroed still receives its clearing UPDATE on the transition snapshot. Do not add a separate dead-set clear pass (extra `BEGIN IMMEDIATE`).
- **No re-fold / migration:** the live daemon self-converges — `projectionJobs` becomes a pure function of `sessionDirtyCount` (independent of `priorSessions` content), so live-fold and from-scratch re-fold produce byte-identical persisted sets after the transition snapshot.
