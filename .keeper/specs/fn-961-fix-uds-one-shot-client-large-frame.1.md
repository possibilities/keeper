## Description

**Size:** M
**Files:** cli/handoff.ts, src/rpc-handlers.ts, src/server-worker.ts, src/daemon.ts, cli/control-rpc.ts, test/handoff.test.ts, test/control-rpc.test.ts

### Approach

Route the handoff doc through the filesystem instead of inlining it in the
`request_handoff` RPC frame (the inline frame exceeds the ~8 KiB UDS send
buffer and silently hangs). Mirror the spill pattern already in `cli/bus.ts`
(large bodies → file + compact pointer, aged out) and the file-passing in
`keeper pair`.

- **CLI (`cli/handoff.ts`):** after assembling the doc (already capped at
  `HANDOFF_DOC_MAX_BYTES` = 64 KB), write it to a spill file under a keeper
  state dir (reuse/mirror bus's spill helper + dir + age-out). Change
  `buildRequestHandoffFrame` to carry `doc_path` (the spill path) instead of
  inline `doc`. The wire frame is now small. On a successful enqueue ack,
  best-effort remove the spill file (the daemon has inlined it by then); rely
  on age-out as the backstop.
- **Validation/types (`src/rpc-handlers.ts`):** `validateRequestHandoffParams`
  validates `doc_path` (non-empty string) instead of `doc`; update
  `RequestHandoffParams` and the `buildRequestHandoffFrame` return type.
- **Bridge (`src/server-worker.ts`):** `RequestHandoffRequestMessage` carries
  `doc_path` worker→main (small) — neither the socket frame nor the worker→main
  message carries the large blob.
- **Daemon (`src/daemon.ts` `request-handoff-request` handler, ~:2556):** read
  the doc from `doc_path`, then inline it into the `HandoffRequested` event's
  `$data` EXACTLY as today (durability, `keeper handoff show`, and the
  `handoffs` projection unchanged). A missing/unreadable/oversized file →
  `ok:false` reply with a clear error (a real, loud failure mode now).
- **Loud-fail guard (`cli/control-rpc.ts`):** in the one-shot client, if an
  encoded frame would exceed a conservative size under the smallest common
  `SO_SNDBUF` (~7-8 KiB), reject with a clear "control frame too large; pass
  bulk via a file" error BEFORE writing — converting the silent-hang failure
  mode into an actionable one for any future oversized frame.

### Investigation targets

**Required** (read before coding):
- cli/handoff.ts:54,88,178-232 — `HANDOFF_DOC_MAX_BYTES`, `buildRequestHandoffFrame`, the enqueue `main()` that reads `--prompt`/`--prompt-file` into `doc` and sends the frame.
- cli/bus.ts:~77 + its spill helper/dir + `SPILL_MAX_AGE_MS` — the established spill-to-file pattern to mirror (compact pointer over the wire, file aged out).
- src/daemon.ts:2556-2636 — the `request-handoff-request` handler that inlines the doc into the event (change to read `doc_path` first); compare the working `set-epic-armed-request` handler at :2480-2554.
- src/rpc-handlers.ts:334-426 — `RequestHandoffParams`, `validateRequestHandoffParams`, `requestHandoffHandler`.
- src/server-worker.ts:~3356-3381 (bridge `requestHandoff`) + the `RequestHandoffRequestMessage` type + the main-side handler wiring — the worker→main message shape.
- cli/control-rpc.ts:40-138 — `roundTrip` (where the loud-size guard goes); `RESPONSE_TIMEOUT_MS` = 5000.
- test/handoff.test.ts, test/control-rpc.test.ts — validator/frame tests + the `listenEcho` real-UDS harness for an end-to-end test.

**Optional** (reference as needed):
- src/protocol.ts — `encodeFrame` (to measure encoded frame size for the guard).

### Risks

- **Durability must be preserved:** the doc has to land inline in the event
  (read from the spill on the daemon side), NOT as a bare file pointer — a
  deleted spill must never orphan a handoff. `keeper handoff show` reads the
  projection, so as long as main inlines, it is unchanged.
- **Spill lifecycle:** main reads the file during enqueue before acking; the CLI
  removes it on success; age-out is the backstop. Treat missing/unreadable as a
  LOUD `ok:false` error.
- **Wire-contract change spans CLI + rpc-handlers + server-worker + daemon** —
  keep the frame field, validator, bridge message, and handler read consistent
  in one change.
- **Same-host assumption:** daemon and CLI share the filesystem (UDS → same
  machine), so main can read the CLI's spill file. True for keeper.

### Test notes

Update test/handoff.test.ts for the new `doc_path` frame shape + validator. Add
an end-to-end test (test/control-rpc.test.ts `listenEcho`, or a daemon-level
test) that enqueues a handoff with a >8 KB doc via a spill file and asserts it
succeeds (small frame) and the doc is recoverable (inlined). Add a test for the
loud-size guard: an oversized frame rejects with the clear error, not a timeout.
`bun run lint` (biome over cli/src/test) and `bun test` must pass.

## Acceptance

- [ ] The handoff doc is passed by file path: `cli/handoff.ts` spills the doc to a file and `buildRequestHandoffFrame` carries `doc_path`, not inline `doc`; the `request_handoff` wire frame is small regardless of doc size.
- [ ] The daemon reads the doc from `doc_path` and inlines it into the `HandoffRequested` event unchanged — `keeper handoff show <id>` returns the full doc and the `handoffs` projection is identical to before.
- [ ] `keeper handoff --prompt-file <a >8 KB file>` enqueues successfully (no "no response from daemon within 5000ms"); a 40-64 KB brief works.
- [ ] A missing/unreadable/oversized `doc_path` produces a LOUD, clear error (`ok:false`), never a silent hang; the spill file is removed on success and aged out as a backstop.
- [ ] The one-shot UDS client rejects an encoded frame that would exceed the safe send-buffer size with a clear error instead of writing-and-hanging.
- [ ] Tests cover the new frame shape, an end-to-end >8 KB handoff enqueue, and the loud guard; `bun run lint` and `bun test` pass.

## Done summary
Route the handoff brief through a spill file: the CLI writes the doc to a file and sends doc_path on the wire (small frame), the daemon reads it back and inlines it into the HandoffRequested event so durability and the handoffs projection are unchanged. Added a loud-fail size guard on the one-shot UDS client and a loud ok:false for a missing/unreadable/oversized spill file.
## Evidence
