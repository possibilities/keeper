## Description

**Size:** M
**Files:** scripts/board.ts, src/readiness-client.ts, test/board.test.ts, test/readiness-client.test.ts

Surface the waiting dead letters on the board and let the human recover one
per keypress.

### Approach

- Add `dead_letters` as a 5th subscription in src/readiness-client.ts:
  `makeState("dead_letters", ...)`, push into `states[]`, add
  `!deadLetters.gotResult` to the `emitSnapshotIfReady` first-paint gate
  (already 4 collections despite stale "all-three" prose — fix the comments
  too), and add it to the `onSnapshot` payload + the
  `ReadinessClientSnapshot` type.
- In scripts/board.ts render a PERSISTENT warn/yellow indicator of the
  `waiting` count (reuse the existing `warn`/`\x1b[33m` bucket; a
  `[dead-letter:N]`-style pill, surfacing the native count — don't collapse
  to a boolean). Place it where it's always visible (e.g. a header/status
  line); drop it cleanly when count is 0.
- Add a replay keypress (mirror the `c`-key `onKey`/`onUnhandledKey` handler
  at board.ts:762,1283). Pick `r`. On press, open an RPC client connection
  (board has no RPC-send path today; reuse the approve.ts connect→send
  `{type:"rpc",id,method:"replay_dead_letter"}`→await `rpc_result` by id with
  timeout pattern) and flash a status (`[replaying…]` → `[recovered N]` /
  `[nothing to replay]` / `[replay failed]`), mirroring the copy-key status
  flash. The waiting count drops on the next frame and the recovered session
  appears.

### Investigation targets

**Required:**
- src/readiness-client.ts: the `states[]` (~1042) + `emitSnapshotIfReady` gate (~1049) + `ReadinessClientSnapshot` type (~121) — the 4→5 collection widening.
- scripts/board.ts:758-766 (`onUnhandledKey`), 1283-1312 (`c` handler + status flash), the PILL_COLORS `warn` bucket + colorizer.
- scripts/approve.ts:240,383-404 — the RPC client send/await pattern to reuse for the replay key.
- test/board.test.ts / test/readiness-client.test.ts — render-shape + first-paint-gate assertions to extend.

### Risks

- First-paint gate: an empty `dead_letters` collection (zero rows, the steady state) still yields `gotResult=true` so the gate clears — verify, don't assume.
- The board's subscribe socket is read-only; the replay key opens a SEPARATE short-lived RPC connection (the request says "keypress → socket → RPC"). Don't try to send RPC over the subscribe stream.

### Test notes

- Render test: a snapshot with N waiting rows shows the warn pill with N; N=0 hides it.
- readiness-client: first-paint waits for all 5 collections; empty dead_letters still clears the gate.

## Acceptance

- [ ] Board persistently shows the `waiting` dead-letter count (warn/yellow, native count) and hides it at 0.
- [ ] The replay keypress sends `replay_dead_letter` over a fresh RPC connection and flashes status; the count drops and the recovered session appears on the next frame.
- [ ] readiness-client first-paint gate widened to 5 collections; stale "three/all-three" comments fixed.

## Done summary

## Evidence
