## Description

Three findings on the selection-sidecar provenance surface, landing as one
commit across plugins/plan/src/selection_sidecar.ts and
plugins/plan/test/saga-assign-cells.test.ts (plus the caller sites).

F1 (the spine — label_source drift): a real selection is tagged
inconsistently. The type doc `plugins/plan/src/selection_sidecar.ts:48` and
the header at line 8 say `heuristic-guided`, and the conformance suite
hardcodes it (`plugins/plan/test/saga-assign-cells.test.ts:74,210,363`), but
every runtime caller writes `selector-chosen` —
`plugins/plan/skills/plan/SKILL.md:620,638`,
`plugins/plan/skills/defer/SKILL.md:184,194`, and
`plugins/plan/README.md:63`. The verb captures the value verbatim
(`plugins/plan/src/verbs/assign_cells.ts` selection-block capture ~line 376),
so the tests pass on a fixture value production never writes. Pick ONE
canonical string for a real selection and apply it to the type doc, the test
fixtures, AND all three call sites + README so schema/tests/runtime agree.
Lean toward preserving the `heuristic-*` family symmetry (`heuristic-guided`
real vs `heuristic-default` degrade) unless there is a stronger reason for
`selector-chosen`; either way, all sites must land on the same string and a
test must assert the value a real runtime selection persists. Degrade rows
already agree on `heuristic-default` — leave them.

F3 (bundled — selection-block coverage): the guards `requireSelStr` /
`shuffle_seed` integer guard / `verdict_raw` guard at
`plugins/plan/src/verbs/assign_cells.ts:231-262` have zero negative-case
coverage (the suite tests only a non-string tier at test:359 and empty cells
at test:451). Add one or two `bad_yaml` cases over a malformed `selection:`
block (a missing/empty `harness`/`config_hash`/`outcome`, a non-integer
`shuffle_seed`, a non-string `verdict_raw`).

F4 (bundled — confidence coverage): `confidence` is typed `number | string |
null` (`plugins/plan/src/selection_sidecar.ts:47`) and accepted as either at
`assign_cells.ts:207-214`, but only the numeric `0.9` form is exercised
(`saga-assign-cells.test.ts:165,209`). Add a case that a string-valued
`confidence` round-trips opaque into the sidecar.

Files: plugins/plan/src/selection_sidecar.ts,
plugins/plan/test/saga-assign-cells.test.ts,
plugins/plan/skills/plan/SKILL.md, plugins/plan/skills/defer/SKILL.md,
plugins/plan/README.md.

## Acceptance

- [ ] One canonical real-selection `label_source` string across the type doc,
      the test fixtures, and all three runtime callers (plan/defer/README);
      degrade rows stay `heuristic-default`.
- [ ] A test asserts the `label_source` a real runtime selection persists.
- [ ] `bad_yaml` cases cover a malformed `selection:` block (bad `harness` /
      `shuffle_seed` / `verdict_raw`).
- [ ] A test asserts a string-valued `confidence` round-trips into the sidecar.
- [ ] `bun test` (plan fast suite) is green.

## Done summary
Reconciled selection-sidecar label_source to one canonical heuristic-guided string across the type doc, tests, and all three runtime callers (plan/defer/README); degrade rows stay heuristic-default. Added coverage for the malformed selection: block guards (bad_yaml) and a string-valued confidence round-trip.
## Evidence
