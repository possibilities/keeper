## Description

**Size:** S
**Files:** src/view-shell.ts, src/live-shell-core.ts, test/live-shell-core.test.ts

The connecting-indicator spinner (`tickConnectingSpinner`) currently calls
`liveShell.pushFrame([formatRefoldLine(glyph)])`, appending every ~125ms
tick to the history ring. It should use the ephemeral `refreshLive` overlay
instead (single-slot, no history growth, auto-cleared by the next real
`pushFrame`).

### Approach

1. `src/view-shell.ts:306` — change `liveShell.pushFrame(...)` to
   `liveShell.refreshLive(...)` in `tickConnectingSpinner`. Update the two
   spinner doc-comments that describe it as minting frames.
2. `src/live-shell-core.ts` `visibleRows()` (~276–284) — the empty-history
   branch returns `[]` and ignores the overlay, which would make the
   spinner invisible during connect (history is empty then). Change the
   `history.length === 0` branch to `return liveOverlay ?? []`. Cold start
   with no overlay still returns `[]`.
3. `src/live-shell-core.ts` passthrough `refreshLive` (~191–194) — currently
   a silent no-op; make it write plain via `onPlainWrite` exactly like
   passthrough `pushFrame`, so the spinner still emits when non-TTY/piped
   and the view-shell tests that observe spinner text via stdout keep
   working. Safe: the only other `refreshLive` caller (`repaintLocal`) is
   key-driven and passthrough `feedStdin` is a no-op, so it can never fire
   in passthrough. Update the comment.
4. Add a `test/live-shell-core.test.ts` regression: on empty history,
   `refreshLive([...])` then `visibleRows()` returns the overlay AND
   `historyLen()` stays 0.

### Investigation targets

**Required** (read before coding):
- src/view-shell.ts:286-307 — `tickConnectingSpinner`, the pushFrame call site
- src/live-shell-core.ts:276-284 — `visibleRows` empty-history branch
- src/live-shell-core.ts:191-194 — passthrough `refreshLive` no-op
- src/live-shell-core.ts:485-514 — `pushFrame` / `refreshLive` (history vs overlay)
- test/view-shell.test.ts:140-360 — passthrough stdout spinner-observation tests
- test/live-shell-core.test.ts:125-132,319-338 — cold-start + refreshLive coverage

## Acceptance

- [ ] Spinner ticks repaint via `refreshLive`; `historyLen()` stays 0 until
  the first real data frame, which is `frame 1`.
- [ ] During connect the spinner still paints (overlay honored on empty history).
- [ ] Non-TTY/passthrough still emits the spinner line; existing
  view-shell.test.ts spinner assertions pass.
- [ ] New live-shell-core regression test covers empty-history overlay + no
  history growth.
- [ ] `bun test test/view-shell.test.ts test/live-shell-core.test.ts` green.

## Done summary
Routed the connecting spinner through the ephemeral refreshLive overlay instead of pushFrame: ticks no longer grow the history ring, visibleRows honors the overlay on empty history so connect still paints, and passthrough refreshLive now emits plain for non-TTY stdout. Added a live-shell-core regression for empty-history overlay + zero history growth.
## Evidence
