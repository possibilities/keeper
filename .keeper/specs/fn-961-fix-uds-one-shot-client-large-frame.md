## Overview

The handoff doc (up to 64 KB) is inlined into the `request_handoff` RPC frame,
but the one-shot UDS client truncates any frame over the ~8 KiB socket send
buffer (`SO_SNDBUF`), so every real `keeper handoff` brief silently hangs.
Rather than harden the socket write path (which would lean on Bun's partial-write
path — oven-sh/bun#32087, open through v1.3.6), route the doc through the
filesystem the way `keeper pair` and `cli/bus.ts` already do: the CLI spills the
doc to a file and sends a SMALL frame carrying the path; the daemon reads the
file and inlines the doc into the `HandoffRequested` event exactly as today.

End state: control frames stay small (the doc rides through the filesystem, not
the wire), so a 64 KB brief enqueues cleanly. Durability, `keeper handoff show`,
and the `handoffs` projection are unchanged (the daemon still inlines the doc into
the event). A loud-fail guard makes any future oversized control frame error
instead of silently hanging.

## Quick commands

- `cd ~/code/keeper && bun test test/handoff.test.ts test/control-rpc.test.ts`
- `printf 'x%.0s' {1..40000} > /tmp/big.txt && keeper handoff --prompt-file /tmp/big.txt --title probe`   # a 40 KB brief enqueues (small frame) instead of hanging

## Acceptance

- [ ] `keeper handoff` with a brief well over 8 KB (up to the 64 KB cap) enqueues successfully — the wire frame stays small, no "no response from daemon within 5000ms".
- [ ] Durability unchanged: the daemon inlines the doc into the `HandoffRequested` event; `keeper handoff show <id>` returns the full doc; the `handoffs` projection is identical.
- [ ] A control frame that would exceed the safe send-buffer size fails LOUDLY with a clear error, never a silent hang.

## Early proof point

Task `.1`. If it fails: the probes at
`/private/tmp/claude-501/-Users-mike-code-sitter/e54dfb53-eed2-41ff-b656-64259bbde190/scratchpad/handoff-probe{2,3,4}.ts`
show the boundary (a small frame succeeds in ~1ms; a ≥8.4 KB frame hangs). The
spill approach keeps the frame small so it never crosses the boundary.

## References

- House pattern to mirror: `cli/bus.ts` spills large bodies to a file with a compact pointer (`SPILL_MAX_AGE_MS`, ~:77); `keeper pair` passes content via files (`--prompt-file` / `--output`). Handoff is the only RPC that inlines a large blob into a control frame.
- `cli/handoff.ts` — already reads `--prompt-file` into `doc` and caps at `HANDOFF_DOC_MAX_BYTES` (64 KB); `buildRequestHandoffFrame` is the frame to change (carry a path, not the doc).
- Daemon handler: `src/daemon.ts` `request-handoff-request` (~:2556) inlines the doc into the event — change it to read the doc from the spill path first; compare the working `set-epic-armed-request` handler at ~:2480.
- Wire/bridge: `src/rpc-handlers.ts` `validateRequestHandoffParams`/`RequestHandoffParams` (~:334-426); `src/server-worker.ts` `RequestHandoffRequestMessage` + bridge `requestHandoff` (~:3356); `cli/control-rpc.ts` `roundTrip` (the small-frame transport — where the loud-size guard goes).
- Transport ceiling: ~8 KiB macOS `SO_SNDBUF`; `src/protocol.ts` `LineBuffer`/`MAX_LINE_LENGTH` (1 MiB) shows the READ side is fine — the bug is send-side only.

## Best practices

- **Keep control RPCs small; route bulk payloads through the filesystem** (pair/bus precedent) instead of inlining big blobs in a control frame.
- **Preserve event-sourced durability:** inline the doc into the event at enqueue (read from the spill on the daemon side); never store a bare file pointer a deleted file would orphan.
- **Fail loud, not silent:** an oversized control frame should error with a clear message, never hang.
