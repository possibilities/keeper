## Description

**Size:** M
**Files:** ../agentuse/agentuse/api.py, ../agentuse/daemon.py, ../agentuse/tests/test_picker.py, ../agentuse/tests/test_daemon_idle_stale_guard.py

### Approach

Use `lift_at` (from task .2) to take a rate-limited profile out of
rotation AND ease off scraping it until it unblocks.

1. **Balancing exclusion (`agentuse/api.py`).** Add a pure
   `_is_rate_limited_now(envelope, now)` helper (true iff
   `envelope["lift_at"]` parses and is in the future) and gate it in
   `_eligible_profiles()` (~ln 131-146), after the `subscription_active
   is True` check: skip profiles still in cooldown. **Fail-open:** if
   the filter empties the eligible set, fall back to the existing
   behavior (return a profile / DEFAULT_PROFILE) — never return empty.
2. **Scrape pause (`daemon.py`).** While a profile's `lift_at` is in the
   future, pause/slow its scrape using the existing idle-skip mechanism
   (~ln 498-545) as the template — schedule the next fetch at/after
   `lift_at` instead of the normal cadence, and write an idle-style
   envelope that preserves `usage` + `lift_at`. Resume normal cadence
   once `lift_at` passes. Do not let the pause suppress the stale-retry
   path (the idle-skip guard already refuses to overwrite a `stale`
   envelope — preserve that).

### Investigation targets

**Required:**
- ../agentuse/agentuse/api.py ~ln 106-170 — `pick_profile` / `_pick_profile` / `_eligible_profiles` / `_choose` / fail-open wrapper.
- ../agentuse/daemon.py ~ln 484-621 — poll cycle; ~ln 498-545 — idle-skip (the pause template); `next_fetch_at` scheduling.

**Optional:**
- ../agentuse/tests/test_picker.py — round-robin + eligibility test patterns.

### Risks

- **All profiles rate-limited:** the eligibility filter must not strand the picker — keep fail-open.
- **Clock/timezone:** compare `lift_at` against an aware `now`; agentuse already works in aware datetimes (`astimezone`).
- **Pause vs stale-retry:** don't let the cooldown pause clobber the `stale` envelope guard (idle-skip already refuses to overwrite `stale`).
- **Resume:** ensure a profile actually resumes scraping at/after `lift_at` (don't pause forever if the next-fetch scheduling is the only resume trigger).

### Test notes

Picker: a profile with future `lift_at` is excluded from selection;
once `lift_at` is in the past it rotates again; all-excluded → fail-open
returns a profile. Daemon: a rate-limited profile's next fetch is
scheduled at/after `lift_at` and the idle/stale guards still hold.

## Acceptance

- [ ] `_eligible_profiles()` excludes profiles whose `lift_at` is in the future; `pick_profile()` stays fail-open (never empty).
- [ ] A rate-limited profile's scraping is paused until `lift_at` (via the idle-skip mechanism) and resumes after, without breaking the stale-retry guard.
- [ ] Tests cover exclusion, post-lift re-rotation, all-excluded fail-open, and the daemon pause/resume; `uv run pytest` passes.

## Done summary

## Evidence
