## Description

**Size:** M
**Files:** src/plan-worker.ts (new), test/plan-worker.test.ts (new)

The producer Worker thread, cloned from `transcript-worker.ts`: watches the
configured roots for `.planctl/{epics,tasks}/*.json`, reads + parses the
current file on each change, and posts typed snapshot messages to main. It
is read-only and NEVER writes the DB.

### Approach

Mirror the transcript-worker structure exactly: `PlanWorkerData`
(`{ dbPath, roots: string[] }` — path strings only cross `workerData`);
a pure exported core (`PlanScanner` or similar) drivable with no Worker or
watcher (parse a file path → `{kind, …}` message, with the number-parse +
task-status derivation + change-gate logic); a `seedFromDb` restart-seed
that loads `(id, updated_at)` from `epics`/`tasks` so an unchanged file on
restart doesn't re-emit; an `isMainThread`-guarded `main()` with its own
`openDb(path, {readonly:true})`.

Watching: ONE recursive `@parcel/watcher` subscribe **per root** (hold an
array of subscriptions, unsubscribe all in the shutdown handler). Pass
POSITIVE `ignore` globs (`**/node_modules/**`, `**/.git/**`, `**/dist/**`,
`**/build/**`, `**/.next/**`, `**/.cache/**`, `**/target/**`,
`**/.venv/**`, `**/*.tmp`) — do NOT use the transcript-worker's
`**/*.!(jsonl)` negation glob (parcel breaks on negation). In the callback,
filter to paths matching `.planctl/epics/*.json` or `.planctl/tasks/*.json`
(epics vs tasks chooses the message kind); treat every event as "go look":
fstat + re-read + safe-parse (skip-and-log + keep-last-good on parse
failure or read-vs-delete race; never emit on failure); route on
path+existence, not `event.type`. Bound the read size (cap before parse).
Emit `{kind:"plan-epic", id, number, title, projectDir, status}` /
`{kind:"plan-task", id, epicId, number, title, targetRepo, status}` only
when the parsed snapshot differs from the change-gate (real-change gate).
Compute `number` from the id (`fn-N-…` → N; `….M` → M; non-matching →
null) and derive task status (`worker_done_at` present → `"done"` else
`"open"`). A missing root is tolerated (skip-and-log, stay alive); the
`subscribe` rejection is the sole unrecoverable surface (→ exit 1).

### Investigation targets

**Required:**
- src/transcript-worker.ts:56-63 — `TranscriptWorkerData` (path-strings-only boundary; test-overridable root)
- src/transcript-worker.ts:160-351 — the pure `TranscriptLineStream` core + `seedFromDb` pattern (lines 368-377) to mirror for the scanner + restart-seed
- src/transcript-worker.ts:385-522 — `main()`: parentPort guard, readonly openDb, subscribe, shutdown unsubscribe, `.catch`→exit(1), the in-callback suffix check + `delete` handling
- test/transcript-worker.test.ts:1-16 — the three-layer worker test convention (pure core / native-addon smoke / spawned-worker shutdown)

**Optional:**
- .planctl/epics/*.json + .planctl/tasks/*.json — the actual field shapes to parse (`id`, `title`, `status`, `primary_repo`; `epic`, `target_repo`, `worker_done_at`)

### Risks

- **Keystone:** @parcel/watcher over `~/code`+`~/src` event volume — the
  positive ignore globs are load-bearing. Fallback if unviable: glob
  `<root>/*/.planctl` at boot + a subscription per `.planctl` dir (loses
  auto-pickup of brand-new projects until restart). Isolate this risk here.
- Atomic-rename writes may surface as create/rename not update — route on
  fstat, confirm the `delete` path just drops tracking (no emit).
- Multiple roots: one missing/erroring root must not kill watching of the
  others (per-subscription error isolation).

### Test notes

Three layers per the convention: (a) pure-core unit tests driving the
scanner over tmp `.planctl` files (parse, number-parse edge cases,
task-status derivation, change-gate suppresses unchanged, safe-parse skips
malformed); (b) a smoke test that the `@parcel/watcher` addon loads under
`bun test`; (c) a spawned Worker that shuts down cleanly on
`{type:"shutdown"}` and unsubscribes. Use a `KEEPER_*` env / `workerData`
root override pointing at a hermetic tmp dir.

## Acceptance

- [ ] `src/plan-worker.ts` clones the transcript-worker contract: pure core, `isMainThread` guard, own read-only connection, owned subscriptions released on shutdown, never writes the DB
- [ ] One recursive watch per root with positive ignore globs (no negation glob); in-callback `.planctl/{epics,tasks}/*.json` filter
- [ ] "Go look" discipline: fstat + re-read + safe-parse; malformed/raced reads skip-and-log without emitting; reads are size-bounded
- [ ] Emits change-gated snapshot messages with parsed number + derived task status; restart-seed from the projection suppresses redundant re-emits
- [ ] Three-layer worker tests pass (pure core, addon smoke, spawned-worker shutdown)

## Done summary
Added src/plan-worker.ts (PlanScanner pure core + seedFromDb + isMainThread-guarded watcher main) and test/plan-worker.test.ts (three-layer suite). Clones the transcript-worker producer archetype: one recursive @parcel/watcher subscription per root with positive ignore globs, in-callback .planctl/{epics,tasks}/*.json filter, fstat+bounded-read+safe-parse, change-gated plan-epic/plan-task snapshot messages, restart-seed from the epics/tasks projection.
## Evidence
