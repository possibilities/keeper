## Overview

The fn-906 rename swept the binary, package, env gate, state dir, and prose,
but missed the plan CLI's own user-facing output: the `PROG` constant and the
error strings still emit the retired `planctl` name in usage, --help, and
"no project found" messages. This sweep finishes the rename so the human
never sees a command name that no longer matches how the CLI is invoked.

## Acceptance

- [ ] No user-facing CLI output (usage, --help, error strings) names the
      retired `planctl` command.
- [ ] Existing guard/CLI test suites stay green with the substituted strings.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | cli.ts:74 PROG=planctl flows into USAGE (:75) and try-help (:754,:761) — user sees a retired command name in usage/help/error output. |
| F2 | merged-into-F1 | .1 | F2 (project.ts:79,186 'No planctl project found' strings) shares F1's root cause and lands as one commit with F1. |
| F3 | culled | — | Dev-only transitive @types/node/undici-types lockfile bump already shipped; no user impact, reverting is churn not value. |

## Out of scope

- The transitive @types/node / undici-types lockfile bump (F3) — already merged, dev-type-only, not reverted.
- Frozen Planctl-* trailer literals and historical migration comments — deliberately preserved per fn-906's anti-clobber discipline.
