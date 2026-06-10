## Description

**Size:** M
**Files:** cli/jobs.ts, cli/board.ts, cli/autopilot.ts,
test/jobs.test.ts, test/board.test.ts, test/autopilot.test.ts

### Approach

Fan the now-stable shared snapshot API (task .1) out to the remaining
shared-harness mains. Each: add `--snapshot`/`--watch`/`--timeout` to its
parseArgs block, compute the mode via `resolveSnapshotMode`, pass the
correct `streamCount`, and document the flags in its `HELP` constant.

- `jobs` (single-stream): `streamCount: 1`. Note jobs has a modal
  `captureKeys` (insert mode) — snapshot mode never reads keys, so capture
  is irrelevant; just ensure snapshot short-circuits before any key wiring.
- `board` (2 streams: readiness + armed_epics): `streamCount: 2`. Snapshot
  must run through board's `emitFrame` wrapper (it drains diagnostics
  before emit, board.ts:896-908) so the captured frame is the
  diagnostics-drained one. The latch holds until BOTH streams report — so
  the `[armed]` pills are deterministically present, not ordering-luck.
- `autopilot` (4 streams: readiness, dispatch_failures, autopilot_state,
  armed_epics): `streamCount: 4`. ALL FOUR handles must be disposed before
  exit (mirror installSigintHandler's onDispose fan-out). The latch
  guarantees the snapshot reflects the folded mode/armed/failed state, not
  seed values.

### Investigation targets

**Required** (read before coding):
- src/snapshot.ts + the createViewShell snapshot option surface from task .1
- cli/jobs.ts:564 (parseArgs) + its HELP + installSigintHandler site
- cli/board.ts:569 (parseArgs), 896-945 (emitFrame diagnostics drain +
  subscribeReadiness + armed_epics subscribeCollection + installSigintHandler)
- cli/autopilot.ts:771-911 (four subscriptions against mutated state, the
  four handle.dispose() calls in installSigintHandler) + its HELP/parseArgs:919

**Optional** (reference as needed):
- test/board.test.ts, test/jobs.test.ts, test/autopilot.test.ts —
  existing per-view test scaffolds (verify which exist; add snapshot cases
  in the dominant in-process style)

### Risks

- **streamCount correctness:** an over-count hangs until timeout (a stream
  that never reports); an under-count snapshots early (partial composite
  defeats determinism). Count the subscriptions that actually feed
  `view.emit` for each main and confirm each delivers an initial frame.
- **autopilot multi-handle dispose:** wiring only the primary handle leaks
  the other three sockets on exit — dispose ALL four.

### Test notes

In-process per-view tests asserting: non-TTY → one frame + valid
`keeper-meta:` + exit 0; the multi-stream latch holds until all streams
reported (board's `[armed]` present; autopilot's folded mode/armed/failed
present, not seed); timeout-degrade marks truncated:true. `bun run
test:full` is mandatory (these spawn CLI subprocess paths in the slow tier).

## Acceptance

- [ ] jobs/board/autopilot each parse `--snapshot`/`--watch`/`--timeout`,
      compute mode via the shared resolver, and document the flags in HELP.
- [ ] board (streamCount 2) and autopilot (streamCount 4) snapshot
      deterministically — the frame reflects ALL streams folded; timeout
      before all-in → truncated:true.
- [ ] autopilot disposes all four subscription handles before exit; no
      leaked socket.
- [ ] Each: non-TTY → frame + valid `keeper-meta:` last line + exit 0;
      no-frame → exit 1; TTY behavior unchanged.
- [ ] `bun run test:full` passes.

## Done summary
Fanned snapshot mode out to jobs (1 stream), board (2), and autopilot (4): each parses --snapshot/--watch/--timeout, resolves mode via resolveSnapshotMode, documents flags in HELP, and disposes all subscription handles before exit. Added view-shell reportSnapshotStream so multi-stream views hold the latch until every stream folds (deterministic composite, not ordering-luck).
## Evidence
