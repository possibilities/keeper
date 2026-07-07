# Latched reserve for the profile balancer

## Status

Accepted

## Context

The `keeper agent` launch path balances across subscribed Claude accounts via the
profile picker (`src/usage-picker.ts`), the sole reader and writer of the
flock-guarded `picker.json`. The picker selected through a stateless per-pick
admission ladder: each call re-decided from scratch, walking rungs from a primary
buffer to an overflow cap to any-unparked to all-subscribed.

Because the ladder held no memory, it flapped on recovery. The moment one
account's session window reset under the buffer, the next pick snapped all
traffic back onto that single account; as that account refilled past the buffer,
the picker flipped away again — and back once it dipped, repeatedly. A single
account crossing the buffer boundary re-steered the whole fleet, so a small
usage oscillation around one threshold produced large swings in which account
served launches. The ladder had no dead-band to absorb that oscillation.

## Decision

Replace the stateless ladder with a **latched reserve** — a two-state machine
persisted as a single top-level `reserve_open` boolean in `picker.json`, updated
inside the one existing flock read-modify-write.

An account is **healthy** when it is unparked and under both the session
threshold (80) and the week threshold (95) on effective usage; it is **re-armed**
when it is unparked and additionally under the lower session re-arm mark (50).
Re-armed accounts are a subset of healthy by construction.

- **Latched (closed):** while any healthy account exists, over-threshold accounts
  are non-viable and the healthy set balances by LRU.
- **Open:** when no healthy account remains the latch opens and the full unparked
  set is viable, balancing each account up to its real rate limit.
- **Re-latch:** an open latch closes only when a re-armed account exists — a
  recovery merely under the main threshold does not close it.

The transitions are asymmetric: the latch opens **fast** (the same pick that
empties the healthy set is served from the reserve — the latch update runs before
viability is resolved) and closes **slow** (only on a genuine sub-re-arm-mark
recovery). The 80→50 session gap is the anti-flap hysteresis band: a Schmitt-
trigger dead-band wide enough that one scrape interval's usage drift cannot flap
the latch. Re-arm ⊆ healthy is what guarantees the re-latch can never leave the
viable set empty — the account that closed the latch is itself healthy, so
healthy-only always has at least it to pick.

When even the unparked set is empty (every account rate-limit **parked**) a single
all-included backstop tier hands out any subscribed account so the picker never
throws. `parked` here is the picker's rate-limit sense — a future `lift_at`
cooldown or a usage-endpoint throttle — distinct from the dead-letter / dispatch
sense of a stuck job.

`picker.json` stays schema v2 (no bump): the latch is a new optional field; a file
without `reserve_open` reads as latched, preserving `pending`/LRU state.

## Consequences

- Recovery no longer flaps: an account dipping under the threshold but staying
  above the re-arm mark does not re-steer the fleet. Traffic only snaps back to
  healthy-only once an account genuinely recovers under the re-arm mark.
- The gates read **effective** usage (scraped percent plus the `pending` burst
  reservation), so a burst of launches can push the last healthy account over the
  threshold and open the reserve before real usage climbs; `pending` zeroes on the
  next scrape, so the reserve tends to stay open until then. This is the intended
  anti-overshoot / slow-close asymmetry — gating on scraped-only usage would trade
  burst protection for less premature opening and is deliberately not taken.
- When every account is week-exhausted (week ≥ 95) no account is ever healthy or
  re-armed, so the latch stays open until a week window rolls over. This stuck-open
  state is accepted: with no healthy pool to protect, balancing the full unparked
  set up to each real rate limit is correct.
- A session-window reset can drop several accounts under the re-arm mark at once,
  synchronizing a re-latch. This is design-accepted; the LRU one-pick-per-call
  rotation mitigates a thundering-herd flood into the reserve on release.
- `last_pick` carries the resolved `tier` (`healthy` / `reserve` / `backstop`) and
  the latch state as a forensic signal; the value the next pick reads is the
  top-level `reserve_open`, never `last_pick.reserve_open`.
