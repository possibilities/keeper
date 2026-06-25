## Description

**Size:** M
**Files:** src/restore-worker.ts, test/restore-worker.test.ts

### Approach

With the control-worker now the topology producer (task `.1`), strip the restore-worker's tmux polling.

- Remove the topology producer arm (`topologySnapshotPulse`), the window-index arm
  (`windowIndexSnapshotPulse`) and the pane-fill arm (`tmuxSnapshotPulse`), and the topology idle-wake
  constant (`RESTORE_TOPOLOGY_IDLE_MS`) AS THE TOPOLOGY DRIVER. These arms also emit `WindowIndexSnapshot`
  / `TmuxPaneSnapshot` events that already fold to no-ops — those emits go too (the reducer no-op arms STAY).
- Re-source `restore.json`'s `window_index`: `buildRestoreTier` currently reads a private window-index
  cache stamped by the removed arms. Change it to read `window_index` from the live `jobs` projection
  (now kept fresh by the control-worker). Remove the now-dead `stampWindowIndexCache`/`pruneWindowIndexCache`
  + cache state. Accept bounded staleness during a control-worker reconnect gap (restore.json is a
  periodically-rewritten mirror; crash-restore re-derives).
- KEEP `backendExecStartPulse` (the ungated `display-message -p '#{pid}'` generation/recycle probe) and the
  ~1s wake that now drives ONLY it — this is the recycle guard for the post-crash no-job state, not a topology
  poll. KEEP `probeServerGeneration` / `probeTmuxTopology` EXPORTED — `seedTmuxProjection` (the boot-seed) still
  imports them even though the restore-worker stops calling `probeTmuxTopology` itself.
- Do NOT touch the reducer, the fold, the floor, or the boot-seed.

### Investigation targets

**Required** (read before coding — verify against the POST-fn-955 restore-worker, which is actively rewriting this file):
- src/restore-worker.ts — `topologySnapshotPulse`, `windowIndexSnapshotPulse`, `tmuxSnapshotPulse`, `RESTORE_TOPOLOGY_IDLE_MS` (the `watchLoop` idle-wake wiring), `backendExecStartPulse` (KEEP), `stampWindowIndexCache`/`pruneWindowIndexCache`, `buildRestoreTier` + the restore.json write path, the exported `probeServerGeneration`/`probeTmuxTopology`, `hasLiveTmuxJob`.
- src/tmux-boot-seed.ts — `seedTmuxProjection` imports the two probes; confirm they stay exported.

### Risks

- fn-955 (topology-anchored-crash-restore) is rewriting this exact file and restore.json semantics — the epic dep sequences this AFTER fn-955; reconcile against its landed shape, do not assume today's line numbers.
- Removing `tmuxSnapshotPulse` also drops its cache stamp — `buildRestoreTier` MUST re-source `window_index` from the projection in the same change or restore.json loses window indices.
- The ~1s wake must SURVIVE for `backendExecStartPulse`; only the topology `list-panes` work is removed from it.

### Test notes

`restore-worker.test.ts`: assert no `list-panes -a` spawn/command on the pulse (topology silenced), the
generation probe still fires, and `buildRestoreTier` reads `window_index` from the projection. Inject the
spawn/post seams; no real tmux in the fast tier. `bun run test:full`.

## Acceptance

- [ ] The restore-worker issues no `list-panes -a` (topology/window-index/pane-fill arms + topology idle-wake driver removed); the `WindowIndexSnapshot`/`TmuxPaneSnapshot` emits are gone; the reducer no-op arms are untouched.
- [ ] `buildRestoreTier` re-sources `window_index` from the live `jobs` projection; the dead window-index cache + stamps are removed.
- [ ] `backendExecStartPulse` (the ungated pid generation probe) and its ~1s wake remain; `probeServerGeneration`/`probeTmuxTopology` stay exported for the boot-seed.
- [ ] Tests prove topology is silenced on the restore-worker, the generation probe still fires, and restore.json carries correct window indices.

## Done summary
Retired the restore-worker's tmux list-panes -a topology poll (topology/window-index/pane-fill arms + idle-wake driver removed); buildRestoreTier now reads window_index straight off the jobs projection (kept fresh by the control-worker's TmuxTopologySnapshot fold). The ungated display-message generation probe and its ~1s wake stay; reducer no-op arms, fold, floor, and boot-seed untouched.
## Evidence
