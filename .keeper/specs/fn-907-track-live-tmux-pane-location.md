## Overview

A worker pane relocated out-of-band by the human (`tmux break-pane` / `move-window`)
keeps showing under its ORIGINAL tmux session in `keeper jobs` / `keeper dash`, and its
`window_index` goes stale too. Root cause: `jobs.backend_exec_session_id` is re-asserted
on EVERY hook event from the FROZEN `KEEPER_TMUX_SESSION` env (the launch session never
rewrites when a pane moves), and the restore-worker's fill-only `TmuxPaneSnapshot` fold
never overwrites a non-NULL session; its anti-recycle guard (`probe.session_name !=
job.backend_exec_session_id`) then ALSO blocks the `window_index` correction — one frozen
column breaks both fields.

End state: a pane's live location (session NAME + window index) tracks reality within
~1-2s of any move, driven by a keeperd TIMER-POLL producer → one authoritative
`TmuxTopologySnapshot` event → a live-only fold keyed on `(generation_id, pane_id)`. The
two location columns become LIVE-ONLY (boot-seeded + skip-floored like the git surface,
excluded from the byte-identical re-fold charter). The frozen env is demoted to a forensic
`backend_exec_birth_session_id`; consumers fall back to it so nothing regresses.

## Quick commands

- Reproduce + verify the fix end to end:
  ```bash
  # with a worker running in tmux session 'autopilot', move its pane to 'foreground':
  tmux break-pane -s autopilot:<win>.<pane> -t foreground:    # or move-window
  # within ~1-2s, keeper reflects the new live location:
  keeper jobs --json | jq '.[] | {t:.title, sess:.backend_exec_session_id, win:.window_index}'
  ```
- Determinism gate (must stay green): `bun test test/refold-equivalence.test.ts test/git-live-projection.test.ts`
- Full slow tier (mandatory — touches daemon/worker/db/hook/git paths): `bun run test:full`

## Acceptance

- [ ] After an out-of-band `break-pane`/`move-window`, `keeper jobs`/`keeper dash` reflect the
      pane's new session + window_index within ~2s, and STAY correct across the worker's
      subsequent tool calls (no env re-clobber).
- [ ] `backend_exec_session_id` + `window_index` are LIVE-ONLY (in `LIVE_ONLY_JOBS_COLUMNS`,
      zeroed by `rewindLiveProjection`, excluded from the re-fold byte-identical charter);
      from-scratch re-fold reproduces byte-identical rows for all OTHER columns.
- [ ] A recycled `%N` pane id from a NEW tmux server generation never overwrites a prior
      generation's job row (the `(generation_id, pane_id)` guard holds).
- [ ] A killed/absent pane, a NULL/garbage window_index, an empty-but-successful probe, or a
      transient probe failure NEVER wipes a job's last-known good location.
- [ ] Crash-restore + dash grouping fall back to `backend_exec_birth_session_id` when the live
      session is unresolved — the restorable set and dash grouping do not regress vs today.
- [ ] `SCHEMA_VERSION` bumped to 83 and added to `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py`
      in the same commit; a fresh DB and an upgraded DB both end at the same schema.
- [ ] `bun run test:full` is green.

## Early proof point

Task that proves the approach: `.3` (topology fold + recycle guard). It is the determinism
keystone — it must overwrite live location, gate above the skip-floor, hold the recycle
guard, and keep retired-event arms as explicit no-ops so re-fold stays byte-identical. If it
fails (re-fold drift, or the guard mis-fires on a recycled pane), fall back to keeping
`window_index` deterministic and shipping only the session correction, then revisit the
column reclassification.

## References

- Design decision (FINAL): signal source is a keeperd timer-poll producer, NOT tmux hooks
  and NOT a persistent control-mode client. Every candidate signal is only a "something
  changed" wake; the authoritative read is always `tmux list-panes -a` (whole-server, one
  shot). Control mode is a documented FUTURE drop-in upgrade behind the SAME `TmuxTopologySnapshot`
  event seam (swap the producer's wake from timer to a `tmux -C` connection; the event, fold,
  recycle guard, and migration are unchanged). Hooks were rejected (server-runtime state lost
  on restart; run-shell spawn-per-fire; config jank).
- `fn-904` (dependency + file overlap): actively churns `src/db.ts` + `test/refold-equivalence.test.ts`
  — this epic must land AFTER it.
- `fn-905` (file overlap): touches `src/git-boot-seed.ts` + `src/daemon.ts` boot sequence, which
  this epic's boot-seed mirrors/extends — sequence after to avoid a merge fight.
- `fn-902` "Order dash by tmux window index" (REVERSE dependency): consumes the
  `foldWindowIndexSnapshot` fold + restore-worker producer this epic RETIRES/extends. fn-902
  must be (re)planned against the new `TmuxTopologySnapshot` world AFTER this epic lands.
