## Overview

The event-store measurements ride the boot-status header, which the serve worker deliberately omits from memoized steady-state replies — so `keeper status` reads `event_store: null` exactly when the daemon is healthy, while the daemon-side computation dutifully produces count, bytes, and projections. Deliver the block through a channel that exists at steady state, and grow the smoke gate's scenario set (by ADR 0073 amendment) to pin steady-state status field delivery so this contract class cannot ship blind again.

## Quick commands

- `keeper status --json | jq '.data.event_store.event_count'` — non-null against a healthy caught-up daemon
- `bun run test:slow-daemon` — the grown scenario set green

## Acceptance

- [ ] A healthy caught-up daemon serves the full event-store block (count, bytes, last-boot catch-up, projections) through `keeper status`
- [ ] The absent-boot-header steady-state contract that the restart probe depends on is byte-identically preserved
- [ ] The smoke gate asserts steady-state event-store delivery, with the scenario addition recorded as an ADR 0073 amendment
