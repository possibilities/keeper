## Description

**Size:** M
**Files:** skills/plan/SKILL.md, skills/close/SKILL.md, skills/defer/SKILL.md, skills/close/classifier/README.md, template/agents/worker.md.tmpl, template/skills/work.md.tmpl, agents/repo-scout.md, agents/gap-analyst.md, agents/classifier.md, agents/quality-auditor.md, docs/diagrams/planctl-workflow.mermaid.md

### Approach

Delete every instruction that tells an agent to curate, browse, harvest,
render, or read snippet/bundle substrate; rewrite surrounding prose so each
file reads as a complete present-tense document (no tombstones, no
"formerly", no dangling references to deleted pins like `inherited_bundle`,
`inherited_bundle_menu`, `inherited_snippets`, or Phase 2a). In the same
pass, fix every `Task(subagent_type="...")` example to the registered
plugin-scoped names (`plan:repo-scout`, `plan:docs-gap-scout`,
`plan:practice-scout`, `plan:epic-scout`, `plan:gap-analyst`,
`plan:quality-auditor`, `plan:classifier`). Edit templates, never their
rendered outputs; finish with `promptctl render-plugin-templates
--project-root /Users/mike/code/planctl` so `skills/work/SKILL.md`,
`agents/worker-*.md`, and their sidecars regenerate.

Per-file deletions:
- `skills/plan/SKILL.md` — Phase 1a `--bundle`/`--snippets` wire format + ref-shape validation (replace with one forward rule: a first line matching `^--(bundle|snippets)\b` is stripped and the remaining prose is the subject); Phase 2a entirely; the "Harvest snippet-name mentions" sentence in the repo-scout return notes; the 5b "Snippets/bundles" block + empty-case-needs-a-reason rule; the 5e per-task snippet/bundle paragraph; the `## Snippet context` epic-spec template section + its omit rule; `snippets:`/`bundles:` lines and the `sketch/<name>` comment in the 5h YAML example; `ref_invalid` from the failure-code list; `snippets`/`bundles` fields in the R1+R2 refine-context envelope description and R5b delta YAML example; spawn names at the Phase 2b and 2c invocation blocks.
- `skills/close/SKILL.md` — the snippet-context render/pin step and the `## Snippet context` prepend into auditor and classifier briefs; spawn names for quality-auditor and classifier. Land AFTER fn-12's rewrite (epic dep enforces this) — apply the same scrub to whatever shape fn-12 leaves.
- `skills/defer/SKILL.md` — bare repo-scout spawn name.
- `skills/close/classifier/README.md` — the optional `## Snippet context` prefix mention.
- `template/agents/worker.md.tmpl` — the BRIEF_REF "pre-rendered snippet context" clause, the "Snippet context" header-note paragraph, the `snippet_context` field bullet in Phase 1 (the brief still carries the key; the worker simply has no instruction about it), and the "Snippet substrate is escape-valve only" block.
- `template/skills/work.md.tmpl` — "pre-rendered snippet context" in the claim/brief descriptions and the Content-blind spawn block; the spawn-prompt template line telling the worker to read snippet context.
- `agents/repo-scout.md` — step 2 "Survey existing snippets" (renumber the strategy list) and the snippet-citation report guidance. Do NOT touch the "<10-line snippets" show-shape rule — that is code-excerpt wording, not substrate.
- `agents/gap-analyst.md`, `agents/classifier.md`, `agents/quality-auditor.md` — the `## Snippet context` preamble paragraph in each.
- `docs/diagrams/planctl-workflow.mermaid.md` — the `snippet_author` node + its two edges; drop "(+ snippets/bundles per spec)" from the `write_planctl` label.

### Investigation targets

**Required** (read before coding):
- skills/plan/SKILL.md:47-62,100-108,163-166,171,228,371-379,402,446-448,494-508,518-521,557,649,712-713 — every plan-skill deletion site
- skills/close/SKILL.md:58,67-69,75-108 — close-side snippet machinery + spawn names at :79,:104
- template/agents/worker.md.tmpl:23,27,51,96 — worker substrate prose
- agents/repo-scout.md:28,68,113 — find-snippets step, citation guidance, and the do-not-delete show-shape rule

**Optional** (reference as needed):
- skills/defer/SKILL.md:56 — bare spawn name
- agents/practice-scout.md.managed-file-dont-edit — sidecar shape, to recognize generated files

### Risks

- fn-12 rewrites skills/close/SKILL.md and agents/quality-auditor.md; the epic dep makes this task land second — re-read both files post-fn-12 rather than applying line numbers above blindly.
- Partial deletion is worse than none: a surviving lone mention of `snippet_context` in any skill/agent prose is an ambiguous prior. After editing, grep each touched file for `snippet`, `bundle`, `inherited_`, `find-snippets`, `render-spec` and resolve every hit deliberately.

### Test notes

No Python tests cover prose; verify via the epic Quick commands greps plus
`promptctl render-plugin-templates` exiting clean with regenerated sidecars.

## Acceptance

- [ ] Quick-command greps return no curation/render instructions in skills/, agents/, template/, docs/diagrams/
- [ ] Every `subagent_type=` example in skills/ is `plan:`-scoped
- [ ] `/plan:plan` has a strip rule for a `--bundle`/`--snippets` first line and no other Phase 1a remnant
- [ ] Generated outputs re-rendered; templates and rendered files agree (sidecar sha256 matches)
- [ ] repo-scout's "<10-line snippets" show-shape wording is intact
- [ ] No tombstone phrasing introduced anywhere

## Done summary

## Evidence
