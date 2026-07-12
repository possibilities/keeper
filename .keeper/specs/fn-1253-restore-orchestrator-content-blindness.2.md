## Description

**Size:** M
**Files:** plugins/plan/template/agents/quality-auditor.md.tmpl, plugins/plan/agents/quality-auditor.md, plugins/plan/skills/close/SKILL.md

### Approach

The quality-auditor becomes the sole reader of the audit depth band and gains a documented task-scoped mode. Epic mode: the agent resolves depth.band from the brief it already opens — a structural field lookup clamped to lean/standard/deep with a lean floor on missing/unrecognized — and keeps echoing the resolved band in its report meta so the close-planner can vet it against the brief's own field. /plan:close stops carrying the band: Phase 1 loses the brief-Read pin step entirely and the Phase 2 spawn prompt drops the DEPTH_BAND line, so the closer passes exactly EPIC_ID, PRIMARY_REPO, BRIEF_REF and is back to pure envelope-and-paths coordination. Task mode (discriminant: TASK_ID present in the spawn config): no brief, implicitly lean, reviews exactly the given commit set, persists its own findings via the task-scoped submit verb, and returns the content-free one-liner `finding_ref=<path> status=<clean|mild|severe> findings=<N>` — it never runs the epic-scoped audit submit, so a spec-following task-mode auditor cannot clobber the epic report. The close skill is hand-edited (no template); the auditor is template-rendered — edit the tmpl and re-render.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/template/agents/quality-auditor.md.tmpl — the current single-contract spec: config inputs, depth-governed dimensions, report-meta echo, fingerprint dedup.
- plugins/plan/skills/close/SKILL.md:40 (the pin step) and :50-61 (the spawn prompt) — the two deletions.
- plugins/plan/src/verbs/close_preflight.ts:420-453 — the brief.depth shape the agent self-reads (band plus degrade flags).

**Optional** (reference as needed):
- plugins/plan/test/consistency-skills.test.ts — structural invariants the rewritten template must satisfy.

### Risks

- Removing DEPTH_BAND from the closer while the agent still expects the config line silently degrades every close audit to lean — the template change and the skill edit must land together in this task.
- A rendered agents file that drifts from its template fails the generated-file guard — always re-render.

### Test notes

Re-render via keeper prompt render-plugin-templates; bun test consistency suites; grep the close skill for DEPTH_BAND expecting zero hits.

## Acceptance

- [ ] The close skill contains no brief Read step and no DEPTH_BAND token; its auditor spawn prompt carries exactly EPIC_ID, PRIMARY_REPO, and BRIEF_REF.
- [ ] The auditor spec directs an epic-mode self-read of the brief's depth band, clamped to the enum with a lean floor, and still echoes the resolved band in report meta.
- [ ] The agent spec documents both modes with an explicit discriminant; task mode persists via the task-scoped submit verb, returns the content-free finding_ref one-liner, and never runs the epic-scoped audit submit.
- [ ] The rendered agent file matches its template and all consistency suites are green.

## Done summary
Moved the close audit's depth band from a closer-carried DEPTH_BAND spawn value to a quality-auditor self-read of the brief's depth.band field (lean-floor clamp), with the resolved band still echoed in report meta. Documented the auditor's task-scoped mode (TASK_ID discriminant) persisting via audit submit-task, and stripped the close SKILL.md's brief-Read pin step and DEPTH_BAND spawn line entirely.
## Evidence
