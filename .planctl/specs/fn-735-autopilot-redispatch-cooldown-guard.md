## Overview

keeper's autopilot reconciler is level-triggered on `PRAGMA data_version` and re-evaluates readiness every cycle. Its suppression arms (`failedKeys`, `isOccupyingJob`, `liveTabKeys`) and the `pending_dispatches` dedup all read PROJECTIONS — when folds lag 15-60s+ behind reality, every arm is blind and the same `verb::id` is re-dispatched (observed: two `close::fn-651` workers at once, infinite re-approve loops, fn-732 re-grabbed mid-migration). This epic adds a fold-lag-immune in-process per-`verb::id` re-dispatch cooldown — an in-memory timestamp `Map` on `ReconcileState`, the optimistic-in-flight-set pattern (cf. Kubernetes `UIDTrackingControllerExpectations`) — that suppresses re-dispatch of a dispatched key regardless of projection lag, covering ALL verbs (work/close/approve). It is dispatch-side scheduling ONLY: never touches the event log, projections, reducer, or RPC surface. Supersedes the approve-only fn-734.

## Quick commands

- `bun test test/autopilot-worker.test.ts`
- `bun test`
- `launchctl kickstart -k gui/$(id -u)/arthack.keeperd`  # deploy: restart the daemon to load the guard

## Acceptance

- [ ] The same `verb::id` is not re-dispatched within the cooldown window even when the projection has not folded the prior dispatch — the DUP-DISPATCH class is closed for work/close/approve.
- [ ] The guard is in-memory only; re-fold determinism, the hook, the event log, and the RPC write surface are untouched.
- [ ] keeperd restarted post-merge; a live unpause produces no duplicate workers.

## Early proof point

Task that proves the approach: `.1`. If it fails (cooldown can't be read in `reconcile` without breaking purity, or the unit/clock model is wrong): fall back to a narrower fix — gate only at the two dispatch sites with a flat `Map<key,number>`, fixed 120s window, no sweep optimization (accepting a small leak), to land the correctness fix fast.

## References

- **Supersedes fn-734-two-condition-approve-dispatch-discharge** (approve-only, reducer-side). fn-734 to be retired; this epic generalizes the concept to all verbs, dispatch-side, in-memory.
- **fn-732-move-approval-to-runtime-sidecar**: functionally complete; NO technical dependency — the cooldown reads no approval state (the epic-scout's "depends on fn-732" was incorrect).
- Kubernetes `ControllerExpectations` / `UIDTrackingControllerExpectations` — canonical optimistic-in-flight-vs-eventually-consistent-cache pattern. K8s issue #129795 (TTL-expiry-without-fulfillment over-dispatch) is NOT applicable here because the durable projection arms remain — the cooldown is additive, not the sole suppressor.
- In-repo `Map`-reaper to mirror: `src/server-worker.ts` `reapStuckPending` + `STUCK_PENDING_TTL_MS`.

## Docs gaps

- **README.md `## Architecture` (~1788-1889)**: revise the dedup enumeration to include the cooldown as the fold-lag-immune arm; consolidate (don't append); note fn-734 supersession; retract forward-refs to fn-734's two-condition approve discharge (~1606-1617).
- **CLAUDE.md / AGENTS.md `## Autopilot` (~140-166)**: add the cooldown as a named suppression arm (bold-lead paragraph: in-memory, lost on restart, covers all three verbs).

## Best practices

- **Optimistic in-flight set is the suppression source of truth; the projection is eventually-consistent and only releases entries** (k8s `UIDTrackingControllerExpectations`).
- **TTL must be conservatively longer than any plausible fold lag** — a TTL shorter than fold lag re-introduces over-dispatch at expiry (k8s #129795). Safe here because the durable arms remain.
- **Cooldown is not debounce** — suppress-after-action, not coalesce-before.
- **Bound + sweep the map** or it leaks over daemon uptime.
