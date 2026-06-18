## Overview

The `keeper await` parse-error message enumerates the valid conditions but
omits the newly-shipped `started` condition. This is a small user-facing
correctness fix on the CLI error path: a human who typos near `started` (or
explores the CLI) gets an error that hides a valid condition.

## Acceptance

- [ ] The `unknown condition` parse error lists `started` among the valid conditions
- [ ] The enumeration stays consistent with `PLANCTL_CONDITIONS`

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | cli/await.ts:455 error string omits started, misleading a user who typos near a valid condition |
| F2 | culled | —  | cli/await.ts:3 header comment drift; comment-only remedy with no concealed constraint fails the cull bar |
| F3 | culled | —  | test for generic require-transition path (not new code); SKILL.md mitigation already shipped |
| F4 | culled | —  | multi-segment latching reuses tested planctl branch; theoretical coverage gap with no defect |

## Out of scope

- The file-header doc comment at cli/await.ts:3 (culled — pure comment drift)
- Added test coverage for require-transition and multi-segment latching (culled — pre-existing/reused tested paths)
