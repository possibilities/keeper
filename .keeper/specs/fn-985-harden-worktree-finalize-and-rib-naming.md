## Overview

Round-2 worktree hardening: close the remaining live-path failure modes a panel review surfaced and that were reproduced this session, so a forked/parallel epic and a real finalize can't jam — before re-enabling worktree mode. Two fixes: (1) rib branch names no longer nest under the base ref (the git directory/file ref conflict that jams the first forked epic), with ribs pruned at teardown; (2) finalize/recover degrade gracefully — skip-and-retry with a distinct reason, never a sticky un-clearable close — when the shared main checkout is dirty/occupied/off-branch or the push is non-fast-forward. New behavior is covered by a real-git base+rib+fan-in slow test plus pure-tier fake-runner tests.

## Quick commands

- `cd plugins/plan && bun run test:slow` — runs the new real-git base+rib+fan-in + finalize-degrade tests (KEEPER_PLAN_RUN_SLOW=1)
- `bun test` — root pure tier (finalize/recover dirty-precheck + idempotency + non-ff via fake runners); must stay green and pure
- `bun run typecheck && bun run lint` (root) and `cd plugins/plan && bun run typecheck && bun run lint`

## Acceptance

- [ ] A forked-DAG epic (>=2 ribs + a fan-in) provisions all lanes with NO git ref directory/file collision.
- [ ] listEpicBaseBranches distinguishes base from rib under the new scheme — no rib is mis-enumerated as a base or merged to the default branch.
- [ ] Ribs (branches + worktrees) are pruned at teardown; nothing leaks; a re-run of the same epic does not collide.
- [ ] finalize + recover skip-and-retry (a DISTINCT, non-`worktree-recover*` reason) on a dirty/occupied/off-branch main checkout or a non-fast-forward push — never a sticky un-clearable close; the recover auto-clear scoping is preserved.
- [ ] finalize is idempotent: a re-run after a partial (post-merge / post-push) failure resumes teardown instead of re-failing.
- [ ] Default `bun test` stays pure; the real-git tests are opt-in slow-tier only; typecheck + lint green (root + plan plugin).

## Early proof point

Task that proves the approach: `.1` — the real-git base+rib+fan-in test passing proves R1 is closed and the listEpicBaseBranches discriminator is right. If it fails: the rib scheme or the base-vs-rib split is still wrong — re-check the FULL consumer set before Task 2.

## References

- Built on fn-984 (centralized resolution + the worktree-lifecycle slow test this extends).
- Panel review + reproduction this session: R1 (rib D/F collision), R3 (no clean-tree guard on finalize/recover), R5 (finalize not idempotent), R7 (ribs never pruned).
- keeper-514 holds a downstream durable per-job worktree-marker epic, on ice until this lands.

## Docs gaps

- **README.md `## Architecture` (worktree lifecycle, ~3201-3232)**: rib branch namespace rename + rib pruning at teardown + finalize/recover skip-and-retry degrade behavior (rewrite in place, don't append).
- **keeper/CLAUDE.md (worktree auto-clear invariant, ~line 116)**: finalize now degrades gracefully (skip-and-retry) on a dirty checkout rather than a sticky jam; the auto-clear scoping to `worktree-recover*` stays. Revise the single sentence, don't split it.

## Best practices

- **Avoid directory/file ref collisions:** no ref may be a path-prefix of another; the flat `--` separator keeps the base ref name unchanged (minimal consumer churn). [git check-ref-format]
- **Idempotent finalize:** is-ancestor-gate the merge + base delete; order teardown as worktree-remove -> branch-delete -> prune; only tear down after a verified push. [git-worktree]
- **Non-fast-forward push without a fetch:** `merge-base --is-ancestor origin/<default> <default>` — degrade, never auto-fetch/rebase/force on a shared checkout. [git-merge-base]
