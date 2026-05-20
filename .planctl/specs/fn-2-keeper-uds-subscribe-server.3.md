## Description

**Size:** M
**Files:** src/server-worker.ts, test/server-worker.test.ts

### Approach

Add the realtime layer to the server worker built in `.2`: an independent `data_version` poll that turns committed `jobs` changes into per-entity `patch` pushes. This is the diff-correctness core — write it as a testable invariant.

1. **Poll loop** — reuse the `watchLoop` shape from `wake-worker.ts` (autocommit, **never wrap the poll in `BEGIN`** or `data_version` freezes for that connection; ~50 ms cadence). The server's connection is its own read-only connection from `.2`.
2. **On a tick where `data_version` advanced**:
   - Read world rev once: `selectWorldRev()` → `rev` stamped on every frame emitted this tick.
   - Compute the **union of all connections' watched ids**, `selectJobsByIds(union)` (one shared re-read, fan out after).
   - For each connection, for each watched `job_id`: push a `patch {rev, job}` **only when `job.last_event_id > lastSent[job_id]`**, then set `lastSent[job_id] = job.last_event_id`. No patch when equal.
3. **Snapshot seeding** (tighten from `.2`): on `query`/`result`, set `lastSent[job_id]` from the **same read** that produced the result rows, so the next tick doesn't re-emit the whole page as patches.
4. **Coalescing** is automatic — the diff is state-based (current row vs `lastSent`), so multiple folds between ticks collapse into one patch. No event queue.
5. **Slow consumer**: a socket with a pending write (backpressured from `.2`) is **skipped for the tick**, never blocking fan-out to other connections; the next tick's diff re-reflects current state, so nothing is lost.
6. The self-correcting race is expected: a poll landing after a hook `events` INSERT but before the reducer folds sees no `jobs` change; the fold is itself a commit that re-bumps `data_version`, so the next poll catches it. **Read `jobs` only, never `events`.**

### Investigation targets

**Required** (read before coding):
- src/wake-worker.ts:65-94 — `watchLoop(db, onWake, isShutdown, pollMs)`: the poll-loop shape to reuse, including the autocommit caveat (86-89) and `MIN_POLL_MS`/`DEFAULT_POLL_MS`
- src/server-worker.ts — the per-connection state (watched-set, `lastSent`, pending-write) and dispatch from task `.2`
- src/db.ts — `selectJobsByIds` + `selectWorldRev` from task `.1`

**Optional** (reference as needed):
- test/wake-worker.test.ts:33-67 — the two-connection `data_version` test pattern (separate writer commits, reader's poll observes)

### Risks

- Wrapping the poll in a transaction freezes `data_version` — the single most-repeated invariant in this repo; keep the poll connection in autocommit.
- Initial-snapshot baseline ordering: if `lastSent` isn't seeded from the same read as the `result`, the first tick re-pushes the entire page.
- A slow/backpressured consumer must not stall the shared fan-out — isolate per-socket.
- Diff must key on `last_event_id` (strictly monotonic per entity), **not** `updated_at` (a float ts).

### Test notes

- Extend `test/server-worker.test.ts`. Use `retryUntil` (from `test/integration.test.ts`) for async patch arrival.
- A separate writer connection commits a `jobs` change → a subscribed client receives exactly one `patch` with the advanced `last_event_id`; `rev` present.
- A tick with no watched-row change (unrelated job folds, or a `data_version` bump that doesn't touch watched ids) → **no patch** to that connection.
- Multi-connection fan-out: only connections watching the changed id get the patch.
- No double-send: after a patch, an immediate tick with no further change emits nothing.

## Acceptance

- [ ] `data_version` poll loop (autocommit, ~50 ms) drives the re-read + diff in the server worker
- [ ] A `patch` is pushed only when `job.last_event_id > lastSent[job_id]`, then `lastSent` is bumped (no double-send, no miss)
- [ ] `result`/snapshot seeds `lastSent` from the same read that produced the rows
- [ ] Every frame carries `rev = reducer_state.last_event_id`, read once per tick
- [ ] A backpressured socket is skipped for the tick without blocking other connections
- [ ] Tests (writer-commit → single patch via `retryUntil`; no-op tick → no patch; multi-conn fan-out) + `bun run lint` + `bun run typecheck` pass

## Done summary

## Evidence
