## Overview

Worktree finalize merges a lane into the local default branch and pushes turn-key without running tests — which is how a lost-update merge landed red trunk silently (two individually-green sides, semantically conflicting merge). This epic tests the prospective merge result on a scratch worktree BEFORE local default advances: green proceeds to the real merge+push; red parks the epic on a visible sticky without touching the default ref, so no false shared-checkout-desync and no rollback machinery.

## Quick commands

- `bun test test/autopilot-worker.test.ts` (fast decision seams) and `bun run test:full:slow` for the real-git finalize tier
- Post-deploy: `keeper query dispatch_failures --json` shows a red-gated close parked visibly, local default untouched

## Acceptance

- [ ] A prospective lane→default merge whose fast suite fails parks the epic on a visible operator sticky with local default unmoved and nothing pushed
- [ ] A green merge result proceeds to the existing merge+push path unchanged
- [ ] A gate that cannot run (scratch provision/install failure) degrades to a visible retry-class skip, never a silent push and never a permanent silent block

## Early proof point

Task that proves the approach: `.1`. If scratch-merge suite cost proves prohibitive per finalize: memoize the gate verdict on the merged-tree key so finalize retries skip recompute.

## References

- docs/adr/0008-plumbing-base-default-merge.md — the merge-push sequence this gate inserts into; verify no contradiction, note supersession if the ordering changes
- Incident: commit 1e0c3928's gating clobbered by a later lane merge, landed silently, red for hours (fn-1198 evidence)
- Merge-queue practice: test the merged state, never per-side; red parks visibly [practice-scout]

## Docs gaps

- **CLAUDE.md** (Autopilot worktree paragraph): fold the gate into the existing per-repo finalize sentence — consolidate, don't append
- **CONTEXT.md** (Needs-human enumeration): add the red-gate park family if it becomes operator-visible

## Best practices

- **Semantic merge conflicts are invisible to git** — only the merged tree's suite catches them [practice-scout]
- **Don't re-validate an already-tested tip** — memoize by merged-tree key across finalize retries [practice-scout]
