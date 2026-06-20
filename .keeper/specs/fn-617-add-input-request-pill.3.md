## Description

**Size:** S
**Files:** `scripts/board.ts`, `test/board.test.ts`, `README.md`

### Approach

Land the `[awaiting:<kind>]` pill in `warn` (yellow) and update README.
Three structural moves in `scripts/board.ts`, one set of README revisions.

1. **`inputRequestPillSeg(at, kind)`**: returns `" [awaiting:<kind>]"`
   when `at != null`, else `""`. Mirrors `rateLimitedPillSeg` / fn-616's
   `apiErrorPillSeg` exactly.
2. **Colorizer prefix fallback**: extend `colorizePillsInLine()`
   alongside the existing `blocked:*` (warn) and fn-616's `failed:*`
   (error) branches. New branch: `inner.startsWith("awaiting:")` →
   `warn` bucket. Standard 16-color ANSI; don't add `awaiting:ask_user_question`
   as a literal `PILL_COLORS` key — the prefix fallback handles all
   future kinds.
3. **Three call-site wires**: `renderJobLinkLines`, `renderJobLines`,
   `projectJobRow`. Pill stacking order:
   `[state] [limited]? [failed:<kind>]? [awaiting:<kind>]?` — the
   awaiting pill stacks LAST so a single row carrying all three
   annotations reads in lifecycle order (state → rate-limited →
   api-error → awaiting).
4. **README revisions** (in-place rewrites, not appends — follow the
   docs-gap-scout's "do not accumulate As-of-vN clauses" rule):
   - "What keeper is" jobs state enum (~line 10): consolidate with
     existing rate-limit / api-error mention.
   - Architecture transcript-worker paragraph (~lines 454-461): splice
     `InputRequest` alongside `TranscriptTitle` / `RateLimited`.
   - Architecture schema version callout + jobs column list (~lines
     473-491): add both new columns with clear-on semantics.
   - Example clients board pill vocabulary (~lines 295-315): add
     `[awaiting:<kind>]` (warn / yellow) to the bracketed enumeration.
   - Inspect jobs SELECT comment (~line 578): add column names if the
     default query carries them.
5. **HELP text + module-level docstring + `renderJobLinkLines` JSDoc**
   in `scripts/board.ts`: describe `[awaiting:<kind>]` and the
   `awaiting:*` prefix fallback alongside the existing pill vocabulary.

### Investigation targets

**Required** (read before coding):
- `scripts/board.ts:212-225` — `rateLimitedPillSeg()` structural template.
- `scripts/board.ts:253-282` — `SGR` + `PILL_COLORS` + bucket rationale.
- `scripts/board.ts:296-307` — `colorizePillsInLine` + the `blocked:*`
  prefix fallback (and post-fn-616, the `failed:*` fallback).
- `scripts/board.ts:338-351` — `renderJobLinkLines` call site.
- `scripts/board.ts:419-437` — `renderJobLines` call site.
- `scripts/board.ts:537-544` — `projectJobRow` call site.
- `scripts/board.ts:83-162` — HELP text + module-level docstring.

**Optional** (reference as needed):
- `test/board.test.ts` — existing `rateLimitedPillSeg` + `[limited]`
  pill tests + `colorizePillsInLine` colorizer test — mirror shape.
- `README.md` lines 10, 295-315, 454-491, 578 — the exact in-place
  edit sites.

### Risks

- **Pill stacking order drift**: if a future change reorders pills
  the rate-limit / api-error / awaiting stack must stay in lifecycle
  order; a snapshot test on a row with all three annotations pins
  the order.
- **README drift**: docs-gap-scout flagged a "revise, don't append"
  rule. Appending `As-of-vN` clauses on each schema bump accumulates
  cruft; consolidate every touchpoint.

### Test notes

- `inputRequestPillSeg` unit: returns `""` on null, `" [awaiting:<kind>]"`
  otherwise.
- `colorizePillsInLine`: `[awaiting:ask_user_question]` renders in
  `warn` (yellow `\x1b[33m`) via the prefix fallback; assert the
  inner-token SGR sequence.
- `renderJobLinkLines` / `renderJobLines` / `projectJobRow`: a row
  with non-null pair renders the new pill in the correct stack
  position; null pair omits it.
- Stacking snapshot: a row with all three annotations renders
  `[stopped] [limited] [failed:rate_limit] [awaiting:ask_user_question]`.

## Acceptance

- [ ] `inputRequestPillSeg(at, kind)` implemented and wired into the
      three call sites.
- [ ] `colorizePillsInLine` carries the `awaiting:*` → `warn` prefix
      fallback.
- [ ] Stacking order is `[state] [limited]? [failed:<kind>]? [awaiting:<kind>]?`.
- [ ] README revised in the five locations docs-gap-scout flagged —
      in-place rewrites, not appends.
- [ ] HELP text + module-level docstring + `renderJobLinkLines` JSDoc
      updated.
- [ ] `bun test` passes; new board tests cover the segment, colorizer,
      three call sites, and stacking-order snapshot.

## Done summary
Wired inputRequestPillSeg into renderJobLinkLines / renderJobLines / projectJobRow; extended colorizePillsInLine with the awaiting:* → warn prefix fallback; added tests for the segment + colorizer + stacking-order snapshot (state → failed → awaiting); revised the five README touchpoints in-place per docs-gap-scout.
## Evidence
