## Description

**Size:** S
**Files:** test/db.test.ts

### Approach

Replace the unbounded `do { n = drain(db); } while (n > 0)` in the `drainAll`
test helper with a **cursor-non-advance guard**: snapshot
`reducer_state.last_event_id` before each `drain()`; if `drain()` returns `>0`
but the cursor did NOT advance, THROW a clear error naming the stalled cursor
and event count. A non-progressing fold is a real re-fold determinism bug
(CLAUDE.md "re-fold determinism is sacred") — surfacing it loudly as a thrown
test failure is the deliverable, never a silent `break`. Keep a generous
absolute iteration ceiling as a secondary backstop. This makes a synchronous
spin structurally impossible in the suite's hottest helper — the watchdog-free
keystone.

### Investigation targets

**Required** (read before coding):
- test/db.test.ts:37-42 — the `drainAll` unbounded loop (prime suspect for the 49-min spin)
- src/reducer.ts — `drain()`: what it returns, how/when `last_event_id` advances

**Optional** (reference as needed):
- test/db.test.ts:1080, 2782, 3028, 3992 — migration tests that call `drainAll` (must still pass)

### Risks

A legitimate long migration must not false-fail — the cursor-advance check (not
a raw iteration cap) is what avoids that. If it proves too tight, the epic's
fallback is a generous absolute iteration ceiling.

### Test notes

Prove the bound by driving a synthetic non-advancing fold (drain returns `>0`
with the cursor static) → it THROWS within N iterations, not hangs. Confirm
every existing db.test.ts migration test still passes.

## Acceptance

- [ ] `drainAll` throws (not hangs) on a non-advancing fold, naming the stalled cursor
- [ ] No unbounded synchronous loop remains in test/db.test.ts
- [ ] All existing db.test.ts migration tests still pass

## Done summary

## Evidence
