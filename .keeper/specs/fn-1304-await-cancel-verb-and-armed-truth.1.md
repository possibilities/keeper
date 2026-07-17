## Description

**Size:** S
**Files:** cli/await.ts, test/await.test.ts

### Approach

Separate "have I armed" from "print the armed line" (ADR 0072): the armed state latches on arm regardless of `--no-armed-line`; the flag suppresses only the initial line's emission, and the printed line's byte shape stays identical where it is emitted. This makes `--require-transition`'s edge suppression work under the flag (an already-met condition no longer fires at the arm tick, a genuine later transition still fires), makes the JSON envelope's `armed` field truthful, and lets the reconnect-blip swallow and progress logging engage exactly as they do without the flag — all four reader flips are the intended semantics, not side effects.

### Investigation targets

*Verify before relying — planner-verified file:line at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/await.ts:1567-1583 — emitArmed's early return before the latch, and the byte-identical armed-line contract below it
- cli/await.ts:2397-2434 — the arming block re-entry and the justArmed/--require-transition edge guard
- cli/await.ts:1961, 2108 — the reconnect-blip swallow and progress-log gate that begin engaging once armed latches

**Optional:**
- test/await.test.ts:1868, 1907, 3487, 691-703 — existing armed/require-transition/no-armed-line coverage to extend
- test/await.test.ts:75 — descriptor summary-match assertion that must keep passing

### Risks

- The latch must not wedge the await "armed forever" such that a genuine later transition is missed — the combined regression test is the gate.
- The arming block's arm-time refusals (not-found/ambiguous) run once post-latch; confirm none can first arise after the arm tick.

### Test notes

The missing combined case is the centerpiece: `--no-armed-line` + `--require-transition` with the condition already met at arm (no fire) and with a later genuine edge (fires met). Also assert the JSON envelope reports armed truthfully under the flag.

## Acceptance

- [ ] With both flags set and the condition already met at arm time, the await does not fire at arm and fires on a genuine later transition
- [ ] The JSON envelope reports the armed state truthfully under the suppression flag
- [ ] The armed line's emitted byte shape and all descriptor summaries are unchanged
- [ ] Existing await suites stay green

## Done summary
Latched the armed lifecycle state independent of --no-armed-line in emitArmed (cli/await.ts): the flag now suppresses only the printed line, while state.armed/result.armed flip on the first arming tick. This makes the JSON envelope's armed field truthful and lets --require-transition's edge guard, the reconnect-blip swallow, and progress logging engage under the flag. The emitted armed line's byte shape and all descriptor summaries are unchanged.
## Evidence
- Commits: 29383145e42b88dd8fd840f7cd20a5b99f36e803
- Tests: bun test ./test/await.test.ts (143 pass), bun test ./test/rpc-handlers.test.ts (72 pass), bun run test:gate (9327 pass, 0 fail), new combined regression test verified red-without-fix: met falsely fires at arm tick