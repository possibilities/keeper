## Overview

Keeper autopilot's dispatch path has a weak outbox + launch-outcome contract
(Codex-root-caused from today's ghost-tab incident; findings.md §7c). Three
fixes: (1) **durable mint-before-launch** — today `emitDispatched` is a
fire-and-forget `postMessage`, NOT awaited before `launch()`, so main can
drain a worker's `SessionStart` BEFORE the queued `dispatched` message → the
`pending_dispatches` row is never written → the launch-window occupancy arm
never fires → double-dispatch (the fn-627 class). (2) **three-way outcome** —
a confirm-timeout (60s ceiling) with `launch.ok===true` means the launch
outcome is UNKNOWN, not failed (zellij accepts `new-tab` and execs `claude`
cold 24–33s later); treating it as sticky `DispatchFailed` produces ghost
workers the system wrote off. (3) **reap-on-pause** — on pause/boot-pause,
cancel launch-window zellij surfaces so pre-pause intents don't escape the
pause boundary. Server-side only; NOT a pause-gate change. Prerequisite for
the future confirmRunning split. No reducer/schema change.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/daemon.test.ts test/exec-backend.test.ts` — ack/outcome/reap proofs.
- `bun run lint && bun run typecheck && bun test` — green; assert SCHEMA_VERSION still 59 (no bump).
- Pause autopilot with a launch-window ghost tab open → the tab is reaped; a live worker's tab (discharged pending row) is NOT.

## Acceptance

- [ ] The worker AWAITS main's durable `Dispatched` insert (an id-correlated `dispatched-ack`) BEFORE `launch()`. On ack `ok:false` or ack-timeout, it ABORTS without launching (no double-dispatch; a phantom row is cleared by the TTL sweep). The SessionStart-drains-before-dispatched race is closed.
- [ ] Three-way `ConfirmOutcome`: `launch.ok===false` → emit `DispatchFailed` (unchanged); `ok:true` + SessionStart < ceiling → `ok`; `ok:true` + ceiling elapsed → `indoubt` — NO `DispatchFailed`, keep the `pending_dispatches` row, release `inFlight`, let the 120s TTL sweep emit `DispatchExpired`.
- [ ] Reducer is UNCHANGED — `foldDispatchFailed`/`foldDispatchExpired` arms untouched; the ceiling-emit suppression is entirely producer-side. NO new event, NO column, NO `SCHEMA_VERSION` bump (stays 59), `keeper/api.py` untouched. (A test asserts no schema bump.)
- [ ] `ceilingMs (60s) < PENDING_DISPATCH_TTL_MS (120s)` invariant pinned by a test (else the sweep fires mid-confirm → re-dispatch).
- [ ] On `set-paused` (covers boot-pause via the same relay), reap zellij surfaces whose tab-name matches `work::|approve::|close::` AND that have an OPEN `pending_dispatches` row (intersect list-panes with open rows — a discharged row = live worker = NEVER reaped); `exited` ghost tabs are cleaned; the reap is try/caught + never-throws (no-self-heal).
- [ ] `bun test` green; CLAUDE.md + README dispatch-lifecycle docs updated.

## Early proof point

Task that proves the approach: `.1` (keystone). Unit tests: (a) the worker
does NOT call `launch()` until the `dispatched-ack` lands (the race fix); (b) a
ceiling hit with `launch.ok===true` returns `indoubt` and emits NO
`DispatchFailed`. If it fails: the ack channel or the outcome model is wrong —
revisit before the reap.

## References

- findings.md §7c, codex-log.md "2026-06-06 19:17 Codex urgent pause/outbox incident".
- src/autopilot-worker.ts: confirmRunning :825-915 (mint :845, fire-and-forget emitDispatched :1325, launch :852, ceiling→DispatchFailed :900-914), ConfirmOutcome type :565, DEFAULT_CEILING_MS :587, ConfirmRunningDeps :420-466, set-paused handler :1241-1250 (reap hook; backend in scope :1264), dispatchKey tab-name :286.
- src/daemon.ts: handleDispatchedMint :2378-2423 (add the ack reply here), set-autopilot-paused ack PRECEDENT to mirror :1252-1345, worker onmessage :2275-2301, TTL sweep :2484-2557 (PENDING_DISPATCH_TTL_MS :263), selectExpiredPendingDispatches (exported).
- src/reducer.ts: foldDispatchFailed DELETE arm :3631-3643 (CONFIRM unchanged), SessionStart discharge-on-bind :6601-6731.
- src/exec-backend.ts: reap primitives — buildZellijListPanesAllJsonArgs :383 (`list-panes -a -j`, carries tab_name+exited), parseListPanesJson :441, ZellijPane :413, buildZellijClosePaneArgs :327; LaunchResult/never-throw envelope :115-160.
- Server-worker↔main ack pattern: src/server-worker.ts:203-214 (Request/Result id-correlated).
- Tests: test/autopilot-worker.test.ts:200-276 (fake-deps factory), :810/:835(ceiling→failed, CHANGES)/:956/:976; test/daemon.test.ts:1911-2088 (TTL sweep); test/exec-backend.test.ts (argv/parse, fake spawn); test/reducer.test.ts insertEvent helper.
- epic-scout: overlaps fn-721 (in_progress) on autopilot-worker.ts — coordinated out-of-band via the operator's invalidate-all-but-this serialization, NOT a hard dep.

## Architecture

The dispatch lifecycle becomes: capture watermark → `await emitDispatched()`
(main inserts the durable `Dispatched` row, replies `dispatched-ack{id,ok}`) →
only on `ok` call `launch()` → poll `findJob` until ceiling → classify
ok/failed/indoubt. Outbox ordering (mint BEFORE launch) is preserved and now
durable — a crash between ack and launch leaves a phantom row the TTL sweep
clears (strictly preferred over double-dispatch). `pending_dispatches` remains
the SOLE launch-window occupancy truth (no live zellij probe in confirmRunning
— fn-674 retired that). Reap derives candidates by intersecting open
`pending_dispatches` rows with `list-panes -a -j` (verb-prefix match), so it
can never close a pane whose row already discharged on SessionStart (a live
worker).

## Alternatives

- **launch-then-mint / keep fire-and-forget** — REJECTED: the race +
  crash-window reopen double-dispatch (fn-627). Durable ack-before-launch is
  load-bearing.
- **Overload `"failed"` for the timeout with a flag** — REJECTED: distinct
  side effects (no DispatchFailed, keep row) warrant a distinct `"indoubt"`
  member; overloading invites the wrong fold arm firing.
- **New `LaunchUnknown` event / status column** — REJECTED: pending-row
  presence already encodes "in-doubt"; reuse it + the TTL sweep. Avoids a
  schema bump.
- **Live zellij probe to confirm launch** — REJECTED: racier than the
  projection (fn-674); keep the durable row authoritative.

## Rollout

Server-internal control-flow change; no migration, no schema. Risk surface:
the ack-timeout floor must exceed busy_timeout + a boot-drain (≈5s) or boot
dispatches false-abort; the reap predicate must intersect OPEN pending rows or
it could kill a live worker (highest blast radius — gated by acceptance).
Rollback = revert. The fn-720 backstop telemetry should re-label a
ceiling→indoubt outcome (no longer a hard "rescue/failure") so the metric
stays honest — a follow-on cleanup, noted not gated.
