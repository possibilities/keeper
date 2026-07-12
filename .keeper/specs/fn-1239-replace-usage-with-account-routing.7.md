## Description

**Size:** S
**Files:** README.md, docs/install.md, CONTEXT.md, CLAUDE.md, docs/plan-name-retirement.md, plugins/keeper/skills/query/SKILL.md, plugins/keeper/skills/autopilot/SKILL.md

### Approach

Make forward-facing documentation describe only the surviving wrapper-based account-routing system. Prune the Usage-model registry and `agentusage` glossary entries, profile-directory guard, usage/query/operator instructions, and installation steps; retain ADR 0038 as the sole rationale/history record.

Document the optional capability matrix, exact public commands, PII-free diagnostics, independent start/resume/restore selection, continuous headroom policy, install-time settings seed with local evolution, and clean-break archive. The archive procedure creates `~/archive/keeper-agent-usage/` at mode 0700, moves retired state without inspecting/importing credentials, aborts on collisions, and is explicitly outside Keeper's runtime.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- README.md:1 — lean project front door
- docs/install.md:14 — current `usage_models` and scraper setup
- CONTEXT.md:87 — current account-routing and usage-scraping glossary clusters
- CLAUDE.md:52 — current profile-directory name guard
- plugins/keeper/skills/query/SKILL.md:125 — usage/profiles collection list
- plugins/keeper/skills/autopilot/SKILL.md:1 — operator guidance that currently points to usage
- docs/adr/0038-external-capacity-and-per-launch-account-routing.md:1 — accepted rationale and vocabulary boundary

**Optional** (reference as needed):
- docs/plan-name-retirement.md:1 — launcher environment naming inventory
- /Users/mike/src/realiti4--claude-swap/README.md:112 — public session-mode and shared-history documentation
- /Volumes/Scratch/src/steipete--CodexBar/docs/cli.md:38 — public JSON usage documentation

### Risks

Documentation can accidentally imply CodexBar supplies managed claude-swap rows, that old profiles remain launchable, or that the archive is a credential migration. `CLAUDE.md` must only retain guardrails an agent could still violate, and `CONTEXT.md` must stay a compact pure glossary rather than narrating implementation/history.

### Test notes

Run domain-doc lint, CLAUDE.md lint, retired-name checks, command/help descriptor tests, and the full three-suite gate. Verify every documented command against current help; do not add a live CLI invocation to automated tests.

### Detailed phases

1. Prune retired front-door, install, glossary, guardrail, skill, and naming content.
2. Add the concise optional integration/fallback and archive operator procedure.
3. Run docs/name/descriptor gates and the full suite, deleting stale test references rather than preserving dead terminology.

### Alternatives

A compatibility page for `keeper usage` was rejected because the clean break has no legacy UI. Duplicating ADR rationale into README/install was rejected by Keeper's docs discipline.

### Non-functional targets

Keep README lean, CONTEXT within its line/sentence constraints, CLAUDE.md below its size cap, and every forward-facing statement present-tense. No doc exposes email, private paths, or credential contents.

### Rollout

Publish these docs with the retiring code, then perform the archive as an explicit post-deploy operator step. If the smoke check fails, disable routing and diagnose before moving any state.

## Acceptance

- [ ] README, installation docs, glossary, guardrails, skills, and naming inventory contain no live instruction for the retired usage/profile system.
- [ ] Documentation clearly distinguishes CodexBar's gate/ambient role from claude-swap's managed-account telemetry and execution role.
- [ ] Start, resume, and restore are documented as independently balanced with no account affinity.
- [ ] The private clean-break archive procedure is collision-safe, mode-restricted, and explicitly performs no credential import.
- [ ] Domain-doc, CLAUDE.md, retired-name, CLI descriptor, fast, and full-suite gates pass.

## Done summary
Pruned retired usage/profile guidance from README, CLAUDE.md, CONTEXT.md, docs/install.md, and docs/plan-name-retirement.md, and documented the surviving CodexBar+claude-swap account-routing system (keeper agent accounts check, independent per-launch selection, settings seeding, and the private clean-break archive procedure). ADR 0038 remains the sole rationale record. Note: plugins/prompt's parity golden-file test (panel-strength) fails pre-existing and unrelated to this task's files.
## Evidence
