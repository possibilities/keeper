## Overview

keeperd gets a reaper worker: it kills the tmux windows of
autopilot-dispatched jobs whose work is verifiably complete — stopped for
over 60s with a `{tag:"completed"}` readiness verdict (work job: task
completed; close job: epic close-row completed) — so the managed
`autopilot` session stops accumulating dead windows. Pure external
actuator: reads projections read-only, kills via a new `killWindow`
ExecBackend op, writes NOTHING to the DB — the existing exit-watcher →
synthetic `Killed` mint records the death and terminalizes the row.

## Quick commands

- `bun test test/reaper-worker.test.ts test/exec-backend.test.ts` — unit tier
- Smoke: let autopilot finish a task, wait ~80s, then `tmux list-windows -t autopilot` no longer shows the worker's window and `keeper jobs` shows the row `killed`
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT job_id,state,plan_ref FROM jobs WHERE plan_ref IS NOT NULL ORDER BY updated_at DESC LIMIT 5"`

## Acceptance

- [ ] ExecBackend exposes `killWindow(paneId)` (pure argv builder, never-throw envelope, pane-id targeted)
- [ ] Reaper kills ONLY rows passing the full predicate: managed session + work/close verb + stopped >60s + completed verdict + non-null pane AND pid
- [ ] Full predicate is recomputed against a fresh snapshot immediately before each kill; any miss aborts
- [ ] Worker writes nothing to the DB; row terminalization flows through the existing exit-watcher Killed mint
- [ ] Cycles fire on data_version pulses AND a coarse periodic tick, single-flight
- [ ] `bun run test:full` passes

## Early proof point

Task that proves the approach: ordinal 1 (the kill op — first kill-class
action on the backend). If it fails: re-verify `kill-window -t %N`
pane-resolution semantics against tmux 3.6b in a scratch `-L` server.

## References

- `fn-799-remove-zellij-exec-backend` (dep) — mid-rewrite of `src/exec-backend.ts`; build on the post-zellij shape.
- `fn-801-add-tmux-window-renamer-worker` (dep + overlap) — its tasks edit `src/exec-backend.ts`, `docs/exec-backend.md`, daemon registration sites, README worker count, and the ALL_WORKERS test pin — the same five surfaces this epic writes; serialized after it.
- `src/autopilot-worker.ts:1307` — `loadReconcileSnapshot`, already exported; the reaper imports it (no extraction).
- `src/readiness.ts:497-516` — the liveness-gated `completed` verdict that IS the "appears complete" bar.
- `src/daemon.ts:2201-2294` — exit-watcher → Killed mint, the post-kill convergence path.
- tmux/tmux #2849 — no after-kill-window hook; post-kill bookkeeping belongs to the exit-watcher.

## Docs gaps

- **README.md** (~2355): worker count → twelve (after fn-801's eleven) + reaper paragraph — covered by task 2.
- **README.md** (~2279): "keeper NEVER closes a window" passage is now false — revise to current behavior, collapse the deleted-reap tombstone language — covered by task 2.
- **README.md** (~118): WAL aside says "the reaper" in a checkpoint sense — rename to "background readers" to free the word — covered by task 2.
- **docs/exec-backend.md** (~54, ~68): op table gains `killWindow`; "There is no reap op on the interface" prose replaced — covered by task 1.

## Best practices

- **`kill-window -t %N` resolves the pane upward and kills the whole window:** intended tmux behavior; managed windows are one-pane so this is the wanted semantics [tmux manpage]
- **Killing the last window kills the session:** fine — the detached managed session is re-minted by the next dispatch's get-or-create
- **remain-on-exit does not block kill-window:** managed windows set it; kill still removes them cleanly
- **SIGHUP can be absorbed:** the exit-watcher (kqueue NOTE_EXIT + pid/start_time match) is the only truth of death — never assume the kill sufficed [Chromium kill_mac.cc pattern]
- **Check-then-kill with an immediate pre-kill re-check:** the CWE-367 TOCTOU mitigation; a verdict that flipped on resume must abort the kill
- **Stable-id targeting is rename-proof:** `%N` targets cannot be redirected by the concurrent renamer worker; only name/index targets race [tmux #4826]
