## Description

**Size:** M
**Files:** src/protocol.ts, src/server-worker.ts, src/rpc-handlers.ts, src/daemon.ts, test/rpc-handlers.test.ts, test/server-worker.test.ts, test/integration.test.ts

The keystone. Recover one dead letter on demand by appending its event back
into the log — routed correctly so the server-worker never writes the events
log and main stays the sole writer of the replayed event.

### Approach

- Net-new server-worker→main request/reply bridge. Today server-worker↔main
  exchange only `{type:"shutdown"}` (in) and `{kind:"ready"}` (out) and RPC
  dispatch is fully SYNCHRONOUS (`RpcHandler = (db,params)=>unknown`). Add:
  a `replay_dead_letter` RPC; server-worker posts
  `{kind:"replay-request", id:<correlation>}` to main; main does the work
  and posts back `{type:"replay-result", id, ok, recovered_dl_id?, error?}`;
  server-worker awaits the matching id then frames the `rpc_result`. This
  requires an ASYNC handler path — either widen `RpcHandler` to allow a
  `Promise` return or special-case replay in `dispatchRpc`. Reuse a
  correlation-id map + timeout (mirror approve.ts's client timeout).
- MAIN does the recovery in ONE `BEGIN IMMEDIATE` transaction: pick the
  oldest `status='waiting'` row by `(dl_written_at ASC, dl_id)`; rebuild the
  event from its stored `bindings` and `stmts.insertEvent.run(...)` (full
  derived columns, REAL pid, preserved `ts` — a plain real event, NOT a
  synthetic one; it gets a NEW higher id and folds at the end of the log);
  UPDATE the row `status='recovered', recovered_at=?, replayed_event_id=?`.
  Then `wakePending=true; pumpWakes()` so the reducer folds it → jobs row →
  worker reappears. If zero waiting rows, reply ok with a "nothing to
  replay" marker (not an error frame).
- Add `replay_dead_letter` to the protocol error vocabulary (reuse
  unknown_method/bad_params/rpc_failed) and register it in
  rpc-handlers.ts `installRpcHandlers` / `registerRpc`.
- daemon.ts `serverWorker.onmessage` (currently unused for runtime msgs)
  gains the replay-request handler.

### Investigation targets

**Required:**
- src/seed-sweep.ts:130 `insertKilledEvent` and src/daemon.ts synthetic-mint sites (282-310 etc.) — the `stmts.insertEvent.run({...})` + `pumpWakes()` template; replay reuses this but with the stored REAL bindings.
- src/server-worker.ts: `RpcHandler` (~647), `dispatchRpc` (~839), the two-connection split (~1663), the main message send/recv (~1711-1737).
- src/rpc-handlers.ts: `installRpcHandlers` (~313), set_task_approval/set_epic_approval as the registration template.
- src/protocol.ts: `RpcFrame`/`RpcResultFrame`/error codes.
- scripts/approve.ts:240,383 — the RPC client connect-await-by-id-timeout pattern (board reuses it in .5; here it informs the timeout contract).

### Risks

- HIGHEST-RISK surface: making one RPC async without breaking the synchronous contract for all other RPCs (set_task_approval etc.). Keep the sync handlers sync; isolate the async path.
- Deadlock/latency: main may be mid-`pumpWakes` (synchronous drain) when the replay-request arrives — it queues until drain completes. Acceptable, but the board's RPC client needs a timeout so a slow main doesn't hang the keypress.
- Append-event + flip-row MUST be one transaction; a crash between them would re-import the still-`waiting` row and double-replay. Use an explicit `db.transaction`.
- Re-fold determinism: the replayed event is a plain real event; a from-scratch re-fold must reproduce it byte-identically and must NOT touch `dead_letters`. Replaying a non-SessionStart event whose session has no jobs row folds as a harmless no-op (no special orphan status needed for v1; note it).
- CLAUDE.md invariants "main is the sole writer of synthetic events" and "approval is the only RPC-writable thing" must be revised to cover this delayed-real-event replay path (task .6).

### Test notes

- Seed a `waiting` row (hand-insert), fire `replay_dead_letter`, assert: an `events` row appears with the stored bindings + new id, the dead_letters row flips to `recovered` with `replayed_event_id`, and after a drain the jobs projection reflects it.
- Replaying the dropped-SessionStart scenario (the actual incident) makes the job appear.
- Two replays drain two rows oldest-first; replay with zero waiting returns the no-op ack.

## Acceptance

- [ ] `replay_dead_letter` RPC routes board→server-worker→main→ack; main appends the event + flips the row in one transaction; the reducer folds it and the session reappears.
- [ ] Synchronous RPCs (approval) are unchanged; only replay uses the async bridge with a correlation id + timeout.
- [ ] Oldest-first single-record replay; zero-waiting returns a clean ack, not an error.
- [ ] Re-fold is byte-identical and never touches dead_letters.

## Done summary
replay_dead_letter RPC implemented: server-worker→main async bridge with correlation-id + timeout, recoverOneDeadLetter BEGIN IMMEDIATE transaction (insert event + flip row), pumpWakes to fold recovered session into jobs. Oldest-first; zero-waiting returns clean ack. Full test coverage including integration round-trip.
## Evidence
