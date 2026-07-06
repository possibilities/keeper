## Description

**Size:** M
**Files:** plugins/plan/src/validation_restamp.ts, plugins/plan/src/verbs/epic_add_deps.ts, plugins/plan/src/verbs/refine_apply.ts, plugins/plan/src/verbs/mv_repo.ts, plugins/plan/src/verbs/assign_cells.ts, plugins/plan/src/verbs/task_reset.ts, plugins/plan/src/verbs/task_set_section.ts, plugins/plan/src/verbs/task_set_target_repo.ts, plugins/plan/src/verbs/epic_set_repos.ts, plugins/plan/src/verbs/epic_dep_edit.ts, plugins/plan/test/verbs-restamp.test.ts, plugins/plan/test/src-integrity.test.ts, plugins/plan/test/saga-scaffold.test.ts, plugins/plan/test/worktree-block-state.test.ts, plugins/plan/test/fixtures/restamp-harness.ts, plugins/plan/CLAUDE.md, plugins/plan/README.md, plugins/plan/skills/plan/SKILL.md

### Approach

The `last_validated_at` marker becomes a strict one-way latch with exactly
three writer classes: `armEpicValidated` (the `validate --epic` arm) is the
ONLY null->timestamp writer; `epic invalidate` and `refine-context
--invalidate` remain the only timestamp->null writers; and NOTHING else
touches the field. The 12 verbs in `VALIDATION_RESTAMP_VERBS` keep their
post-write integrity gate exactly as-is (assert-all, fail-forward,
`process.exit(1)`, the add-dep rollback hook) but stop reading or writing
the marker entirely: the gate function no longer returns a stamp (void),
and every caller drops its `last_validated_at = newStamp` write while
keeping its `updated_at` bump unchanged (including `runSetter`'s
`stampUpdatedAt` opt-out contract). This closes the arming race — a ghost
epic stays a ghost through any verb interleaving until the trailing
validate arms it — AND removes the read-then-write clobber vector, since no
second marker writer exists to race the arm/invalidate paths.

Names must state the new behavior: rename the constant, function, and file
away from "restamp" (e.g. `INTEGRITY_GATE_VERBS`, a gate-named function,
`integrity_gate.ts`) and update all importers and the test harness; prune
the stale "byte-parity port of planctl/validation_restamp.py" / "Mirrors
restamp_epic_or_fail" provenance comments (no Python twin exists). Rewrite
the three drifted doc surfaces to the latch contract: the plugins/plan
CLAUDE.md "Validation marker" paragraph (also fixing its stale "11 verbs"
count — the list has 12; keep the canonical-list-do-not-duplicate
discipline), the README assign-cells blurb ("then re-stamps
`last_validated_at`" is now false) plus its validate section (state arm
exclusivity), and the skills/plan/SKILL.md Phase 7 rationale that narrates
add-deps arming (hand-authored file, no template sidecar — edit direct).
All prose stays forward-facing: state the latch as current behavior, no
incident narration outside the commit message. The decision record already
exists at docs/adr/0006-validation-marker-arm-exclusive-latch.md — do not
restate rationale in comments.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/validation_restamp.ts:98-296 — the gate function + `runSetter` spine; the marker read at :110 and stamp-write at :291-296 both disappear
- plugins/plan/src/verbs/validate.ts:78-119 — `armEpicValidated`, the sole arm seam (unchanged; confirm no new caller appears)
- plugins/plan/src/verbs/epic_add_deps.ts:237-240, refine_apply.ts:768-779, mv_repo.ts:161-165, assign_cells.ts:401-405 — the four direct call sites whose marker writes drop
- plugins/plan/test/fixtures/restamp-harness.ts — spawned-child harness (failure path is `process.exit(1)`); scenarios setter-clean / setter-fail-forward / add-dep-cycle / set-target-repo; add a ghost-preservation scenario
- plugins/plan/test/verbs-restamp.test.ts:64 — `stampMarker` fixture seam for seeding a non-null marker

**Optional** (reference as needed):
- plugins/plan/src/verbs/epic_short_circuit.ts:48 and refine_context.ts:149-183 — the two sanctioned null-writers (unchanged latch counterparties)
- src/board-render.ts:327-343 — the daemon-side null-vs-set predicate proving marker recency has no consumer
- plugins/plan/test/src-integrity.test.ts:292-387 — pins the 12-member list and a fail-forward "NOT re-stamped" postcondition the rename must rework

### Risks

- A flow or script whose LAST mutation is a gate verb with no trailing validate would strand a visible dashed ghost — verified absent (plan Phase 7, defer Phase 4, close-finalize all arm), but re-grep skills/ and template/ after the change to be sure.
- The rename ripples through importers and fixtures; a missed importer is a typecheck error, a missed doc reference is silent drift — grep restamp/RESTAMP case-insensitively across plugins/plan and repo-level docs afterward.
- Tests that seed a null marker then assert a frozen stamp encode the OLD arming behavior and must flip to assert null-preserved — do not "fix" them by seeding non-null and keeping the stamp assertion, which would silently drop ghost coverage.

### Test notes

Fast suite only (`cd plugins/plan && bun test`), zero real git. Flip the
encode-the-bug cases (verbs-restamp.test.ts:115,131,145,198,241,284,342,530;
src-integrity.test.ts:357,440; worktree-block-state.test.ts:205 — re-verify
each seed). Add: (1) the headline regression — a gate verb on a ghost with
`depends_on_epics: []` leaves the marker null; (2) armed-epic byte-identical
marker after a gate verb (seed via `stampMarker`, assert the exact prior
value, not just non-null); (3) idempotent arm — `validate --epic` twice
yields exactly one null->timestamp transition; (4) a mixed mv-repo batch
(armed + ghost epics) preserves each independently; (5) a ghost-preservation
harness scenario. Preserve the already-correct null cases (scaffold mints
null; invalidate paths; fail-forward null-stays-null). If SKILL.md is
touched, run `bun scripts/vendor-corpus.ts --check` from the repo root to
confirm no BAKE-guard drift.

## Acceptance

- [ ] Every verb in the post-write integrity-gate set, run on a ghost epic, leaves `last_validated_at` null (the epic stays a blocked ghost) while its structural write lands and the integrity gate still fail-forwards with exit 1 on violation
- [ ] The same verbs on an armed epic leave the marker byte-identical to its prior value; `updated_at` bumps exactly where it did before
- [ ] The only null->timestamp path is the `validate --epic` arm, idempotent across repeated runs; the only timestamp->null paths remain `epic invalidate` and `refine-context --invalidate`
- [ ] The incident interleaving is pinned by a regression test: a select-window cell write on a dep-less ghost leaves it a ghost, and only the trailing validate arms it
- [ ] No source, test, or doc surface still names the gate "restamp" or claims mutation verbs stamp the marker; the plugins/plan CLAUDE.md paragraph states the latch contract with the correct verb count
- [ ] `cd plugins/plan && bun test`, `bun run lint`, and `bun run typecheck` all pass

## Done summary

## Evidence
