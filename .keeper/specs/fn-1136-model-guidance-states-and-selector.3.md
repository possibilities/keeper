## Description

**Size:** S
**Files:** plugins/plan/agents/close-planner.md, plugins/plan/test/consistency-skills.test.ts

### Approach

The follow-up template omits the required per-task `model:` field (scaffold rejects model_invalid with no default) and its tier enum omits `low` — a close-planner following the template literally burns its shared retry budget on rejects. Add the `model:` line in the existing "REQUIRED — scaffold errors ..._invalid if absent" comment style, widen the tier enum to the full configured axis (low|medium|high|xhigh|max), and update the task-spec rules prose to require BOTH tier and model. State, forward-facing, that the stamped cells are the mechanical default the close flow's selection beat overwrites. Add the missing consistency pin: no test currently asserts the template's tier/model shape — pin that the template block carries both fields and the full enums so axis drift trips the suite.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/agents/close-planner.md:163-194 — the template block and the task-spec rules prose
- plugins/plan/subagents.yaml:20-21 — the axis source of truth the enums must mirror
- plugins/plan/test/consistency-skills.test.ts — where the new pin lands; follow the existing prose-pin style

**Optional** (reference as needed):
- plugins/plan/src/verbs/scaffold.ts:426-447 — the tier/model validation the template must satisfy

### Risks

- Hard-coding the enums in the pin re-creates the drift problem — derive expected values from subagents.yaml in the test.

### Test notes

The new pin should fail if either field line disappears from the template or the enums drift from the configured axes.

## Acceptance

- [ ] The follow-up template emits per-task tier AND model with the full configured enums, and the rules prose requires both
- [ ] A consistency test pins the template's tier/model shape against the configured axes
- [ ] Fast suite green

## Done summary

## Evidence
