## Description

**Size:** S
**Files:** cli/status.ts, src/board-render.ts, cli/board.ts, test/status.test.ts, test/board.test.ts

### Approach

Surface the selection-review flag as a new DISPLAY-ONLY needs-human class. keeper status
gains needs_human.selection_reviews counting epics with a non-null review flag
REGARDLESS of open/closed status — an un-cleared review must outlive its epic's close.
The counter contributes ZERO to needs_human.total and never flips jammed; encode that in
the status fixture and bump the status schema version. The board's needs-human block
renders one line per flagged epic (epic id, verdict counts, and the clear-verb hint),
sourced so a CLOSED epic still renders — pin the data source: if the epics
snapshot/subscription feeding the block is open-filtered, add the narrow unfiltered read
rather than widening the board's default row filter. Nothing in this surface may gate
dispatch, close, or autoclose.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/status.ts:193-210 and :344-362 — needs_human shape, needsHumanTotal, jammed; the finalize_non_ff exclusion precedent
- src/board-render.ts:382-433 — needsHumanLines block + the open-status board filter
- test/status.test.ts — the fixture pinning the envelope shape

**Optional** (reference as needed):
- cli/board.ts:661-665 — the needs-human banner count feed
- src/collections.ts — how the board subscribes epics

### Risks

- The closed-epic visibility requirement is the one place the parked-question precedent
  does not carry — verify the render path with a flagged closed epic before calling it done.

### Test notes

Status fixture: flagged open epic, flagged closed epic, cleared epic; assert total and
jammed unchanged in all three. Board render unit with a flagged closed epic producing a
needs-human line.

## Acceptance

- [ ] A flagged CLOSED epic renders in the board needs-human block and counts in
      needs_human.selection_reviews.
- [ ] The flag never changes needs_human.total or jammed, pinned by the status fixture
      across flagged/cleared/closed variants.
- [ ] Clearing the review removes the board line and the count on the next snapshot.

## Done summary
Surface the close-time selection-review flag as a display-only needs-human class: keeper status gains needs_human.selection_reviews (schema v6, zero into total/jammed) and the board renders a 'selection review' block, both sourced from a new epics_selection_review narrow unfiltered read so a flagged CLOSED epic outlives its epic's close.
## Evidence
