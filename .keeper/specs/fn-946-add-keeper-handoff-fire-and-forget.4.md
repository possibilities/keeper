## Description

**Size:** S
**Files:** cli/board.ts, src/icon-theme.ts, src/dash/view-model.ts

### Approach

Surface the handoff-er→handoff-ee relationship. Add `renderHandoffLinkLines` in
`cli/board.ts` as a sibling of `renderJobLinkLines` — render the handoff links on
the job/session surface (a handoff has no epic header to sit under), e.g. a
top-level handoffs grouping or on the job row, showing the peer label + a
`[handoff-from]`/`[handoff-to]` pill + the peer's state pill (the enriched
`HandoffLinkEntry` already carries title/state). Add a handoff glyph pair to
`src/icon-theme.ts` (next to creator/refiner), theme-keyed, with a missing-glyph
fallback for the from-side-unknown (null `initiator_job_id`) case. Add a minimal
relation badge on the dash `CardVM` (`src/dash/view-model.ts`) — GREENFIELD, the
dash renders NO relationships today, so build a small badge reading the job's
handoff link (e.g. "↰ from <initiator>" / "↳ handed off"). Render-only — the
links are already folded by tasks .2 + .3; do NOT touch the reducer.

### Investigation targets

**Required** (read before coding):
- cli/board.ts:270-303 — renderJobLinkLines (the sibling to mirror) + :487 call site
- src/icon-theme.ts:113-117 — creator/refiner glyph pairs + the glyphForToken/iconizeToken path
- src/dash/view-model.ts:209 — CardVM interface + :279 buildCard
- src/types.ts — HandoffLinkEntry (the shape being rendered)

**Optional** (reference as needed):
- src/board-render.ts:52-60 — pill/iconizeToken helpers; PILL_COLORS (relationship pills are uncolored by convention)

### Risks

- The dash badge is greenfield (no precedent) — keep it minimal; do NOT overbuild a relationship subsystem.
- The missing-glyph / null-initiator fallback must render cleanly (the from-side can be unknown).
- Render reads, does not fold — but do NOT accidentally re-sort the stored link arrays at render time.

### Test notes

- board.test.ts: renderHandoffLinkLines over a synthetic enriched HandoffLinkEntry set → expected lines; null-initiator renders the fallback.
- A dash view-model test that a card with a handoff link surfaces the badge.

## Acceptance

- [ ] renderHandoffLinkLines renders handoff-from/handoff-to links with peer label + pill + state on the board
- [ ] handoff glyph pair in icon-theme; missing-glyph / null-initiator fallback present
- [ ] dash CardVM shows a minimal handoff relation badge
- [ ] render-only (no reducer change); test:full green

## Done summary

## Evidence
