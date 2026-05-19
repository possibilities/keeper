## Description

**Size:** S
**Files:** src/wake-worker.ts

### Approach

Bun Worker entry. On startup, opens a **NEW read-only** `bun:sqlite` connection via `openDb(path, { readonly: true })` — `Database` handles are thread-affine and cannot be transferred across the Worker boundary, so the worker must open its own. Sets `busy_timeout` connection-locally (per task 2 contract).

Main loop:
```ts
let last = db.query("PRAGMA data_version").get().data_version;
while (!shutdown) {
  await Bun.sleep(50);  // 50ms cadence — practice-scout's 25-100ms sweet spot
  const cur = db.query("PRAGMA data_version").get().data_version;
  if (cur !== last) {
    last = cur;
    self.postMessage({ kind: "wake" });
  }
}
```

**Contentless ping** — main thread re-reads from `reducer_state.last_event_id` regardless of the wake payload (per brief). The wake is a signal, not a hint.

Handle `{ type: "shutdown" }` from parent → set `shutdown` flag, exit the loop, `db.close()`, `process.exit(0)`.

### Investigation targets

**Required** (read before coding):
- [Bun Workers docs](https://bun.com/docs/runtime/workers) — Worker API, postMessage semantics, structured-clone constraints
- [SQLite forum: data_version semantics](https://sqlite.org/forum/info/d2586c18e7197c39c9a9ce7c6c411507c3d1e786a2c4889f996605b236fec1b7) — confirms cross-process change visibility

**Optional** (reference as needed):
- Brief's wake mechanism spec

### Risks

- **Sharing a `Database` instance across the Worker boundary fails** — the handle is not structured-cloneable. The worker MUST open its own connection. Pass only the path string in the worker's data.
- **`PRAGMA data_version` is connection-local** and only increments when *another* connection commits. A long-running read transaction in the worker would freeze its visibility of new commits. Stay in autocommit (no `BEGIN`) — just naked `PRAGMA` reads.
- **Tight loop without sleep burns a core.** `await Bun.sleep(50)` is the floor; do not drop below 25ms.
- **FSEvents / kqueue / `fs.watch` are not viable alternatives** on macOS (drop same-process writes, miss WAL writes to `.db-wal`). Do not try them as fallbacks.

### Test notes

- Deterministic testing is hard (involves timing + two SQLite connections). Covered end-to-end in task 7's integration test.
- A small unit test can verify spawn + shutdown round-trip without asserting data_version behavior.

## Acceptance

- [ ] Worker opens its OWN read-only connection (not shared with parent)
- [ ] Polls `PRAGMA data_version` every 50ms in autocommit (no surrounding BEGIN)
- [ ] Posts `{ kind: "wake" }` to parent on any data_version change
- [ ] Responds to `{ type: "shutdown" }` by closing db and exiting cleanly

## Done summary
Added src/wake-worker.ts: a Bun Worker that opens its own read-only bun:sqlite connection and polls PRAGMA data_version every 50ms in autocommit, posting contentless { kind: wake } messages on any change and shutting down cleanly on { type: shutdown }. workerData carries only the dbPath. Added round-trip unit tests.
## Evidence
