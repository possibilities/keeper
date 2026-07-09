## Description

Source finding: F2 (audit of fn-1206). Evidence path: `model-guidance-check.ts`
invariant (b) hashes `plugins/plan/skills/model-guidance/references/*.md`
against the sha256s recorded in `plugins/plan/model-selector.yaml`
(`reference:` entries resolve to `skills/model-guidance/references/{opus,sonnet}.md`),
but `isModelGuidancePath` in `src/commit-work/lint-matrix.ts` (predicate near
line 122) matches only `plugins/plan/model-selector.yaml` and
`plugins/plan/subagents.yaml`. A references-only staged edit — the exact hash
drift invariant (b) exists to catch — does not fire arm 13.

Files:
- `src/commit-work/lint-matrix.ts` — extend `isModelGuidancePath` to also
  match `path.startsWith("plugins/plan/skills/model-guidance/references/")`.
- `test/lint-matrix.test.ts` — add a trigger-predicate assertion (positive +
  negative) that a references cache path fires arm 13 and unrelated paths do
  not, in-process via the existing `deps.runTool` seam.

Keep the change scoped to the predicate; do not touch arm 13's dispatch,
aggregation, or the zero-cost `stagedFiles.some(predicate)` gating.

## Acceptance

- [ ] `isModelGuidancePath` returns true for a `plugins/plan/skills/model-guidance/references/*.md` path
- [ ] arm 13 fires on a references-only staged set and stays silent when nothing in its trigger set is staged
- [ ] New predicate test passes in the fast in-process suite (no subprocess boot)

## Done summary

## Evidence
