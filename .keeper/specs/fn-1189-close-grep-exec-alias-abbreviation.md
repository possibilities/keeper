## Overview

A confirmed arbitrary-program-execution bypass survives the diagnosis-role
escalation guard: git parse-options accepts any unambiguous prefix of
`--open-files-in-pager` (`--open`, `--open-f`, ...) as the same exec alias,
and `gitReadSubcommandExecFlag` matches only the exact literal plus a
single-dash `-O` cluster regex. So `git grep --open=<cmd>` runs `<cmd>` from
a read-only diagnosis session — the precise breach this fail-closed guard
exists to prevent. This closes that remaining exec vector.

## Acceptance

- [ ] `gitReadSubcommandExecFlag` denies every unambiguous `--open-files-in-pager`
      prefix down to `--open`, in both `--flag=<cmd>` and space-separated forms
- [ ] The guard still fails closed (no new under-block) and benign read args
      (diff/log `-O` order files, plain grep patterns) still pass
- [ ] Deny-case tests cover `git grep --open=/tmp/evil` and `--open-files=/tmp/evil`

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Live-confirmed `git grep --open=<cmd>` executes the caller command; exact-literal long-form check and single-dash `-O` regex both miss `--open` prefixes at escalation-guard.ts:503-510. |
| F2 | culled | — | Fail-safe over-block on rare glued `-eOpenDb`/`-fOfile` with a trivial `-e OpenDb` workaround; advisory usability + comment-accuracy nit below the keep bar. |

## Out of scope

- The Axis-2 regex over-block on glued `-eOpenDb`/`-fOfile` (culled: fails safe, trivial workaround)
- The `--open-files-in-pager` doc-comment "over-blocks nothing" accuracy quibble (culled with F2)
