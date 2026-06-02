## Description

**Size:** M
**Files:** src/restore-worker.ts (new), src/daemon.ts, README.md, CLAUDE.md, test/restore-worker.test.ts (new)

### Approach

New pure-consumer Worker `src/restore-worker.ts` following the
`wake-worker.ts` skeleton: `isMainThread` guard, own
`openDb(dbPath,{readonly:true})`, `RestoreWorkerData {dbPath}`, shutdown
via `parentPort.on("message")` (`{type:"shutdown"}` -> close db ->
exit 0). Drive change detection with `watchLoop` (naked autocommit reads
— no BEGIN). On each pulse, read `jobs` + `epics` via `runQuery` using the
EXACT `read(collection)` helper shape from
`autopilot-worker.ts:loadReconcileSnapshot` (`{type:"query",collection,id,limit:0}`).
Extract a PURE `buildRestoreDescriptor(jobs, epicsById)` that: filters to
live jobs (`state IN ('working','stopped')`), groups by
`backend_exec_session_id` (decide: omit null-session jobs, or a sentinel
bucket — omit is simpler and they're not restorable into a session),
pre-resolves `tier` via T1's `tierForJobFromEpics`, builds per-agent
`{job_id, cwd, resume_target, tier, plan_verb, plan_ref}` (resume_target
from T1's `resumeTarget`), sorts agents by `job_id`, and wraps in
`{schema_version: 1, captured_at, sessions: {...}}`. Stable-serialize
(sorted keys via the existing `serializePlanctlJson`/`sortObjectKeys` in
db.ts, or equivalent), hash (`Bun.hash`), keep `lastHash` in worker
memory, and `atomicWriteFile(resolveRestorePath(), serialized)` ONLY when
the hash changed. `captured_at` is informational only and MUST be excluded
from the hashed shape (else every tick churns). Worker mkdirs the parent
dir on first write. Write failures are SWALLOWED to stderr (pure side-file;
next pulse rewrites) — do NOT throw/fatalExit. Wire into `daemon.ts`
mirroring the `backendWorker` block (spawn after boot drain; `onerror` +
`close` -> `fatalExit`; NO `onmessage` — it posts nothing to main). Add to
the shutdown sequence (`postMessage shutdown` -> `exited()` race ->
`terminate()`). Update the prose worker counts (daemon.ts "NINE"->"TEN",
"seventh"/"sixth producer" wording; README "nine workers" + new tenth-worker
paragraph) and add the CLAUDE.md sole-writer carve-out.

### Investigation targets

**Required** (read before coding):
- src/wake-worker.ts:69-150 — `watchLoop` + the `main()` skeleton to copy
- src/autopilot-worker.ts:1045-1111 — `loadReconcileSnapshot` read() helper (exact runQuery shape)
- src/backend-worker.ts:284-366 — producer `main()` shutdown handler + `shuttingDown` swallow precedent
- src/daemon.ts:1794-1864 — `backendWorker` spawn block to mirror
- src/daemon.ts:2081-2180 — shutdown sequence + `WORKER_SHUTDOWN_DEADLINE_MS`
- src/db.ts:4998 — `atomicWriteFile`; and `serializePlanctlJson`/`sortObjectKeys` (~4931-4942) for stable serialization

**Optional** (reference as needed):
- src/db.ts:resolveRestorePath (from T1)
- README.md `## Architecture` worker list; CLAUDE.md sole-writer block

### Risks

Hashing instability is the top risk — any per-tick-drifting field
(`updated_at`, `last_event_id`, `captured_at`) in the hashed shape causes
a write on every hook event. Hash the descriptor WITHOUT `captured_at`,
stable-sorted. `lastHash` in-memory means one redundant write per daemon
boot (acceptable — do NOT read the existing file to seed it; that
re-introduces the discouraged fs read). watchLoop reads must stay naked
autocommit or `data_version` freezes.

### Test notes

`test/restore-worker.test.ts` drives the pure `buildRestoreDescriptor`
(live-only filter, session grouping, tier pre-resolution, job_id sort) +
a "did serialized content change" gate directly against a seeded writer DB,
never spawning a Worker (isMainThread guard keeps import inert). Use the
sandboxed base-env helper incl. `KEEPER_RESTORE_FILE` so the real file is
never touched.

## Acceptance

- [ ] `src/restore-worker.ts` follows the worker contract; pure `buildRestoreDescriptor` extracted and tested.
- [ ] Reads jobs+epics via the `runQuery` read() helper; writes `restore.json` via `atomicWriteFile` only on content change (stable hash, `captured_at` excluded).
- [ ] Write failures swallowed to stderr; worker never fatalExits on a write error.
- [ ] Daemon spawns + shutdown-sequences the worker; `onerror`/`close` -> fatalExit; no `onmessage`.
- [ ] Worker counts updated in daemon.ts + README; CLAUDE.md sole-writer carve-out added.

## Done summary
Added src/restore-worker.ts as keeperd's tenth Worker: pure consumer that watches PRAGMA data_version, reads jobs+epics via the shared runQuery seam, builds a stable RestoreDescriptor (sessions keyed by backend_exec_session_id, agents sorted by job_id, tier pre-resolved via tierForJobFromEpics), and rewrites ~/.local/state/keeper/restore.json via atomicWriteFile only when the hashed shape (captured_at excluded) changes. Write failures swallowed; daemon spawn + shutdown wired; README tenth-worker paragraph + CLAUDE.md sole-writer carve-out added. 18 unit tests in test/restore-worker.test.ts.
## Evidence
