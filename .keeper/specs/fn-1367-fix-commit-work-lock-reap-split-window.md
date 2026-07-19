## Overview

The stale-lock reap in `commit-work` unlinks the lock file while a
concurrent blocking `acquire()` may be parked on that inode's flock,
opening a split-lock window where two invocations both believe they hold
the exclusive commit-work lock. The finding also shows the reap has no
functional benefit — the kernel auto-releases a dead holder's flock and
`acquire()` re-locks an empty leftover file cleanly — so it adds a
double-grant hazard to a mutual-exclusion primitive for no gain. This
follow-up removes that hazard while keeping the observability wins
(`lock_path` / `cause` / preview `lock_state`) that shipped alongside it.

## Acceptance

- [ ] The commit-work lock reap no longer opens a split-lock window (preferred: stop unlinking the empty unheld lock and let `acquire()` re-lock it cleanly; alternatively rename-to-unique-then-unlink or verify the fd's inode after locking).
- [ ] The refusal-envelope naming and preview `lock_state` reporting are preserved unchanged.
- [ ] Any defensive reap branches the fix retains are covered by tests; branches the fix removes are gone rather than left untested.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | probeCommitWorkLock's unlinkSync opens a real flock+unlink split-lock window and flock.ts confirms the reap has no functional benefit — cheap net-simplifying fix. |
| F2 | merged-into-F1 | .1 | F2's untested defensive reap branches exist only to make F1's unlink safe; the F1 fix in this task deletes or covers them. |
| F3 | culled | — | The report frames the split-lock-race test as a known gap not a request, and it is mooted once F1 drops the unlink. |

## Out of scope

- The observability surface (`lock_path`, `cause`, `lock_state`) — it ships correct and is retained, not reworked.
- The `CommitWorkLock` FFI/flock primitive itself (`src/commit-work/flock.ts`) — the fix lives in the reap caller, not the lock class.
