## Description

**Size:** M
**Files:** src/usage-picker.ts, test/usage-picker.test.ts, docs/adr/0012-latched-reserve-profile-balancer.md, CONTEXT.md

Replace the stateless admission ladder in `src/usage-picker.ts` with a latched-reserve state machine, persist the latch in `picker.json`, rework the picker test suite, and land the decision record + glossary. All selection stays inside the one existing flock-guarded read-modify-write in `doPickProfile`; the DB-free-leaf discipline holds (only `node:fs`/`os`/`path` + `usage-flock`/`usage-models`, never `src/db.ts`, never the reducer).

### Approach

The behavioral contract is a per-pick state machine over subscribed accounts. Reuse the existing machinery untouched: `subscribedProfiles` (each carries `.parked` = future `lift_at` OR usage-endpoint throttle — the real rate limit), the `Row` build (`effSession`/`effWeek` = scraped percent + `pending` burst inflation), `reconcilePending` (orthogonal — a landed scrape zeroes `pending` before the gates read, leave it), `lruWinner`, `scrapedPercent`, `loadPickerState`/`writePickerState`, and the single `nowFn()` read at entry (do NOT add a second clock read — a load-bearing test invariant).

Constants (`src/usage-picker.ts:65-71`): keep `WEEK` threshold at 95; rename the session buffer to a single threshold (recommended `SESSION_THRESHOLD=80`, `WEEK_THRESHOLD=95`); add `SESSION_REARM=50` (a plain module const — "tunable" means edit-the-const, no config/env plumbing); DELETE `SESSION_OVERFLOW` and `WEEK_OVERFLOW` (no consumers outside this file). Keep `STEP_SESSION`/`STEP_WEEK`.

The machine, inside the existing flock RMW:

