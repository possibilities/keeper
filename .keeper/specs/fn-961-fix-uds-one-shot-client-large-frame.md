## Overview

The shared one-shot UDS client `roundTrip` (`cli/control-rpc.ts`) writes each
request frame with a single `s.write(encodeFrame(send))` and ignores the
partial-write return value. When the encoded frame exceeds the OS socket send
buffer (~8 KiB `SO_SNDBUF` on macOS), the write is truncated, the daemon never
sees a complete newline-terminated line, never dispatches the RPC, and the
caller times out with no response. `request_handoff` is the only client→server
RPC that inlines a large payload (the handoff doc, capped at 64 KB), so it is
the sole victim — every real `keeper handoff` brief (>~8 KB) silently hangs.

End state: the one-shot UDS client(s) write the full encoded frame with
backpressure handling (byte-offset loop on `socket.write`'s return + a `drain`
resume), so frames up to the 64 KB handoff cap round-trip cleanly. A regression
test exercises a >8 KiB round-trip over the real UDS transport.

## Quick commands

- `cd ~/code/keeper && bun test test/control-rpc.test.ts`   # the new >8 KiB round-trip regression test passes
- `printf 'x%.0s' {1..12000} > /tmp/big.txt && keeper handoff --prompt-file /tmp/big.txt --title probe`  # a >8 KiB brief now enqueues instead of hanging

## Acceptance

- [ ] A `request_handoff` (or any) frame well over 8 KiB round-trips end-to-end via the real UDS transport without hanging.
- [ ] `keeper handoff` with a realistic (>8 KB) brief enqueues successfully (no "no response from daemon within 5000ms").
- [ ] No remaining one-shot UDS client that writes a frame with a single `write()` ignoring backpressure.

## Early proof point

Task that proves the approach: `.1`. If it fails: the diagnostic probes at
`/private/tmp/claude-501/-Users-mike-code-sitter/e54dfb53-eed2-41ff-b656-64259bbde190/scratchpad/handoff-probe{2,3,4}.ts`
reproduce the exact boundary (small doc succeeds in ~1ms; ≥8.4 KB frame hangs;
a 12 KB frame written with backpressure-aware writing succeeds in ~1ms) and the
fix is literally that backpressure-aware write moved into `roundTrip`.

## References

- The in-repo pattern to mirror: `src/server-worker.ts:2110-2190` (`writeFrames`/`flush`/`resumePending` — byte-loop, stash tail on a short write, resume from the `drain` handler) and its `drain(socket)` wiring at `:2959`. The client fix is the same shape but one-shot (no `conns`/reaper).
- Bun socket write semantics: `socket.write(data, byteOffset?, byteLength?)` returns a BYTE COUNT — `>=1` written, `0` = send buffer full (stop, wait for `drain`), `-1` = closed. For a STRING arg, `byteOffset`/`byteLength` are ignored and the return is the UTF-8 byte count — so encode to bytes first. Bun docs: socket/write, SocketHandler/drain, runtime/networking/tcp.
- Bun bug to avoid: oven-sh/bun#32087 (`writeOrEndBuffered` partial-writev arithmetic, open through v1.3.6) — do NOT mix app-level buffering (`ArrayBufferSink` corking) with Bun's internal write buffer in the same path; write the encoded bytes directly with explicit offset tracking.
- Read side is fine: `src/protocol.ts` `LineBuffer` + `MAX_LINE_LENGTH=1 MiB` reassembles multi-chunk inbound frames; the bug is purely send-side.

## Best practices

- **Check `socket.write`'s return; `0` means backpressure** — stop the loop, stash `[bytes, offset]`, resume on `drain`; never busy-loop on `0`. [Bun docs / practice-scout]
- **Encode the frame to a `Uint8Array` (TextEncoder) before the offset loop** — `socket.write` ignores `byteOffset`/`byteLength` for string args, and the byte count never matches `string.length` for non-ASCII. [Bun docs]
- **Add a `drain` handler with a re-entrancy guard and a `readyState` check** — without `drain` the stashed tail never resumes; mirror the server's `resumePending`. [practice-scout / repo-scout]
- **Don't mix `ArrayBufferSink` corking with raw `socket.write` in the same path** — Bun#32087 miscounts the remainder; direct offset writes sidestep it. [bun#32087]
