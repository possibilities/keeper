## Description

**Size:** S
**Files:** src/git-boot-seed.ts (or a sibling seed module), src/daemon.ts

Boot-seed the tmux live surface so it is never left empty/stale, mirroring the git boot-seed,
and slot it correctly in the two-gate boot ordering.

### Approach

Write `seedTmuxProjection` modeled on `seedGitProjection` (git-boot-seed.ts:236): capture
`floor = readMaxEventId(db)` BEFORE the probe, `setTmuxProjectionSeedRequired(db, true)`, probe
`tmux list-panes -a` once (whole server) + the generation, mint ONE synthetic `TmuxTopologySnapshot`
(id > floor), drain it, then `raiseTmuxProjectionFloor(db, floor)` + clear `seed_required`
ATOMICALLY. Degrade-not-fatal on a probe failure (leave `seed_required` set → re-seed next boot),
exactly like the git seed. Invoke it in `serveBootDrain` (src/daemon.ts) AFTER the drain + AFTER
`seedKilledSweep` (job rows must exist to match) and right after `seedGitProjection` (~daemon.ts:1601),
BEFORE `truncateEphemeralProjections` and BEFORE the actuator/mutating-RPC gate (`boot-complete`,
daemon.ts:2164). Gate on the relevant `want(...)` selector. Unseeded (`seed_required=1`) reads must
surface UNKNOWN, never a stale-clean session — confirm consumers honor it (task 5 owns the fallback).

### Investigation targets

**Required** (read before coding):
- src/git-boot-seed.ts:236-298 — `seedGitProjection` (capture-floor-first → seed → raise+clear contract)
- src/daemon.ts:1588-1618 — `serveBootDrain` ordering (seedKilledSweep → seedGitProjection → truncate)
- src/daemon.ts:2162-2171 — the actuator/mutating-RPC `boot-complete` gate (seed must precede it)
- src/db.ts — tmux floor/seed accessors + `readMaxEventId` (from task 1)

**Optional** (reference as needed):
- src/daemon.ts:1790-1809 — the read-socket gate (catching_up:true) for context on the two-gate split

### Risks

- Seeding BEFORE `seedKilledSweep` (no job rows) yields zero matches → surface stays empty.
- Seeding AFTER the actuator gate lets a consumer act on an unseeded surface.
- A crash mid-seed must leave `seed_required` set (atomic raise+clear) so the next boot re-seeds.

### Test notes

Subprocess/integration (slow tier): boot a daemon against a seeded DB + a live tmux server (or
injected probe) and assert the live surface is populated before the actuator arms; assert an
interrupted seed re-seeds on the next boot (`seed_required` stays 1).

## Acceptance

- [ ] `seedTmuxProjection` captures the floor before probing, mints+drains one seed snapshot, and
      raises the floor + clears `seed_required` atomically; degrades-not-fatal on probe failure.
- [ ] It runs in `serveBootDrain` after `seedKilledSweep` + `seedGitProjection` and before the
      actuator gate; a fresh boot populates live location before any mutating RPC acts.
- [ ] An interrupted seed leaves `seed_required=1` and re-seeds next boot.

## Done summary

## Evidence
