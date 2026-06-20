## Description

**Size:** M
**Files:** src/backend-worker.ts (new), src/daemon.ts, src/reducer.ts, CLAUDE.md, test/backend-worker.test.ts (new)

### Approach

Enrich `jobs.backend_exec_tab_{id,name}` through the event log — workers never write the DB. Create `src/backend-worker.ts` mirroring `git-worker.ts`: `isMainThread` guard, `openDb(readonly:true)`, on each tick read live jobs with non-null `backend_exec_session_id`/`backend_exec_pane_id`, dedup by distinct session, run ONE `resolveTabForPane(session, paneId)` (T1) per pane, and `postMessage` a `{kind:"backend-exec-snapshot", job_id, tab_id, tab_name}` per resolved pane. Guard with a per-tick `isRunning` flag and a per-session in-flight lock; treat non-zero exit / ENOENT / parse failure as "no session" → log+skip, never post a clobbering snapshot. In `src/daemon.ts`, wire the worker like `gitWorker`: `onmessage` lifts the message into a synthetic `BackendExecSnapshot` event via `stmts.insertEvent.run({...})` (tab payload in the event's `data` JSON, keyed by `job_id`), then `wakePending`/`pumpWakes`; `onerror`/`close` → `fatalExit`. In `src/reducer.ts`, fold `BackendExecSnapshot` (extract `data`, `UPDATE jobs SET backend_exec_tab_* WHERE job_id=?`, last-known sticks). Add `BackendExecSnapshot` to CLAUDE.md's Sole-writer list.

### Investigation targets

**Required** (read before coding):
- src/daemon.ts:1566-1634 — gitWorker wiring (Worker + onmessage→synthetic event→wakePending; onerror/close→fatalExit)
- src/git-worker.ts:1061-1072,1430,1521 — isMainThread guard, readonly openDb, shutdown handler, entrypoint
- src/exec-backend.ts:540-573 — runCapture (concurrent drain, ENOENT→null) — and resolveTabForPane from T1
- src/reducer.ts — synthetic-event fold + data-extract pattern (e.g. extractUsageSnapshot) for the new BackendExecSnapshot arm
- CLAUDE.md:62-73 — Worker contract + Sole-writer rules (add BackendExecSnapshot)

**Optional**:
- src/db.ts insertEvent call sites in daemon.ts — the new caller must list all columns explicitly

### Risks

- Worker must NEVER write `jobs` directly — only post messages main lifts into events; a direct write violates the sole-writer invariant and breaks re-fold.
- Subprocess hang: explicit TERM→KILL timeout + per-session in-flight lock + per-tick isRunning guard; `setInterval` does not self-throttle.
- Untrusted `list-panes` output (session names, cwd, commands) flows into `tab_name` — bind-safe, don't log wholesale.
- Tab tombstone = last-known sticks (decided) — do not emit clearing snapshots on a vanished pane.

### Test notes

Test the worker's pure tick logic with a spawn stub: dedup-by-session, skip coord-less jobs, no-op on non-zero exit. Test the reducer `BackendExecSnapshot` fold (job_id match, last-known sticks).

## Acceptance

- [ ] `src/backend-worker.ts` resolves tab per live (session, pane), one `list-panes` per distinct session, and posts `BackendExecSnapshot` messages — never writes the DB.
- [ ] daemon.ts lifts messages into synthetic `BackendExecSnapshot` events (tab payload in `data`, keyed by job_id); reducer folds them onto `jobs.backend_exec_tab_*`.
- [ ] Subprocess robustness: TERM→KILL timeout, per-session in-flight lock, per-tick guard, non-zero-exit/ENOENT/parse-fail → log+skip.
- [ ] `BackendExecSnapshot` added to CLAUDE.md Sole-writer list; worker error → fatalExit; re-fold deterministic.

## Done summary
Added the backend-exec tab-resolver producer worker (src/backend-worker.ts), wired it through daemon.ts to mint synthetic BackendExecSnapshot events, and added the reducer fold that UPDATEs jobs.backend_exec_tab_{id,name} with last-known-sticks tombstone semantics. CLAUDE.md sole-writer list updated; worker + fold tests cover dedup, tombstone, throw, and re-fold determinism.
## Evidence
