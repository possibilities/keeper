## Overview

In worktree mode the autopilot merges each epic's base branch into the repo
default branch by running `git merge` + `git push` IN the shared repo toplevel
checkout — the human's interactive working copy. A dirty or off-default checkout
silently retry-skips that merge (no visible row), stranding a done epic
unmerged. This epic makes the base merge working-tree-free (a plumbing
merge-tree/commit-tree/update-ref-CAS/push pipeline) so it never touches or
depends on the shared checkout, then neuters the shared-checkout distress signals
that become false positives once a dirty checkout no longer blocks anything.
Root fix only; the full removal of now-inert machinery + the CLAUDE.md/CONTEXT.md
prune ride a sequenced follow-up.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/worktree-git.test.ts` — fast suites green

## Acceptance

- [ ] The base->default merge lands and pushes with NO working-tree merge, even when the shared checkout is dirty or on a non-default branch
- [ ] When the shared checkout is idle-clean-on-default its working tree still ends up carrying the merged commit (best-effort, non-blocking)
- [ ] A dirty/mid-merge shared checkout no longer produces a false-positive needs_human distress row
- [ ] A concurrent default advance (CAS mismatch) is a transient retry-skip; a real content conflict still escalates on the existing sticky path
- [ ] docs/adr records the plumbing-merge decoupling decision

## Early proof point

Task that proves the approach: `.1` — the plumbing merge landing while the shared
checkout is dirty/off-default is the whole thesis. If it fails (e.g. merge-tree
conflict semantics or the CAS/ahead-check interaction don't hold): stop and
reassess before touching the distress machinery in `.2`.

## References

- Reference implementation of this exact merge-tree/commit-tree/update-ref/push pipeline: kortix-ai/suna apps/api/src/projects/git/merge.ts
- `keeper prompt render engineering/landed-vs-complete` — the milestone contract this merge lands
- Overlaps `fn-1139` (same-file refactor) — wired as an upstream dep to avoid a fan-in collision on src/autopilot-worker.ts + src/worktree-git.ts
