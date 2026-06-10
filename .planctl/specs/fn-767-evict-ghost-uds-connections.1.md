## Description

**Size:** M
**Files:** src/server-worker.ts, test/server-worker.test.ts

### Approach

Diagnose first, then fix. (1) Reproduce: open a UDS client, send one query frame,
close the socket cleanly, and observe whether the server's conns Set drops the
entry — instrument or assert via a test seam (conns size is observable through
the existing reaper/log paths or export a counter for tests). Determine why the
close isn't evicting: Bun.listen socket close/error callbacks not wired to the
conns.delete path, an error swallowed before eviction, or half-close semantics.
Write the verdict in Evidence. (2) Fix at the socket-lifecycle layer: close AND
error callbacks both evict + destroy; keep the EPIPE-on-write evict (it covers
mid-diff deaths). (3) Add the idle sweep: connections with zero subscriptions and
no inbound frame for IDLE_CONN_TTL_MS (~5 min) are evicted in the poll-tick reaper
— and hoist the existing stuck-pending TTL reap so it runs on EVERY poll tick,
not only when data_version changed (the deep-review fn-723 gap: a wedged conn on
a quiet DB is never reaped). Subscribed connections are NEVER idle-reaped (a
quiet board is legitimate — the fn-723 descope rationale stands; this targets
only zero-subscription ghosts). (4) Churn test: N sequential one-shot query
clients; assert conns returns to baseline; a never-subscribing silent-death stub
is evicted within the TTL; existing reaper tests (EPIPE, pending TTL, cap) stay
green. All of this is connection hygiene per the CLAUDE.md fn-723 carve-out —
no worker respawn, no DB writes, no synthetic events.

### Investigation targets

**Required** (read before coding):
- src/server-worker.ts — the conns Set lifecycle: accept path, data handler, write paths, the fn-723 reaper (EPIPE-evict, reapStuckPending, MAX_CONNECTIONS reject), and the poll loop's changed-tick gate
- ~/.local/state/keeper/server.stderr — tonight's rejection evidence
- test/server-worker.test.ts — existing client/lifecycle test seams

### Risks

- Do not evict subscribed-but-quiet viewers (the deliberate fn-723 no-ping-pong
  descope); the idle sweep keys on zero subscriptions only.
- Keep reject-new-at-cap semantics (never LRU-evict the oldest legit board).

### Test notes

Covered in Approach (4); also assert the cap log line still fires when genuinely
at cap with live conns.

## Acceptance

- [ ] diagnosis written in Evidence; close/error paths evict; idle zero-sub sweep + every-tick pending reap live
- [ ] churn test: conns returns to baseline after N one-shot clients; silent-death ghost evicted within TTL
- [ ] existing reaper tests green; full bun test green

## Done summary

## Evidence
