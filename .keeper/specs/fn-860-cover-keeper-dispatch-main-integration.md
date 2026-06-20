## Overview

The `keeper dispatch` command shipped with well-tested pure seams
(`resolvePlanCwd`, `checkRaceGuard`, `resolveSession`) but its `main()`
orchestration has zero integration coverage — the arg-parse gate, the
free-form prompt-file/byte-validation wiring, and the dry-run/launch-result
branches are entirely unexercised. This follow-up adds a `main()`-level test
pass so the new command's user-facing contract (mode mutual-exclusion exit
codes, prompt-file error handling, dry-run output) has a regression net.

## Acceptance

- [ ] `main()` is driven end-to-end in tests covering the exit-2 arg-fault
      branches, the free-form prompt-file/validate paths, and the dry-run /
      launch-result branches.
- [ ] The launch seam (`ensureLaunched` via `resolveExecBackend`) is
      injectable so a launch-path test runs without a real tmux backend.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | cli/dispatch.ts:194 paused strict-equality is theoretical; the projection column is a real bool/int, no current impact |
| F2 | culled | — | cli/dispatch.ts:377 empty --prompt is a harmless, arguably-intentional no-op for a manual hatch |
| F3 | culled | — | cli/dispatch.ts:401-407 dry-run column alignment is pure cosmetic polish |
| F4 | culled | — | cli/dispatch.ts:389 resolveSession ordering is a non-issue; the report itself says no change needed |
| F5 | kept | .1 | cli/dispatch.ts:308-325 main() arg-fault exit-2 branches have zero integration coverage |
| F6 | merged-into-F5 | .1 | F6 (prompt-file/validatePromptBytes integration) shares F5's root: main() has no integration coverage |
| F7 | merged-into-F5 | .1 | F7 (dry-run/launch-result branches) folds into F5: same main() coverage hole, same test file |

## Out of scope

- The four culled Consider items (F1-F4): theoretical/cosmetic, left as-is per cull discipline.
- Any behavior change to `keeper dispatch` — this is test-coverage only.
