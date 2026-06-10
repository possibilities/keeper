## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/engineering/code-comment-style.md.tmpl (new, via verb), claude/arthack/template/_partials/bundles/engineering-rules.yaml

### Approach

Author the canonical code-comment-style snippet in arthack, voice-matched to the sibling guards (read future-facing-docs.md.tmpl and claude-md-scope.md.tmpl first). Body expands the epic's canonical 5-bullet block (planctl cat the epic from ~/code/planctl) into the snippets' prose style: default-no-comments with the falsifiable "would a future reader be confused without it?" test, anti-provenance/narration, prune-on-touch, the protected-comment allowlist, and the docs-prune-never-append rule. Create it with `promptctl save-snippet` (check `promptctl save-snippet --help` for flags) — slug `code-comment-style`, domain `engineering`, severity `guard`, audience `agent`, scope `[any]`, phase `[executing, reviewing]`, related `[future-facing-docs, claude-md-scope]` — the verb writes the file AND updates `_index.yaml` atomically; never hand-edit `_index.yaml`. Then hand-edit `engineering-rules.yaml`: append `code-comment-style` to `snippet_ids` and refresh the `summary:` line.

### Investigation targets

**Required** (read before coding):
- claude/arthack/template/_partials/snippets/engineering/future-facing-docs.md.tmpl — frontmatter shape + voice
- claude/arthack/template/_partials/snippets/engineering/claude-md-scope.md.tmpl — sibling guard, cross-reference style ([[...]] links)
- claude/arthack/template/_partials/bundles/engineering-rules.yaml — registration target

### Risks

`validate-bundles` passes even when a snippet is unbundled, so it cannot prove registration — the acceptance carries an explicit bundle-membership check. If `save-snippet` errors on an existing slug, stop and surface; do not pass `--force`.

### Test notes

From ~/code/arthack: `promptctl validate-bundles` exits 0; `promptctl render bundle/engineering-rules` includes the new block; `uv run pytest apps/promptctl/tests/` green.

## Acceptance

- [ ] Snippet file exists with `{#- ... -#}` frontmatter (severity guard, related future-facing-docs + claude-md-scope); `_index.yaml` updated by the verb, not by hand
- [ ] `engineering-rules.yaml` lists `code-comment-style` in snippet_ids with refreshed summary
- [ ] `promptctl validate-bundles` exits 0 and `promptctl render bundle/engineering-rules` shows the snippet
- [ ] `uv run pytest apps/promptctl/tests/` green
- [ ] Snippet body contains the protected-comment allowlist and zero ticket/epic ids

## Done summary

## Evidence
