## Overview

Worktree-mode autopilot funnels every lane's work through two single
producer `git push` legs — the epic-finalize merge-to-default and the
crash-recovery merge-to-default. Both shell `git push` with no
`GIT_TERMINAL_PROMPT=0`, so a repo whose `origin` needs interactive
credentials (no cached helper / expired token) can block on git's
askpass / credential helper opening `/dev/tty`, hanging the producer step
inside the reconcile cycle. This hardens both legs to fail fast instead of
hang, matching the deliberate `GIT_TERMINAL_PROMPT=0` already set on the
commit-work push leg.

## Acceptance

- [ ] Both producer push legs fail fast (no `/dev/tty` prompt) when origin needs interactive credentials.
- [ ] The hardening matches the existing commit-work push-leg pattern.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1  | kept   | .1 | src/autopilot-worker.ts:2157 and :2351 pass no env; spawnGitExec inherits ambient env and GIT_TERMINAL_PROMPT is set nowhere globally, so an interactive-cred origin can hang the reconcile cycle. |
| F2  | culled | — | OFF-mode assertOnDefaultBranch is a deliberate, documented design choice (commit b1847be6 + code comment), recoverable via retry_dispatch, no happy-path break. |
| F3  | culled | — | Multi-repo guard raw-string compare is over-rejection only and unreachable in this single-repo epic. |
| F4  | culled | — | worktreePathFor slug collision is unreachable under the current deterministic branch scheme; remedy is a comment only. |
| TG1 | culled | — | Integration test for OFF-mode blocking is the test sibling of culled F2 (intentional behavior). |
| TG2 | merged-into-F1 | .1 | TG2 (push-credential path untested) is closed by F1's GIT_TERMINAL_PROMPT=0 hardening, so it folds into F1's task. |
| TG3 | culled | — | finalizeEpic partial-teardown re-runnability is safe by construction (ancestor-skipped merge + idempotent removes). |

## Out of scope

- OFF-mode on-default-branch assertion (F2) — intentional, documented behavior; not changed here.
- Multi-repo guard path normalization (F3) — deferred; over-rejection only, unreachable in single-repo epics.
- worktreePathFor slug collision hardening (F4) — unreachable; deferred.
