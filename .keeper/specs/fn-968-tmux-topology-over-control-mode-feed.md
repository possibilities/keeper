## Overview

The persistent tmux control-mode client (landed by fn-952) already pulls the whole-server
pane topology over its connection — the `list-panes -a` re-read it issues for focus is a command
on the persistent `-C` socket, not a subprocess. This epic makes that worker the SOLE topology
producer: it emits `TmuxTopologySnapshot` from its existing re-read, and the restore-worker's ~1s
`list-panes -a` poll (plus the window-index and pane-fill probe arms) is retired entirely. The live
job-location surface (`jobs.backend_exec_session_id` / `window_index`) becomes real-time and the
daemon stops polling tmux for topology. The downstream fold / projection / floor / boot-seed and the
reducer's no-op arms are UNCHANGED — this is a producer relocation behind a byte-identical contract.

The generation-boundary recycle probe (`BackendExecStart`, a one-line `display-message -p '#{pid}'`)
STAYS in the restore-worker: it runs ungated for the post-crash no-job state and relocating it would
force a connect-gate widening plus a crash-restore timing reconciliation with the in-flight fn-955 —
not worth it to move one cheap line that is not the topology poll.

## Quick commands

- `keeper jobs` — switch tmux windows/sessions in another pane; the job's session/window updates in real time (no ~1s lag).
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT job_id,backend_exec_session_id,window_index FROM jobs WHERE backend_exec_type='tmux'"` — live job locations, now control-worker-fed.
- `bun run test:full` — mandatory (daemon/worker/db/reducer paths).

## Acceptance

- [ ] The control-worker emits `TmuxTopologySnapshot` from its EXISTING over-the-connection re-read (no new tmux command, no subprocess spawn), emit-gated on `hasLiveTmuxJob`, with null-generation / read-fault / empty-panes / degraded all as NO-posts (never a wiping snapshot); main mints the event.
- [ ] The restore-worker runs NO `list-panes -a` poll — the topology, window-index, and pane-fill probe arms and the topology idle-wake are removed; `restore.json`'s `window_index` re-sources from the live `jobs` projection; the ungated `display-message -p '#{pid}'` generation probe (and the ~1s wake that now drives only it) STAYS.
- [ ] The `TmuxTopologySnapshot` fold, the `tmux_projection_state` floor, `seedTmuxProjection`, and the reducer no-op arms (`TmuxPaneSnapshot`/`WindowIndexSnapshot`/`BackendExecSnapshot`/`BackendExecStart`) are untouched; a from-scratch re-fold is byte-identical.
- [ ] Dual-source equivalence: for a given tmux state the control-worker's `TmuxTopologySnapshot` payload matches what the old restore-worker poll produced (golden strings); the fast tier uses no real tmux; the live `tmux -C` path is `*.slow.test.ts`, allowlisted.

## Early proof point

Task that proves the approach: `.1` (control-worker topology emit). If its over-the-feed snapshot
drives `jobs.session`/`window_index` identically to the old poll, the relocation holds. If it fails:
revert `.2` (keep the restore-worker poll) while `.1`'s producer is hardened — the two coexist behind
the same fold, so a rollback is a one-arm change.

## References

- fn-952 (tmux-control-mode-focus-capture) — DONE; the control-worker host this epic extends. The `list-panes -a` re-read is already a framed command over the persistent `-C` connection (`sendCommand` → `child.stdin.write`), not a subprocess — topology rides the same read.
- The generation boundary stays in the restore-worker: its ungated post-crash semantics can't move to the `hasLiveTmuxJob`-gated control-worker without widening the connect gate AND reconciling timing with fn-955.
- tmux control-mode notifications carry `window-id` (`@N`) not `window_index` (positional), and a window reorder has no dedicated notification — so a framed re-read (not a pure notification-driven delta model) is required; the delta-model is the fragile path fn-952 rejected.

## Docs gaps

- **README.md `## Architecture`**: give the control-worker its own numbered worker paragraph noting it now emits BOTH focus AND topology; strip the topology-poll arm from the restore-snapshot worker block (it retains the restore.json mirror + the cheap generation probe); update "timer-poll" / "topology poller" phrasings to the real-time control-worker.

## Best practices

- **Canonicalize via `hashTopology`:** feed the mapped `{pane_id,window_index,session_name}` triples through the SAME `hashTopology` in the same order so the new source's dedup hash matches the old — a steady topology never churns a spurious event.
- **Empty/degraded ⇒ no-post:** the topology path must never post on null-generation, read-fault, or zero panes (unlike focus, which posts `status:"none"`) — a wiping snapshot would clobber every live job location.
