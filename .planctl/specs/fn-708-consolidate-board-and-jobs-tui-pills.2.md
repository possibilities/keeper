## Description

**Size:** M
**Files:** cli/board.ts, test/board.test.ts, README.md

### Approach

Replace the inline pill assembly in `cli/board.ts:renderEpicBlock` with
the pure helpers from task `.1`: the task line uses `renderTaskPills`,
the close row uses `renderClosePills` (no `[status]`), the epic header
uses the omit-default `validatedPill` (drop `[unvalidated]`), and the
embedded creator/refiner + job lines drop `[stopped]` via the shared
state omit-default. Append the board footer-legend constant to
`bodyLines` (so it reaches both live and sidecar/piped output). Apply the
sanctioned presentation polish — reorder pills/segments and spacing for
clarity where it stays lossless (e.g. keeping the verdict as the row
anchor); do not adopt fixed-width slots. Revise the board HELP constant
and the README board client bullet (and the adjacent jobs bullet, to
keep the shared convention in one place) to the new shapes + the
absence-encodes-default legend. Update the existing board tests.

### Investigation targets

**Required** (read before coding):
- ~/docs/pill-inventory.md — Part 4 board render spec (epic header / task line / close row / link lines / subagent lines)
- cli/board.ts:642-767 — `renderEpicBlock` (task line 743-752, close row 761-765, epic header 715, embedded `renderJobLines` 587-624, `renderJobLinkLines` 513-549)
- cli/board.ts:130-259 — HELP constant (row-shape doc to revise in place)
- cli/board.ts:800-806 — `renderBody` (where the legend line is appended to bodyLines)
- src/board-render.ts — the task-.1 helpers + legend constant to consume

**Optional** (reference as needed):
- README.md:685-849 — ## Example clients (board + jobs bullets to revise/consolidate)
- src/view-shell.ts:455-480 — bodyLines → sidecar/piped frame text (confirms the legend is captured in piped output)

### Risks

- test/board.test.ts asserts pill shapes as exact full-line strings — expect broad, mostly-mechanical updates; don't let a missed fixture mask a real shape regression.
- Legend must be a body line (renderBody/bodyLines), NOT `liveShell.setStatus` (the transient banner is not in piped output).

### Test notes

Update every affected board assertion to the new shapes; verify the
common-row reductions from the design (waiting task 5→2 pills; completed
task 4→2; close row 3→1). Add a test that the legend line is present in
bodyLines.

## Acceptance

- [ ] Board task line, close row, epic header, and embedded/link lines render via the task-.1 helpers with defaults omitted
- [ ] Close-row `[status]` pill gone; `[unvalidated]` gone; `[stopped]` gone on embedded/link lines
- [ ] Board footer legend appended to bodyLines (present in live + sidecar output)
- [ ] Sanctioned pill/line reordering applied where it improves clarity, still lossless; no fixed-width slots
- [ ] Board HELP + README board/jobs client passages revised in place to the new shapes
- [ ] test/board.test.ts green; bun run typecheck clean

## Done summary

## Evidence
