## Description

**Size:** S
**Files:** README.md, CLAUDE.md

Document the new connection lifecycle + viewer exit behavior.

### Approach

README ## Architecture (the UDS subscribe-server paragraph): add a
connection-lifecycle sentence — server evicts on EPIPE / stuck-pending and
enforces a max-connection cap (note: NO ping/pong — heartbeat descoped).
README ## Example clients: for each viewer, extend the exit-condition
sentence to include SIGHUP / parent-death / TTY-loss self-exit alongside
Ctrl-C. CLAUDE.md: add a carve-out to the no-self-heal DO-NOT bullet
(closing a stale/EPIPE UDS client connection is connection hygiene, not
self-heal — no worker respawn, no DB write, no synthetic event); add a
one-line worker-contract note that the UDS client connection lifecycle
(evict/cap) is the server-worker's socket-handler concern, distinct from the
{type}/{kind} worker↔main message bus.

### Investigation targets

**Required** (read before coding):
- README.md ## Architecture (UDS subscribe-server / wire-protocol paragraph) + ## Example clients (per-viewer exit-condition sentences).
- CLAUDE.md no-self-heal DO-NOT bullet + Worker-contract typed-message-protocol bullet.
- The shipped .1/.2 changes (so docs match actual triggers + cap value).

### Risks

- Don't overstate — server-worker + CLI only, no reducer/schema change; keep the framing accurate (no ping/pong, since descoped).

## Acceptance

- [ ] README ## Architecture documents EPIPE-evict + stuck-pending TTL + max-conn cap (no ping/pong); ## Example clients lists SIGHUP/parent/TTY self-exit per viewer.
- [ ] CLAUDE.md no-self-heal carve-out for connection reaping added; worker-contract note added.

## Done summary

## Evidence
