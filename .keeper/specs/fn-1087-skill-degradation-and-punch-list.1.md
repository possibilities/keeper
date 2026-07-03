## Description

**Size:** M
**Files:** plugins/plan/skills/hack/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/plan/SKILL.md, plugins/plan/template/agents/practice-scout.md.tmpl, plugins/plan/template/skills/work.md.tmpl, plugins/plan/agents/close-planner.md (reference only)

### Approach

Sweep every arthack-CLI reference from the study's §1.6 inventory and convert hard
assumptions to guarded optionals in close-planner.md:215's style ("if <ctl> is absent, skip
and move on / use <fallback>"): hack's allowed-tools stays (declaring a tool is harmless)
but its recipes gain the guard phrasing and a degraded path (e.g. searchctl absent →
WebSearch/WebFetch; claudectl absent → keeper session verbs); practice-scout's render-time
shell teasers become null-safe (absent CLI renders an empty teaser, not a render failure) —
verify the template engine's shell helper behavior on nonzero exit and guard accordingly;
prune work.md.tmpl:30's stale "hookctl's tracker" phrasing to the session_files reality.
Doc rule #0: displace, don't stack. Re-render all generated outputs.

### Investigation targets

**Required** (read before coding):
- The §1.6 table in ~/docs/arthack-dissolution-study.md — the complete reference list
- plugins/plan/agents/close-planner.md:215 — the guard pattern to copy
- The render engine's shell() failure semantics (plugins/prompt/src/render_engine.ts) — what an absent binary does to a render today

### Risks

- Degraded fallbacks must name REAL alternatives (keeper-native or harness-native), not invent capabilities.

### Test notes

Render consistency + skill-id lint green; spot-render practice-scout with a PATH lacking knowctl.

## Acceptance

- [ ] Every §1.6 reference guarded with a stated fallback; teasers null-safe; hookctl phrasing pruned
- [ ] Renders regenerated; lints green

## Done summary
Guarded every §1.6 arthack-CLI reference in the hack/panel/plan skills and practice-scout with stated harness- or keeper-native fallbacks; made practice-scout's render-time knowctl shell teasers null-safe (absent CLI renders empty, not a render failure); pruned the stale 'hookctl's tracker' phrasing; rebaselined the prompt parity goldens. skill-id + corpus-drift lints and the prompt suite are green.
## Evidence
