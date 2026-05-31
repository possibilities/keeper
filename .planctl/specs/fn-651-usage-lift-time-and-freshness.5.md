## Description

**Size:** M
**Files:** cli/usage.ts, README.md, test/usage.test.ts

### Approach

Render the lift countdown and a freshness warning.

1. **Lift countdown.** On the rate-limited line, show
   "rate-limited for <rel>" where `<rel> = relTime(rate_limit_lifts_at,
   nowMs)` (the ISO variant — already renders future times bare, e.g.
   "1h 2m"). Replace the current fired-time display.
2. **n/a + past-reset guard.** When `rate_limit_lifts_at` is null OR
   already `<= now`, render `n/a` — NEVER a "<rel> ago" countdown. Do
   not fall back to the fired-time (`last_rate_limit_at`).
3. **Staleness warning.** When `last_usage_fold_at` is older than a
   threshold (a single const, e.g. ~15-30m — tune to agentuse's normal
   fetch cadence), render a per-row staleness marker (e.g. a `stale Nm`
   tag) so a wedged ingestion path is visible. Drive this ONLY off
   `last_usage_fold_at` age — never `updated_at` (rate-limit folds bump
   it) and never agentuse's own `status`. Keep stale / idle / rate-
   limited as visually distinct states.
4. **Change-gate.** Add `r.rate_limit_lifts_at` and
   `r.last_usage_fold_at` to `usageRowsHashKey` (~ln 671-697) or
   lift-only / freshness-only changes won't repaint.
5. **codex.** Keep the existing `isCodex` suppression for the
   rate-limit line.
6. **Docs.** cli/usage.ts header JSDoc + `HELP`; README `usage` block.

### Investigation targets

**Required** (verify against the live `cli/usage.ts` — fn-646 is mid-edit on it):
- cli/usage.ts — `renderRowLines` / `RowCells`, `rlRel` computation, `renderRateLimit`, the label-pool width math, `relTime` (ISO future-bare) and `relTimeFromUnixSec`.
- cli/usage.ts ~ln 671-697 — `usageRowsHashKey` (change-gate).
- cli/usage.ts ~ln 275 — the redaction filter (now populated after task .1) + the status-chip render (context for where staleness sits).

**Optional:**
- test/usage.test.ts ~ln 420-524 — existing rate-limited render tests (omit-when-NULL, omit-for-codex, alignment) as the template.

### Risks

- **Past-reset guard** — `relTime` renders past times as "<rel> ago"; the lift line must intercept `target <= now` → `n/a`, not show "ago".
- **Change-gate omission** — silent staleness bug; add both columns to the hash.
- **Threshold tuning** — too low → false "stale" on quiet periods; align to agentuse's fetch cadence. Make it a single named const.
- **fn-646 conflict** — it is editing `cli/usage.ts`; coordinate / land after.
- **Width/alignment** — the `n/a`, "for <rel>", and staleness tag must fit the existing label-pool width math.

### Test notes

Render: future `rate_limit_lifts_at` → "rate-limited for Nh Mm"; null OR
past → `n/a` (assert NO "ago"); codex omits; old `last_usage_fold_at` →
staleness marker, fresh → none; the change-gate hash includes both new
columns.

## Acceptance

- [ ] Rate-limited line renders "rate-limited for <rel>" when lift is known and future; `n/a` when null or past; never "<rel> ago", never the fired-time.
- [ ] A row stale per `last_usage_fold_at` age shows a distinct staleness marker (driven only by that stamp); stale/idle/rate-limited stay visually distinct.
- [ ] `usageRowsHashKey` includes `rate_limit_lifts_at` + `last_usage_fold_at`; codex still omits the rate-limit line.
- [ ] cli/usage.ts header/HELP + README updated; render tests pass.

## Done summary
Render v41 lift countdown ('rate-limited for <rel>') with past-reset guard ('n/a'), add per-row staleness warning ('stale Nm') driven off last_usage_fold_at against a 15m threshold, gate frame repaints on both new columns. Tests + README + JSDoc updated.
## Evidence
