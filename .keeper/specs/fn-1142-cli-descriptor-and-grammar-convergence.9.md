## Description

**Size:** S
**Files:** claude/arthack/template/_partials (the keeper-history-forensics snippet source and any sibling snippet citing the renamed session surface)

### Approach

The keeper prompt corpus vendors its snippets from this repo (the authoring home pinned in plugins/prompt/corpus/vendor.lock). Update the source snippets for the keeper-side cutover: `keeper show-session-events --session-id <id>` → `keeper session events --session-id <id>`, `keeper session-summary <id>` → `keeper session summary <id>`, `keeper session-state` → `keeper session state`, `keeper show-session-files` → `keeper session files`, and `keeper show-job --session <title>` → `keeper show-job --session-title <title>`. `search-history` and `find-file-history` keep their names — do not touch them. Sweep the whole _partials tree (grep for each retired spelling) so no snippet re-vendors a dead verb; forward-facing prose only, no rename narration. The keeper-side re-vendor + BAKE re-render is the downstream task's job (it runs `vendor-corpus --sync` against this repo).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- ~/code/keeper/plugins/prompt/corpus/vendor.lock — names the authoring path + pinned sha (confirm the source path inside this repo)
- the keeper-history-forensics snippet under claude/arthack/template/_partials — the primary citation site

**Optional** (reference as needed):
- ~/code/arthack snippet index build tooling (rebuild the index if this repo's conventions require it after snippet edits)

### Risks

- Editing only the vendored keeper-side copy instead of this source would be reverted by the next sync — this task exists precisely to prevent that.

### Test notes

Grep the _partials tree for each retired spelling → zero hits; snippet index rebuild green if applicable.

## Acceptance

- [ ] Every snippet in the arthack authoring tree cites only the post-cutover keeper session verbs and show-job selector spellings
- [ ] search-history and find-file-history citations are unchanged
- [ ] No snippet contains rename narration; prose states current behavior only

## Done summary
Updated the keeper-history-forensics snippet source to cite post-cutover session verbs (session events/summary) and show-job --session-title; rebuilt the snippet index. No other _partials snippets cited the retired spellings.
## Evidence
