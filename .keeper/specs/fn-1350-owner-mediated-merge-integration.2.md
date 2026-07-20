## Description

**Size:** M
**Files:** src/autopilot-worker.ts, plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json, plugins/prompt/test/oracle/fixtures/check-generated.json, test/daemon.test.ts

### Approach

Provision stops performing pairwise fan-in pre-merges: it provisions the lane on its bare base, records the pending sibling integration as an incident-shaped manifest on the task's dispatch surface, and keeps its existing dirt attribution (the provably-redundant-leak cleaning stays producer-side — only the merges move). The work skill gains an integrate phase ahead of worker spawn: when the claim envelope carries a fan-in incident, the orchestrator claims it (exclusion lock), spawns plan:merge-resolver with the delimited incident, escalates a declined receipt to plan:deconflicter, and acts on the typed outcome — resolved releases the claim and proceeds to the worker; declined_clean releases and surfaces (the owner-router owns re-dispatch policy); declined_residue quarantines as a new incident with the wedge metadata, abort attempted only by the granted agent under the existing sole-owned carve-outs; stale_base releases and re-pulls a fresh envelope. One integrate round per dispatch; receipts are delimited data.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/autopilot-worker.ts:5688-5759 — the provision pre-merge loop being removed (verify current position; the WorktreeDriver methods live around :1042-1194 in the current tree — reconcile both refs on read)
- src/autopilot-worker.ts — liveAttributedDirty attribution inside provision, which must survive the merge removal intact
- plugins/plan/template/skills/work.md.tmpl — where the new integrate phase lands relative to claim and worker spawn
- The lane pre-merge guard and its self-clearing rows — the adjacent machinery whose semantics must not shift

**Optional** (reference as needed):
- src/daemon.ts:3813 — the work-scoped resolver brief whose content the agent port already carries

### Risks

- The half-assembled-base hazard moves here: a lane whose fan-in never completed must be unable to reach finalize as if assembled — the pending-integration manifest must be visible to the finalize gate, not just to the skill
- Removing pre-merges changes provision timing for every worktree dispatch, conflict or none — the no-incident path must remain byte-equivalent apart from merge absence

### Test notes

In-process driver tests: provision leaves siblings unmerged and mints the manifest; claim-integrate-release round-trip on a synthetic conflict; each receipt value drives the specified transition; no-sibling dispatches unchanged. Render + goldens re-captured.

## Acceptance

- [ ] Provision performs no fan-in merges and records pending integration visibly; dirt attribution behavior is unchanged
- [ ] A work session integrates its fan-in under a claim and resolves or terminally surfaces conflicts via typed receipts without any escalation session
- [ ] A lane with incomplete fan-in cannot present as assembled to downstream finalize logic
- [ ] Driver, skill render, and golden suites green via named gates

## Done summary
Provision no longer pre-merges fan-in siblings; it records a pending-integration manifest that blocks finalize from treating the base as assembled. The work skill gains an integrate phase that claims the incident and runs merge-resolver/deconflicter in-session on typed receipts, releasing on resolved/declined/stale outcomes. Driver, daemon, reducer, refold, and template-render suites are green.
## Evidence
