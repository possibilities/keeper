## Description

**Size:** S
**Files:** src/transcript/claude.ts, test/transcript-cli.test.ts

### Approach

`encodeClaudeProject` must reproduce Claude Code's real bucket naming: `resolve(project)`
then replace EVERY character outside `[A-Za-z0-9]` with `-` — one dash per character,
non-collapsing (adjacent specials produce adjacent dashes). Today it replaces only the
path separator, so any dotted/underscored project path (keeper's own worktree lanes are
`<slug>.N`) silently matches zero sessions in both discovery paths (`findClaudeSession`
and `scanSessionFiles` route through `projectDirs`). One regex change fixes both; the
real work is the regression fixture that cannot co-move with the encoder.

Give the test helper an explicit literal-bucket override (or a sibling helper) and write
fixtures into HARD-CODED bucket directory names: one dotted worktree-lane-like path, and
one with adjacent non-alphanumerics (e.g. `_.`) so a future "cleanup" cannot silently
reintroduce run-collapsing. Existing dotless fixtures (`/work/alpha`) must be unaffected.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/transcript/claude.ts:110 — encodeClaudeProject, the single chokepoint
- src/transcript/claude.ts:140-149 — projectDirs: both list and show consume the encoder
- test/transcript-cli.test.ts:49-62 — writeSession derives its bucket via the encoder under test (the bug-hiding co-move to break)

**Optional** (reference as needed):
- cli/transcript.ts:377-380 — default cwd scope, the blast-radius call site

### Risks

- Legacy dot-preserving buckets from older Claude Code builds exist on disk (observed: one May-era bucket, zero sessions). The char-class encoder will not find those; accepted — current Claude Code writes dashed buckets.

### Test notes

Follow the hermetic fixture pattern (mkdtempSync + injected deps + utimesSync). The
regression assertion compares against a literal on-disk bucket string, never a value
computed by encodeClaudeProject.

## Acceptance

- [ ] Listing and showing with a project path containing dots/underscores returns the sessions Claude Code stored for that path, proven by a fixture written to a hard-coded literal bucket name
- [ ] The encoder converts every non-alphanumeric character to a dash, one dash per character, with adjacent specials yielding adjacent dashes
- [ ] No test derives its expected bucket name via the encoder under test
- [ ] Existing transcript CLI tests stay green

## Done summary

## Evidence
