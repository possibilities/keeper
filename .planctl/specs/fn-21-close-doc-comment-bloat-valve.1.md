## Description

**Size:** S
**Files:** template/agents/worker.md.tmpl, AGENTS.md, tests/test_worker_template_discipline.py (new)

### Approach

Insert a `## Doc & comment discipline` section into `template/agents/worker.md.tmpl` immediately before `## Rules`, containing the epic spec's canonical 5-bullet block verbatim (run `planctl cat <epic_id>` to read it). Re-render with `promptctl render-plugin-templates --project-root /Users/mike/code/planctl` so all four worker-*.md files and their .managed-file-dont-edit sidecars regenerate. Rendered files and sidecars are gitignored — commit only the template, AGENTS.md, and the new test. Then revise AGENTS.md's existing "Doc & comment style" block in place: state the canon once, cross-reference the worker template, delete any wording the template now makes redundant — net line count must not grow. Add a prose-consistency test mirroring tests/test_work_skill_consistency.py that scans the TEMPLATE source (never a rendered file) for the discipline heading and the protected-comments line.

### Investigation targets

**Required** (read before coding):
- template/agents/worker.md.tmpl:199-213 — the `## Rules` section the block slots before; match its tone and bullet style
- tests/test_generated_guard_hook.py — why direct edits to agents/worker-*.md are denied; never fight the hook
- tests/test_work_skill_consistency.py — the template-scanning test pattern to mirror

**Optional** (reference as needed):
- agents/worker-high.md — rendered style reference (read-only)

### Risks

A partial re-render leaves sidecar sha256s stale and the check-generated guard will block the NEXT edit to any worker file. After rendering, re-run the render command — it must be a no-op (idempotent) — and confirm all four sidecars changed together.

### Test notes

`uv run pytest tests/` green, including the new test.

## Acceptance

- [ ] Template contains `## Doc & comment discipline` placed immediately before `## Rules`, max 5 bullets, including the protected-comments allowlist bullet
- [ ] All four rendered workers + sidecars regenerated; second render run is a no-op; rendered files remain uncommitted/gitignored
- [ ] AGENTS.md revised in place with no net line growth; cross-references the worker template
- [ ] New template-prose test exists and passes; full `uv run pytest tests/` green
- [ ] No bullet in the new block contains a ticket/epic id or backward-facing phrasing

## Done summary
Added the canonical 5-bullet Doc & comment discipline block before ## Rules in template/agents/worker.md.tmpl, re-rendered all four worker agents + sidecars (idempotent), consolidated the CLAUDE.md/AGENTS.md doc-style block to cross-reference it without net line growth, and added a template-prose test.
## Evidence
