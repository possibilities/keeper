## Description

**Size:** M
**Files:** plugins/plan/template/agents/merge-resolver.md.tmpl, plugins/plan/template/agents/deconflicter.md.tmpl, plugins/plan/template/agents/unblocker.md.tmpl, plugins/plan/template/agents/repairer.md.tmpl, plugins/plan/prompt-artifacts.yaml, plugins/plan/agents/, docs/examples/matrix.example.yaml, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json, plugins/prompt/test/oracle/fixtures/check-generated.json

### Approach

Author four static agent templates porting the capability contracts: merge-resolver (tier-1 mechanical fan-in resolution — re-runs the failed merge in its cwd, resolves only mechanically-clear conflicts, declines to the deconflicter on anything needing judgment; sourced from the daemon's inline resolver brief builders), deconflicter (tier-2 judgment merge reconciliation with real edits), unblocker (blocked-task diagnosis and board-verb resolution, no source writes), repairer (granted trunk fix: reproduce at HEAD, land a gated fix or green no-op via keeper commit-work). Shared contract across all four: frontmatter disallowedTools per role (all deny Task; unblocker additionally denies Edit/Write), incident input arrives as a data-delimited prompt section plus a brief_ref the agent may read via the read-only escalation-brief CLI, output is exactly one typed receipt line — resolved | declined_clean | declined_residue | stale_base — plus a bounded reason, and receipts never carry instructions. Wire each into prompt-artifacts.yaml roles with static binding and membership in the work and close bundles, add example agent_pins rows to the example matrix, render, and re-capture both golden fixtures.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/prompt-artifacts.yaml — roles/bundles schema and how the eleven existing static agents register
- plugins/plan/template/agents/ — frontmatter + body conventions of existing agent templates (pins, color, disallowedTools)
- src/daemon.ts:3710 and :3813 — buildResolverBrief / buildWorkResolverBrief, the tier-1 contract being ported (close-scoped and work-scoped variants)
- plugins/plan/skills/deconflict/SKILL.md, unblock/SKILL.md, repair/SKILL.md — the tier-2/diagnosis/repair contracts being ported
- cli/escalation-brief.ts — the read-only envelope shape agents may consume

**Optional** (reference as needed):
- plugins/prompt/test/oracle/capture.ts — how goldens re-capture
- docs/plugin-composition-map.md — bundle-to-skill composition background

### Risks

- agent_pins live in the host-generated gitignored matrix — the rendered agents must tolerate an absent pin (falling back to render defaults) rather than failing the render
- Porting the resolver brief too literally would keep close-scoped assumptions; the agent must stay scope-neutral (works in a lane or a base checkout, told only its cwd and incident)

### Test notes

`keeper prompt render-plugin-templates --project-root plugins/plan` then `--check` clean; re-capture and commit both golden fixtures; no unit suite beyond the render/golden gates.

## Acceptance

- [ ] Four managed escalation agents render from templates, each with role-appropriate disallowedTools, no Task access, a data-delimited incident input contract, and the four-value typed receipt as its sole output contract
- [ ] prompt-artifacts.yaml registers all four roles and both work and close bundles include them
- [ ] The example matrix documents agent_pins rows for all four and rendering succeeds with pins absent
- [ ] Render check and both golden fixtures are green

## Done summary

## Evidence
