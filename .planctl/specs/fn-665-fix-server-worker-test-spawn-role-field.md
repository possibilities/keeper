## Overview

A server-worker test spawns the worker without the `role: "server"` field in
`workerData`, so the entrypoint guard added in fn-661 never fires. The socket
never binds, `ready` never fires, and the test hangs to its 5 s timeout.
This is a one-line fix in the test that restores deterministic green CI and
the shutdown/socket-release coverage path.

## Acceptance

- [ ] `test/server-worker.test.ts` "spawned Worker shuts down cleanly and removes the socket file" passes without timeout.
- [ ] `bun test test/server-worker.test.ts` exits green with no timeouts.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| f-001 broken-server-worker-test | kept | .1 | test/server-worker.test.ts:1318 confirmed — spawn missing role: "server"; gate at server-worker.ts:2306 blocks entrypoint, deterministic 5 s timeout |

## Out of scope

- Any changes to src/server-worker.ts (the role gate is correct)
- src/daemon.ts (already passes role: "server" correctly)
