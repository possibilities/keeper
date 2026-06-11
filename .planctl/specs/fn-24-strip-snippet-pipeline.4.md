## Description

**Size:** M
**Files:** claude/arthack/template/commands/sketch.md.tmpl, claude/arthack/template/_partials/snippets/cli-conventions/boundary-lint.md.tmpl, claude/arthack/template/_partials/snippets/_index.yaml, claude/arthack/template/_partials/snippets/collab/, claude/arthack/template/_partials/snippets/reporting/, claude/arthack/template/_partials/snippets/research/, claude/arthack/CLAUDE.md

### Approach

In sketch.md.tmpl: delete Process step 3 (snippet-id accumulation) and renumber the remaining steps, delete the "## Snippets in bundle" output section and its empty-declaration rule, and inside the "plan sketch" followup delete the save-bundle/--snippets bundle plumbing and the --bundle first-line handoff (keep all five followup signals; "plan sketch" now passes subject + Direction + Touchpoints as plain prose). Also drop the fn-630 scaffold-advisory and bundle-health backstop sentences (lines ~33, ~71). In boundary-lint.md.tmpl:40 prune the render-spec/inline-sketch-refs exemption example (replace with the surviving planctl-to-keeper example). Delete the 4 orphan snippet files (collab/answer-only-mode, collab/print-answer-directly, reporting/report-presentation, research/research-process) and their _index.yaml entries INCLUDING the related/cross-ref backlinks between the two collab snippets (~387, ~405-406, ~455, ~472, ~1661, ~1684). Reword claude/arthack/CLAUDE.md:38 — the arthack plugin ships /sketch (investigation-and-direction command); drop "for the runtime snippet substrate". Then re-render via `promptctl render-plugin-templates --project-root /Users/mike/code/arthack` — this regenerates BOTH sketch.md and hack.md (hack.md:316 carries the boundary-lint snippet text). Never Edit the generated commands/*.md directly. Verify-and-skip: Bash(jobctl:*) grants are already absent from both templates (fn-715 shipped) — confirm, do not scaffold work for it.

### Investigation targets

**Required** (read before coding):
- claude/arthack/template/commands/sketch.md.tmpl:22-43,63-71,85-101 — ceremony, output section, plan-sketch plumbing
- claude/arthack/template/_partials/snippets/_index.yaml — orphan entries + backlinks
- claude/arthack/template/_partials/snippets/cli-conventions/boundary-lint.md.tmpl:40 — exemption example

**Optional** (reference as needed):
- claude/arthack/commands/sketch.md.managed-file-dont-edit — sidecar proving the render contract
- claude/arthack/CLAUDE.md:38 — the phrase to reword

### Risks

- fn-664.1 also edits the snippet template tree and re-renders hack/sketch — possible rebase noise; both edits are independent in content.
- validate-bundles must stay green after orphan deletion (none of the 4 orphans are referenced by any bundle — verified in session; re-verify before deleting).

### Test notes

`promptctl validate-bundles` green; `promptctl render-plugin-templates` clean with no orphan-template warnings; rendered sketch.md contains no "Snippets in bundle"/"find-snippets"/"save-bundle" ceremony; rendered hack.md:316 region carries the updated boundary-lint text; `grep -r jobctl claude/` returns nothing (verify-and-skip confirmation).

## Acceptance

- [ ] sketch.md.tmpl has no snippet ceremony; five followup signals intact; steps renumbered; rendered sketch.md + hack.md regenerated from templates
- [ ] 4 orphan snippets + index entries + backlinks gone; validate-bundles green; remaining library untouched
- [ ] claude/arthack/CLAUDE.md reworded present-tense; no backward-facing prose

## Done summary

## Evidence
