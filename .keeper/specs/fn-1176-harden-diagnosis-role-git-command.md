## Overview

The escalation-guard's diagnosis roles (`unblock`/`resolve`) are documented
as read-only, and the hook advertises that it blocks the arbitrary-exec / file-write
bypass class that survives `--dangerously-skip-permissions`. Two gaps in the
git classifier let a marked diagnosis session route around that guarantee: git
per-invocation config injection turns an allowlisted read subcommand into
arbitrary program execution, and the `branch` subcommand is treated as read-only
despite its delete/force/rename forms mutating refs. This is backstop hardening
of a security control, not a happy-path fix.

## Acceptance

- [ ] A diagnosis role can no longer execute an arbitrary program via a git
      `-c <exec-bearing-key>=<value>` config injection on an allowlisted read subcommand.
- [ ] A diagnosis role can no longer mutate refs via `git branch` delete/force/rename forms.
- [ ] The `evaluateEscalationCommand` truth table gains deny cases for both vectors.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | gitSubcommand skips `-c`+value uninspected and classifyExecutable allows any READONLY_GIT_SUBCOMMANDS sub, so `git -c core.fsmonitor=/interp status` runs arbitrary exec on the allowlist. |
| F2 | merged-into-F1 | .1 | F2 (`branch` on the read-only list lets a diagnosis role run `git branch -D/-f/-m`; branch-guard is inert without agent_id) shares F1's root cause and fix site, so it folds into F1's task. |
| F3 | culled | — | Refuted: a SHARED_BASE_BROKEN repo is a desired/boot-seeded gated root that GitRootDropped never drops; the null-row defer is the intentional self-healing transient, not a black hole. |
| F4 | culled | — | No functional impact (folds key on payload verb/id, never session_id); a telemetry-naming nitpick below the keep bar. |

## Out of scope

- Write-capable roles (`deconflict`/`repair`) — they get all of git by design; both gaps are diagnosis-role-specific.
- The repair-route defer/seed behavior (F3) and repair synthetic-event session_id naming (F4) — both culled, no follow-up.
