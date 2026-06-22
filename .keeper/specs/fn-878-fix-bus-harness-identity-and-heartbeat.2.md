## Description

**Size:** S
**Files:** cli/bus.ts (watch loop heartbeat), test/bus-cli.test.ts

Fix Bug B: the long-lived `watch` client must heartbeat so the server does
not evict a live channel after 90s.

### Approach

After the `watch` client registers, start a periodic timer (~30s, well under
`HEARTBEAT_EVICT_MS=90s`) that sends `{op:"heartbeat"}` on the open
connection; clear it on disconnect/exit. Confirm the server's heartbeat
handler refreshes the channel's `last_heartbeat` (it should already — verify
in src/bus-worker.ts). Keep it inside the existing watch connection (do not
open a second connection per beat).

### Investigation targets

**Required** (read before coding):
- cli/bus.ts (the long-lived `watch` client loop — where register/subscribe happen; add the heartbeat interval here), :455-484 (registerFrame + the register/ack flow)
- src/bus-worker.ts:78-79 (HEARTBEAT_WARN_MS/EVICT_MS), the `{op:"heartbeat"}` handler + last_heartbeat refresh

**Optional** (reference as needed):
- ~/code/arthack/apps/chatctl/chatctl/run_watch_chat.py `_heartbeat_loop` (30s cadence shape)

### Risks

- The heartbeat must ride the SAME long-lived connection as the subscription, not a one-shot connect.
- Clear the interval on socket close so a dead watcher doesn't leak a timer.

### Test notes

Unit-test that the watch client schedules heartbeat frames at the expected
cadence (fake timers). A full-tier test: register a watcher, advance past
90s of wall-clock with heartbeats flowing, assert the channel is NOT evicted
(shares the bus integration harness; sandbox KEEPER_BUS_SOCK/DB).

## Acceptance

- [ ] The `watch` client sends `{op:"heartbeat"}` on a ~30s interval over its open connection; the interval is cleared on disconnect
- [ ] A live watcher's channel survives well past 90s — no heartbeat-timeout eviction in the daemon log
- [ ] Unit + full-tier persistence tests pass

## Done summary
The watch client now heartbeats every 30s on its long-lived connection after register-ack (cleared on disconnect), so the relay no longer evicts a live channel at the 90s threshold. Added a fast-tier cadence/dispatch unit test and a full-tier wire test that the registered watcher's heartbeat is accepted and the channel survives.
## Evidence
