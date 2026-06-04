## Description

**Size:** M
**Files:** src/board-render.ts, cli/board.ts, test/board.test.ts, README.md

### Approach

Two board-side changes, both honoring "show it blocked, don't hide."

(1) **`epic-no-tasks` pill.** Once task `.1` lands, `formatPill` produces
`[blocked:epic-no-tasks]` and `colorizePillsInLine` auto-warns it via the
generic `blocked:` prefix branch (`src/board-render.ts:321`) — no render
code change. Add a test asserting `formatPill` / `colorizePillsInLine` on
the `epic-no-tasks` verdict produce the expected `[blocked:epic-no-tasks]`
string + warn color (fits the existing `colorizePillsInLine` test block at
`test/board.test.ts:943`).

(2) **Header legibility.** Today the epic header (`cli/board.ts:697`,
inside the non-exported `renderEpicBlock` closure) builds
`${seg(row.epic_number)} ${seg(row.title)}`, which collapses to a blank
`(keeper)  [unvalidated]` line when both are null (the pre-EpicSnapshot
stub). Extract a small **pure header-assembly helper into
`src/board-render.ts`** (mirroring the `renderJobLinkLines` /
`subagentLinesFor` extractions already done for testability) that falls
back to `seg(row.epic_id)` when `epic_number`/`title` are null (`epic_id`
is non-null on the `Epic` projection — type-safe), wire `renderEpicBlock`
to call it, and unit-test the helper directly. Reuse the existing `seg`
coalescer (`:562`) and `epicId` (`:682`); do not write new null checks. Do
NOT hide any epic row.

Also update the `cli/board.ts` module doc-comment (header-format line +
pill vocabulary) and README BlockReason vocabulary to name
`epic-no-tasks` and the header fallback.

### Investigation targets

**Required** (read before coding):
- cli/board.ts:629-749 — `renderEpicBlock`; header assembly at `:697`;
  `epicId` at `:682`; `seg` at `:562`.
- src/board-render.ts — existing pure-helper extractions
  (`renderJobLinkLines`, `subagentLinesFor`) as the pattern to mirror;
  `colorizePillsInLine` at `:305`, blocked:→warn branch at `:321`.
- test/board.test.ts — fixture builders, exact-string assertions;
  `colorizePillsInLine` test block ~`:943`.
- src/types.ts:1033 — `Epic` projection (`epic_id: string` non-null;
  `epic_number` / `title` nullable).

**Optional** (reference as needed):
- cli/board.ts:150-263 — module doc-comment (header format + pill vocab).

### Risks

- **`renderEpicBlock` is a non-exported closure** — not directly testable.
  Mitigate by extracting the header-assembly into an exported pure helper
  in `src/board-render.ts` (established precedent), not by testing through
  the full subscribe loop.
- Keep the change render-only; do not hide any epic row (show-blocked, not
  hide).

### Test notes

- Header-helper: a stub row (`epic_number=null`, `title=null`, `epic_id`
  set) renders a labeled header using `epic_id`, with the
  `[unvalidated]` / `[blocked:…]` pills — assert NO blank header.
- Header-helper: a normal row (`epic_number`+`title` set) renders
  unchanged (regression).
- Pill: `colorizePillsInLine("[blocked:epic-no-tasks]")` warns;
  `formatPill(<blocked epic-no-tasks>)` === `"[blocked:epic-no-tasks]"`.

## Acceptance

- [ ] Pure header-assembly helper extracted to `src/board-render.ts` with
  `epic_id` fallback when `epic_number`/`title` are null.
- [ ] `renderEpicBlock` wired to the helper; normal rows render unchanged.
- [ ] A stub epic (null number/title) renders a legible, clearly-blocked
  header — no blank `(keeper)  [unvalidated]` line; row not hidden.
- [ ] `colorizePillsInLine` / `formatPill` produce `[blocked:epic-no-tasks]`
  correctly (warn color).
- [ ] `cli/board.ts` doc-comment + README BlockReason vocab updated for the
  header fallback + `epic-no-tasks`.
- [ ] `bun test test/board.test.ts` passes.

## Done summary
Extracted pure epicHeaderLabel helper to src/board-render.ts (epic_id fallback when epic_number/title are null), wired renderEpicBlock to it, and tested the helper plus the [blocked:epic-no-tasks] formatPill/colorize contract. Updated cli/board.ts doc-comment and README BlockReason vocab.
## Evidence
