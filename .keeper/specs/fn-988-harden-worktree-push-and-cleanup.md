## Overview

Round-3 worktree hardening: close the remaining LIVE-PATH failure modes a blind panel surfaced (verified) so a real finalize can't stick and lanes can't orphan, before re-enabling worktree mode. (1) finalize/recover detect a non-turn-key push BEFORE the local merge and degrade to a non-sticky retry; (2) mergeReadiness detects a would-clobber-untracked merge (a targeted intersection, preserving benign-untracked); (3) teardown/recover prune ALL of an epic's ribs and sweep done-but-unmerged bases beyond the snapshot; (4) lane paths disambiguate across same-basename repos. Builds on fn-984/985/987.

## Quick commands

- `cd plugins/plan && bun run test:slow` — real-git finalize-degrade / lifecycle / fork tests
- `bun test` — root pure tier (remotePushFastForwardable, mergeReadiness, finalize/recover/path fakes)
- `bun run typecheck && bun run lint` (root) and `cd plugins/plan && bun run typecheck && bun run lint`

## Acceptance

- [ ] finalize + recover detect a non-turn-key push (no remote / no push-target / would-prompt) BEFORE the local merge and degrade to a DISTINCT non-sticky skip-and-retry — finalize-side NOT `worktree-recover*`-prefixed, recover-side `worktree-recover*` — never merge-then-stick.
- [ ] remotePushFastForwardable no longer returns true on an unresolved remote-tracking ref.
- [ ] mergeReadiness flags a would-clobber untracked file (the lane's incoming tracked paths ∩ main's untracked) as not-ready/skip-retry, while a benign untracked-only tree still finalizes (no fn-987 regression).
- [ ] teardown + recover prune EVERY `keeper/epic/<id>` + `keeper/epic/<id>--*` rib (branch + worktree), is-ancestor-gated; recover sweeps done-but-unmerged bases even outside the current snapshot.
- [ ] worktreePathFor disambiguates same-basename repos; provision-registration + removeWorktree path comparisons still hold.
- [ ] default `bun test` stays pure; new real-git tests are opt-in slow tier; typecheck + lint green (root + plan).

## Early proof point

Task that proves the approach: `.1` — the push pre-check + the remotePushFastForwardable fix with the existing finalize-degrade slow test green. If it fails: the reason-family scoping or the push-readiness gate is wrong — re-check the classifyPushError reuse before Task 2.

## References

- Built on fn-984 / fn-985 / fn-987.
- REUSE src/commit-work/push.ts (classifyPushError — 6 classes incl. no_upstream/auth/non_fast_forward — + pushCommitted, GIT_TERMINAL_PROMPT=0) for the push taxonomy; do not duplicate.
- Auto-clear scoping: WORKTREE_RECOVER_REASON_PREFIX (src/autopilot-worker.ts:405) + recoverFailuresToClear (:421) — finalize-side reasons stay OUT of that scope.

## Docs gaps

- **README.md `## Architecture` (worktree block ~3220-3276)**: extend the finalize + recover degrade lists (add non-turn-key push + would-clobber); clarify ALL-ribs pruning + the extended base sweep; add the lane-path disambiguation convention. Revise in place.
- **keeper/CLAUDE.md (~line 116)**: add non-turn-key-push + would-clobber to the finalize non-sticky degrade enumeration; preserve the auto-clear scoping rule (additive only).

## Best practices

- Pre-push gate order: remote exists -> push-target resolves (`@{push}`, NOT `@{upstream}`) -> `git push --dry-run`; GIT_TERMINAL_PROMPT=0 (+ GIT_SSH_COMMAND BatchMode for ssh); dry-run is a probe, not an auth oracle; degrade, never force-push. [git-push]
- Would-clobber detection = `git ls-files --others --exclude-standard` ∩ `git ls-tree -r --name-only <lane>`; only the intersection blocks (benign untracked stays clean); `git merge-tree` does NOT see untracked. [git-merge]
- Enumerate lane refs via `git for-each-ref refs/heads/keeper/epic/<id>*`; prune-before-branch-delete; is-ancestor-gate; NEVER `git branch --contains` for cleanup (force-deletes siblings). [git-for-each-ref]
