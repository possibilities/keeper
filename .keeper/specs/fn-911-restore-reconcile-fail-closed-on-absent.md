## Overview

The fn-904 de-git refactor collapsed reconcile's source-scan repo-shape gate
onto the shared PlanVcs facade, which softened a fail-closed contract. When
the `git` binary is absent, `findSourceCommits` now returns a clean empty
result instead of raising `tooling_error`, contradicting the module-header
invariant "ANY unexpected git failure → tooling_error, never a clean one".
This is a correctness fix to restore the documented fail-closed boundary,
paired with the regression test the audit flagged as missing.

## Acceptance

- [ ] A reconcile source-scan on a host with no `git` binary yields a `tooling_error` verdict, never a clean "no source commit" one.
- [ ] A genuinely non-git directory (git present, repo absent) still returns `[]` — the not-a-work-tree case stays a clean signal, only the absent-binary case fail-closes.
- [ ] A regression test asserts `tooling_error` survives an absent git binary on the source scan.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | reconcile.ts:134 + vcs.ts:367 — facade isGitRepo swallows ENOENT to false, so findSourceCommits returns [] on a no-git host instead of the fail-closed tooling_error the module header promises. |
| F2 | culled | — | vcs.ts:226 git-dir vs is-inside-work-tree divergence only surfaces for a bare/.git-internal stateRepo that never happens in practice; theoretical. |
| F3 | culled | — | test-gate.ts onSignal not killing the child only orphans on a directed kill of the gate pid; tidiness-only on a fail-open dev script. |
| F4 | culled | — | Dropped isTaskId guard in hasRealTrailerValue is EQUIVALENT (caller pre-filters validTaskIds); auditor noted it only to prevent re-flagging. |

## Out of scope

- The bare-repo `--git-dir` vs `--is-inside-work-tree` probe divergence (F2) — never reachable in practice.
- test-gate.ts signal-path child kill (F3) and the equivalent isTaskId guard (F4).
