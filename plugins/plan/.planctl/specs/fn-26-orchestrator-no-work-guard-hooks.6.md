## Description

**Size:** S
**Files:** template/skills/work.md.tmpl, skills/close/SKILL.md, README.md, AGENTS.md

### Approach

Frontmatter: in template/skills/work.md.tmpl drop `Bash(keeper:*)` from allowed-tools and add `disallowed-tools: Edit, Write, NotebookEdit, TodoWrite`; add the same disallowed-tools line to skills/close/SKILL.md (direct-tracked, edit in place). Re-render with `promptctl render-plugin-templates --project-root /Users/mike/code/planctl` and verify the rendered skills/work/SKILL.md (gitignored) carries both frontmatter changes intact — if the renderer drops the unknown key, stop and surface (the rendered file is the enforcement surface).

Prompt hardening at the Phase 2b decision point (template lines ~121-129, inside the verdict switch intro, not the guardrails tail): every non-done verdict is a resume directive, never a work order; a dirty tree, failing lint, or missing commit is the worker's to fix in the worker's context; the global commit-by-default convention does not apply to this skill — it never edits, so it never commits. Forward-facing present-tense wording only; align with (do not fork) the existing guardrail phrasings at lines ~176-196.

Docs: README.md — revise the /plan:work skills-table row to state the orchestrator carries hook-enforced no-commit constraints, and add a compact hooks subsection (the three dispatchers, marker path ~/.local/state/planctl/sessions/, PLANCTL_GUARD_BYPASS=1); AGENTS.md "Skills and agents" — one present-tense sentence that the plugin's hooks layer enforces the content-blind orchestrator contract mechanically. Behavior contract source of truth is the epic spec — write docs from it.

### Investigation targets

**Required** (read before coding):
- template/skills/work.md.tmpl:13 (frontmatter), :121-129 (Phase 2b switch — hardening insertion point), :176-196 (existing never-commits guardrails to align with)
- skills/close/SKILL.md:12 — frontmatter line
- README.md /plan:work table row and surrounding style (dense single-paragraph rows; revise, don't append); AGENTS.md "Skills and agents" section

**Optional** (reference as needed):
- skills/work/SKILL.md.managed-file-dont-edit — sidecar mechanics confirming the rendered file regenerates

### Risks

- The renderer may not pass `disallowed-tools` through (external promptctl, possible known-keys handling) — verification of the rendered output is part of acceptance, not optional
- Doc discipline: no backward-facing phrasing ("no longer", "used to") anywhere in the new prose

### Test notes

No code tests; verification is the rendered-output check plus a docs read-through against the doc-discipline rules. Run the existing fast bucket to confirm nothing asserts on the old frontmatter.

## Acceptance

- [ ] Rendered skills/work/SKILL.md frontmatter: no Bash(keeper:*), disallowed-tools present; skills/close/SKILL.md likewise
- [ ] Phase 2b hardening present in the template at the verdict switch, forward-facing wording, no fork of the canonical guardrail phrasings
- [ ] README row + hooks subsection and AGENTS.md sentence land per docs-gap guidance; no backward-facing prose
- [ ] `uv run pytest tests/` green

## Done summary
Dropped Bash(keeper:*) and added disallowed-tools to work+close skill frontmatter; hardened Phase 2b verdict switch as resume-only; documented the three orchestrator hooks in README and AGENTS. Rendered work/SKILL.md verified carrying both frontmatter changes.
## Evidence
