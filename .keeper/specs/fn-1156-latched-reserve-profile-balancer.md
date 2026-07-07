## Overview

The `keeper agent` launch path balances across subscribed Claude accounts via `src/usage-picker.ts` (`pickProfile`), the sole reader+writer of the flock-guarded `picker.json`. Today it selects through a stateless per-pick admission ladder: because it re-decides from scratch every call, the moment one account's session window resets under threshold it snaps all traffic back onto that single account, then flips away again as it fills — recovery flapping. This epic replaces the ladder with a **latched reserve**: over-threshold accounts are non-viable while any healthy account exists; when none remain the latch OPENS and every not-rate-limited account balances up to its real rate limit; the latch RE-LATCHES to healthy-only only when an account recovers under a lower re-arm mark. The hysteresis band (session 80 → re-arm 50) is the anti-flap mechanism.

## Quick commands

- `bun test test/usage-picker.test.ts` — the picker suite (fast, pure in-process; the primary gate)
- `bun test` — the full root fast suite (no regressions elsewhere)
- `bun run typecheck` — TS types green

## Acceptance

- [ ] The picker holds over-threshold accounts non-viable while any healthy account exists, and balances only the healthy set (LRU) in that regime.
- [ ] When no healthy account remains, the latch opens and the same pick is served from the full not-rate-limited set (fast-open), balancing up to each account's real rate limit.
- [ ] The latch re-latches to healthy-only only when an account recovers under the re-arm mark — a recovery merely under the main threshold does NOT re-latch (the anti-flap invariant).
- [ ] `parked` (rate-limited) accounts remain the hard stop and are only ever handed out via the all-included fail-open backstop; the picker never throws and returns `"default"` on total failure.
- [ ] `picker.json` stays schema v2 (no bump); an existing file with no `reserve_open` field is read as latched, preserving accumulated `pending`/LRU state.
- [ ] The picker suite is reworked green: the anti-flap regression, same-call open/re-latch, boundary, and absent-flag cases all covered.

## Early proof point

Task that proves the approach: `.1`, specifically the anti-flap regression test — reserve open, an account recovers from 85% to 79% session (under the 80 threshold, above the 50 re-arm mark) and the latch must STAY open. If that can't be made to pass deterministically, the hysteresis model is wrong at its core; recovery is to re-examine whether the gates should read scraped rather than effective usage before proceeding.

## References

- `docs/adr/0006-validation-marker-arm-exclusive-latch.md` — the repo's canonical persisted-latch ADR; mirror its arm / re-latch verb vocabulary and its "state means when established, not when last checked" framing.
- `src/reducer.ts` `block_escalations` latch (arm-on-enter / clear-on-leave, re-arms fresh) — in-repo naming precedent for the OPEN→RE-LATCH transition. Borrow the state-machine shape only; the picker latch is a flat flock-guarded JSON flag, NOT a reducer projection (DB-free-leaf discipline).
- New ADR `docs/adr/0012-latched-reserve-profile-balancer.md` (0012 confirmed free) records this decision. Epic-scout: fn-1149 and fn-1151 add ADRs 0010/0011 and edit OTHER `CONTEXT.md` sections — this epic's ADR is a NEW file at 0012 and its glossary lands in a NEW disjoint "Usage picker" section, so no dep edge is wired; the disjoint edits git-merge cleanly at fan-in.
- Hysteresis / anti-flap canon: Schmitt-trigger dead-band (gap must exceed signal noise), circuit-breaker fail-open-to-safe-state, K8s HPA asymmetric fast-open/slow-close, TCP AIMD cautious re-entry.

## Docs gaps

- **`src/usage-picker.ts:1-37` header docstring + `chooseByLadder` JSDoc**: rewrite from the "five-rung fail-open ladder" to the latched two-state model — forward-facing only, no change history. Handled inside the task.
- **`CONTEXT.md`**: add a new disjoint "Usage picker" glossary section with role-and-behavior entries (+ `Avoid:` lines) for latched reserve / reserve, re-arm mark, healthy account, viable/non-viable account, and disambiguate the picker's `parked` sense from the dead-letter/dispatch sense. Handled inside the task.
- **`docs/adr/0012-latched-reserve-profile-balancer.md`**: new ADR. Handled inside the task.

## Best practices

- **Dead-band sizing:** the 80→50 session gap (30 points) must stay wider than one scrape interval's usage drift so a single measurement doesn't flap the latch [Schmitt-trigger canon].
- **Fail-open toward the conservative state:** missing/corrupt `reserve_open` resolves to latched (healthy-only), matching circuit-breaker convention — keep it.
- **Asymmetric transitions:** open fast (protective, same-call), re-latch conservatively (only on genuine sub-re-arm-mark recovery). LRU-one-pick-per-call is the built-in mitigation against a thundering-herd flood into the reserve on release.
- **Session-reset awareness:** a window reset can drop several accounts under the re-arm mark at once → synchronized re-latch; design-accepted, covered by a "doesn't crash, picks valid" test rather than new machinery.
