## Description

**Size:** M
**Files:** cli/usage.ts, test/usage.test.ts

### Approach

`usage` is the open-coded outlier (fn-660.1 deferral) — it does NOT use
createViewShell. Thread snapshot mode INLINE into its bespoke loop,
reusing the shared `src/snapshot.ts` helpers (resolver, latch, trailer/
no-frame formatters) so its output stays byte-compatible with the shared
harness's — NO trailer drift. Do NOT fold usage onto createViewShell
(explicit non-goal; note as a future follow-up).

Specifics: add `--snapshot`/`--watch`/`--timeout` to usage's parseArgs
(usage.ts:809) + HELP; compute mode via `resolveSnapshotMode`; usage blends
TWO streams (usage + jobs) into `composeBody` — pass `streamCount: 2` to
the latch. Snapshot fires when both streams have reported, captures the
composed body + state, writes usage's sidecars once, prints frame +
`keeper-meta:` via the SHARED formatter, then exits. usage has no
connecting spinner to suppress, BUT clear its 30s `refreshLive` tick
(usage.ts:1100-1106) and avoid arming the SIGINT/ppid teardown for a
one-shot exit. Use `script: "usage"` in the trailer.

### Investigation targets

**Required** (read before coding):
- src/snapshot.ts — the shared helpers to import (the whole point is reuse)
- cli/usage.ts:808-1200 — main: createLiveShell:833, frameCount/lastFrame:838-839,
  writeSidecars:911-938, composeBody:1016-1028, emitFrame:1036-1045,
  emitLifecycle:1108-1130, 30s tick:1100-1106, exitCleanly:1168-1190
- the usage + jobs subscription sites (confirm both deliver an initial
  frame so the streamCount:2 latch can't hang)

**Optional** (reference as needed):
- test/usage.test.ts — currently pure-render-fn only; factor the snapshot
  decision into a testable pure-ish function and add cases

### Risks

- **Trailer drift:** the entire reason to import the shared formatter — if
  usage hand-rolls its trailer it WILL drift from the other four. Assert
  byte-identical trailer shape in a test.
- **Tick leak:** the 30s refreshLive interval must be cleared on snapshot
  exit or it keeps the process alive past the intended exit.

### Test notes

usage has no harness-level test today — add `test/usage.test.ts` cases (or
a small subprocess test under sandboxEnv in the slow tier) asserting:
non-TTY usage prints one composed frame + a valid `keeper-meta:` (script:
"usage") last line + exits 0; the trailer JSON shape matches the shared
contract; the 30s tick is cleared. `bun run test:full` mandatory.

## Acceptance

- [ ] usage parses `--snapshot`/`--watch`/`--timeout` + documents them in HELP.
- [ ] usage snapshot reuses the shared `src/snapshot.ts` formatter — its
      `keeper-meta:` line is byte-shape-identical to the other four
      (script:"usage").
- [ ] usage snapshot waits for BOTH usage+jobs streams (streamCount 2),
      prints the composed frame + trailer, clears the 30s tick, exits 0.
- [ ] No-frame → exit 1; TTY usage behavior unchanged.
- [ ] `bun run test:full` passes.

## Done summary

## Evidence
