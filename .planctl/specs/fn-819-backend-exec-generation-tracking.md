## Overview

Record each tmux-server "generation" boundary as a backend-agnostic synthetic
`BackendExecStart` event so keeper can scope crash-restore to the PREVIOUS
session generation — "the session you just lost" — instead of the 7-day pool
`deriveRestoreSet` returns today. The restore-worker pulse (already minting
change-gated `TmuxPaneSnapshot` + `WindowIndexSnapshot`) gains a third member of
that family: it probes the tmux server pid, change-gates, and main emits
`BackendExecStart` carrying `backend_type` + the generation id. A new read-time
`deriveLastGenerationSet` bounds crash candidates to the kill-anchored generation
window, surfaced via a `restore-agents --last-generation` flag and a
`keeper setup-tmux` foreground-only "restore last session" offer. TIGHT scope:
establish the extensible seam; capture nothing beyond server-generation now.

## Quick commands

- `bun scripts/restore-agents.ts --last-generation` — dry-run: lists ONLY the last generation's crash candidates.
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT id, datetime(ts,'unixepoch','localtime'), json_extract(data,'\$.generation_id') FROM events WHERE hook_event='BackendExecStart' ORDER BY id DESC LIMIT 5"` — eyeball recorded generations.
- `bun run test:full` — mandatory; touches restore-worker / daemon / reducer / restore-set / exec-backend / a CLI subprocess.

## Acceptance

- [ ] `BackendExecStart` is minted by the restore-worker pulse when the tmux server pid changes (or on first observation), backend-agnostic (`backend_type` + `generation_id` in the payload), via the existing pulse→event→fold family; a keeperd restart against an UNCHANGED server emits no spurious boundary.
- [ ] The reducer folds `BackendExecStart` via an explicit no-op DISPATCHER arm (never the inner-switch default that routes to `projectJobsRow`); no new events column, no schema bump.
- [ ] `deriveLastGenerationSet` bounds crash-like candidates to the kill-anchored generation window (`last_event_id >= B_boundary` where `B_boundary = MAX(events.id) <= K_max`), falling back to the burst heuristic when no `BackendExecStart` exists; reads only `events` + `jobs` off a read-only DB (daemon-down OK).
- [ ] `restore-agents --last-generation` composes with `--apply` + `--session`; `keeper setup-tmux` offers a foreground-only restore (TTY-gated, candidates computed before any session-creating call) when `foreground` is absent and last-generation candidates exist; skips when `foreground` exists.
- [ ] `bun run test:full` green; docs (README boundary-free claim, ninth-worker event list, the two HELPs) updated.

## Early proof point

Task that proves the approach: `T2` (`deriveLastGenerationSet`). The kill-anchored window is the load-bearing correctness piece — boot ordering (seedKilledSweep mints dead-gen kills BEFORE the restore-worker spawns) makes the naive "after most-recent start" bound exclude the very agents we want. Prove it against a seeded fixture replaying that exact ordering (BackendExecStart events + killed foreground agents straddling boundaries + an older straggler that must be excluded). If the window logic is wrong, fix it before T3 builds the UX on it.

## References

- Continues fn-817 (DB-derived crash-restore) + fn-818 (restore-set burst-key invariant), both DONE; reuses close_kind / window_index / deriveRestoreSet + the restore-worker pulse→event→fold family. fn-817 .2 (697d9883) is the WindowIndexSnapshot template.
- Design provenance: this session's design conversation. Boundary MUST cut by `events.id` (rowid) ORDER, never `ts` (the central fn-817/fn-818 invariant — boot-sweep Killed events are Date.now()-stamped).

## Docs gaps

- **README.md (~2369-2391, crash-restore-set subsection)**: the "boundary-free: no global crash marker" claim becomes FALSE — revise to the generation-boundary semantics.
- **README.md (~2400-2431, ninth-worker)**: add `BackendExecStart` to the worker's event-log contributions (currently lists only WindowIndexSnapshot + TmuxPaneSnapshot).
- **README.md (~1172-1190 setup-tmux, ~2393-2398 restore-agents)** + **cli/setup-tmux.ts HELP** + **scripts/restore-agents.ts HELP**: the restore offer + `--last-generation` flag.

## Best practices

- **Cut the boundary by `events.id` (rowid), never `ts`:** matches fn-817/fn-818; boot-sweep Killed events share one Date.now() instant. [event-sourcing as-of-query]
- **Anchor the window on the kills, not "the current generation":** boot ordering puts the new BackendExecStart after the dead-gen kills, so anchor on K_max. [gap-analyst]
- **pid-reuse missed boundary is benign for restore:** a reused pid means the boundary doesn't advance, so the kills stay inside the (shared) window and are still restored — pid-only suffices; (pid,starttime) is a deferred robustness upgrade. [practice-scout]
