## Description

**Size:** M
**Files:** agents/quality-auditor.md, agents/close-planner.md (new), agents/classifier.md (delete), skills/close/classifier/ (delete), tests/test_classifier_schema.py (delete), tests/fixtures/classifier/ (delete)

### Approach

Quality-auditor rewrite: config-only spawn contract (EPIC_ID + BRIEF_REF); reads the brief itself (commit_groups, snippet_context, task list — drop the Callers two-step-chain prose, the inline COMMIT_GROUPS input shape, and the Snippet-context prepend contract); keeps the recall-oriented audit strategy, untrusted-diff fences, and empty-commits short-circuit; ends by piping its report to `planctl audit submit <epic_id> --file - --findings N --risk <level>` via quoted heredoc and returning ONE LINE: `report_ref=<path> risk=<level> findings=<N>`. New close-planner agent (model: opus bare alias, high effort, disallowedTools Edit/Write/Task): reads brief + report by path, vets each finding (claim → evidence → kept/culled/merged with the leave-code-alone cull discipline, bar higher than the report), decides fatal, clusters survivors by type-of-work, derives the follow-up title (no source-epic id in title), authors the follow-up plan YAML (audit-decisions table schema rules, always-one-epic with split as rare exception, four-section task specs, tier required), pipes verdict JSON to `planctl verdict submit` and YAML to `planctl followup submit` with a self-correction budget of 3 on typed rejects, and returns a one-line summary (fatal?, kept/culled/merged counts, title, refs). Escape-hatch ladder BEFORE any question — (1) brief specs + done summaries, (2) full report, (3) git show the source commits, (4) mine originating sessions: `claudectl list-sessions --all` filtered to session-name `work::<task_id>`, then `claudectl show-session`; each rung degrades gracefully (claudectl absent / no session → next rung). Only a verdict-flipping question surviving all four rungs returns `QUESTION: <text>` (budget: one; emitted INSTEAD of submitting a verdict — nothing persisted before a QUESTION). Delete classifier.md, skills/close/classifier/ (README + schema.json), tests/test_classifier_schema.py, tests/fixtures/classifier/. No version-pinned model ids anywhere in the two agent files.

### Investigation targets

**Required** (read before coding):
- agents/quality-auditor.md — current spec (keep audit strategy + fences; replace I/O contract)
- agents/classifier.md + skills/close/SKILL.md Phases 6.2/6.3/8 — the cull discipline, tier-vet redundancy being merged, audit-decisions table rules, title rules the planner inherits
- template/agents/worker.md.tmpl — brief-reading + self-check pattern and BLOCKED taxonomy the planner's contract mirrors

**Optional** (reference as needed):
- tests/test_close_skill.py:35 — references the classifier schema path (rewritten in task 5; deletion here must not strand it — coordinate: leave the test file edits to task 5, delete only fixtures it no longer needs or stage the test change here if pytest would break)

### Risks

Deleting the classifier schema while tests/test_close_skill.py still imports its path breaks the suite mid-epic — sequence the deletion with a minimal same-commit test stub or fold that edit here. The planner prompt must keep the cull bar (leave-code-alone default) or follow-up epics inflate.

### Test notes

Suite must stay green post-deletion (`uv run pytest tests/ -q`). Agent files: grep no `claude-*-N-M` version pins; frontmatter parses; no Task tool for either agent.

## Acceptance

- [ ] quality-auditor is content-blind (BRIEF_REF read, audit submit persist, one-line return contract) with audit strategy + fences intact
- [ ] close-planner exists: vet/cull/merge + cluster/title + YAML authoring, submit self-correction (3), escape-hatch ladder with graceful degradation, QUESTION protocol (nothing persisted before QUESTION)
- [ ] classifier.md, skills/close/classifier/, test_classifier_schema.py, fixtures deleted; suite green
- [ ] No version-pinned model ids in either agent file

## Done summary
Rewrote quality-auditor content-blind (reads BRIEF_REF, persists via audit submit, one-line return) and added the close-planner agent (vet/cull/merge, cluster+title, verdict+followup submit with 3-retry self-correction, four-rung escape-hatch ladder, QUESTION protocol). Deleted classifier agent + skill subtree + schema test + fixtures and the stale wire-format test; suite green, no version-pinned model ids in either agent file.
## Evidence
