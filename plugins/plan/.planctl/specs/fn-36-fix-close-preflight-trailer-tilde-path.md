## Overview

The close-preflight conformance fix threaded the `--project` root through the
read-only trailer so a cwd-outside-the-project invocation no longer re-resolves
from cwd. But `trailerProjectRoot` and the verb disagree on what a valid
`--project` is: the trailer checks `isAbsolute` on the raw flag string while the
verb runs `expandUser()` first. A tilde-form `--project ~/proj` from a non-project
cwd is accepted by the verb yet returns `null` from the trailer, falling back to
`resolveProject`, which errors with a spurious missing-project message — the exact
path the fix was meant to close. This matters because the tilde recovery
invocation is documented (skills/close/SKILL.md) as the AMBIGUOUS_EPIC_ID re-run.

## Acceptance

- [ ] `trailerProjectRoot` and the close-preflight verb agree on tilde-form `--project` roots
- [ ] A tilde `--project` from a non-project cwd emits no spurious missing-project trailer error
- [ ] Regression test covers the tilde-path-from-outside-cwd case

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | project.ts:76 checks isAbsolute on the raw `--project` string while close_preflight.ts:104 runs expandUser first; tilde-from-outside-cwd falls through to resolveProject/emitError (project.ts:58-59), re-opening the spurious-missing-project path the fix targets. |
| F2 | merged-into-F1 | .1 | F2 (missing tilde `--project`-from-outside-cwd test in saga-close-preflight.test.ts) is the regression test that locks F1's fix; same root cause and commit, so F2 folds into F1. |

## Out of scope

- The broader pytest-to-bun translation and Python retirement shipped by the source epic — audit confirmed purely-subtractive and clean.
- Test-budget ratio (advisory only; by design for a suite-translation epic).
