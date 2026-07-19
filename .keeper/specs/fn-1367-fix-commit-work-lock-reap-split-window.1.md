## Description

Rework `probeCommitWorkLock` in `cli/commit-work.ts` to close the
split-lock window found in the fn-1365 audit (F1). The reap `unlinkSync`s
a stale lock path while a concurrent blocking `CommitWorkLock.acquire()`
may be parked on `flock(LOCK_EX)` for that same inode: the parked
acquirer then wins the flock on the now-unlinked inode while the next
`acquire()` opens the path with `O_CREAT` and gets a fresh inode — two
invocations hold flocks on different inodes and both believe they own the
exclusive commit-work lock.

Evidence: the reap in `cli/commit-work.ts` (`probeCommitWorkLock` /
`auditStaleLockReap`, commit aa0fb4f) and the primitive in
`src/commit-work/flock.ts:176-231` (`acquire` / `tryAcquire` open with
`O_CREAT|O_TRUNC` and flock the open-file-description). The same evidence
shows the reap is benefit-free: a dead holder's flock is auto-released by
the kernel and an empty unheld file is re-locked cleanly by `acquire()`,
so the reap only deletes a harmless directory entry while introducing the
hazard. Preferred fix: stop unlinking (report `lock_state` in preview but
leave the empty unheld file in place); if a stale entry must still be
removed, rename-to-unique-then-unlink or have `acquire()` reject a lock
whose fd inode no longer matches the path after locking.

Merged finding F2: the defensive reap branches (`probe_failed` on a
non-ENOENT `lstat`, the dev/ino-changed and re-lstat-ENOENT "available"
fallbacks, the non-file/symlink branch) are untested and exist only to
make the unlink safe. Dropping the unlink removes most of them; whatever
the chosen fix retains must be exercised by a test.

Files: `cli/commit-work.ts`, `test/commit-work.test.ts`.

## Acceptance

- [ ] No sequence of concurrent `acquire()` / reap can leave two commit-work invocations both holding a lock on different inodes for one worktree.
- [ ] Preview still reports `lock_state`; refusal envelopes still carry `lock_path` and `cause`.
- [ ] Retained defensive branches are covered by a test; removed branches are deleted, not left dead.

## Done summary

## Evidence
