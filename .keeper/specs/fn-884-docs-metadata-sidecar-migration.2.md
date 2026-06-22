## Description

**Size:** S
**Files:** claude/arthack/hooks/post_tool_use.ts, claude/arthack/hooks/tests/post_tool_use.test.ts, claude/arthack/hooks/hooks.json, claude/arthack/CLAUDE.md, claude/CLAUDE.md

### Approach

Surgically remove the docs-metadata + gist-url machinery now that the keeper hook (`.1`) owns it. Keep the formatters (`postWriteStylua`, `postWriteZigFmt`), `commandAdvice`/`COMMAND_ADVICE`/`slugify`, and `_lib.ts`. Verified removal map (re-confirm line numbers before editing — they may have shifted):

- DELETE functions: `postWriteDocsMetadata` (~62-125), `isoWithOffset` (~128-137), `gitField` (~140-151), `shq` (~154-156), `shlexSplit` (~360-404, the post_tool_use copy ONLY — pre_tool_use.ts has its own independent copy, leave that), `extractFileArgs` (~407-429), `resolvePath` (~432-438), `isTrackedFile` (~441-446), `updateMarkdownMetadata` (~449-475), `updateSidecar` (~478-496), `postGistDocsMetadata` (~499-513)
- DELETE consts `GIST_URL_PATTERN`/`GH_GIST_CREATE_PATTERN`/`FLAGS_WITH_VALUE` (~355-357)
- DELETE the two `main()` call sites: `postWriteDocsMetadata` in the Write branch (~529), `postGistDocsMetadata` in the Bash branch (~562)
- DELETE exports `_extractFileArgs`, `_postGistDocsMetadata` (keep `_commandAdvice`)
- UPDATE section comments (~40-42, ~158-160) and the file header (~1-18) to drop docs/gist mentions
- DELETE the 3 gist/docs test blocks in tests/post_tool_use.test.ts and the `post_gist_docs_metadata` bullet in its header comment
- UPDATE doc strings: hooks.json `description` (drop "docs-metadata, gist metadata"), claude/arthack/CLAUDE.md:6 (drop post_write_docs_metadata + post_gist_docs_metadata), claude/CLAUDE.md:34 (drop "gist/docs metadata")

Forward-facing only — no "formerly/moved to keeper" narration in the prose (commit message is the place for that).

### Investigation targets

**Required:**
- claude/arthack/hooks/post_tool_use.ts — confirm the Write/Bash branches still run formatters + commandAdvice after removal
- claude/arthack/hooks/pre_tool_use.ts — confirm it has its OWN shlexSplit (so removing the post copy is safe)
- claude/arthack/hooks/tests/post_tool_use.test.ts — the keep/delete test split

### Risks

- Don't remove `shlexSplit` from pre_tool_use.ts. Don't touch `_lib.ts`. No reader of the sidecar or the `## Metadata` block exists (confirmed) — safe to remove.

### Test notes

`bun test --cwd claude/arthack/hooks` stays green with only the formatter + command-advice tests.

## Acceptance

- [ ] docs/gist functions, consts, call sites, and exports removed; formatters + commandAdvice intact
- [ ] post_tool_use.test.ts passes with gist/docs blocks removed
- [ ] hooks.json description + both CLAUDE.md mentions updated forward-facing
- [ ] `bun test --cwd claude/arthack/hooks` green

## Done summary
Removed docs-metadata + gist-url machinery from arthack post_tool_use.ts (functions, consts, call sites, exports, tests) now that the keeper plugin owns it; kept stylua/zig-fmt formatters and commandAdvice. Updated hooks.json and both CLAUDE.md descriptions forward-facing. bun test --cwd claude/arthack/hooks green (64 pass).
## Evidence
