## Description

**Size:** M
**Files:** plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md

### Approach

Rewrite the work skill's per-task audit gate so the orchestrator handles only typed envelopes and refs. The idempotency step calls the gate-check verb and switches on its envelope — the finding artifact is never opened: a covering clean/mild routes to unblock-resume; a covering severe escalates directly with no second refute (the persisted verdict stands — the refute-once budget is not re-derivable across crashes); not-covering runs the audit. The audit spawn uses the auditor's task mode, which persists its own findings and returns the one-liner the orchestrator parses (finding_ref, status, findings count) — the orchestrator Write step is deleted. The severe path blocks with the ref-based reason `AUDIT_SEVERE: finding_ref=<path>` (the daemon escalation producer parses the category prefix only), and the refute directive passes finding_ref for the auditor to re-read — no finding prose ever crosses into the orchestrator. An empty derivable commit set at the gate mirrors the worker's empty-diff exception: unblock-resume, nothing to audit. Prune frontmatter tools the skill no longer needs (Write existed only for the artifact relay; drop Read too if no remaining step uses it).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/template/skills/work.md.tmpl — Phase 2d as-is (the four steps) plus the allowed-tools frontmatter.
- The gate-check and submit-task envelopes from the verbs task — the exact fields the switch reads.
- plugins/plan/skills/close/SKILL.md — the one-line agent-return parse pattern (report_ref, risk, findings) this mirrors.

**Optional** (reference as needed):
- plugins/plan/template/agents/worker.md.tmpl:120-132 — the AUDIT_READY park and empty-diff exception the gate pairs with.

### Risks

- The AUDIT_READY reason format stays worker-owned; the gate must never depend on parsing anything after the category token.
- A stale rendered SKILL.md fails the generated-file guard — re-render.

### Test notes

Re-render plus bun test; grep the rendered skill: no Read of the per-task finding path, no orchestrator Write in the audit gate.

## Acceptance

- [ ] The work skill's audit gate consumes only the gate-check envelope and the auditor's one-line return; no step opens or writes the finding artifact.
- [ ] Resume behavior is explicit: a covering severe artifact escalates directly with no second refute; covering clean/mild unblock-resumes; an empty commit set unblock-resumes.
- [ ] The severe block reason is the ref-based AUDIT_SEVERE form and the refute directive carries finding_ref only.
- [ ] The frontmatter lists only tools the skill still uses; the rendered file matches its template; consistency suites are green.

## Done summary
Rewrote /plan:work's Phase 2d audit gate to consume only the gate-check envelope and the auditor's task-mode one-line return; deleted the orchestrator's finding-artifact Write; covering-severe short-circuits with no second refute, a freshly-derived severe gets one refute pass, and an empty commit set unblock-resumes. Dropped Read/Write from allowed-tools.
## Evidence
