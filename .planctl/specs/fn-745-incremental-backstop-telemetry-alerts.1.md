## Description

**Size:** M
**Files:** cli/keeper-watch.ts, scripts/backstop-stats.ts, test/keeper-watch.test.ts, test/backstop-stats.test.ts

### Approach

Two coupled detector fixes in the read-only babysitter, landing together
because the `StatsRow` change exists ONLY to feed the detector windowing.
`detectBackstopTelemetry` stays pure over the read text; the caller
persists. Five rules:

**R1 — Per-rescue samples in `computeStats` (scripts/backstop-stats.ts).**
`computeStats` already collects every rescue's `staleness_ms` into per-bucket
arrays for percentiles (~line 178) — surface the rescue `ts` alongside so the
detector can window. Add `samples: { ts: number; staleness_ms: number | null }[]`
to `StatsRow`, populated in the rescue ingest loop (~145-162) from
`rec.ts`/`rec.staleness_ms`. Keep `computeStats` WATERMARK-AGNOSTIC — it
surfaces all samples; the detector does the windowing. Memory profile is
unchanged in kind (the percentile arrays already hold this). Guard `ts` with
`Number.isFinite` symmetric with the existing `staleness_ms` guard — a
NaN/Infinity `ts` must not poison `max(ts)`. Keep `max`/p50/p95/p99 (the CLI
renderer still shows `max`). ADDITIVE ONLY — `test/backstop-stats.test.ts` is
a second consumer.

**R2 — Staleness windowing (cli/keeper-watch.ts branch (a), ~905-927).** Add
`rescue_watermark_ts: number` to `BackstopBaselineEntry`. Stop triggering
branch (a) on `row.max` (all-history). Instead: among this bucket's samples
with finite `ts > prior.rescue_watermark_ts`, take the max non-null
`staleness_ms`; fire only if `>= STALENESS_ALARM`. Render THAT windowed max in
title/detail/evidence (not the all-history max). Advance the watermark to
`max(finite ts)` over ALL the bucket's rescues this tick — including
null-staleness (cold-boot) rescues: a null-staleness rescue ADVANCES the
watermark (its `ts` was seen) but never ARMS the alarm.

**R3 — Missed-wake on `rescues_total` (branch (b), ~929-973).** Move the
ENTIRE delta-and-reset block from `fires_total` to `rescues_total` — the
`isReset` (`current < baseline`) check, the `delta = current` reset branch,
AND the threshold compare all key off `rescues_total`. Keep `fires_total`
stored in the entry and in the evidence object. Relabel the finding
title/detail from "fired Nx / fires_total rose" to rescue-based wording (e.g.
"rescued Nx / rescues_total rose"); keep `fires_total` in evidence for
continuity. Preserve the existing timeout-vs-missed-wake detail branch (fn-738).

**R4 — Rescue-only-bucket writeback (the gotcha).** Today `nextBuckets[bucket]`
is written ONLY inside the `row.fires_total !== null` guard (~line 931), so a
rescue-only bucket (rescues, no rollup) persists no entry and loses its
watermark every tick. Lift the writeback OUT of that guard: every bucket the
tick sees gets a `nextBuckets` entry carrying at least its
`rescue_watermark_ts`. A rescue-only bucket's counter fields must NOT default
to 0 (a later rollup would compute a phantom delta against 0) — make
`fires_total`/`rescues_total` OPTIONAL on the entry and treat a missing
counter as "seed silently" in branch (b).

