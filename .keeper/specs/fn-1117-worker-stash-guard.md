## Overview

Concurrent keeper workers in sibling worktrees share one repo-global refs/stash
stack with each other and the human's checkout; interleaved worker
`git stash push/pop` cycles displace files across trees mid-epic. This epic
closes the hole mechanically and textually: the branch-guard hook denies every
mutating stash verb for subagents (allowlist: list/show/create), its deny
message teaches the safe alternatives, and every worker-guidance surface states
the ban. The sanctioned collision-free baseline primitive is deliberately out
of scope — a follow-up epic planned after this lands.

## Quick commands

- `bun test test/branch-guard.test.ts` — the guard's per-verb allow/deny table
- `echo '{"tool_name":"Bash","tool_input":{"command":"git stash pop"},"agent_id":"probe"}' | bun plugins/keeper/plugin/hooks/branch-guard.ts` — live deny-envelope smoke
- `bun cli/prompt.ts render-plugin-templates --project-root . && keeper prompt check-generated` — template→generated parity
- `bun scripts/lint-claude-md.ts` — CLAUDE.md size gate

## Acceptance

- [ ] A subagent Bash command containing any mutating `git stash` form (bare, flag-only, wrapped, compound, and verbs unknown today) is denied via the PreToolUse envelope; list/show/create and all non-agent stash use stay allowed
- [ ] The deny reason names the shared-stash hazard and the sanctioned alternatives
- [ ] Every guard-narrating prose surface (worker guidance templates + generated outputs, CLAUDE.md hook rules, consistency surfaces) states the worker stash ban, with all lint/parity/consistency gates green

## Early proof point

Task that proves the approach: ordinal 1 (the stash rule inside
isBranchMutatingInvocation plus the case-table). If the allowlist polarity
fights the existing dispatch shape, model stash as a sibling predicate the
command scanner also consults instead of a branch inside the same function.

## References

- Incident: fn-1106 concurrent workers (.1/.4/.6) interleaved stash push/pop across the epic's linked worktrees; task .6's tree received sibling files from an errant pop; recovery commits 601157c6 / 5516973a; keeper.db sessions 1b9ba145 / 01a477df / 52df2ed1.
- git-stash(1), git 2.50: bare `git stash` == `git stash push`; verbs export/import exist; `create` writes no ref, `store` writes refs/stash. git-worktree(1): refs/stash is a shared ref — no per-worktree stash mechanism exists.
- `fn-1106-keeper-domain-knowledge-layer` (overlap) — its in-progress task .7 prunes CLAUDE.md whole-file; this epic's CLAUDE.md clause lands after it (epic dep), re-measure the byte budget then.
- `fn-1114-shared-checkout-mid-merge-wedge-recovery` (reverse-dep-adjacent context only) — sibling incident family (daemon mid-merge wedge); no file overlap with this epic.

## Docs gaps

- **plugins/plan/CLAUDE.md**: extend the branch-guard sentence with the stash denial (tracked in task 2)
- **plugins/keeper/hooks/hooks.json**: description field names branch+stash guarding (tracked in task 2)

## Best practices

- **Allowlist, never a deny-list:** git 2.50 added stash export/import; deny-by-default covers every future verb for free [git-stash(1)]
- **Resolve the verb before classifying flags:** bare `git stash` and `git stash <flags>` are push; `-p` means push under bare stash but is a diff flag under show — verb-first classification, never substring matching [git-stash(1); backslash.security denylist-delusion]
- **Deny on the touches-shared-stack axis, not writes-refs:** `apply` writes no ref yet materializes another tree's files — exactly the incident shape; keep the rationale in a comment
- **Fail-open and deny-by-default are orthogonal:** unparseable command → allow (hook contract); cleanly-parsed stash with a non-allowlisted verb → deny
- **Alias-laundering is an accepted gap:** a dep-free hook cannot resolve `[alias] st = stash`; the prose ban is the backstop [git alias semantics]
