## Overview

Expose the event store's growth costs as first-class status measurements — total event count, DB bytes, and projected boot catch-up / full-replay time — so the checkpoint work that follows has live trigger data against the ratified SLOs (boot catch-up 60s, full rebuild 15min). Measurement only; no horizon or checkpoint behavior.

## Quick commands

- `keeper status --json | jq '.data.event_store'` — the three measurements present and sane

## Acceptance

- [ ] Status carries event count, DB bytes, and projected catch-up and full-replay durations derived from observed fold rates
- [ ] The projections are computed from durable observations, not wall-clock guesses at query time

## References

- Ratified SLOs: boot catch-up ≤60s, full disaster rebuild ≤15min (backlog #11) — displayed context, not enforced here
