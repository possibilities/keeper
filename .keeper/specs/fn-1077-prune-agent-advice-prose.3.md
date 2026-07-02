## Description

**Size:** M
**Files:** plugins/plan/skills/{hack,plan,close,defer,panel}/SKILL.md, plugins/plan/agents/{repo-scout,docs-gap-scout,gap-analyst,quality-auditor}.md, plugins/plan/template/agents/practice-scout.md.tmpl

### Approach

hack: single-statement the triple-stated panel routing (:84-96,:105-107), commit rule
(:240,:242-270 with the corpus-snippet bake carrying the detail), and quiet-wrapup
(:187-214) — roughly 40 lines out. plan (739 lines): Phase 5 re-narrates the 3b depth tables
— collapse to references; move its own orientation reads status-first; keep the phase map,
depth/decomposition heuristics, scaffold YAML schema, and bus-resume block verbatim. close/
defer/panel: bookend dedup only. Gate the grafted frontend/design-system DNA behind presence
checks: repo-scout:97-102, docs-gap-scout:43-53, gap-analyst:52-60,85-86,
quality-auditor:135-144,180-183, practice-scout.tmpl (React/Vercel/named-influencer examples)
— each gets one conditional lead-in ("when the target repo has a design system / frontend
surface...") so cross-project use keeps the capability while keeper-shaped repos stop
receiving Storybook advice; also strip the tutorial-voice emoji tables and star-count
heuristics where they carry no decision weight. Sentence-level no-op prune across all
touched files; prompt-injection fencing and .keeper/-exclusion guards are sacred.

### Investigation targets

**Required** (read before coding):
- plugins/plan/skills/hack/SKILL.md:84-96,105-107,187-214,240-270
- plugins/plan/skills/plan/SKILL.md Phase 5 vs Phase 3b tables; :582-597 (sacred bus-resume)
- The five agent briefs' frontend sections at the lines above

### Risks

- plan tooling is cross-project — gating must be a branch, not a deletion; a frontend repo must still get the design-system guidance.
- practice-scout is generated — edit the .tmpl and re-render.

### Test notes

Plan suite + render consistency green; spot-render practice-scout; review discipline as in
the sibling task.

## Acceptance

- [ ] hack/plan skill duplications single-stated; plan skill orientation status-first
- [ ] All five briefs gate design-system content on a presence condition; tutorial-voice trimmed
- [ ] Fencing guards and sacred blocks verbatim; renders regenerated

## Done summary

## Evidence
