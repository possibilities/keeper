## Description

**Size:** M
**Files:** src/protocol.ts, src/server-worker.ts, test/protocol.test.ts, test/server-worker.test.ts

### Approach

Add the foundational RPC layer to the keeper protocol and server, landing
the SHELL with zero registered RPC methods. Touching this in isolation
proves the framing + dispatch path before any concrete handler exists in
Task .3.

Three moves:
1. Add `RpcFrame { type: "rpc", id: string, method: string, params?: object }`
   and `RpcResultFrame { type: "rpc_result", id: string, value: unknown }`
   to `src/protocol.ts`. Add both to the `ClientFrame` / `ServerFrame`
   discriminated unions. The existing `ErrorFrame` is reused for RPC
   errors with id correlation — add three new error codes: `unknown_method`,
   `bad_params`, `rpc_failed`. No change to `LineBuffer`, `encodeFrame`, or
   `MAX_LINE_LENGTH`.
2. In `src/server-worker.ts`, open a SECOND DB connection in WRITER mode
   alongside the existing read-only connection used by `pollLoop`. The
   writer connection runs through `applyPragmas` (BUSY_TIMEOUT etc); the
   reader stays autocommit (no BEGIN — `data_version` would freeze
   otherwise per APSW docs). Both connections live in `main()` of the
   worker; release both in the shutdown handler.
3. Add an `RPC_REGISTRY: Map<string, RpcHandler>` where `RpcHandler` is
   `(db: Database, params: unknown) => unknown`. Extend `dispatchLine` to
   handle `frame.type === "rpc"`: validate `id` and `method` are non-empty
   strings (else `bad_frame` error with the frame's id if present), look
   up the handler, frame as `unknown_method` if missing, otherwise invoke
   inside a try/catch and frame the return as `rpc_result` (or as `error`
   code `rpc_failed` on throw). The handler is invoked with the WRITER
   connection (the server's reader is read-only and will reject INSERTs).

Critical: `dispatchLine` is contracted never to throw past returning frames.
Preserve that — every RPC failure path returns an `ErrorFrame`, never throws.

The registry is EMPTY in this task. A test-only `noop` handler registered
from inside the test (via a setter or by injection) exercises the dispatch
end-to-end without polluting the prod registry.

### Investigation targets

**Required** (read before coding):
- src/protocol.ts:198-205 — `ClientFrame` / `ServerFrame` / `Frame` union exports; the new frame types slot in here
- src/protocol.ts:60-205 — frame shape catalog + invariants comment (`rev` on every server frame, id correlation pattern); the new RPC frames follow the same conventions
- src/server-worker.ts:481-573 — `dispatchLine` is the switch to extend; the existing `query` / `unsubscribe` cases are the template
- src/server-worker.ts:1068-1140 — the worker `main()` body; this is where the second `openDb` lands and where shutdown handling releases both connections
- src/server-worker.ts:885-907 — `pollLoop` runs on the READER connection; it MUST STAY in autocommit mode (no BEGIN) per the "naked autocommit read" comment, so the new writer MUST be a distinct connection
- src/db.ts:769-791 — `openDb(path)` (default writer mode) + `openDb(path, { readonly: true })` (the existing reader); both apply `applyPragmas`
- src/db.ts:355-361 — `applyPragmas` — what `busy_timeout=5000` does and why the writer needs it
- test/protocol.test.ts — existing protocol round-trip patterns to mirror for the new frame types
- test/server-worker.test.ts — existing dispatch / framing tests; the new RPC tests live alongside

**Optional** (reference as needed):
- src/db.ts:1-19 — schema layer header (context, not edited in this task)

### Risks

- **Writer-connection contention with the hook + planctl-files writer + reducer.** All three already coexist via WAL + `busy_timeout=5000`. The server-worker's new writer is one more participant; the pattern holds.
- **`pollLoop` blindness to same-process writes.** `PRAGMA data_version` updates when changes come from OTHER connections; the reader connection sees writes from the writer connection because they're distinct. Verify in a test by writing on the writer and observing a `data_version` bump on the reader.
- **`dispatchLine` contract.** The function is contracted not to throw past returning frames. Every new code path (frame parse, handler lookup, handler invocation) must respect this — wrap handler invocation in try/catch and frame the throw as `error`.

### Test notes

- `bad_frame` on `rpc` missing `id` / `method`, or non-string types — id is echoed when present
- `unknown_method` when method is well-formed but absent from the registry
- Happy path: register a test-only `noop` handler via a test-visible setter or injected registry; send `rpc` with that method; assert `rpc_result` echoes the request `id`
- Handler throw → `error` with code `rpc_failed`; connection stays open
- Writer connection is reachable: a `noop` handler that does a trivial `INSERT INTO meta (key, value) VALUES ('test_rpc_marker', 'ok') ON CONFLICT(key) DO UPDATE SET value=excluded.value` succeeds (reader can see it via a subsequent read)
- Existing `query` / `unsubscribe` / `result` / `patch` / `meta` tests still pass

## Acceptance

- [ ] `src/protocol.ts` exports `RpcFrame` and `RpcResultFrame` types; both added to `ClientFrame` / `ServerFrame` unions
- [ ] `src/server-worker.ts` opens a writer connection alongside the existing reader; both pass through `applyPragmas`; shutdown releases both
- [ ] An `RPC_REGISTRY` Map<string, RpcHandler> is exported from `src/server-worker.ts` (or a sibling module — `src/rpc-handlers.ts` if cleaner)
- [ ] `dispatchLine` handles `type: "rpc"` by validating frame shape (`bad_frame` on malformed), looking up the method (`unknown_method` on miss), invoking the handler with the writer connection inside try/catch (`rpc_failed` on throw), and framing the return as `rpc_result` with the request's `id`
- [ ] The registry is empty at the end of this task — no concrete RPCs registered yet
- [ ] New unit tests in `test/protocol.test.ts` round-trip the new frame types
- [ ] New unit tests in `test/server-worker.test.ts` exercise the dispatch path with a test-injected `noop` handler (success, throw → rpc_failed, unknown_method, bad_frame)
- [ ] `bun test` passes with no regressions on existing tests

## Done summary

## Evidence
