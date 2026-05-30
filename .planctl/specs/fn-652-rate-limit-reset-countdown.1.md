## Description

**Size:** M
**Files:** src/api-error-reset.ts (new), test/api-error-reset.test.ts (new)

### Approach

Net-new pure module exporting a single total function, the keystone of
the epic:

```
parseRateLimitResetAt(text: string, anchorUnixSec: number): number | null
```

It extracts the lift time from a Claude Code rate-limit message
("…resets 3:20am (America/New_York)") and returns an absolute
unix-SECONDS timestamp, or `null` on any failure. It NEVER throws and
NEVER reads the wall clock — the `anchorUnixSec` parameter is the
determinism boundary (callers pass the event's own `ts`).

Algorithm:
1. **Strict regex.** Match the known shape only — roughly
   `/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+\(([A-Za-z0-9_\/+\-]+)\)/i`.
   Any mismatch → return `null` immediately (the message wording is
   only "typically" stable; never coerce).
2. **12h→24h.** `12am`→0, `12pm`→12, else `pm ? h+12 : h`. Minutes
   group absent ("resets 3am") → 0, never `NaN`.
3. **Wall-clock → epoch via two-pass inverse-Intl** so DST is resolved
   by ICU, not a snapshotted offset. Build an `Intl.DateTimeFormat`
   with `{ timeZone, hourCycle: 'h23', locale 'en-CA', year..second }`,
   derive "today in zone" from `anchorUnixSec`, compute the candidate
   instant, then a second pass to correct any DST offset shift.
4. **Next future occurrence anchored on `anchorUnixSec`.** If the
   candidate epoch ≤ anchor, roll the calendar day +1 (via
   `Date.UTC(y, m, d+1)` normalization — NOT `+86_400_000`) and
   recompute.
5. **Guards:** wrap `new Intl.DateTimeFormat(...)` in try/catch (invalid
   IANA zone → `null`); collapse any `NaN` to `null`; if the result is
   more than ~1 day behind the anchor, treat it as a mis-parse → `null`
   (a few seconds behind, from clock skew, is fine to return as-is).

Keep the module dependency-free (Intl only — no Temporal, no
date-fns/luxon) so it stays importable from the transcript worker
without dragging in worker-thread or third-party deps.

### Investigation targets

**Required** (read before coding):
- src/transcript-worker.ts ~ln 92-99 — the example reset string + the "doesn't parse" docstring this epic reverses.
- The epic's `## Best practices` section — the Intl/DST/hourCycle/two-pass gotchas are load-bearing.

**Optional:**
- Grep src/ for any existing `Intl` / `new Date` usage — confirms this is greenfield (no reusable tz helper exists).

### Risks

- **Highest-risk item in the epic.** Verify `Intl.DateTimeFormat` with a `timeZone` option + `formatToParts` + `hourCycle:'h23'` actually works under the project's Bun/JSC version BEFORE building on it — there is no fallback date library.
- DST spring-forward gap / fall-back overlap correctness — the two-pass method must land on a sane instant (slightly-later for gaps, slightly-earlier for overlaps are both acceptable for a reset).
- Format fragility — the parser silently no-ops (returns null) if Claude changes the wording; that's acceptable (the renderer shows `n/a`), but capture multiple real wordings as fixtures.

### Test notes

Table-driven, fully deterministic via a fixed `anchorUnixSec` per case
(no `Date.now()` in tests). Cover: am/pm, `12am`/`12pm`, minutes-optional
("resets 3am"), invalid/unknown IANA zone → null, total garbage → null,
next-occurrence rollover (reset clock already past the anchor that day →
+1 day), a DST-transition day in `America/New_York`, and a >1-day-behind
mis-parse → null. New file `test/api-error-reset.test.ts`.

## Acceptance

- [ ] `parseRateLimitResetAt(text, anchorUnixSec)` returns absolute unix-seconds for a well-formed reset clock and `null` for any malformed/absent/unknown-zone input, and never throws.
- [ ] "Next occurrence" is computed relative to `anchorUnixSec` (not `Date.now()`); the same `(text, anchor)` always yields the same result.
- [ ] 12-hour edge cases (`12am`=00:00, `12pm`=12:00) and minutes-optional inputs parse correctly; DST-boundary inputs land on a sane instant.
- [ ] Module is Intl-only (no third-party / Temporal deps) and importable from `src/transcript-worker.ts`.
- [ ] `test/api-error-reset.test.ts` covers the table above and passes.

## Done summary

## Evidence
