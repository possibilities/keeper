## Overview

Crash-restore currently reconstructs "what was live at the crash" RETROSPECTIVELY from `state='killed'` rows + a point-in-time `close_kind` probe. That probe RACES the tmux server restart: once `setup-tmux` respawns the server, the dead crash-victim panes read as "server up, pane gone" → stamped `window_gone_server_alive` (identical to a deliberate user close) → excluded from restore; and the generation window anchors on a stale `BackendExecStart` event-id, sweeping a full day of previously-closed rows into the offer. A real incident restored 40+ sessions when only ~12 were live and only 1 overlapped.

End state: derive the restore set from POSITIVE pre-crash evidence — the dying server generation's last `TmuxTopologySnapshot` event (written before the crash, immune to the restart race), selected by probing the current server pid (`G_now`) at restore time and taking the newest snapshot whose `generation_id != G_now`. The retrospective `close_kind`/killed-cohort model is DEMOTED to a clearly-labeled fallback used only when the dying generation has no surviving snapshot. The offer count then matches what `--apply` restores.

## Quick commands

- `bun scripts/restore-agents.ts --last-generation` — dry-run; prints the topology-anchored restore set for the dying generation (read-only, daemon-down OK)
- `bun test test/restore-set.test.ts test/restore-agents.test.ts test/compaction.test.ts`
- `bun run test:full` — mandatory before landing (touches db/reducer/worker/restore paths)

## Acceptance

- [ ] `--last-generation` derives the restore set from the dying generation's last `TmuxTopologySnapshot`, not the killed cohort, when a snapshot exists
- [ ] The killed-cohort + `close_kind` model still works as a labeled fallback when the dying generation has no snapshot
- [ ] A re-run of the real-incident scenario (server respawned, day-old killed rows present) offers ONLY the genuinely-live windows, not the historical pool
- [ ] `restore-agents --apply` fails closed (non-zero, launches nothing) while autopilot is unpaused unless `--force` is passed
- [ ] `TmuxTopologySnapshot` retention is an explicit, tested compaction invariant
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: `.2` (the topology-anchored deriver). If it fails — e.g. snapshots are not reliably present for the dying generation — the demoted `close_kind` fallback still produces a (weaker) restore set, so the feature degrades rather than breaks.

## References

- Producer: `src/restore-worker.ts:1028-1064` (`topologySnapshotPulse`), `:1076` (`probeServerGeneration`, reused for `G_now`), `:1161-1186` (`seedLastGenerationHash`, the daemon-down read template)
- Deriver: `src/restore-set.ts:435-509` (`deriveLastGenerationSet`, the stale-anchor model), `:355-374` (idempotence filters kept in fallback)
- Fold: `src/reducer.ts:3199-3248` (`extractTmuxTopologySnapshot`), `:3285-3315` (`foldTmuxTopologySnapshot`, sole writer of `backend_exec_generation_id`)
- Coordination — **fn-947** (Consolidate resume launch transport): `fn-947.2` ("Migrate crash-restore, delete old transport") edits `src/restore-worker.ts` + `scripts/restore-agents.ts` and should build on THIS epic's topology-anchored consumer model rather than the old killed-cohort one — a reverse-dependency (this lands first), not wired as a hard edge.
- Coordination — **fn-952** (tmux control-mode focus capture): `fn-952.2` (`src/reducer.ts` new fold) and `fn-952.5` (`src/compaction.ts` new predicate) touch disjoint regions of the same two files; conflict risk is low, not wired as a hard edge.

## Alternatives

- **Keep the killed-cohort model, fix only the boundary + restart race** — rejected: `close_kind` is fundamentally a point-in-time probe that loses the restart race; no boundary fix makes a post-restart "pane gone" distinguishable from a user-close.
- **A new periodically-persisted live-set snapshot event** — rejected: `TmuxTopologySnapshot` already IS that event; minting a second producer duplicates it.
- **Harden `generation_id` to `(pid, start_time)` in this epic** — deferred: `generation_id` is bare-pid across all landed machinery; hardening is a cross-cutting change to a committed event format, its own follow-up epic. PID reuse here degrades to the fallback (a miss, not a wrong restore).

## Architecture

Restore-time read path (daemon-down, read-only `keeper.db`):
probe `G_now` (current tmux server pid) → scan `events` for the newest `TmuxTopologySnapshot` whose `generation_id != G_now` (this is the dying generation; `G_now == null` ⇒ newest snapshot overall, since no server is up) → decode its panes (each now carrying `job_id`) from the EVENT PAYLOAD (never the fold-lagged projection) → filter by `session_name`, apply the existing idempotence filters → order by `window_index` → resume. No snapshot for any non-`G_now` generation ⇒ labeled fallback to the `close_kind` killed-cohort model.

## Rollout

Purely additive to the event payload (`job_id` per pane) — no migration; existing snapshots without `job_id` simply fall through to the fallback or resolve via the `(generation_id, pane_id)` projection join. Ship behind the existing `--last-generation` path. Rollback = revert the deriver swap; the fallback model is unchanged and remains correct.
