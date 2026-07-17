## Description

**Size:** S
**Files:** src/server-worker.ts, cli/status.ts, test/status.test.ts

### Approach

Add an event-store block to the status surface: total event count and DB byte size (cheap queries), plus projected boot catch-up and full-replay durations derived from durable observations — the natural source is the measured duration of the most recent boot catch-up (the boot gate already knows when it started and when it reached ready) scaled by event growth, with an honest null when no measurement exists yet. Compute daemon-side where the DB connection and boot gate live; render in the status CLI's JSON (and a compact human line if the board header has a natural home). No thresholds are enforced and no behavior changes — this is the measurement substrate the checkpoint design consumes.

### Investigation targets

*Verify before relying.*

**Required** (read before coding):
- src/server-worker.ts — the boot gate and boot-status computation (where catch-up start/ready are already known) and the status frame assembly
- cli/status.ts:158-233 — the status data surface the new block joins

### Risks

- The projection must never read wall-clock inside a fold or projection path — producer/serve-side derivation only, from recorded timestamps.

## Acceptance

- [ ] `keeper status --json` carries event count, DB bytes, and projected catch-up/replay durations (null-honest before first measurement)
- [ ] The catch-up projection is derived from a recorded boot measurement, verified by a test over injected observations
- [ ] Focused suite green; no behavior beyond measurement

## Done summary

## Evidence