**R5 — Version bump + reseed (THE core invariant).** Bump
`BACKSTOP_BASELINE_VERSION` 1 -> 2. On a fresh/reseeded bucket — empty
baseline from the 1->2 version mismatch, a corrupt-file reseed, OR a
`(dev,ino)` identity change — the staleness alarm MUST fire nothing and
instead seed `rescue_watermark_ts` to `max(ts)` seen this tick. Symmetric with
how missed-wake already seeds silently on first observation and how
`(dev,ino)` invalidation fires nothing. Without it the first post-deploy tick
re-pages ALL backstop history — a regression worse than the bug. The watermark
is SUBORDINATE to the `(dev,ino)` identity guard (both needed: identity
invalidates the whole baseline on rotation/restart; the watermark advances
within one file's life). DO NOT touch `COOLDOWN_SECS`.

### Investigation targets

**Required** (read before coding):
- cli/keeper-watch.ts:874-983 — `detectBackstopTelemetry` (pure; caller persists). Branch (a) 905-927, branch (b) 929-973, `next` assembly 976-981.
- cli/keeper-watch.ts:743-746 — `BackstopBaselineEntry` (extend with `rescue_watermark_ts`; make counters optional).
- cli/keeper-watch.ts:762-769, 791-814, 821-843 — `emptyBackstopBaseline` / `loadBackstopBaseline` (version-mismatch reseed at 799) / `saveBackstopBaseline` (sorts bucket keys for byte-identical rewrite — keep determinism; watermark is a scalar, fine).
- cli/keeper-watch.ts:735, 1268, 151 — `BACKSTOP_BASELINE_VERSION`, `COOLDOWN_SECS` (DO NOT change), `FINGERPRINT_VERSION`.
- scripts/backstop-stats.ts:37-57, 145-162, 175-197 — `StatsRow`, rescue ingest loop, row assembly.
- src/backstop-telemetry.ts:102-130 — `BackstopRecord` (`ts`:103, `staleness_ms`:110) / `BackstopRollup` (`fires_total`/`rescues_total`). NO producer change.

**Optional** (reference as needed):
- test/keeper-watch.test.ts:732-951 — detector suite; `rescueLine` fixture (732-749, hardcodes `ts` — add a `ts` override param); `rollupLine` (751-765); `version: 1` baseline literals at 866/884/909/967 (→ `version: 2` + watermark field).
- test/backstop-stats.test.ts:20-168 — second `StatsRow` consumer (additive-only).

### Risks

- **Re-paging history on deploy (highest):** a wrong reseed rule fires every historical rescue on the first post-1->2 tick. Mitigate with R5 + an explicit test (empty/reseeded baseline + old high rescue → no finding, watermark seeded).
- **Phantom missed-wake delta** if a rescue-only bucket seeds counters at 0 and a later rollup diffs against 0. Mitigate with optional counters + seed-silently (R4).
- **Non-monotonic / duplicate `ts`:** the exclusive `ts > watermark` cursor with millisecond-coarse `ts` could skip a same-ms new rescue. Acceptable (rescues are append-ordered, producer wall-clock) — note it, don't over-engineer.
- **Determinism:** `saveBackstopBaseline` sorts bucket keys for byte-identical rewrites; the watermark is a scalar — don't persist unsorted arrays into the entry.

### Test notes

In test/keeper-watch.test.ts give `rescueLine` a `ts` override, then add cases:
- old stale rescue (`ts <= watermark`) + clean later rollups → no `backstop-staleness` across two ticks.
- new rescue (`ts > watermark`) over threshold → fires with the WINDOWED staleness in evidence.
- `fires_total` rises by 10 while `rescues_total` flat → NO `backstop-missed-wake`.
- `rescues_total` rises past `MISSED_WAKE_DELTA` → fires with rescue-delta evidence.
- `(dev,ino)` identity change reseeds silently (watermark too).
- version 1->2 / empty baseline → first tick fires nothing, seeds the watermark.
- null-staleness rescue advances the watermark but does not arm the alarm.
- timeout vs missed-wake detail wording (fn-738) stays intact.
Update the `version: 1` baseline literals (866/884/909/967) to `version: 2` + watermark. Keep test/backstop-stats.test.ts green (additive `StatsRow` field).

## Acceptance

- [ ] `StatsRow` carries per-rescue `{ts, staleness_ms}` samples (additive); `computeStats` stays watermark-agnostic; `test/backstop-stats.test.ts` green
- [ ] `backstop-staleness` fires only on rescues with `ts >` the prior per-bucket watermark; title/detail/evidence show the windowed (not all-history) staleness
- [ ] `BackstopBaselineEntry` carries `rescue_watermark_ts`; rescue-only buckets persist a watermark (writeback lifted out of the `fires_total !== null` guard); rescue-only counters seed-silently (no phantom delta)
- [ ] `backstop-missed-wake` keys the full delta-and-reset block off `rescues_total`; `fires_total` retained in evidence; finding wording relabeled to rescues; timeout-vs-missed-wake branch intact
- [ ] `BACKSTOP_BASELINE_VERSION` bumped 1->2; first tick after reseed / identity change fires nothing and seeds the watermark to max `ts` seen
- [ ] repeated `keeper-watch` over an unchanged `backstop.ndjson` regenerates no staleness followup for an old rescue
- [ ] `Number.isFinite` guards on `ts`; `COOLDOWN_SECS` unchanged
- [ ] `bun test test/keeper-watch.test.ts test/backstop-stats.test.ts` passes

## Done summary
Made both keeper-watch backstop detectors incremental: staleness alarm now windows on a per-(backstop,class) rescue-ts high-watermark (one old resolved rescue no longer re-pages), and the missed-wake delta keys off rescues_total instead of fires_total. Bumped BACKSTOP_BASELINE_VERSION 1->2 for a silent reseed (first tick fires nothing, seeds the watermark); rescue-only buckets persist a watermark with optional counters. StatsRow gained additive per-rescue {ts, staleness_ms} samples.
## Evidence
