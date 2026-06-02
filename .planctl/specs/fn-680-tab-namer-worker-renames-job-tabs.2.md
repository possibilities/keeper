## Description

**Size:** M
**Files:** src/tab-namer-worker.ts (new), test/tab-namer-worker.test.ts (new)

### Approach

New worker modeled on `backend-worker`'s LIFECYCLE (`setInterval` 5s +
`isRunning` re-entry guard + immediate first tick + `setImmediate(() =>
process.exit(0))` shutdown) but with `restore-worker`'s PURITY (read-only
`openDb`, no `onmessage` beyond `{type:"shutdown"}`, no `postMessage`, never
writes the DB). Use `setInterval` — NOT restore-worker's `watchLoop`/data_version
— because a wall-clock tick is what converges with backend-worker's 5s read-back.

Export three pure/testable symbols + a thin `main()`:
- `sanitizeTabName(title): string` — strip `\x00-\x1f` and `\x7f` (control/ANSI/OSC
  bytes), collapse internal whitespace, trim, strip leading `-` (clap flag guard),
  cap to ~50 chars. Display-safety only (argv-array spawn is the injection guard).
- `readLiveJobsForTabNaming(db)` — `SELECT job_id, backend_exec_session_id,
  backend_exec_tab_id, title, backend_exec_tab_name FROM jobs WHERE
  backend_exec_session_id IS NOT NULL AND backend_exec_tab_id IS NOT NULL AND
  title IS NOT NULL AND state NOT IN ('ended','killed')`.
- `runTick(deps: {db, backend?, lastSet: Map<string,string>, isShuttingDown})` —
  read rows; dedup by `(session, tab_id)` deterministically (keep lowest `job_id`)
  per the one-pane-per-tab assumption so a violation degrades to stable-arbitrary,
  not oscillation; for each, `name = sanitizeTabName(title)`; SKIP if name empty;
  SKIP if `name === backend_exec_tab_name` (already correct, covers cold restart)
  OR `lastSet.get(job_id) === name` (in-flight debounce); else (gated on
  `!isShuttingDown()`) `await backend.renameTab(session, tabId, name)` and
  `lastSet.set(job_id, name)` ONLY when the result is `ok` (success-gated -> a
  failed rename retries next tick). Prune `lastSet` of job_ids absent from the
  current live set (bound memory).

`main()`: `isMainThread`-guarded, own `openDb(dbPath, {readonly:true})`, default
backend via `resolveExecBackend({noteLine: console.error})`, `tickMs` from
workerData (default 5000), `isRunning` guard, immediate first tick, shutdown
handler clears the interval + sets the flag + closes the DB + `setImmediate`
exit 0. `TabNamerWorkerData { dbPath; tickMs? }`.

### Investigation targets

**Required** (read before coding):
- src/backend-worker.ts — whole file: `DEFAULT_TICK_MS`, `WorkerData` shape, `readLiveJobsWithCoords`, `runTick`/`TickDeps`, `isRunning` guard, immediate first tick, `setImmediate` shutdown, `isMainThread` guard
- src/restore-worker.ts — `main()` (~329-403): pure-consumer model, own readonly `openDb`, shutdown closes the connection, no `onmessage` beyond shutdown
- src/exec-backend.ts — `renameTab` (from task .1) + `LaunchResult` + `resolveExecBackend`
- test/backend-worker.test.ts — mkdtemp+`openDb` fixture, `insertJob` helper (extend to set `title`/`backend_exec_tab_id`/`backend_exec_tab_name`), `makeBackendStub` via `Pick<ExecBackend,...>`, `runTick` assertion style
- src/db.ts — `jobs` schema (~640-667, confirms TEXT/nullable fields) + `openDb` readonly

**Optional**:
- CLAUDE.md "## Worker contract" — the durable contract every worker follows
- src/types.ts — `Job` type + the fn-668 last-known-sticks tombstone note on `backend_exec_tab_name`

### Risks

- **Convergence with backend-worker:** after a rename, `backend_exec_tab_name`
  only catches up on backend-worker's next ~5s tick. `lastSet` (success-gated,
  keyed on the SENT sanitized name) is the durable debounce — it bounds spawns to
  one per (job, name) even if zellij stores a normalized form so the
  `backend_exec_tab_name` compare never byte-matches. Do NOT rely on the tab_name
  compare alone.
- **Multiple jobs per tab** (assumption violated): the `(session, tab_id)` dedup
  tie-break prevents two titles fighting over one tab.
- **Empty title after sanitize:** skip the rename (never send an empty name).
- **Never throw out of the tick:** wrap like backend-worker's tick try/catch +
  stderr log; an interval-callback rejection must not wedge the worker.

### Test notes

- Drive `runTick` directly with a fixture DB + an injected fake backend
  (`Pick<ExecBackend,"renameTab">`) recording `(session, tabId, name)` — no real
  zellij, no process spawn.
- Cases: renames only when sanitized title differs from `backend_exec_tab_name`;
  `lastSet` suppresses a redundant rename across ticks; a backend `{ok:false}`
  return is NOT recorded in `lastSet` (retried next tick); skips null-title /
  null-tab_id / `ended`/`killed` jobs; sanitization (newline/control/length/leading-`-`);
  empty-sanitized -> no rename; `(session, tab_id)` dedup keeps the lowest job_id;
  `isShuttingDown()` between read and rename suppresses the call; `lastSet` prunes
  a job that left the live set. Plus direct `sanitizeTabName` unit cases.

## Acceptance

- [ ] `src/tab-namer-worker.ts` exports `sanitizeTabName`, `readLiveJobsForTabNaming`, `runTick`; `isMainThread`-guarded `main()` with its own read-only `openDb`
- [ ] `runTick` renames a job's tab to its sanitized title only when it differs from `backend_exec_tab_name` AND `lastSet`; records `lastSet` only on `result.ok`; prunes `lastSet` of dead jobs
- [ ] `sanitizeTabName` strips control/ANSI bytes, collapses whitespace, strips leading `-`, caps length; empty result -> no rename
- [ ] Dedup by `(session, tab_id)` is deterministic; null-title / null-tab_id / ended / killed jobs are skipped; shutdown gating blocks renames after `shuttingDown`
- [ ] `bun test test/tab-namer-worker.test.ts` is green

## Done summary

## Evidence
