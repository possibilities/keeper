## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

The producer escalates a graced `worktree-lane-wedge` needs_human distress
row whenever a fan-in base lane stays not-losslessly-cleanable past
`LANE_WEDGE_GRACE_SEC` — but a healthy, actively-running worker's lane is
naturally dirty with uncommitted WIP, so the escalation fires as a false
positive and pages the operator for work that self-heals the moment the
worker commits. Gate the mint on owning-worker liveness: at the seam where
the `wedged` Map is assembled for the lane-wedge tracker's `.step()`, map
each GRACED (`immediate:false`) lane path to its owning epic (the
`keeper/epic/<id>` branch, via `epicIdFromKeeperLaneEntry`) and consult the
SAME read-time liveness probe the reconciler already uses
(`isOccupyingJob(snapshot.jobs, ..., snapshot.livePaneIds)`, mirroring the
`hasActiveResolver` closure). If the owning worker is alive AND progressing,
withhold the lane from `wedgedLanes` so it stays the quiet self-clearing
premerge/recover note; only escalate when the worker is dead or STALLED
(live pane but `updated_at`/`last_event_id` aged past a grace, mirroring the
slot-reclaim reaper's dead-vs-alive idiom). Leave `immediate:true` (hard
abort-failed) lanes escalating at once — an abort-failed mid-merge is a real
wedge even under a live worker. Decide and TEST the degraded-probe
(`livePaneIds === null`) fallback explicitly. Do not touch the
`laneFailuresToClear` premerge positive-evidence clear path, and keep the
liveness read producer-side (never a fold — re-fold determinism). The
sibling `shared-checkout-wedge` mints from `src/daemon.ts` and is OUT OF
SCOPE for this task.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but
the repo moves. `src/autopilot-worker.ts` and `test/autopilot-worker.test.ts`
are grep-binary — use `grep -a`.*

**Required** (read before coding):
- `src/autopilot-worker.ts:6652-6667` — the seam assembling the `wedged` Map
  from `laneWedged`; the gate lands HERE (call site), not inside
  `recoverWorktrees` (which takes no jobs/liveness param).
- `src/autopilot-worker.ts:6683-6706` — lane-wedge tracker `.step()` +
  `emitSharedWedgeDistress` mint; `:5157-5231` `probeLaneBaseReadiness`
  (source of `laneWedged`; `immediate:true` only at `:5209-5213`).
- `src/autopilot-worker.ts:6540-6546` — the `hasActiveResolver`
  liveness-closure pattern to mirror; `:1304` `LANE_WEDGE_GRACE_SEC`;
  `:1322-1414` `createLaneWedgeTracker` (feed/withhold obs, don't fork it).
- `src/reconcile-core.ts:1157-1199` — `isOccupyingJob` / `isStoppedJobLive` /
  `epicHasActiveResolver` (reuse this probe, do NOT re-invent);
  `:1286,1319,1372-1440` — `SLOT_RECLAIM_GRACE_SEC` / `isBareShellCommand` /
  `computeSlotOccupancy` (the dead-vs-alive + staleness idiom for "stalled").
- `src/autopilot-worker.ts:476-490` (+ call site `:6669-6676`) —
  `laneFailuresToClear` premerge clear; keep byte-untouched.
- `test/autopilot-worker.test.ts:14100-14199` (lane-wedge cadence),
  `:645-927` (`isOccupyingJob`), `:984-1144` (`computeSlotOccupancy`),
  `makeSnapshot` livePaneIds/paneCommandById seeding (~`:288-291`), cycle
  harness `recoverLaneWedged` (~`:4880-4962`) — where the new
  alive-no-escalation / dead-escalation cases slot in.

## Acceptance

- [ ] A graced lane wedge whose owning worker is alive and progressing does
  NOT mint a `worktree-lane-wedge` needs_human distress row — it stays the
  quiet self-clearing premerge/recover note.
- [ ] A lane wedge whose owning worker is dead or stalled (past grace) still
  escalates to the `worktree-lane-wedge` distress row exactly as today.
- [ ] A hard `immediate` (abort-failed) lane still escalates at once
  regardless of worker liveness.
- [ ] The degraded liveness probe (`livePaneIds === null`) has an explicit,
  tested fallback.
- [ ] The `worktree-lane-premerge` positive-evidence level-clear path is
  unchanged.
- [ ] New/extended tests in the autopilot-worker tier cover both the
  alive-no-escalation and dead/stalled-escalation branches.

## Done summary
Gated the graced lane-wedge needs_human escalation on owning-worker liveness+progress: a running worker's naturally-dirty fan-in base is withheld (quiet self-clearing note), only a dead/stalled owner or a hard immediate abort-failed lane escalates. Producer-side probe, never a fold; degraded livePaneIds falls back to pre-gate escalate.
## Evidence
