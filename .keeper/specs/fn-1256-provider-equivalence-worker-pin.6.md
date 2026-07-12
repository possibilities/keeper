## Description

**Size:** M
**Files:** plugins/plan/src/verbs/selection_audit_brief.ts, plugins/plan/skills/cell-review/SKILL.md, plugins/plan/README.md, plugins/plan/test/saga-selection-audit-brief.test.ts

### Approach

Make selection research grade the cell that actually ran. The selection-audit brief today
reads only the sidecar's assigned cell; teach it to additionally read the task's runtime
dispatched_* keys (via the merged task state) and emit, per task, the assigned cell, the
dispatched cell, and the constraint — bumping SELECTION_AUDIT_BRIEF_SCHEMA_VERSION. Absent
runtime keys ⇒ dispatched == assigned (one fallback rule covers pre-feature briefs and
unconstrained runs). Update the cell-review skill: the auditor grades the DISPATCHED cell;
selector-policy cohort aggregation (config_hash cohort rates and any guidance proposals)
EXCLUDES constrained runs — their verdicts are evidence about the equivalence map, and the
skill's report surfaces them in a separate constrained-runs section addressed to
/model-guidance. Cohorting stays keyed on the assigned cell's config_hash. Update the README
selection coverage to state the assigned→dispatched distinction.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/selection_audit_brief.ts:244-312 — sidecar cellByTask, auditableTasks record, SELECTION_AUDIT_BRIEF_SCHEMA_VERSION
- plugins/plan/skills/cell-review/SKILL.md — the grading flow, cohort computation, rubric/version stamping, --force re-grade rules
- plugins/plan/src/models.ts mergeTaskState + the dispatched_* runtime keys (task .5)

**Optional** (reference as needed):
- plugins/plan/src/verbs/selection_review_submit.ts — verdict stamping (rubric_version/judge_model_version/prompt_hash) if the constraint needs a stamp
- plugins/plan/src/selection_sidecar.ts:40 — SidecarCell shape (unchanged; assigned stays sidecar-sourced)

### Risks

- Schema-version bump interacts with the committed-briefs-minus-reviews watermark — a version change must not orphan pre-feature briefs; the fallback rule keeps them gradable
- Keep the blinding intact: the auditor stays blind to selector confidence/rationale; the constraint field is execution fact, not selector signal

### Test notes

Brief tests: constrained task emits both cells + constraint; unconstrained and pre-feature
tasks emit dispatched == assigned; schema version asserted. Skill-doc consistency tests per
the plan suite.

## Acceptance

- [ ] The brief emits assigned cell, dispatched cell, and constraint per task with the documented fallback, under a bumped schema version
- [ ] The cell-review skill grades the dispatched cell and excludes constrained runs from selector-policy cohort aggregation, routing their findings to a constrained-runs report section
- [ ] plugins/plan/README.md states the assigned→dispatched distinction in the selection coverage
- [ ] Plan fast suite green

## Done summary
selection-audit-brief now emits assigned + dispatched cells + constraint (schema v2, fallback dispatched==assigned); cell-review skill grades the dispatched cell and excludes constrained runs from cohort aggregation, routing them to a constrained-runs section for /model-guidance; README documents the distinction.
## Evidence
