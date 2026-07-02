## Overview

README.md (4,466 lines) has served as the append target for every feature's architecture
rationale because `scripts/lint-claude-md.ts` funnels CLAUDE.md overflow into README
`## Architecture`. The repo is single-user/internal; git history and `.keeper/` specs archive
all provenance. This epic guts README to a lean front door (hard-capped ~250 lines), deletes
rather than relocates (no docs/ tree, no ADR corpus, no examples/ dir — explicitly rejected),
reverses the lint funnel (guidance becomes tighten/delete), adds a hard README size+content
gate so it can never re-monolithize, and repoints every code/CLAUDE.md cross-reference so
nothing dangles.

## Quick commands

- `wc -l README.md && wc -c README.md` — must be ≤250 lines / ≤24576 bytes after the gut
- `bun scripts/lint-claude-md.ts` — must stay green throughout (also gates README post-task-2)
- `rg -n 'README' src cli scripts CLAUDE.md` — no reference to a deleted README section survives
- `bun test test/lint-claude-md.test.ts`

## Acceptance

- [ ] README.md ≤250 lines and ≤24576 bytes; only front-door content survives (what/is-NOT, system map, minimal install/uninstall incl. the manual steps with no code home, lean Architecture invariants, lean Backup & restore pointer at the code-sourced runbook)
- [ ] `## Example clients`, `## Inspect`, and the bulk of `## Install`/`## Architecture` deleted, not relocated
- [ ] `scripts/lint-claude-md.ts` no longer directs anyone to relocate prose into README (docstring AND epilogue); it hard-gates README size + content fingerprints
- [ ] All cross-references repointed: src/backup.ts:743,808; cli/reclaim.ts:33; cli/board.ts:126-131; src/usage-picker.ts:2; src/db.ts:4870; CLAUDE.md:2,116-117 — reworded forward-facing, no tombstones
- [ ] CLAUDE.md stays ≤120 lines / lint-green; `bun test` green

## Early proof point

Task that proves the approach: task 1 (the gut itself). If the keep-bar judgment proves too
lossy mid-edit, fall back to keeping a longer lean `## Architecture` (~150 lines) — the cap in
task 2 is set after task 1 lands, so the number can absorb it.

## References

- `scripts/lint-claude-md.ts:1-25` header docstring + `:136-142` failure epilogue — the two funnel messages (both must be retargeted)
- `src/commit-work/lint-matrix.ts:389-407` — commit-time gate fires only when CLAUDE.md is staged today
- `src/backup.ts:755,810` — `reclaimInstructions()`/`restoreInstructions()`: the backup/restore runbook is rendered from code (also via `keeper reclaim --agent-help`, `scripts/backup-db.ts:40`); code is the sole source of truth
- `test/lint-claude-md.test.ts` — pure-fixture test pattern to extend
- fn-1058 (codex leg transcript attribution): confirmed no file overlap, no dep
- `.keeper/` specs cite old README line numbers — historical provenance, never chase/update

## Docs gaps

- **plugins/plan/agents/docs-gap-scout.md**: generic routing table says "Architecture/internals change → README/docs" — repo-agnostic guidance, flagged only; do not scope into this epic

## Best practices

- **Byte cap is the real guard:** wide diagrams/multibyte chars blow bytes long before lines; gate both `wc -l` and `Buffer.byteLength`
- **Atomic cross-reference consistency:** README/CLAUDE.md/source-comment edits land in one commit per task — no window with dangling pointers
- **Deletion breadcrumb lives in the commit message only** (one line: content preserved in git history) — never a breadcrumb paragraph in the file
- **Surviving prose gets clear headings:** lost-in-the-middle recall drop makes an unstructured wall the worst shape for agent readers
