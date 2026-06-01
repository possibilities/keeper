## Description

Addresses f-001 (broken-server-worker-test). The test at
`test/server-worker.test.ts:1318` spawns the server-worker with
`workerData: { dbPath, sockPath, lockPath }` — no `role` field. The
fn-661 entrypoint guard (`server-worker.ts:2306-2307`) gates on
`workerData?.role === "server"`, so `main()` never runs, no UDS socket
binds, no `ready` message fires, and the test hangs to its 5 s timeout.

Fix: add `role: "server"` to the `workerData` object at line 1318. One line.
The other `server-worker.ts` reference in the file (line ~2150) is a
`readFileSync` source-lint test — no change needed there.

## Acceptance

- [ ] `test/server-worker.test.ts` "spawned Worker shuts down cleanly and removes the socket file" passes.
- [ ] `bun test test/server-worker.test.ts` exits green.
- [ ] No other tests regressed.

## Done summary

## Evidence
