## Description

**Size:** M
**Files:** `src/rpc-handlers.ts`, `src/db.ts`, `src/collections.ts` (remove `APPROVALS_DESCRIPTOR`), `src/types.ts` (remove `Approval`), `test/rpc-handlers.test.ts`, `test/db.test.ts`

### Approach

Replace `set_approval` with `set_task_approval { epic_id, task_id, status }` and `set_epic_approval { epic_id, status }`. Status enum is `"approved" | "rejected" | "pending"` (no more `"clear"`). Each handler: (a) wire-level validation (throw `BadParamsError` on bad shape; reject path separators or `..` in `epic_id` / `task_id`); (b) acquire per-file single-flight lock (`Map<absolutePath, Promise<void>>` -- chain new write onto the existing promise); (c) load the existing JSON file, mutate ONLY `approval`, preserve every other field, serialize using EXACTLY the planctl-canonical form locked in by task `.1` evidence; (d) write to `<final>.tmp.<pid>.<crypto.randomUUID()>` in the same directory; (e) `renameSync` (atomic on POSIX same-fs); (f) return `{ ok: true, epic_id, task_id?, approval }`. Eventual consistency: the watcher round-trip surfaces the new state on the next data_version poll (~50ms); the RPC return does not claim the projection is updated.

Schema v13 migration in `src/db.ts` (runs at boot BEFORE spawning worker threads, in a `BEGIN IMMEDIATE` transaction): (a) for each `.planctl/epics/*.json` across configured roots, load -> check for `approval` field -> if absent, write `approval: "approved"` (atomic temp+rename) -- SKIP if `approval` already present (idempotent across partial-completion re-runs); (b) for each row in the existing `approvals` table, parse `task_key`: if `task_key === "close:<epic_id>"` (or matches the epic id itself -- audit existing rows before writing parser), write `epic.approval = <status>` to the epic file; otherwise treat `task_key` as a task id and write `task.approval = <status>` to that task file (overwrites the blanket "approved" backfill -- sidecar wins); orphan rows (epic/task file missing) log + skip; (c) `DROP TABLE IF EXISTS approvals` using uncached `db.run` (bun:sqlite statement-cache pin gotcha); (d) bump `SCHEMA_VERSION` to 13. Remove `APPROVALS_DESCRIPTOR` from `src/collections.ts` and `Approval` from `src/types.ts`. Remove the old `set_approval` handler and its registration.

### Investigation targets

**Required** (read before coding):
- `src/rpc-handlers.ts:39-247` -- the entire `set_approval` handler (pattern: validate -> `BEGIN IMMEDIATE` -> mutate -> return -> ROLLBACK on throw; carries over verbatim except the mutate body shifts from SQLite UPSERT to file write)
- `src/db.ts:319-351` -- `CREATE_APPROVALS` DDL (delete)
- `src/db.ts:539-567` -- v6 to v7 step with DROP (precedent for v12 to v13 ordering)
- `src/db.ts:769-783` -- v11 to v12 step comment + v10 to v11 rewind-and-redrain (precedent for state-touching steps)
- `src/collections.ts:212-241` -- `APPROVALS_DESCRIPTOR` + registry entry (remove)
- `src/types.ts:248-284` -- `Approval` interface (remove)
- `src/rescan.ts:103+` -- `RescanScheduler` (trailing-edge debounce + single-flight) -- TEMPLATE for the per-file single-flight `Map<path, Promise>`
- Task `.1` evidence -- the EXACT planctl serializer form (indent, key order, trailing newline) to match byte-for-byte

**Optional:**
- `src/db.ts:655-663` -- bun:sqlite statement cache pin gotcha (use uncached `db.run` for DROP)
- `src/plan-worker.ts:34-35, 995` -- planctl's `os.replace` semantics for atomic write reference

### Risks

- **JSON serialization parity** -- keeperd must match planctl byte-for-byte or every keeperd-touched file produces a noisy diff that planctl will "fix" on next write (infinite ping-pong). Task `.1` must document the canonical form; this task must conform.
- **Migration partial-completion** -- power loss between backfill and overlay leaves the daemon in a half-migrated state. Re-run must be idempotent (skip-if-present on backfill; overlay is naturally idempotent since it just writes the same value).
- **DROP TABLE while readers live** -- DDL needs EXCLUSIVE lock; run BEFORE spawning worker threads.
- **bun:sqlite statement cache pin** -- use uncached `db.run(sql)` for the DROP.
- **Orphan sidecar rows** -- `approvals` row referencing a missing epic/task file: log + skip (do not fail migration).
- **First-time boot with no `approvals` table** -- `IF EXISTS` guards must cover all reads in the migration step.

### Test notes

RPC handler tests in `test/rpc-handlers.test.ts`: (a) `set_task_approval` / `set_epic_approval` write the field to the correct file; (b) all other fields preserved; (c) byte-identical output to planctl's serializer (golden test using a fixture file produced by task `.1`); (d) per-file single-flight serializes concurrent same-file writes; (e) invalid enum throws `BadParamsError`; (f) path-traversal in `epic_id` / `task_id` throws `BadParamsError`; (g) old `set_approval` is unregistered. Migration tests in `test/db.test.ts`: (a) stale v12 DB with approvals table + sample rows + sample epic files -> migrate -> assert epic files have `approval: "approved"` backfilled + sidecar overlay applied + approvals table dropped + schema_version = 13; (b) re-run on already-migrated DB is a no-op; (c) orphan sidecar rows log + skip; (d) first-time boot (no approvals table) does not crash.

## Acceptance

- [ ] `set_task_approval` and `set_epic_approval` registered; old `set_approval` removed
- [ ] Both RPCs atomically write the planctl JSON file (temp+rename, same dir, `.tmp.<pid>.<uuid>` suffix)
- [ ] Per-file single-flight serializes concurrent same-file RPC writes
- [ ] All non-`approval` fields preserved on rewrite; serializer matches planctl byte-for-byte
- [ ] Wire validation rejects bad enum + path-traversal `epic_id` / `task_id`
- [ ] Schema v13: backfill writes `approval: "approved"` only when absent (idempotent); sidecar overlay writes `(epic|task).approval` per row; orphans log + skip; `DROP TABLE IF EXISTS approvals`; `SCHEMA_VERSION` -> 13
- [ ] `APPROVALS_DESCRIPTOR` removed from collections registry; `Approval` type removed from types
- [ ] All migration tests pass on a fresh DB and on a stale-v12 DB; partial-completion re-run is a no-op

## Done summary
Replaced sidecar set_approval RPC with set_task_approval + set_epic_approval that atomically rewrite .planctl/{epics,tasks}/*.json (canonical serializer matches planctl json.dumps(indent=2, sort_keys=True, ensure_ascii=True)+'\n' byte-for-byte). Schema v13: addColumnIfMissing epics.approval + DROP TABLE IF EXISTS approvals in migrate(); new runPlanctlApprovalMigration backfills 'approved' to epic files lacking the field and overlays the soon-to-be-dropped approvals rows onto epic/task files (close:<epic> → epic, otherwise task; orphans log+skip); daemon calls FS half post-openDb pre-worker-spawn. Removed APPROVALS_DESCRIPTOR + Approval interface. 451/451 tests pass.
## Evidence
