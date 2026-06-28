## Overview

The origin-containment re-push added last round runs a bare `git push` with no
refspec. Under `push.default=simple` (git's default and this environment's
config), a no-refspec push targets the CURRENT HEAD's upstream — not the default
branch. So when the primary checkout is on a non-default branch, the re-push
silently pushes the wrong ref (or reports "Everything up-to-date", exit 0) while
`origin/<default>` never advances — yet the caller treats it as pushed and tears
the base down, stranding the merge on local default (a reintroduction of the
push-timeout-strand failure). This epic makes the re-push deterministic w.r.t.
HEAD and adds a post-push origin-containment recheck so teardown only ever
follows a merge that provably reached origin. It is the last code-correctness
gate before re-enabling worktree mode on a supervised canary.

## Quick commands

- `bun test test/autopilot-worker.test.ts` — the pass-3 / re-push driver tier
- `KEEPER_PLAN_RUN_SLOW=1 bun run test:slow` — plan real-git tier

## Acceptance

- [ ] the re-push never pushes a non-default ref; off-default degrades cleanly instead of stranding a merge
- [ ] teardown follows the re-push only when origin/<default> provably contains the merge
- [ ] no finalize-side reason leaks the worktree-recover* prefix; recover-side keeps it

## Early proof point

Task that proves the approach: `.1`. If it fails: the HEAD-safety assertion can't
be threaded as a structural off-branch arm → fall back to a branch-explicit
refspec push plus an explicit pre-push HEAD check.

## References

- A blind multi-model panel reproduced the bug empirically (push.default=simple, HEAD off-default → bare push exits 0, origin/<default> does not advance) and isolated it as the sole remaining canary blocker; everything else in the worktree finalize/recover path verified correct. Builds on fn-990 / fn-991.
