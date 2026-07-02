## Description

**Size:** M
**Files:** src/usage-picker.ts, src/usage-flock.ts, src/keeper-state-dir.ts, test/usage-picker.test.ts, test/usage-picker.slow.test.ts

### Approach

Replace the stride-scheduling core of `pickProfile` with two independent mechanisms inside the existing flock-guarded read-modify-write in `doPickProfile`: a hard admission gate decides who is allowed; pure LRU decides whose turn. Per pick, inside the lock: load state, reconcile `pending` for EVERY subscribed profile (strict-equality compare of stored `seen_fetch_at` vs envelope `last_successful_fetch_at`, `null` included — `null == null` is unchanged; on change reset `pending` to 0 and store the new stamp), compute the gate, pick by LRU, record the winner (stamp `last_picked_at` via `localIsoWithOffset`, increment `pending`), and persist ALL reconciliations plus the winner in one atomic write.

Ladder — each rung LRU-ordered (oldest `last_picked_at` first; absent/corrupt/tz-naive stamp sorts as epoch-oldest, never throws; ties by name), first non-empty rung wins:

1. **Admitted**: unparked (existing `lift_at`-future + usage-endpoint-throttle checks) AND `effective_session < SESSION_BUFFER (80)` AND `effective_week < WEEK_BUFFER (95)`, where `effective_X = percent_X + pending * STEP_X / multiplier` (STEP_SESSION = 5, STEP_WEEK = 1; reuse the existing `multiplier()` coercion as the divisor).
2. **Overflow**: unparked AND `effective_session < SESSION_OVERFLOW (90)` AND `effective_week < WEEK_OVERFLOW (98)`.
3. **Any unparked** — thresholds dropped. This is the designed degradation: a stalled scraper (frozen `last_successful_fetch_at`, accumulating `pending`) lands the fleet here, i.e. plain rotation. No cap on `pending` — this rung is the liveness backstop.
4. **All subscribed** including parked (today's `includeRateLimited` fallback).
5. `DEFAULT_PROFILE` only when zero subscribed profiles — return WITHOUT writing state (preserves the existing no-eligible-no-write behavior).

Expose all four thresholds + both STEPs as named constants at the top of the module. Gate inputs are defensive: `percent_used` null/missing/non-number counts as 0 (a fleet with no scrape data collapses to plain LRU); `sonnet_week` is deliberately not gated (model-specific window). Rollover grace: per window, when `usage.<window>.resets_at` is a tz-aware PAST instant (reuse the `hasTimezone` + parse discipline of `isRateLimitedNow`), treat that window's scraped percent as 0; naive/unparseable `resets_at` means no grace; grace never touches `pending` (it self-clears on the next scrape).

Ledger v2: bump `PICKER_SCHEMA_VERSION` to 2; per-profile state `{last_picked_at, pending, seen_fetch_at}`; delete `counts()`, `seedNewEntrants()` (an absent entry sorts oldest, so a new profile naturally wins one catch-up turn), `effectiveWeight()`/`sessionHeadroom()` (gate math replaces them), and every `.count` read/write. Additionally write a top-level `last_pick: {profile, rung, at}` blob on every recorded pick — rung forensics without changing the string-returning contract; overwritten in place. `loadPickerState` already treats an unrecognized `schema_version` as absent — keep that, so a v1 file is discarded on first pick (one name-ordered rotation, accepted).

Docstrings: rewrite the module docstring and the `PICKER_SCHEMA_VERSION` comment forward-facing — describe buffered LRU as it is now; no stride references, no Python-coexistence or cross-runtime-ledger claims, no history narration. Same one-line prunes in src/usage-flock.ts:6-8 and src/keeper-state-dir.ts:4-5, and in the `recordPick`/`localIsoWithOffset` blurbs that reference "the Python reader". Keep unchanged: `listProfiles` (cli/usage.ts imports it), the DI seams `setStateDir`/`setClock` (new time reads go through `nowFn()`, never `new Date()` directly), `localIsoWithOffset` stamping, atomic tmp+rename writes, `FileLock` usage, the never-throws `pickProfile` wrapper, and the DB-free leaf import discipline (node:fs/os/path + usage-flock only).

### Investigation targets

**Required** (read before coding):
- src/usage-picker.ts — whole module: `doPickProfile` (:160-188, RMW shape), `choose` (:302-330, replaced), `counts`/`seedNewEntrants` (:332-377, deleted), `recordPick` (:385-402, reworked), `isRateLimitedNow` + `hasTimezone` (:199-226, reuse for resets_at grace and last_picked_at parsing), `loadPickerState` (:427-445, schema gate)
- src/usage-scraper-worker.ts:148-176 — `Envelope` interface: top-level `last_successful_fetch_at: string | null`, `multiplier: number | null`, `usage: ScrapeUsage | null`
- src/usage-scrape-runner.ts:60-76 — `UsageWindow { percent_used, resets_at }` nullability
- test/usage-picker.test.ts:60-140 — fixture helpers: `readCounts` reads the deleted field; `writeEnvelope`/`EnvelopeOpts` lacks week/resets_at/fetch-stamp knobs; `installMonotonicClock` stays valid for LRU ordering

**Optional** (reference as needed):
- src/agent/main.ts:1995-2009 — sole consumer; string contract unchanged
- src/usage-worker.ts:274 — `NON_USAGE_JSON_FILES` keeps picker.json excluded from envelope cleanup; do not regress
- cli/usage.ts:55 — imports only `listProfiles`

### Risks

- A stalled scraper silently demotes the fleet to rung 3 (plain LRU, no limit protection) — intended degradation; pin it with an explicit test so it stays a decision, not an accident.
- The v2 cutover discards v1 `last_picked_at` history: the first rotation is name-ordered, self-correcting within one round. No migration wanted.
- The LRU comparator must never throw on garbage stamps (corrupt/naive/absent sorts epoch-oldest) — a poisoned comparator would break the never-throws contract.

### Test notes

DELETE test/usage-picker.slow.test.ts outright — its statistical stride-proportionality proofs have no LRU analog; every new behavior pins deterministically in the fast suite under `installMonotonicClock`. Rework fast-suite helpers: `readCounts` becomes a v2-state reader; `writeEnvelope` gains `week_percent`, `session_resets_at`, `week_resets_at`, `last_successful_fetch_at` knobs. Scenarios to pin: plain LRU rotation + name ties; new-entrant absent-stamp picked first then rotating to the back (no burst); exclusion at the buffer and admission just under it; overflow rung when all exceed the buffer; rung-3 when all exceed overflow; rung-4 parked inclusion; zero-subscribed returns DEFAULT with NO state write; a burst between scrapes spreads across profiles via `pending` and resets when `last_successful_fetch_at` changes (null-to-string resets; null-to-null does not); rollover grace zeroes a past-reset window (tz-aware only; naive stamp gets no grace); corrupt `last_picked_at` sorts oldest without throwing; v1-schema picker.json treated as absent; multiplier coercion pinned ([0, -5, "garbage", 3.5, true, null] all coerce to 1) now as the reservation divisor; `last_pick` blob records profile + rung. Stay pure in-process on a per-test tmpdir; 10s fast-tier ceiling.

## Acceptance

- [ ] Ordering is pure LRU (`last_picked_at`, ties by name) within the resolved rung; `count` and multiplier weighting are gone from ordering
- [ ] 5-rung fail-open ladder exactly as specced: buffer (80/95) then overflow (90/98) then any-unparked then all-subscribed then DEFAULT only at zero subscribed (no state write on that final rung)
- [ ] `pending`/`seen_fetch_at` reconciled for EVERY subscribed profile each pick and persisted in the same atomic write; reservation math is `pending * STEP / multiplier`
- [ ] picker.json v2: `PICKER_SCHEMA_VERSION = 2`, per-profile `{last_picked_at, pending, seen_fetch_at}`, top-level `last_pick {profile, rung, at}`; `counts`/`seedNewEntrants` deleted; a v1 file is treated as absent
- [ ] Rollover grace zeroes a window only on a tz-aware past `resets_at`
- [ ] Stale stride/cross-runtime docstrings rewritten forward-facing in usage-picker.ts, usage-flock.ts, keeper-state-dir.ts
- [ ] `bun test test/usage-picker.test.ts` green; slow file deleted; DB-free imports and never-throws contract unchanged

## Done summary
Replaced the stride-scheduling picker with buffered LRU: pure LRU rotation over a five-rung fail-open admission ladder (buffer/overflow/any-unparked/all-subscribed/DEFAULT), a pending burst reservation reconciled per pick against last_successful_fetch_at, rollover grace, and a v2 picker.json ledger with a last_pick forensic blob. Deleted the slow stride-proportionality suite.
## Evidence
