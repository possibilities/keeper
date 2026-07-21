## Description

Extend coverage and docs for the private-worktree integration landed by task 1:

- Test matrix over the deferred-ff and edge paths: dirty-tracked-only,
  untracked-only, off-default-branch shared checkout, racing origin (push
  retry), conflict inside the scratch worktree, gate-red inside the scratch
  worktree — via the pure seams in plugins/plan/test/saga-close-finalize.test.ts.
- Update docs/problem-codes.md for the retired any-dirt
  TRUNK_INTEGRATION_DIRTY semantics and the new deferred-ff code; sweep the
  close skill prose (plugins/plan/skills/close/) for statements that the
  shared checkout must be clean to land; align CONTEXT.md's trunk-lease
  vocabulary if fn-1386 introduced an entry.
- Cross-link ADR 0102 from the touched doc sections where rationale is named.

Files: plugins/plan/test/saga-close-finalize.test.ts, docs/problem-codes.md,
plugins/plan/skills/close/, CONTEXT.md.

## Acceptance

- [ ] Each listed edge path has a deterministic in-process test.
- [ ] docs/problem-codes.md reflects the new outcome semantics.
- [ ] Close-skill prose no longer requires a clean shared checkout for landing.
- [ ] Docs state current behavior only (no history narration outside ADR).

## Done summary
Split the deferred-ff dirt test into dirty-tracked-only and untracked-only cases, clarified the racing-origin CAS-retry test, documented the TRUNK_* problem codes, and corrected the close skill's stale clean-checkout prose.
## Evidence
