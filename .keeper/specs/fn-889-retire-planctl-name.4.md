## Description

**Size:** S
**Files:** docs/planctl-strip.md, plugins/plan/README.md, plugins/plan/CLAUDE.md, plugins/plan/skills/**/*.md, plugins/plan/template/**/*.tmpl, README.md

### Approach

Sweep the markdown/prose the AST codemod doesn't cover (forward-facing only — no "renamed from planctl" tombstones). Rename `docs/planctl-strip.md` → `docs/plan-name-retirement.md` and rewrite it as a CLOSED note (state the end reality: trailer strings + schema-history literals permanently grandfathered; everything else retired) — its filename is itself a living planctl reference, and it must reflect shipped reality not the stale roadmap. Update plugins/plan/README.md + CLAUDE.md (intro, `.keeper/` not `.planctl/`, drop the vestigial planctl-bun "Bun cutover runbook", `planctl_invocation`→`plan_invocation` prose, the env-var notes), the plan skills + work.md.tmpl/worker.md.tmpl, and the keeper README `file_attributions` badge comments (drop the legacy `'planctl'` value once `.3` narrows the CHECK). KEEP literal `Planctl-*` trailer references where docs document the wire format.

### Investigation targets

**Required:**
- docs/planctl-strip.md (the whole doc — retire it)
- plugins/plan/README.md, plugins/plan/CLAUDE.md (heaviest prose)
- plugins/plan/skills/{plan,work,close,next,defer,hack}/SKILL.md + template/{skills/work,agents/worker}.md.tmpl
- README.md (file_attributions badge CHECK comments)

### Risks

- Keep the grandfathered trailer literals in any doc that documents the trailer wire format.
- work.md.tmpl mirrors skills/work/SKILL.md — update both to avoid divergence.

### Test notes

Grep done-gate over docs returns only allowlisted trailer-literal references.

## Acceptance

- [ ] docs/planctl-strip.md renamed to plan-name-retirement.md and rewritten as a closed forward-facing note
- [ ] plan README/CLAUDE.md/skills/templates swept to keeper plan/.keeper; vestigial binary runbook removed
- [ ] README badge comments updated; trailer-wire-format doc refs preserved
- [ ] no planctl prose residue outside the allowlist

## Done summary
Swept the planctl name from prose/skills/templates: renamed docs/planctl-strip.md to docs/plan-name-retirement.md as a closed note, swept plan README/CLAUDE.md/skills/templates to keeper plan/.keeper, dropped the vestigial binary runbook, updated keeper README badge prose to the 'plan' source value, and preserved the grandfathered Planctl-* trailer-wire refs.
## Evidence
