## Description

**Size:** M
**Files:** src/daemon.ts, test/daemon.test.ts

Spawn the plan worker as keeperd's fourth Worker and turn its snapshot
messages into synthetic `EpicSnapshot`/`TaskSnapshot` events on main's
writable connection — main stays the sole writer.

### Approach

Spawn the plan worker in the same post-migrate window as the others, with
`workerData: { dbPath, roots: resolvePlanRoots() }`. Wire its lifecycle in
**all three places** the other workers appear: the spawn, the
`Promise.all([exited(...)])` in `shutdown()`, and the `terminate()` block;
plus its own `onerror`→`fatalExit` and `close`→`fatalExit` (the
`!shuttingDown` guard avoids a double-exit on clean shutdown). A missing
`close` handler leaves a zombie daemon. Add an `onmessage` branch: a
`plan-epic`/`plan-task` message → `stmts.insertEvent.run(...)` with
`hook_event = "EpicSnapshot"`/`"TaskSnapshot"`, `session_id` = the entity
id, the snapshot serialized into the `data` column (matching the exact
15-arg positional column order — everything else NULL), then
`wakePending = true; pumpWakes()`. Mirror the `transcript-title` branch
exactly. Update the boot-sequence docstring (now four workers).

### Investigation targets

**Required:**
- src/daemon.ts:188-249 — the transcript-worker spawn + `onmessage` synthetic-insert + `onerror`/`close` wiring (the exact branch to mirror)
- src/daemon.ts:204-237 — the `stmts.insertEvent.run(...)` 15-arg positional column order (FRAGILE — match exactly)
- src/daemon.ts:275-329 — `shutdown()`: the three-place lifecycle (post shutdown to all, `Promise.all([exited(...)])`, terminate)
- test/daemon.test.ts — how worker spawn/shutdown + synthetic-event flow is tested

### Risks

- The 15-arg positional `insertEvent` order is silent-corruption-prone —
  a transposed arg misfiles plan data. Cross-check against `stmts.insertEvent`.
- Don't forget any of the three lifecycle sites; a missing `close` handler
  = zombie daemon when the worker crashes.

### Test notes

`test/daemon.test.ts`: drive a `plan-epic`/`plan-task` message (or a
worker stub) → assert a synthetic event lands in `events` with the right
`hook_event`/`session_id`/`data` and folds into the projection; assert
clean shutdown awaits the fourth worker's `close`.

## Acceptance

- [ ] Plan worker spawned with `roots` from `resolvePlanRoots()`; lifecycle wired in all three places + `onerror`/`close`→`fatalExit`
- [ ] `plan-epic`/`plan-task` messages become synthetic `EpicSnapshot`/`TaskSnapshot` events via `stmts.insertEvent` (correct positional order), then `pumpWakes()` folds them
- [ ] Main remains the sole writer; the worker never writes the DB
- [ ] Clean SIGTERM shutdown awaits all four workers; no zombie on worker crash
- [ ] Boot docstring updated to four workers

## Done summary

## Evidence
