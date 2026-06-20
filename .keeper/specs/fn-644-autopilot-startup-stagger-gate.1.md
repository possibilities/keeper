## Description

**Size:** M
**Files:** scripts/autopilot.ts, test/autopilot.test.ts

### Approach

Add a hardcoded one-at-a-time startup gate to autopilot's dispatch
loop. New module state: `settling: Map<string,number>` (`${verb}::${id}`
→ launch ts; holds 0 or 1 entries) and `pendingLaunches: Map<string,
{verb,id,dir,dirFull,command,rowId,tier?}>` (launches deferred because
the gate was full, keyed to dedupe repeat edges). Gate condition is
literally `settling.size >= 1 && !settling.has(key)` — NO knob, no env
override, no MAX constant (concurrency may be added later but never at
startup/settling time). Add a `SETTLE_TIMEOUT_SEC` constant (180) as a
fail-open: a settling key that never reaches running is dropped so the
ramp can't wedge — not a tuning knob. Add a `"settling-gate"` variant to
the `SuppressionReason` union for the lifecycle transition log.

In `launchInGhostty`, after the existing `shouldSuppressDispatch` passes
and a real (non-dry) launch fires, `settling.set(key, Date.now())`. The
gate is wet-only (dry-run skips it, exactly like `paused`). Route the
`processLaunchTransitions` dispatch sites through a new `tryLaunch(params)`
instead of calling `launchInGhostty` directly: if the gate is full and
the key isn't already settling, stash the launch in `pendingLaunches`
and `noteLine` a `settling-gate` deferral; otherwise launch.
`lastVerdictSig` still advances honestly (the verdict IS ready) — re-drive
is the pending queue's job, not edge replay. When a row's verdict leaves
ready/job-pending, delete any matching `pendingLaunches` entry.

In `onSnapshot` (after `detectJobTransitions`): a settle pass (for each
settling key, look up its row verdict via `perTask`/`perCloseRow` by
id-shape; if the tag is `running` OR the key is in `completedKeys`,
`settling.delete`), a timeout sweep (drop settling entries older than
`SETTLE_TIMEOUT_SEC`, logged), then `drainPending(lastSnap)`. New
`drainPending(snap)`: while `settling.size < 1` and pending is non-empty,
pop the oldest, RE-VALIDATE against the current snap (verdict still
ready/pending AND `shouldSuppressDispatch` returns null — this is what
drops the held duplicate once the per-root mutex has blocked it), then
launch or discard. `settling`/`pendingLaunches` are this-run-only (not
persisted): a restart re-derives running rows from the live snapshot and
the durable `dispatchedKeys` guard still prevents work/close re-launch.

Explicitly out of scope: the readiness-side `isLiveWorkOccupant`
widening, fixing the upstream duplicate-epic scaffold, and any
steady-state concurrency cap.

### Investigation targets

**Required** (read before coding):
- scripts/autopilot.ts:664 — `SuppressionReason` union; add the
  `"settling-gate"` variant here.
- scripts/autopilot.ts:703 — `shouldSuppressDispatch`; the gate composes
  after this in `tryLaunch`, and `drainPending` re-validates through it.
- scripts/autopilot.ts:1919 — `launchInGhostty`; suppression check at
  :1951, `logDispatch` at :2000, `if (dryRun) return` at :2011 — add the
  `settling.set` on the real-launch path.
- scripts/autopilot.ts:2164 — `processLaunchTransitions`; the deferred
  dispatch sites at :2208 (work `ready`) / :2221 (approve `job-pending`)
  / :2246 (close `ready`) / :2259 (approve-close) route through
  `tryLaunch`; `lastVerdictSig` advance at :2202.
- scripts/autopilot.ts:2363 — `onSnapshot`; `detectJobTransitions` runs
  at :2374, `processLaunchTransitions` at :2399 — insert settle pass +
  timeout sweep + `drainPending` between them.
- scripts/autopilot.ts:1466 — `detectJobTransitions`; mirrors the
  fulfillment-detection precedent the settle pass follows.
- src/readiness.ts:261 — `Verdict` tag union; `{tag:"running"}` is the
  occupancy signal that frees the settling slot.
- test/autopilot.test.ts — existing `shouldSuppressDispatch` /
  `isLiveSessionInRoot` unit patterns to mirror for the new tests.

## Acceptance

- [ ] `settling` holds at most one key; a second ready row while the slot
  is occupied is deferred to `pendingLaunches`, not launched.
- [ ] A settling key is released when its row verdict is observed
  `running` or it enters `completedKeys`; `drainPending` then fires the
  next pending launch.
- [ ] `drainPending` re-validates each pending launch against the current
  snapshot and discards one that is no longer ready or now suppressed
  (the duplicate-race fix).
- [ ] A settling key older than `SETTLE_TIMEOUT_SEC` is swept (fail-open)
  so the ramp cannot wedge on a dead startup.
- [ ] Gate is inert under `--dry-run` (like `paused`); steady-state
  parallelism of already-running workers is unaffected.
- [ ] `bun test test/autopilot.test.ts` covers: first launch fires +
  settles, second held while occupied, drain-on-settle fires it, drain
  re-validation drops a now-mutex-blocked pending, timeout fail-open.

## Done summary
Hardcoded one-at-a-time startup gate added to autopilot dispatch loop. settling/pendingLaunches maps stash launches when the slot is held; releaseSettledKeys frees on running-tag verdict or completedKeys membership; sweepSettleTimeouts fail-opens after SETTLE_TIMEOUT_SEC=180s; drainPendingLaunches re-validates pending entries against the current snap (closing the duplicate-race against per-root mutex). Gate is wet-only; dry-run bypasses. Routed via tryLaunch in processLaunchTransitions. 14 new tests in test/autopilot.test.ts cover all five acceptance bullets.
## Evidence
