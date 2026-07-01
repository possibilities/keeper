## Description

Remove the dead read-only-trailer residue left by the single-value read
contract change. F1 (evidence: plugins/plan/src/project.ts:302): the
exported `trailerProjectRoot()` helper has zero callers — the only two
references in the plugin are its own definition and a test comment — and
being exported, biome's unused-symbol lint will not flag it. Delete the
function and its docstring.

F2 (merged into F1; evidence: plugins/plan/test/saga-close-preflight.test.ts:410-415):
the test comment names `trailerProjectRoot` and narrates the removed
read-only-trailer mechanism ("the read-only trailer never re-resolves from
cwd into a missing-project error envelope"). F2 folds into F1 because
deleting the helper forces touching this comment. The test itself still
validly exercises verb-level `~`-form `--project` resolution, so keep the
test body and re-anchor the comment to the verb's own tilde handling — do
not reference the removed trailer.

## Acceptance

- [ ] `trailerProjectRoot()` and its docstring are deleted from plugins/plan/src/project.ts
- [ ] The saga-close-preflight.test.ts comment no longer names trailerProjectRoot or the read-only trailer; it describes the verb's own tilde `--project` handling in present tense
- [ ] `bun run typecheck` and `bun run lint` are green; `bun test` passes

## Done summary

## Evidence
