## Description

**Size:** M
**Files:** src/exec-backend.ts, src/restore-worker.ts, src/daemon.ts, src/reducer.ts, test/restore-worker.test.ts, test/daemon.test.ts, test/reducer-*.test.ts

Mint a backend-agnostic `BackendExecStart` synthetic event when the tmux server generation changes — the third member of the restore-worker pulse→event→fold family (after TmuxPaneSnapshot + WindowIndexSnapshot).

### Approach

Add a SYNC backend-agnostic server-pid argv builder to exec-backend (e.g. `buildTmuxServerPidArgs()` → `["tmux","display-message","-p","#{pid}"]`), pure + exported (the pulse injects only a sync `SpawnSyncFn`, so an async ExecBackend method does NOT fit — keep it a sync argv builder run via the pulse's spawnSync). In `tmuxSnapshotPulse`/a sibling pulse arm: run the probe under the locale-defaulted env, validate the output is a positive integer (non-zero exit / no server / garbage → no generation, emit nothing), build `generation_id` = the pid string + `backend_type` = `DEFAULT_EXEC_BACKEND`. Change-gate on a new `lastGenerationHash` in `PulseState`; run UNGATED by `hasLiveTmuxJob` (the post-crash state has no live job). On the FIRST pulse after boot, seed `lastGenerationHash` from the last logged `BackendExecStart` payload (`SELECT data FROM events WHERE hook_event='BackendExecStart' ORDER BY id DESC LIMIT 1`) so a keeperd restart against an UNCHANGED server emits no spurious boundary. On change, post a new `BackendExecStartMessage` worker→main; main's onmessage adds a `kind` arm that mints ONE event via `stmts.insertEvent.run` with the stable per-kind synthetic `session_id = "backend-exec-start"`, `hook_event = "BackendExecStart"`, payload in `$data`. The reducer gets an explicit no-op DISPATCHER arm for `"BackendExecStart"` (mirror the retired `BackendExecSnapshot` arm — DISTINCT name; do NOT rely on the inner jobs-switch default, which routes to `projectJobsRow` and corrupts jobs). No new events column, NO schema bump.

### Investigation targets

**Required** (read before coding):
- src/restore-worker.ts:740-792 — `tmuxSnapshotPulse` + `windowIndexSnapshotPulse` (the single-value change-gated template), :456-485 `PulseState` (add `lastGenerationHash`), :501-511 `hasLiveTmuxJob` (do NOT gate on it), :137-167 message interfaces (add `BackendExecStartMessage`), :710-717 `hashWindowIndexCache` (clone for the gen-id gate)
- src/daemon.ts:3397-3459 — restore-worker `onmessage` (add the kind arm; stable synthetic session_id at :3406-3409), :92-93 message-type imports, :1237-1241 boot order (seedKilledSweep before worker spawn)
- src/db.ts:3549-3566 — `insertEvent` prepared stmt (payload rides `$data`, no new column), :362 events PK is `id INTEGER PRIMARY KEY AUTOINCREMENT`
- src/reducer.ts:7180-7245 — dispatcher chain + the retired `BackendExecSnapshot` no-op arm at :7227 (the exact pattern; pick a fresh name)
- src/exec-backend.ts:194-218 (buildTmux*Args pure-builder pattern), :110 `DEFAULT_EXEC_BACKEND`, :312 `localeDefaultedEnv`, :494-538 `runCapture`

**Optional**:
- 697d9883 (fn-817 .2) — the WindowIndexSnapshot commit, the end-to-end template

### Risks

- Probe gate: copying the `hasLiveTmuxJob`-gated template verbatim → silent no-boundary post-crash. Wire the gen probe ungated.
- Validate the pid is a positive integer before hashing/emitting — a garbage/empty parse must NOT fire a spurious boundary.
- The two synthetic-mint column lists (raw vs prepared insert) must stay in sync; gen-id rides `$data`, so no column changes — verify.
- re-fold determinism: the gen-id is probed by the PRODUCER; the no-op fold reads nothing. An empty re-fold reproduces zero rows.

### Test notes

restore-worker test: stub `spawnSync` to return a pid, drive the pulse, assert ONE `BackendExecStartMessage` on change and NONE on an unchanged repeat; assert the boot-seed suppresses a same-pid re-emit; assert no-server (non-zero exit) emits nothing. reducer test: a `BackendExecStart` event folds as a no-op (no jobs/projection mutation) and the cursor advances; re-fold reproduces identically. Use `freshDb()` in-process; `retryUntil` for any async daemon assertion.

## Acceptance

- [ ] A sync backend-agnostic server-pid argv builder added to exec-backend; the pulse probes it ungated by `hasLiveTmuxJob`, validates a positive-int pid.
- [ ] `BackendExecStart` minted on generation change (and first observation), suppressed on an unchanged server across a keeperd restart (boot-seed from the last logged event).
- [ ] Reducer folds it via an explicit no-op dispatcher arm; no schema bump; re-fold deterministic.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