- tmux gotchas (verified): `#{pane_id}`/`#{window_id}`/`#{session_id}` are stable across
  break-pane/move-window and contain no control chars; session/window NAMES can contain tabs
  (delimiter hazard); `%N` is reused after kill (hence the generation guard); server pid is the
  generation handle (consistent with existing `BackendExecStart`); exit0+empty stdout = server
  up with no panes (do NOT wipe), non-zero+"no server running" = gone, other non-zero = transient.

## Alternatives

- **tmux hooks (`set-hook -g window-linked/...` → run-shell emitter)** — rejected: global hook
  state is lost on tmux server restart (needs re-arming or a config drop-in), spawns a process
  per fire, and is spookier than a self-contained worker.
- **Persistent control-mode client (`tmux -C`)** — viable and self-contained (a single client
  hears server-wide window/session lifecycle), but buys sub-second latency we don't need at the
  cost of a persistent connection's `%begin/%end/%error/%exit` parser, reconnect-on-restart, and
  `no-output` firehose suppression. Held as the documented upgrade behind the same event seam.
- **Keep `window_index` deterministic, fix only session** — rejected: the anti-recycle guard
  ties the two together; a half-fix leaves window_index stale. (Retained as the `.3` fallback.)

## Architecture

Producer (live, may probe) → event (frozen payload) → fold (pure, gated). The restore-worker
already owns the `tmux list-panes -a` probe, the per-pulse dedup hashes, and the server-pid
generation machinery (`probeServerGeneration` / `BackendExecStart`). It gains a ~1s timer wake
and a new whole-server topology probe whose hash-deduped result is posted to main, which mints
ONE `TmuxTopologySnapshot` carrying `{generation_id, panes:[{pane_id, session_name, window_index}]}`.

The fold is the sole owner of live location: for each live tmux job, match by `pane_id`, verify/
adopt `generation_id` (recycle guard), and OVERWRITE `backend_exec_session_id` + `window_index`
only with present, non-NULL values — gated above `tmux_projection_state.floor`. Pure: reads only
the event payload + in-txn rows. The env COALESCE arm stops writing session and instead writes
`backend_exec_birth_session_id`. `TmuxPaneSnapshot` + `WindowIndexSnapshot` folds become explicit
no-op arms (historical events must not re-route into `projectJobsRow`).

`tmux_projection_state` (singleton `floor` + `seed_required`, mirroring `git_projection_state`)
is boot-seeded in `serveBootDrain` after the drain + `seedKilledSweep`, before the actuator gate.
Unseeded reads UNKNOWN, never a stale-clean session.

## Rollout

Forward-only migration (v82 → v83) inside one `.immediate()` txn: add columns, create
`tmux_projection_state`, add it to the fresh-schema CREATE block, extend `LIVE_ONLY_JOBS_COLUMNS`
+ `rewindLiveProjection`, one-time backfill `birth_session ← current backend_exec_session_id`,
bump `SCHEMA_VERSION` + `SUPPORTED_SCHEMA_VERSIONS`. No cursor rewind (the location columns go
live-only and are boot-seeded; history isn't replayed for them). Rollback: an old binary refuses
to downgrade (the migrate() version guard), so rollback is "redeploy old binary against a v82 DB";
a v83 DB stays forward-compatible. Sequenced after fn-904 + fn-905.

## Docs gaps

- **README.md**: revise the hook-scraping intro (~67-77), backend-exec coordinates (~2006-2036),
  window_index/close_kind block (~2186-2195), restore-worker description (~2848-2869), and the
  live-only/projection-class taxonomy (~1858-1884); add an "As of schema v83" history block.
- **CLAUDE.md / AGENTS.md**: add the tmux live surface + `tmux_projection_state` to the
  projection-class taxonomy block (~65-99); update "Scraping is scoped" (~164-167) so
  `KEEPER_TMUX_SESSION` maps to the forensic birth column, not the live session.

## Best practices

- **Key on IDs, never names:** session/window NAMES can contain tabs/newlines and change on
  rename; use `#{pane_id}`/`#{session_id}` for identity + hashing so a rename can't fire a phantom
  topology event. [tmux Formats wiki]
- **Distinguish server-gone from transient:** exit0+empty stdout = up-with-no-panes (don't wipe);
  non-zero + "no server running"/"failed to connect" = gone; other non-zero (timeout/SIGKILL/EPIPE)
  = transient → keep last state. [tmux issue #4026]
- **Generation must be in the key:** `%N` is reused after kill, so `(generation_id, pane_id)` is
  mandatory — a recycled pane in a new server is a different pane. [tmux ID semantics]
- **localeDefaultedEnv is load-bearing:** a C-locale tmux client mangles the TAB delimiter and
  drops every row — the probe MUST go through `defaultSpawnSync`.
