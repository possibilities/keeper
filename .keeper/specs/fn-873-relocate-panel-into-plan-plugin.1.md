## Description

**Size:** M
**Files:** plugins/plan/skills/panel/SKILL.md (new), plugins/plan/skills/panel/references/panel.md (new), plugins/plan/agents/panel-judge.md (new), plugins/plan/skills/hack/SKILL.md, docs/planctl-strip.md, plugins/plan/README.md, plugins/plan/CLAUDE.md

### Approach

Copy the panel skill + judge agent from arthack into keeper's plan plugin, flip every namespace reference, and refresh the plan-plugin enumerations. Auto-discovery means NO `plugin.json` edits. panel-judge is a HAND-AUTHORED static agent — drop it into `plugins/plan/agents/` with NO `.managed-file-dont-edit` sidecar and NO `.tmpl` (the generator `promptctl render-plugin-templates` only owns worker-*.md + practice-scout.md and must not learn about panel-judge).

Source paths (read across the repo boundary; worker cwd is keeper):
- /Users/mike/code/arthack/claude/arthack/skills/panel/SKILL.md -> plugins/plan/skills/panel/SKILL.md
- /Users/mike/code/arthack/claude/arthack/skills/panel/references/panel.md -> plugins/plan/skills/panel/references/panel.md
- /Users/mike/code/arthack/claude/arthack/agents/panel-judge.md -> plugins/plan/agents/panel-judge.md

Reference flips (EVERY literal must change or the model invokes a dead skill at runtime — no load-time validation):
- copied SKILL.md: `arthack:panel-judge` @16,27,91 -> `plan:panel-judge`; `/arthack:panel` @108 -> `/plan:panel`. Keep the relative `references/panel.md` ref (travels with the move). Frontmatter `name: panel` stays.
- copied references/panel.md: `arthack:panel-judge` @26,37 -> `plan:panel-judge`.
- copied panel-judge.md: `/arthack:panel` @3 (description, x2) + @12 (body) -> `/plan:panel`. Frontmatter `name: panel-judge` stays.
- plugins/plan/skills/hack/SKILL.md: `/arthack:panel` @92,97,101,113 -> `/plan:panel` (ONLY the namespaced literals; leave generic "the panel"/"panel mode" prose alone).
- docs/planctl-strip.md:247: `/arthack:panel` -> `/plan:panel`.

Enumeration updates:
- plugins/plan/README.md skill table (~161-165): add a `/plan:panel` row near `/plan:hack`.
- plugins/plan/CLAUDE.md:32: add `panel-judge` to the named agent list.
- keeper root CLAUDE.md:17-18: OPTIONAL — the general "plan:* skills" phrase already covers panel; add an explicit mention only if it matches the keeper:await/dispatch/autopilot convention. Leave as-is if in doubt.

Forward-facing prose only — NO "moved from arthack"/"formerly arthack:panel" breadcrumbs (plugins/plan/CLAUDE.md:5). Commit via `keeper commit-work`; keep the unrelated modified plugins/keeper/plugin/hooks/branch-guard.ts OUT of the commit (explicit-path staging).

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/arthack/claude/arthack/skills/panel/SKILL.md — copy source (silent-cognition prose already landed; copy as-is, then flip refs)
- /Users/mike/code/arthack/claude/arthack/skills/panel/references/panel.md — copy source
- /Users/mike/code/arthack/claude/arthack/agents/panel-judge.md — copy source
- /Users/mike/code/keeper/plugins/plan/skills/hack/SKILL.md:92,97,101,113 — callsite refs to flip
- /Users/mike/code/keeper/plugins/plan/README.md:158-165 — skill table edit site
- /Users/mike/code/keeper/plugins/plan/CLAUDE.md:32 — agent-list edit site

**Optional** (reference as needed):
- /Users/mike/code/keeper/plugins/plan/agents/close-planner.md — exemplar hand-authored static agent (no sidecar) to match panel-judge against
- /Users/mike/code/keeper/plugins/plan/skills/hack/ — exemplar skill layout

### Risks

- Missing any `arthack:panel` / `arthack:panel-judge` literal silently breaks the skill/agent at runtime — grep must be empty after editing.
- Don't add a sidecar/.tmpl for panel-judge; don't edit plugin.json; keep panel model-invokable (no disable-model-invocation).
- Reading the source requires crossing into the arthack repo while cwd is keeper — use absolute paths.

### Test notes

- `ls plugins/plan/skills/panel/SKILL.md plugins/plan/skills/panel/references/panel.md plugins/plan/agents/panel-judge.md` -> all exist.
- `grep -rn "arthack:panel" plugins/plan/ docs/planctl-strip.md` -> no matches.
- `grep -c "plan:panel" plugins/plan/skills/hack/SKILL.md` -> >=4.
- `test ! -e plugins/plan/agents/panel-judge.md.managed-file-dont-edit`.

## Acceptance

- [ ] panel skill (SKILL.md + references/panel.md) and panel-judge.md exist under plugins/plan/ (skills/panel/ and agents/), copied with the silent-cognition prose intact.
- [ ] Every `arthack:panel` / `arthack:panel-judge` literal in the copied files, hack/SKILL.md (4), and docs/planctl-strip.md (1) is flipped to `plan:*`; `grep -rn "arthack:panel" plugins/plan/ docs/planctl-strip.md` is empty.
- [ ] plugins/plan/README.md skill table has a /plan:panel row; plugins/plan/CLAUDE.md:32 names panel-judge.
- [ ] panel-judge.md has NO sidecar/.tmpl; no plugin.json edited; panel stays model-invokable.
- [ ] Forward-facing prose only; committed via keeper commit-work (branch-guard.ts excluded).

## Done summary

## Evidence
