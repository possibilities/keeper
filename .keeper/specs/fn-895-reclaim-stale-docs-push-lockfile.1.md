## Description

From audit finding F1 (evidence: `plugins/keeper/plugin/hooks/docs-pusher.ts:257-276`).
`tryAcquireLock` is a bare `openSync(lockPath, "wx")` with no pid/mtime stamp
and no reclaim; `releaseLock` runs only in `pushDocs`'s `finally` (line 322-324).
A hard kill of the Stop hook between acquire (line 306) and the `finally`
orphans `.git/keeper-push.lock`, after which every subsequent `tryAcquireLock`
returns false → `pushDocs` returns `"locked"` permanently, silently halting all
docs pushes. The `locked` path also emits no `logSkip`, so the stall is
invisible. The release comment at lines 272-274 falsely claims a manual
`git push` self-heals the lock — nothing in the manual-push path removes
keeper's lockfile.

Make the lock self-reclaiming: stamp it with pid + mtime on acquire, and on a
pre-existing lock reclaim it when the holder pid is verifiably gone OR the lock
is older than a threshold comfortably above `GIT_TIMEOUT_MS` (e.g. > 60s).
Emit a `logSkip` line on a genuine (non-reclaimed) `locked` skip so a stuck
lock is diagnosable. Correct the misleading self-heal comment. Preserve the
exit-0 / fail-open contract and the never-rebase / never-force invariant — a
reclaim failure must skip, not throw.

## Acceptance

- [ ] A lock whose stamped holder pid is gone, or that is older than the
      staleness threshold, is reclaimed on the next push (push proceeds).
- [ ] A live, fresh lock (concurrent session mid-push) still blocks — no racing
      push.
- [ ] A `locked` skip is logged via `logSkip` so a stuck lock is visible.
- [ ] The self-heal comment is corrected to describe actual behavior.
- [ ] Test covers the orphaned-lock-reclaimed path against a real
      `initRepo` + bare-origin fixture (the gap `docs-pusher.test.ts` leaves today).
- [ ] The hook still always exits 0 and never rebases / force-pushes.

## Done summary
Made the ~/docs push lock self-reclaiming: pid-stamp on acquire, reclaim when the holder pid is gone or the lock is older than 60s (>GIT_TIMEOUT_MS), log a locked skip, and fix the misleading self-heal comment. Added reclaim-path tests against a real initRepo fixture.
## Evidence
