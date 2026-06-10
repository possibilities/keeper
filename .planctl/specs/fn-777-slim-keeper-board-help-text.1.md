## Description

**Size:** S
**Files:** cli/usage.ts (and the board help wiring in cli/board.ts if help text lives there)

### Approach

Read how `keeper board --help` text is assembled (cli/usage.ts). Split the wall into: a compact default help (usage line, one line per flag, 2-3 examples) and the long-form reference (move to --agent-help output or point at README's board section if it already covers it — delete duplication rather than relocating it). Follow the repo doc/comment discipline: present-tense, no ticket ids. Keep flag semantics text accurate to current behavior.

### Investigation targets

**Required** (read before coding):
- cli/usage.ts — current help assembly
- README.md board section — what the long-form already duplicates

### Risks

Help text may be asserted in tests (grep test/ for usage strings before editing).

### Test notes

`bun test` green; `bun run test:full` if any non-help code path touched; eyeball `keeper board --help` output.

## Acceptance

- [ ] Default `keeper board --help` <= ~40 lines, accurate
- [ ] Long-form content reachable or deleted-as-duplicate; no orphaned references
- [ ] Tests green

## Done summary

## Evidence
