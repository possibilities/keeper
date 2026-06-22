## Description

**Size:** M
**Files:** src/bus-worker.ts, src/bus-identity.ts, test/bus-worker.test.ts, test/bus-worker.integration.test.ts

### Approach

Make the bus server distinguish a connected channel from a known-disconnected one, deliver only to connected sockets, return the sender a synchronous result frame, and retire the heartbeat entirely (no replacement timer — `close()` is the death signal).

- **Presence axis on the resolver.** Keep identity resolution (current-or-former name via `name_history`/`jobs`) unchanged, but gate DELIVERY on `sock!==null`. Surface presence so a resolved identity reports whether it has an open socket — `toLiveChannel` drops `sock` today; `liveChannelForIdentity`/`collapseByLive` treat "in registry" as "live" and must redefine "live/preferred" as "connected" while still resolving a known-disconnected agent for identity.
- **Honest result frame.** Plumb `sock` into `opPublish` (via `handleOp`). Compute the TRUE outcome AFTER fanout — the count of targets whose full frame was accepted into an OPEN socket with no eviction — persist that to `messages.status`, and reply with `sendAck(sock, "publish", {result})`. Result vocabulary: `delivered`, `not_connected` (identity resolved, no open socket), `unknown_target`, `ambiguous_target`, `delivery_failed` (resolved+connected but the write was partial/failed). Remove the unconditional pre-fanout `status:"delivered"` write. A broadcast replies with a recipient count and never `unknown_target`/`ambiguous_target`.
- **Retire the heartbeat.** Delete `reapOnce`/`reapTimer`/`reapDecision`, the HEARTBEAT_*/REAP_INTERVAL constants, the server `opHeartbeat` + its `ClientOp` member + `handleOp` case, and the now-dead `RegistryEntry.lastBeatMono`/`warned` fields. Also remove the server `opResolve` handler + its `handleOp` case + `ClientOp` member (the CLI subcommand is removed in `.2`; the internal `resolve` closure STAYS — `opPublish` uses it). Boot rehydration (`liveChannelsAtBoot` via `isPidAlive`) stays. Add NO periodic liveness timer.
- **Generation token for the takeover late-close race.** The `close` handler must only null `entry.sock` if it still owns the current entry binding; a takeover rebinds the entry to a new conn, so the victim socket's late `close()` must no-op rather than clobber the reconnected channel.
- **SIGPIPE safety.** Verify whether `Bun.listen` sockets raise SIGPIPE on a write to a closed peer (they typically surface EPIPE as the write return). Add process-wide suppression only if a test shows the signal can reach the worker. A send to a dead peer must never crash the worker; wrap write/result paths best-effort like the existing per-op try/catch.

### Investigation targets

**Required** (read before coding):
- src/bus-worker.ts:809-892 — `opPublish`: plumb `sock`, compute true outcome, reply result frame; remove pre-fanout `status:"delivered"` (~:872)
- src/bus-worker.ts:560-590 — `deliver`: the `sock===null` silent no-op; the connected-gate seam
- src/bus-worker.ts:337-346 — `toLiveChannel`: drops `sock` state today; presence must surface
- src/bus-worker.ts:1010-1018 — `close` handler: keeps entry + nulls `sock`; the generation-token check goes here
- src/bus-worker.ts:278-294 — `takeoverVictim`: (pid,start_time) key; the race counterpart
- src/bus-worker.ts:80-85, 253-268, 1037-1065, 771-776, 164, 650-651, 330-334 — heartbeat constants / `reapDecision` / `reapOnce`+timer / `opHeartbeat` / `ClientOp` member / `handleOp` case / dead `RegistryEntry` fields to remove
- src/bus-worker.ts:906-921, 662-663, 175 — server `opResolve` + `handleOp` case + `ClientOp` member to remove (keep the `resolve` closure ~:534)
- src/bus-worker.ts:1134-1146 — `sendAck`/`sendError` frame shapes (`{type:ack,op,...}` / `{type:error,code,message}`)
- src/bus-identity.ts:33-41, 103-115, 196-212, 229-289 — `LiveChannel`, `liveChannelForIdentity`, `collapseByLive`, `resolveTarget`: layer the presence axis

**Optional** (reference as needed):
- src/server-worker.ts:833-844, 1988-2023 — `isPidAlive` + `reapDeadPeers` (pattern reference for the boot-only probe; do NOT add a steady-state sweep)
- src/bus-db.ts:59-76, 301-329 — `messages.status` is free-text TEXT (no schema bump); `appendMessage`
- test/bus-worker.test.ts:150-204 — `reapDecision`/`takeoverVictim`/`liveChannelsAtBoot` test templates (remove `reapDecision`/HEARTBEAT tests; add presence + result-outcome pure-fn tests)

### Risks

- The connected-filter must live where fanout selects targets (`selectFanoutTargets`) or as a post-filter, so the count fed to the result matches what actually got written.
- The generation token must not regress a legitimate close (a real disconnect of the current conn must still mark known-disconnected).
- A delivered message whose result-ack partial-writes/drops surfaces as exit 1 (false negative); `messages.status` stays the truth. Acceptable (no L2 receipts) — note it.

### Test notes

Pure-fn fast-tier tests for the presence/outcome decision functions in test/bus-worker.test.ts. Full-tier integration in test/bus-worker.integration.test.ts: send to connected → `delivered` + arrives; send to known-disconnected (close the peer socket, keep the registry entry) → `not_connected` + delivered to no one; unknown name → `unknown_target`; takeover then late victim-`close()` does not clobber the fresh socket. Sandbox the bus pair (KEEPER_BUS_DB/KEEPER_BUS_SOCK) via `sandboxEnv`; poll with `retryUntil`/`waitFrame`, never sleep. Run `bun run test:full`.

## Acceptance

- [ ] A directed send to a connected agent returns `delivered` and the message arrives at the recipient
- [ ] A send to a known-but-disconnected agent (resolves by identity, no open socket) returns `not_connected` and delivers to no one; `messages.status` records `not_connected`, not `delivered`
- [ ] An unknown name returns `unknown_target`; an ambiguous name returns `ambiguous_target`
- [ ] `messages.status` records the true per-send outcome (no unconditional pre-fanout `delivered`)
- [ ] The heartbeat is fully removed: no HEARTBEAT_* constants, no reaper/timer, no server heartbeat op, no dead `RegistryEntry.lastBeatMono`/`warned`; boot rehydration still drops dead pids
- [ ] The server `resolve` op is removed; the internal `resolve` closure still serves `opPublish`
- [ ] A takeover followed by the victim socket's late `close()` does not null the reconnected channel's socket (generation token)
- [ ] No periodic liveness timer exists in the bus worker
- [ ] A send to a dead peer cannot crash the worker (SIGPIPE verified/suppressed)
- [ ] `bun run test:full` passes

## Done summary
Bus server now distinguishes connected from known-disconnected channels (presence axis on the resolver), gates delivery on an open socket, and replies a synchronous publish result (delivered/not_connected/unknown_target/ambiguous_target/delivery_failed) persisted as the true messages.status. Heartbeat fully retired (no reaper/timer/op) in favor of socket-close liveness; server resolve op removed (internal closure kept); takeover late-close guarded by a generation token. Full suite green.
## Evidence
