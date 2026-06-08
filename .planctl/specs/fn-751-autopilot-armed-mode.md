## Overview

Add an explicit autopilot mode enum alongside today's implicit "yolo"
behavior. **yolo** (the current behavior, and the backward-compatible
default) works every ready epic until none remain. **armed** works ONLY a
human-chosen set of armed epics PLUS their transitive upstream dependency
closure — so arming an epic also pulls in the prerequisites it can't
complete without, instead of deadlocking on them. Cross-project deps get no
special-casing: an armed epic (and everything its closure pulls in) is
dispatched exactly as a yolo epic would be, in its own `project_dir`.

Mode + the per-epic armed flag are persisted via synthetic events into
projections (`AutopilotMode` → a new `mode` column on the `autopilot_state`
singleton; `EpicArmed` → a new `armed_epics` presence table). The reconcile
worker reads both from the projection snapshot every cycle — NO relay, NO
in-memory cache — so the state survives restart for free and there is one
source of truth. The human controls it via `keeper autopilot mode
<yolo|armed>` and `keeper autopilot arm|disarm <epic>`; the autopilot screen
shows the mode + armed list, and the board flags armed epics with a pill.

## Quick commands

- `keeper autopilot mode armed && keeper autopilot arm <epic-id> && keeper autopilot play`  # arm an epic and let armed mode work it + its upstream closure
- `keeper autopilot mode yolo`   # back to work-everything
- `keeper autopilot`             # screen shows `[playing] · armed · N armed` banner + armed-epics section
- `keeper board`                 # armed epics carry an `[armed]` pill

## Acceptance

- [ ] In `armed` mode the reconciler dispatches `work` only for explicitly-armed epics and their transitive upstream dep-closure; everything else is suppressed.
- [ ] Arming an epic whose (possibly cross-project) upstream is unarmed still works that upstream — no deadlock; behaves like yolo for the eligible set.
- [ ] `yolo` mode is byte-for-byte unchanged from today's behavior; `mode` defaults to `'yolo'` on a zero-event / pre-existing DB.
- [ ] `approve` and `close` finalizers + completion-reap are mode-exempt — disarming mid-flight never orphans a live worker or leaks zellij surfaces.
- [ ] Mode + armed set are read from the projection each reconcile cycle (no relay, no `ReconcileState` cache); they survive a daemon restart.
- [ ] Schema bumps 61→62 with `62` added to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py` in the same change; `test/schema-version.test.ts` passes.
- [ ] `AutopilotMode` + `EpicArmed` folds are re-fold-deterministic (never throw, malformed → safe no-op, `armed_epics` in the re-fold DELETE list).
- [ ] `keeper autopilot mode|arm|disarm` round-trip through the new RPCs; the screen shows mode + armed list; the board shows the `[armed]` pill on explicitly-armed epics.

## Early proof point

Task that proves the approach: `.1` (storage + events + projections
foundation). If the singleton column-preservation matrix or the re-fold
determinism for the new events can't be made to hold, the whole persistence
model is wrong and we rethink the projection shape before building the
reconcile arm or the control plane on top of it.

## References

- Template to clone end-to-end: the `AutopilotPaused`/`AutopilotCapSet` path — reducer fold + payload extract (`src/reducer.ts:3882-4057`), `applyEvent` switch (`src/reducer.ts:8055`), schema table+column (`src/db.ts:1535`), migration block (`src/db.ts:5960-6022`), wire descriptor + REGISTRY (`src/collections.ts:718-813`), RPC handler + registration (`src/rpc-handlers.ts:457-683`), bridge messages (`src/server-worker.ts:190-216`), daemon bridge (`src/daemon.ts:1734-1827`).
- Closure substrate: `ResolvedEpicDep` (`src/types.ts:1215-1242`) — walk `resolved_epic_deps[].resolved_epic_id`; resolver `src/epic-deps.ts:172` (do NOT add new resolution code).
- Reconcile dispatch arms: `src/autopilot-worker.ts` reconcile() at :1154, `state.paused` checks at :1255 (task) / :1332 (close-row), budget gate :1310, `loadReconcileSnapshot` :1841, worker boot-seed :1942.
- Inter-epic coordination (advisory, see epic deps): fn-747 (slow-tier in-process daemon harness — our slow-tier RPC/fold tests need it; also co-edits `src/daemon.ts` + `test/helpers/in-process-daemon.ts`), fn-749 (extends `DaemonOptions`/spawn block in `src/daemon.ts`), fn-744 (reshapes `src/server-worker.ts` cold-subscribe serialize + diffTick delta loop where the new `armed_epics` collection must be wired).

## Docs gaps

- **CLAUDE.md** (`## Writes are tightly scoped — DO NOT widen them`): the closed "RPC may write ONLY four surfaces" enumeration must gain `set_autopilot_mode` + `set_epic_armed` and update the count/framing.
- **CLAUDE.md** (`## Autopilot`): add the yolo-vs-armed enum, the `armed_epics` table, and what transitive upstream dep-closure means for dispatch gating.
- **README.md**: RPC surface paragraph (~178-206), `What keeper is NOT` non-goals (~212-223, already-stale RPC-write sentence), `keeper autopilot` CLI subsection (~800-841, add arm/disarm/mode + armed section + `[armed]` pill), and a new v62 schema narrative block mirroring the v47 `autopilot_state` block (~1549-1575).
- **keeper/api.py**: `SUPPORTED_SCHEMA_VERSIONS` += `62` (hard gate; same change as the `SCHEMA_VERSION` bump).

## Best practices

- **Multi-source BFS for the closure:** seed one `visited` set from ALL armed epics and walk reversed (child→parent) edges in a single O(V+E) pass — avoids the per-root visited-set alias bug and is cycle-safe by construction (a visited node is never re-enqueued, so a user-authored dep cycle can't hang the reconciler). [argo-workflows; BFS visited-set pitfalls]
- **Read armed state from the projection, not in-memory:** the armed set is a configuration/safety gate, so it must survive restart — read it from the snapshot each cycle (like every other dedup arm) rather than threading it through `workerData` (static/stale) or a `ReconcileState` cache (boots empty). [kubebuilder: base allowlists on API state, not global in-memory]
- **"not armed" is a desired-state verdict, not a pre-filter skip:** the mode check lives inside reconcile as a suppression arm, preserving level-triggered correctness — readiness.ts is untouched. [kubebuilder good practices]
- **Don't encode armed in the dispatchKey or command args:** mode is a read-side eligibility filter, nothing downstream should see it.
