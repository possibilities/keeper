# 0102 — Close-finalize integrates trunk merges in a private worktree

## Status

Accepted (2026-07-21). Implementation tracked by the close-pipeline hardening epics.

## Context

Close-finalize's trunk integration (`integrateRepoUnderLease`) merges an epic's lane
into the default branch **in the shared checkout**: it requires HEAD to sit on the
default branch and refuses with `TRUNK_INTEGRATION_DIRTY` when `git status
--porcelain --untracked-files=all` reports anything at all — including tracked or
untracked paths entirely unrelated to the merge. On a machine where the human and
long-lived operator sessions work in the same checkout, this stranded finished epics
behind ordinary desk dirt: one epic's close bounced through ~10 closer mints while
unrelated edits were in flight, and an operator had to integrate by hand each time.
The operator playbook that always worked is the private-worktree pattern: merge and
gate in a temporary worktree cut from the default tip, push, then fast-forward the
shared checkout only once it is clean. The human directed that finalize adopt it
("the system is supposed to be automatic").

## Decision

Finalize performs trunk integration in a **private scratch worktree**, never in the
shared checkout:

- Cut a temporary worktree and branch from the default tip, merge the epic base
  there, and run the merge-suite gate against that merged tree.
- Publish by pushing the temp branch to the default branch (bounded fetch–merge–push
  retry under the same trunk lease).
- The shared checkout only ever **fast-forwards**, and only when it is clean and on
  the default branch. A dirty or off-branch shared checkout defers *just the
  fast-forward* — visibly and self-clearingly — instead of refusing the whole
  integration.
- The temporary worktree and branch are removed on every exit path.

## Consequences

- Shared-checkout dirt no longer blocks landing an epic; the any-dirt
  `TRUNK_INTEGRATION_DIRTY` refusal class retires.
- No mid-merge state (`MERGE_HEAD`) is ever visible in the shared checkout, so the
  recover pass's mid-merge self-heal never races a finalize merge there.
- A deferred fast-forward leaves the shared checkout trailing the default tip; the
  existing trailing-tip probes own surfacing and clearing that window.
- Content conflicts keep their existing sticky escalation path (resolver, then
  deconflict); they simply materialize in the scratch worktree instead of the
  shared checkout.
