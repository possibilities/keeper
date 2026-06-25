## Description

**Size:** S
**Files:** cli/control-rpc.ts, test/control-rpc.test.ts, src/board-render.ts

### Approach

Make `roundTrip` (`cli/control-rpc.ts`) write the FULL encoded frame with
backpressure handling instead of a single fire-and-forget `s.write()`:
encode the frame to bytes (`new TextEncoder().encode(encodeFrame(send))`),
then in the `open` handler run a byte-offset loop calling
`socket.write(bytes, offset, bytes.byteLength - offset)` — advance `offset`
by the return value while `>= 1`, stop and stash the remaining `offset` when
it returns `0` (send buffer full), and `settle`-reject if it returns `-1`
(closing). Add a `drain(s)` handler to the `Bun.connect` `socket` config that
resumes the loop from the stashed `offset` (state captured in the `roundTrip`
Promise closure), with a re-entrancy guard and a `socket.readyState` check.
Mirror the server-side `writeFrames`/`flush`/`resumePending` shape
(`src/server-worker.ts:2110-2190`) but keep it one-shot — no `conns` set, no
pending-reaper.

Apply the SAME fix to the duplicate hand-rolled `roundTrip` in
`src/board-render.ts:942` (the `replay_dead_letter` path) — either refactor it
to import the fixed `roundTrip` from `cli/control-rpc.ts`, or apply the
identical backpressure-aware write. Prefer sharing the write path so a single
site owns the logic. (Its params are small today, but it is the same latent
bug; leave no one-shot client that ignores backpressure.)

Update the `cli/control-rpc.ts` file-header comment and the `roundTrip` JSDoc
to describe the backpressure-aware write (the current text claims it "writes a
single frame"). Forward-facing only — no change-history, fn-ids, or dates.

### Investigation targets

**Required** (read before coding):
- cli/control-rpc.ts:40-138 — `roundTrip` (the single-write bug at :85, the `Bun.connect` socket config with no `drain`); :150-207 `queryCollection`/`sendControlRpc`; RESPONSE_TIMEOUT_MS=5000 at :32.
- src/server-worker.ts:2110-2190 — `writeFrames`/`flush`/`resumePending`: the canonical byte-loop + stash-tail + drain-resume to mirror; :2959 the `drain(socket){ resumePending }` wiring.
- src/protocol.ts:363-471 — `encodeFrame` (appends `\n`), `LineBuffer`, `MAX_LINE_LENGTH` (1 MiB; read side is fine — confirms send-side-only bug).
- test/control-rpc.test.ts:29-162 — `listenEcho` real `Bun.listen` UDS echo harness under `mkdtempSync`, and the assert/reject test shape to follow for the new regression test.
- src/board-render.ts:942 — the duplicate hand-rolled `roundTrip` to fix/unify.

**Optional** (reference as needed):
- cli/handoff.ts:54,88 — `HANDOFF_DOC_MAX_BYTES` (64 KB), `buildRequestHandoffFrame` (the large-payload frame shape; no change needed).

### Risks

- **Bun #32087 (open through v1.3.6):** mixing app-level buffering with Bun's
  internal write buffer in `writeOrEndBuffered` miscomputes the remainder →
  byte duplication/loss. Mitigation: write the encoded bytes DIRECTLY with
  explicit offset tracking (what the diagnostic probe did); do NOT introduce
  `ArrayBufferSink` corking in this path.
- **String vs bytes:** `encodeFrame` returns a string; `socket.write` ignores
  `byteOffset`/`byteLength` for strings and the return is the UTF-8 byte count.
  Must encode to a `Uint8Array` and loop on byte offsets.
- **`drain` re-entrancy / closed socket:** guard against recursive flush and
  check `socket.readyState` before writing in `drain`.
- **Duplicate site decision:** refactor board-render to share the fixed path vs
  fix-in-place — pick one and leave no third copy.

### Test notes

Add a regression test in test/control-rpc.test.ts using the existing
`listenEcho` UDS harness: send a frame whose encoded size is well over 8 KiB
(e.g. a `request_handoff`/`query` frame with a ~32-64 KB doc field) and assert
`roundTrip` (via `queryCollection`/`sendControlRpc` or `roundTrip` directly)
RESOLVES — it would reject/time-out at RESPONSE_TIMEOUT_MS=5000 pre-fix. Keep a
small-frame case too (no regression). `bun run lint` (biome over cli/src/test)
and `bun test` must pass.

## Acceptance

- [ ] `roundTrip` writes the full encoded frame with backpressure handling: bytes encoded once, an offset loop on `socket.write`'s return value, a `drain` handler resuming the stashed tail (re-entrancy-guarded, `readyState`-checked), and a settle-reject on a closing socket (`-1`).
- [ ] A frame well over 8 KiB (~32-64 KB doc) round-trips end-to-end through the real UDS transport without hanging — new test in test/control-rpc.test.ts passes (times out pre-fix), and a small-frame case still passes.
- [ ] The duplicate one-shot client in src/board-render.ts:942 is fixed the same way or refactored to reuse the fixed write path — no remaining single-`write()`-ignoring-backpressure one-shot UDS client in the codebase.
- [ ] The write path writes encoded bytes directly with offset tracking — no `ArrayBufferSink`/app-buffer mixing with Bun's internal buffer (avoids bun#32087).
- [ ] cli/control-rpc.ts file-header + `roundTrip` JSDoc describe the backpressure-aware write, forward-facing (no change-history).
- [ ] `bun run lint` and `bun test` pass.

## Done summary

## Evidence
