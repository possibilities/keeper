## Description

**Size:** S
**Files:** cli/board.ts

### Approach

The board HELP block lives in cli/board.ts (each subcommand parses --help itself; cli/usage.ts is the separate `keeper usage` command — not in scope). Slim the 179-line wall to the commit-work house style: usage line, one line per flag/keybinding group, 2-3 examples, <= ~40 lines. The long-form rendering reference duplicates README's board section — delete the duplication and point at README; move anything agent-essential and non-duplicated behind an --agent-help branch only if it genuinely cannot live in README. Present-tense, no ticket ids.

### Investigation targets

**Required** (read before coding):
- cli/board.ts — current HELP block
- README.md board section — what the long-form already duplicates
- cli/commit-work.ts — house-style reference
- test/ — grep for board help/usage string assertions before editing

### Risks

Help text may be asserted in tests (grep first).

### Test notes

`bun test` green; eyeball `keeper board --help`.

## Acceptance

- [ ] `keeper board --help` <= ~40 lines, accurate
- [ ] Long-form content deleted-as-duplicate or reachable via README/agent-help; no orphaned references
- [ ] Tests green; Done summary reports lines/chars deleted

## Done summary

## Evidence
