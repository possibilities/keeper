## Description

**Size:** S
**Files:** src/board-render.ts, cli/board.ts, test/board.test.ts

Surface armed epics on the board with an `[armed]` pill on explicitly-armed
epic headers (v1: explicit-armed only — matches the screen's armed list and
keeps the board honest about what the human chose; the dep-pulled-in view is
a documented future enhancement).

### Approach

- **`armedPill` helper** (src/board-render.ts, mirror `validatedPill` at :271): `armedPill(isArmed: boolean): string` → `` ` ${pill("armed")}` `` when armed, `""` otherwise (omit-default convention). Route through the existing `pill(token)` (:58) / `iconizePills` (:66) so it picks up the icon theme. Add an `armed` entry to `PILL_COLORS`.
- **Board wiring** (cli/board.ts): subscribe the `armed_epics` collection; in the epic-header assembly (~:741), append `armedPill(armedSet.has(epicId))` alongside `validatedPill(...)`/`slottedSeg`.

### Investigation targets

**Required** (read before coding):
- src/board-render.ts:57-68 (`pill`/`iconizePills`), :271-277 (`validatedPill` — the pattern to mirror), the `PILL_COLORS` table (~:401-460).
- cli/board.ts:715-745 — epic-header assembly + how `snap.epics` / collections are read; :94-101 — board-render imports.

**Optional** (reference as needed):
- test/board.test.ts — board render test harness.

### Risks

- The `armed_epics` collection must be subscribed/diffed for a live board to update (depends on task 1's REGISTRY registration; coordinate rebase with fn-744 which edits the server-worker diff loop).

### Test notes

- Board render test: an epic in `armed_epics` shows `[armed]`; an unarmed epic shows no pill.

## Acceptance

- [ ] `armedPill` helper added (omit-default), routed through `pill`/`iconizePills`, with a `PILL_COLORS` entry.
- [ ] Board subscribes `armed_epics` and renders `[armed]` on explicitly-armed epic headers only.
- [ ] Board render test covers armed vs unarmed.

## Done summary

## Evidence
