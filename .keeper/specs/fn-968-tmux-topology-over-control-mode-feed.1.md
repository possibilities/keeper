## Description

**Size:** M
**Files:** src/tmux-control-worker.ts, src/tmux-focus-derive.ts, src/daemon.ts, test/tmux-focus-derive.test.ts, test/tmux-control-worker.test.ts

### Approach

Make the control-worker emit `TmuxTopologySnapshot` from the framed `list-panes -a` re-read it
ALREADY issues for focus (`runReread` / `runConnection`) — no new tmux command, no subprocess.

- Widen `deriveFocus` (src/tmux-focus-derive.ts) to ADDITIVELY return the full parsed pane set
  (`TmuxPaneRow[]`) alongside the focus — today the rows are parsed in `parsePaneLines` then discarded
  inside `pickCurrentClient`. Keep `FocusDerivation` additive (don't break the focus contract).
- In the re-read path, map `TmuxPaneRow[]` → the topology pane shape (`paneId→pane_id`,
  `session→session_name`, `windowIndex→window_index`), build a `TmuxTopologySnapshotMessage`
  `{kind:"tmux-topology-snapshot", generation_id, panes:[…]}`, dedup it on `hashTopology` (export/move it
  from the restore-worker) mirrored on the existing `focusDedupKey` per-connection-scope pattern, and post
  on change. EMIT-gate on `hasLiveTmuxJob` (topology is pointless with no jobs to locate). Apply the four
  restore-worker skip-gates as NO-posts: `generationId === null`, read-fault (the re-read catch), empty
  panes (`panes.length === 0`), degraded — only a successful non-empty read posts. Topology rides the SAME
  debounced single-in-flight re-read as focus (no separate cadence).
- Widen the `TmuxControlWorkerMessage` union; in `src/daemon.ts` the control-worker `onmessage` handler
  mints the synthetic `TmuxTopologySnapshot` event (relocate the restore-worker's existing topology mint
  arm; main stays the SOLE synthetic-event writer). Preserve message ordering so generation context is consistent.

### Investigation targets

**Required** (read before coding — line numbers are from fn-952's landing and will have drifted):
- src/tmux-control-worker.ts — `runConnection`/`runReread` (the framed re-read; `sendCommand` over `child.stdin`), `focusDedupKey`, `hasLiveTmuxJob`, the `TmuxControlWorkerMessage` union, the per-connection `lastPostedKey`/`generationId` scope.
- src/tmux-focus-derive.ts — `parsePaneLines` (5-col `TmuxPaneRow[]`) and `pickCurrentClient` (where the pane set is discarded today).
- src/restore-worker.ts — `hashTopology` (reuse for dedup-equivalence), `topologySnapshotPulse` (the four skip-gates + the `TmuxTopologyPane`/`TmuxTopologySnapshotMessage` types to mirror).
- src/daemon.ts — the restore-worker `onmessage` topology mint arm to relocate, and the control-worker `onmessage` handler.
- src/reducer.ts — `foldTmuxTopologySnapshot` (UNCHANGED; confirm the relocated event folds identically).

### Risks

- The 5-col focus format and the restore-worker's 3-col topology format use DIFFERENT parsers; map the rows, do not claim verbatim `parsePaneLines` reuse.
- Dedup-equivalence: a different field order would churn a spurious first snapshot — reuse `hashTopology` on the same triples/order.
- A wiping empty/degraded snapshot would clobber live locations — the skip-gates are mandatory.

### Test notes

Fast tier: `deriveFocus`'s widened return + the row→topology mapping + the dedup/skip-gates, driven by
synthetic `list-panes`/`list-clients` golden strings (no real tmux). Dual-source equivalence: assert the
mapped snapshot equals what the restore-worker poll produced for the same fixture. The live attach path is
exercised in task `.3`'s `*.slow.test.ts`.

## Acceptance

- [ ] `deriveFocus` additively returns the full pane set; the focus contract is unbroken.
- [ ] The control-worker posts `TmuxTopologySnapshot` from the existing re-read, emit-gated on `hasLiveTmuxJob`, deduped via `hashTopology`, with null-generation / read-fault / empty / degraded as no-posts.
- [ ] Main mints the relocated topology event; the `TmuxControlWorkerMessage` union is widened; `foldTmuxTopologySnapshot` is unchanged.
- [ ] Fast-tier tests cover the mapping, dedup-equivalence vs the old source, and every skip-gate.

## Done summary

## Evidence
