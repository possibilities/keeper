## Description

**Size:** M
**Files:** cli/commit-work.ts, src/worktree-git.ts, test/commit-work.test.ts

### Approach

The commit-work lock serializes whole-repo staging: one lock file under the repo's shared `.git` dir covers every worktree of that repo. A crashed invocation strands an empty lock file, and today every subsequent invocation fails `stage_failed` without ever naming the lock — the failure is invisible and unreaped, so autonomous workers block TOOLING_FAILURE on verified diffs. Two behavioral changes, one owner: (1) when lock acquisition is why the invocation cannot proceed, the failure envelope names the lock's absolute path and that it is the cause; (2) before failing on an existing lock, a provably-stale lock — empty, older than a conservative age bound, and with no live holder — is removed in-line with one audited log line, and the invocation proceeds normally. A lock with a live holder is never touched: concurrent invocations must still serialize exactly as today. Determine the actual acquire semantics first (flock vs create-exclusive) — the reap predicate must match how the lock is genuinely held so a held flock is never misread as stale.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/commit-work.ts:1343 — the `acquire(`${lockDir}/keeper-commit-work.lock`)` call site; what acquire() actually does decides the staleness predicate
- cli/commit-work.ts:1403,1484,1537 — the `stage_failed` envelope constructions that today swallow the lock cause
- src/worktree-git.ts:28,348-394 — the lock-path derivation contract (worktree-anchored absolute `--git-dir`, never bare relative `.git`) and the merge-serialization flock comment

**Optional** (reference as needed):
- test/commit-work-worktree-isolation.test.ts — existing worktree lock-sharing coverage patterns
- test/commit-work-foundation.test.ts — envelope-shape test patterns

### Risks

- The same lock filename is taken by daemon-side merge paths (src/worktree-git.ts); the reap must not fight a live fan-in merge — the no-live-holder predicate must cover those holders too.

### Test notes

Deterministic, in-process, through the pure seam: simulate a stranded empty lock, a fresh lock, and a live-held lock; assert reap/name/serialize respectively. Never boot a daemon or spawn real concurrent processes.

## Acceptance

- [ ] A commit-work invocation refused because the repo lock is present/held emits an envelope naming the lock path as the cause, not a bare stage_failed.
- [ ] An invocation meeting a provably-stale lock (empty + past the age bound + no live holder) reaps it with one audited log line and completes with a normal outcome.
- [ ] A lock with a live holder is never reaped and still serializes the invocation exactly as before.
- [ ] `bun test ./test/commit-work.test.ts` and the other named commit-work gates pass, plus `bun run typecheck`.

## Done summary
commit-work now names the contended lock's absolute path in refusal envelopes and reaps a provably-stale (empty, past age bound, no live holder) lock in-line with one audited log line; a live-held lock is never reaped and still serializes as before. Preview now also probes/reports lock state.
## Evidence
