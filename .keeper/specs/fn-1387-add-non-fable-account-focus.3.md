## Description

**Size:** S
**Files:** cli/board.ts, test/board.test.ts, test/clipboard-debug.test.ts, test/view-shell.test.ts, test/live-shell.test.ts

### Approach

Add a full-label `Non-Fable focus` peer section immediately after `Fable focus` in the canonical semantic header. Off state collapses to `Non-Fable focus: off`; configured or unavailable state renders target account route, permanent/absolute lifetime, current eligibility, effective routing state, and scoped delivery diagnostic using the existing unlimited word wrapping with no abbreviation, condensation, ellipsis, or ANSI in evidence output.

Project the Non-Fable durable cell from the existing `autopilot_state` subscription and join it with one generic/non-Fable Capacity inspection. Preserve the independently computed Fable view. Feed both exact view models into board frame state so live, snapshot, frames, sidecars, copied diagnostics, resize, and history use the same semantic rows.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `cli/board.ts:422-474` — complete semantic row wrapping without truncation.
- `cli/board.ts:476-560` — current full-label Fable section and autopilot/summary composition.
- `cli/board.ts:1405-1413,1505-1556` — frame-state input and subscribed Projection/live-observation join.
- `src/view-shell.ts:233-238,1310-1312,1518-1538` — shared semantic-header evidence path.
- `test/board.test.ts:337-438` — wide/narrow, fallback, unavailable, and no-condensation assertions.

**Optional** (reference as needed):
- `test/clipboard-debug.test.ts:6-22` — accepted plain semantic header in copied diagnostics.
- `test/view-shell.test.ts:933-948,1395-1408` — snapshot/frame header parity.

### Risks

- A generic inspection accidentally run with Fable intent could make one section report the other's eligibility/outcome.
- More pinned rows reduce body height; existing live-shell geometry must continue deriving from the actual wrapped row count.
- Updating only board tests would leave copied/frame fixtures stale.

### Test notes

Cover both off, one active, both active same target, both active different targets, Non-Fable fallback/unavailable/expired, Fable unaffected by Non-Fable delivery failure, wide and narrow wrapping, live resize, snapshot/frame/copy parity, and structured frame-state identity.

### Detailed phases

1. Extend header/frame view models with the second scoped inspection.
2. Render the peer section with shared full-label helpers and independent diagnostics.
3. Update board and cross-output fixtures at wide/narrow widths and resize transitions.

### Alternatives

Combining both focuses into one compact line or abbreviating Non-Fable would recreate the readability problem the verbose header fixed. A body-only section would scroll away and diverge from snapshots/frames.

### Non-functional targets

- Header formatting remains pure for one `{dualFocusView, width, now}` input.
- All semantic text remains full-label, PII-free, control-safe, and width-wrapped without data loss.

### Rollout

The new off row is visible before activation, making absence of policy explicit. Rendering requires no live mutation.

## Acceptance

- [ ] The board always renders a full `Non-Fable focus` peer section after Fable focus, collapsing only a clean off state to one line.
- [ ] Active/unavailable Non-Fable state shows stable target, lifetime, eligibility, effective focused/fallback state, and scoped diagnostic without abbreviation or truncation.
- [ ] Fable and Non-Fable sections use independently projected policies and correctly scoped live eligibility.
- [ ] Live, snapshot, frames, sidecars, copied diagnostics, structured frame state, and resize all carry identical semantic information.
- [ ] Existing summary/autopilot fields and body navigation remain correct with the increased dynamic header height.
- [ ] Named board, clipboard, view-shell, and live-shell tests pass.

## Done summary

## Evidence
