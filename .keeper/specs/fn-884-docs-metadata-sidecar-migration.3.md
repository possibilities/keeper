## Description

**Size:** S
**Files:** claude/arthack/template/_partials/snippets/source-dirs/docs-dir-and-gist-open.md.tmpl, claude/arthack/template/_partials/snippets/_index.yaml

### Approach

Update the canonical snippet body: the open command becomes `gh gist create <doc>.md <doc>.yaml --web` (markdown FIRST, sidecar SECOND), and add a sentence that document metadata lives ONLY in the `.yaml` sidecar (never embedded in the `.md`). Then `keeper prompt build-snippets --project-root /Users/mike/code/arthack` to regenerate `_index.yaml`; update the snippet's `summary` field if build-snippets doesn't (it's derived from frontmatter — edit the frontmatter `summary` to mention the two-file command). Forward-facing only.

### Investigation targets

**Required:**
- claude/arthack/template/_partials/snippets/source-dirs/docs-dir-and-gist-open.md.tmpl — current body/frontmatter
- plugins/prompt/src/build_snippets.ts — index regen (name==stem, domain==parent dir enforced)

### Risks

- The exact snippet body must match what task `.4` re-bakes into `/hack` byte-for-byte under the canonical-source cite — coordinate wording with `.4`.

### Test notes

`keeper prompt render source-dirs/docs-dir-and-gist-open` shows the new body; index build is clean.

## Acceptance

- [ ] snippet body shows `gh gist create <doc>.md <doc>.yaml --web` + "metadata only in the sidecar"
- [ ] `_index.yaml` regenerated; summary consistent with the body
- [ ] `keeper prompt render source-dirs/docs-dir-and-gist-open` reflects the change

## Done summary
Updated docs-dir-and-gist-open snippet: open command is now gh gist create <doc>.md <doc>.yaml --web with metadata living only in the .yaml sidecar; regenerated _index.yaml summary to match.
## Evidence