1. `now = nowFn()` (single read); `subscribed = subscribedProfiles(now)`; if empty → return `DEFAULT_PROFILE` with NO state write (preserve today's behavior).
2. `loadPickerState()`; set `schema_version = 2` (NO bump); `reconcilePending` per subscribed; build `rows`.
3. `unparked = rows.filter(!parked)`; `healthy = unparked.filter(effSession < SESSION_THRESHOLD && effWeek < WEEK_THRESHOLD)`; `rearm = unparked.filter(effSession < SESSION_REARM && effWeek < WEEK_THRESHOLD)` (⊆ healthy by construction — this is what guarantees a non-empty healthy pool on re-latch, so re-latching can never leave `viable` empty).
4. Read the latch: `reserveOpen = state.reserve_open === true` (absent/null/non-bool → `false` = latched). Update: if `!reserveOpen && healthy.length === 0` → `reserveOpen = true` (OPEN); else if `reserveOpen && rearm.length > 0` → `reserveOpen = false` (RE-LATCH); else HOLD.
5. `viable = reserveOpen ? unparked : healthy`. Resolve tier: if `viable.length` → `tier = reserveOpen ? "reserve" : "healthy"`; else `viable = rows; tier = "backstop"` (single-level fail-open, all-included — there is NO separate any-unparked tier; under fast-open it would be unreachable).
6. `chosen = lruWinner(viable, picks)`; persist `state.reserve_open = reserveOpen` (top-level, authoritative) and `last_pick = { profile: chosen, tier, reserve_open: reserveOpen, at }`; `writePickerState`. The NEXT pick reads the top-level `reserve_open`, never `last_pick.reserve_open`.

Fast-open is the key ordering invariant: the latch update in step 4 happens BEFORE `viable` is computed in step 5, so the pick that empties `healthy` opens the reserve and is served from it in the same call. Replace `chooseByLadder`'s 4-rung body accordingly and rewrite its JSDoc (`:291-302`) and the file header docstring (`:1-37`) to describe the latched two-state model — forward-facing only, no "was a ladder" narration.

Docs deliverables (land with the code):
- `docs/adr/0012-latched-reserve-profile-balancer.md` — follow the repo's ADR shape (Status / Context / Decision / Consequences). Record: the recovery-flap problem the stateless ladder had; the latched-reserve decision; the hysteresis band and why re-arm ⊆ healthy; the effective-usage gate consequence (a burst can open the reserve pre-scrape — the intended slow-close asymmetry); and the accepted stuck-open-until-week-rollover property when all accounts are week-exhausted.
- `CONTEXT.md` — a NEW "Usage picker" section (the file has none) with role-and-behavior entries + `Avoid:` lines for the new terms and a disambiguation of the picker's `parked` sense.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/usage-picker.ts:158-185 — `doPickProfile` flock RMW; the single mutation point.
- src/usage-picker.ts:303-340 — `chooseByLadder` (the body to replace) + its Row build.
- src/usage-picker.ts:65-71 — the constants to rename/add/delete.
- src/usage-picker.ts:421-433 — `recordPick`; change its rung→tier signature and persist `reserve_open`.
- src/usage-picker.ts:475-516 — `loadPickerState`/`writePickerState` fail-open + atomic write.
- test/usage-picker.test.ts — the whole suite; note helpers `writeEnvelope`, `seedState`, `readState`/`readPicks`, `installMonotonicClock`/`isoOffset`, `setStateDir`, `writeConfig`.

**Optional** (reference as needed):
- docs/adr/0006-validation-marker-arm-exclusive-latch.md — latch ADR shape + vocabulary.
- src/reducer.ts (block_escalations latch) — naming precedent only.
- CONTEXT.md — house glossary format (`- **Term**: behavior. Avoid: synonyms.`).

### Risks

- **Effective-usage gate opens the reserve pre-scrape.** Because gates read `effSession = scraped + pending inflation`, a burst of launches can push the last healthy account over 80 effective and open the reserve before real usage climbs; `pending` only zeroes on the next scrape, so the reserve tends to stay open until then. This is the intended anti-overshoot / slow-close behavior — document it, don't "fix" it. The single close alternative (gate on scraped-only) trades burst protection for less premature opening and is deliberately not taken.
- **Rung→tier rename is test-wide.** `last_pick.rung` is asserted as literals 1/2/3/4 across ~10 assertions; the overflow-tier tests and the reservation-divisor `rung===2` test break by design. Rewrite, don't renumber.
- **`parked` term overload** (picker rate-limit vs dead-letter/dispatch) must be disambiguated in the glossary/ADR or the ambiguity propagates.
- **Single-host assumption**: the flock + local non-XDG state dir assume `picker.json` is never on a shared/synced FS. Preserve that; do not add cross-host coordination.

### Test notes

Pure in-process `bun test`, sandbox state via `setStateDir`, poll-don't-sleep, one `nowFn()` per pick (keep `installMonotonicClock` strictly-increasing). Add a `describe("latched reserve")` block and rework the affected `admission ladder` tests. Required coverage:
- Anti-flap regression (THE proof): reserve open, an account recovers 85→79 (under 80, over 50) → `reserve_open` stays true, no re-latch; then drops under 50 → re-latch.
- Same-call OPEN: healthy non-empty, all unparked driven >80 effective, latch closed → in ONE pick `reserve_open` flips true AND the pick resolves at `tier="reserve"` (not backstop).
- Same-call RE-LATCH: reserve open, one account driven <50 → in ONE pick `reserve_open` flips false AND pick resolves at `tier="healthy"`.
- HOLD-open: reserve open, all accounts between 50 and 80 → stays open.
- Boundaries: exactly 50 (strict `<`, new), 80, 95.
- Absent `reserve_open` (seed an old v2 file with no field) → treated as latched on first pick.
- Backstop: all unparked accounts parked while reserve open → no throw, `tier="backstop"`, `reserve_open` still persisted.
- Rework the existing overflow (`:293-304`), any-unparked (`:306-316`), stalled-scraper (`:318-338`), reservation-divisor (`:517-538`), and ledger-v2-shape (`:599-620`) tests to the new tiers and the `{profile, tier, reserve_open, at}` last_pick shape.
- Degenerate check: equal-headroom accounts still degrade to plain LRU rotation (existing distribution test stays green).

## Acceptance

- [ ] While at least one healthy account (unparked, session<80, week<95) exists, over-threshold accounts are never picked; the healthy set balances by LRU.
- [ ] With no healthy account, a single pick opens the latch and is served from the full unparked set at `tier="reserve"`, balancing up to each account's real rate limit.
- [ ] The latch re-latches to healthy-only only when an account is under the re-arm mark (session<50, week<95); a recovery to between 50 and 80 keeps the reserve open (anti-flap invariant holds under test).
- [ ] `parked` accounts are handed out only via the all-included fail-open backstop; `pickProfile` never throws and returns `"default"` when nothing resolves.
- [ ] `picker.json` remains schema v2; a pre-existing file lacking `reserve_open` is read as latched and its `pending`/LRU state is preserved (no state wipe).
- [ ] `last_pick` carries `{profile, tier, reserve_open, at}` with `tier` in `{"healthy","reserve","backstop"}`; the top-level `reserve_open` is the value the next pick reads.
- [ ] `bun test test/usage-picker.test.ts` and `bun test` pass; the anti-flap, same-call open/re-latch, boundary, absent-flag, and backstop tests are present and green.
- [ ] `src/usage-picker.ts` header + `chooseByLadder` docs describe the latched model (forward-facing); `docs/adr/0012-latched-reserve-profile-balancer.md` and a new disjoint `CONTEXT.md` "Usage picker" glossary section land with the change.

## Done summary

## Evidence
