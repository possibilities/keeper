## Description

**Size:** M
**Files:** scripts/autopilot.ts, test/autopilot.test.ts

Close P2 and the P1 secondary gap. P2: `dispatchedKeys` keys on launch, not
fulfillment, so an approve window opened then dismissed (without
`/plan:approve` running) marks `approve::<id>` handled-for-life and never
re-dispatches — deadlocking everything queued behind it. P1 secondary: a
`job-pending` row claims a pass-1 mutex slot but is not pass-2-demotable, so
an approve dispatch can still overlap a live worker in the same root.

### Approach

Two parts. (a) **Approve-verb fulfillment-keying:** for `verb === "approve"`,
suppress a re-dispatch only when an approve job for that id has actually been
observed in the projection (`fulfilledKeys` via `findSessionJob` /
`detectJobTransitions`), not merely when it was launched (`dispatchedKeys`).
Keep the once-for-life launch-keyed `dispatchedKeys` guard for `work`/`close`
(double-spawn risk is real there). An approve has no side effect until the
human runs `/plan:approve`, so re-opening a dismissed window is harmless —
this makes it self-heal on the next `job-pending` edge. (b) **Pre-spawn
live-session-in-root gate:** before `launchInGhostty` spawns, refuse if the
target root already has a live session — derive "live in root" from the
snapshot (a job at `state='working'` / a `running`-tag verdict on that root)
OR a launched-but-unfulfilled dispatch on that root. Exclude the row being
dispatched (don't block self). Fail-closed (suppress) on a stale/partial
snapshot — duplicate workers on one task risk git corruption
(false-negative-safe). Reuse the `effectiveRoot` derivation
(`scripts/autopilot.ts:206-210`) and the `isLiveWorkOccupant` notion rather
than reinventing. This gate covers the P1 `job-pending`-overlapping-a-worker
case at dispatch time WITHOUT widening readiness pass-2 — the verdict
deliberately keeps the honest "awaiting your approval" signal. Reconcile the
three suppression mechanisms (once-for-life `dispatchedKeys`, approve
fulfillment-keying, pre-spawn gate) so they neither deadlock nor storm. Do
NOT add a general wall-clock self-heal timer (noted alternative; out of
scope).

### Investigation targets

**Required** (read before coding):
- scripts/autopilot.ts:1458-1468 — `logDispatch`; :1493-1499 — `dispatchedKeys.has` suppression in `launchInGhostty`
- scripts/autopilot.ts:812-932 — `hydrateDispatchLog` two-pass (rebuilds dispatched/fulfilled/completed sets)
- scripts/autopilot.ts:956-986 — `findSessionJob` (matches embedded `plan_verb`; needs `.2`'s `--name`)
- scripts/autopilot.ts:1050-1136 — `detectJobTransitions` (fulfilled/completed)
- scripts/autopilot.ts:206-210 — root derivation; :1670-1729 — dispatch sites
- src/readiness.ts:785-790 — `isLiveWorkOccupant`

### Risks

- Three suppression mechanisms can deadlock (never re-dispatch) or storm (always re-dispatch) — scope fulfillment-keying to `approve` only and keep `dispatchedKeys` load-bearing against the dispatch→projection propagation race.
- Pre-spawn gate must exclude the row it is dispatching (self), or it blocks its own dispatch.
- Snapshot staleness post-reconnect — bias fail-closed.

### Test notes

autopilot.test.ts: (a) simulate a dismissed approve (launch line, no
fulfilled) → assert re-dispatch is allowed on the next `job-pending` edge;
(b) assert `work`/`close` remain once-for-life suppressed; (c) a live
session in a root → a second dispatch to that root is suppressed; (d)
fail-closed on a partial snapshot.

## Acceptance

- [ ] `approve` suppression keyed on fulfillment (`fulfilledKeys`), not launch; dismissed approve re-dispatches on the next edge
- [ ] `work`/`close` retain once-for-life launch suppression
- [ ] Pre-spawn gate refuses a second live session in an occupied root (self excluded), fail-closed on stale snapshot
- [ ] Covers the job-pending-overlap case without changing readiness pass-2
- [ ] No re-dispatch storm and no deadlock across the three suppression mechanisms

## Done summary
Approve dispatches now suppress on fulfillment (not launch) so a dismissed approve re-dispatches on the next job-pending edge; work/close keep once-for-life launch suppression. Added pre-spawn live-session-in-root gate (running-tag sibling OR launched-but-unfulfilled in same root, self excluded, fail-closed on null/empty snapshot). Reconciled in pure shouldSuppressDispatch helper with 12 new tests.
## Evidence
