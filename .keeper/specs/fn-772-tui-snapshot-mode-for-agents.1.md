## Description

**Size:** M
**Files:** src/snapshot.ts (new), src/view-shell.ts, cli/git.ts,
test/snapshot.test.ts (new), test/view-shell.test.ts, test/git.test.ts

### Approach

Build the shared snapshot machinery as a new dep-free-ish `src/snapshot.ts`
module, integrate it into `createViewShell`, and wire `git` (the simplest
single-stream view, `cli/git.ts:279-323`) as the end-to-end proof point.

`src/snapshot.ts` exports pure-ish helpers BOTH the shared harness and the
open-coded `usage` (task .3) call, so the trailer can never drift:
- `resolveSnapshotMode({ snapshotFlag, watchFlag, stdoutIsTTY, env })` →
  `"snapshot" | "watch"` (or throws a typed CLI-misuse error when both
  flags set). Precedence: flag > `CI`/`TERM=dumb` > `stdout.isTTY !== true`.
  Tri-state safe (`undefined` is non-TTY; never coerce before `!== true`).
- a **stream-readiness latch**: caller declares `streamCount`; each
  stream's FIRST data callback decrements the latch (latch on data, NOT the
  `connected` lifecycle — `connected` fires first per readiness-client.ts:800).
  When it hits 0 → resolve "ready" (truncated:false). A `~2s` (override)
  timer resolves "timeout": if ≥1 stream reported → emit the partial
  composite with truncated:true, exit 0; if 0 reported → frame:null, exit 1.
  A single `settled` flag guards frame-vs-timeout races (no double-emit).
- `formatSnapshotOutput({ frameText, meta })` → the stdout block (frame
  text + labeled lines + the final single-line `keeper-meta: {json}` per the
  epic contract) and `formatNoFrameOutput(...)` → the stderr diagnostic +
  the stdout `keeper-meta:` (frame:null) line.

In `createViewShell`: add a `snapshot` branch driven by a new
`ViewShellOptions` field (`mode: "live" | "snapshot"` + `streamCount` +
`timeoutMs`). In snapshot mode: do NOT construct the live OpenTUI shell
(use `createLiveShell({enabled:false})` or short-circuit before any
`pushFrame`); do NOT arm the connecting spinner (gate `armConnectingSpinner`
at `emitLifecycle` view-shell.ts:634); capture the first ready composite's
`bodyLines`/`stateJson` via the existing `renderBody`/`sidecarFrameText`
path; write the sidecars once (so the trailer paths point at real files);
print the block; dispose the subscription handle(s) via the caller's
onDispose; `process.exit(0)`. Reuse `getLastFrameText`/`metaSidecar`/
`lifecycleSidecar` already on the ViewShell interface.

Wire `git` to: parse `--snapshot`/`--watch`/`--timeout` (boolean/boolean/
string in its parseArgs block, validate timeout manually — parseArgs has no
number type), compute the mode via `resolveSnapshotMode`, pass
`streamCount: 1`, and update its `HELP` constant with the three flags.

### Investigation targets

**Required** (read before coding):
- src/view-shell.ts:290-698 — createViewShell; emit byte-gate 567-586;
  frameCount 0→1 at 577 (first-frame signal); writeSidecars 485-530;
  emitLifecycle spinner-arm 634; installSigintHandler/exitCleanly 644-682
- src/view-shell.ts:184-189 — ViewRender{bodyLines,stateJson}; 270-288 —
  the ViewShell interface (metaSidecar/lifecycleSidecar/getLastFrameText)
- src/live-shell.ts (createLiveShell enabled gate) + src/live-shell-core.ts:174-229
  (passthrough — what snapshot replaces; confirm enabled:false is a clean no-op shell)
- cli/git.ts:279-323 — the single-stream wiring template (parseArgs block,
  subscribeCollection→view.emit→installSigintHandler) + its HELP constant
- src/readiness-client.ts:310-312,1330 (idempotent dispose), :800
  (connected-before-data ordering — confirms latching on DATA not connected)

**Optional** (reference as needed):
- test/view-shell.test.ts:155-385 — patchStdout/patchIntervals harness
- test/git.test.ts:139-340 — mock-socket subscribeCollection driver

### Risks

- **Empty-frame deadlock:** the latch must decrement even when a stream's
  collection is empty. CONFIRM each subscription delivers an initial
  callback on an empty collection (subscribeCollection onRows with []); if a
  stream can stay silent when empty, latch on its `connected` lifecycle
  instead for that stream. This is load-bearing — a silent empty stream
  hangs the snapshot until timeout.
- **Frame source without the live shell:** in live mode the frame text is
  produced as a side effect of `pushFrame`; snapshot must capture
  bodyLines/sidecarFrameText directly from renderBody, before/without any
  live push.
- **diff subprocess:** the first sidecar write hits the "no previous"
  sentinel (no `diff` spawn) — confirm snapshot never spawns `diff`.

### Test notes

In-process (fast tier) via the test/view-shell.test.ts harness: drive a
snapshot-mode createViewShell with a fake stream, assert (a) the captured
stdout carries the frame + a `keeper-meta:` last line that JSON.parses,
(b) the spinner interval was NOT armed, (c) `process.exit` is invoked with
0 on a frame and 1 on timeout (inject a fake exit like
test/keeper-cli.test.ts). Add test/snapshot.test.ts for the pure helpers
(resolveSnapshotMode precedence incl. CI/TERM=dumb and the both-flags
error; latch ready-vs-timeout-vs-degrade; trailer JSON validity). Run
`bun run test:full` — git's path is slow-tier-adjacent.

## Acceptance

- [ ] `src/snapshot.ts` exports `resolveSnapshotMode` (flag>env>isTTY,
      tri-state, both-flags→typed error), the stream-readiness latch, and
      the trailer/no-frame formatters; all unit-tested in test/snapshot.test.ts.
- [ ] `createViewShell` snapshot branch: no live shell, no spinner arm,
      captures the first ready composite, writes sidecars, prints frame +
      `keeper-meta:` block, disposes handle(s), exits 0.
- [ ] Non-TTY `keeper git` prints one frame + a valid single-line
      `keeper-meta:` (last stdout line) and exits 0; `--snapshot` forces it
      on a TTY; `--watch` forces the live stream when piped; both flags →
      stderr error + exit 2; bad `--timeout` → exit 2.
- [ ] No-frame `keeper git` → exit 1, diagnostic on stderr, `keeper-meta:`
      (frame:null) on stdout; empty-but-healthy projection → exit 0.
- [ ] git's HELP documents `--snapshot`/`--watch`/`--timeout`.
- [ ] Humans: TTY `keeper git` unchanged. `bun run test:full` passes.

## Done summary
Added src/snapshot.ts (resolveSnapshotMode precedence, stream-readiness latch, keeper-meta: trailer/no-frame formatters), wired the snapshot branch into createViewShell, and proved it end-to-end on cli/git: non-TTY stdout auto-detects snapshot and prints one frame + a parseable keeper-meta: last line then exits 0, --snapshot/--watch force the mode, both flags or a bad --timeout exit 2, and a dead-sock timeout exits 1 with status daemon-unreachable / frame:null.
## Evidence
