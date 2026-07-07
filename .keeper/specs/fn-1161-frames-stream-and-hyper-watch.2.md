## Description

**Size:** M
**Files:** src/view-shell.ts, cli/board.ts, test/view-shell.test.ts, test/board.test.ts

### Approach

Add a third `createViewShell` mode `frames` alongside live/snapshot: on each
accepted frame (after the existing byte-compare gate) the shell emits an
envelope through the task-1 emitter instead of painting, honoring the duration
and max-frames bounds with a guaranteed trailer flush — including on the
SIGINT teardown path, which today only logs sidecar paths. Thread the latest
`BootStatus.rev` into the emit path: no seam exists today (renderBody receives
only the snapshot), so the shell gains a way for the caller to hand it the
freshest boot status per tick — follow the cli/status.ts latestBoot consumer
pattern. While the daemon is catching up (rev below head_event_id) frames are
emitted tagged rather than suppressed — the trailer's coverage plus the
envelope cursor let the consumer judge. Wire board as the first frames-capable
viewer: board exposes a frames entry the future subcommand dispatch will call
(its own flag grammar, NOT resolveSnapshotMode), and board's per-frame
stateJson is enriched beyond bare epics to also carry the already-built
subagent index (serialize the Map as a stable-ordered array of entries) so a
frames consumer has ground truth for stale-pill truthfulness checks by
pointer. Multi-stream views gate each stream to one report (usage-style
once-guards) so coverage accounting cannot drift. Snapshot and live modes stay
byte-identical to today.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/view-shell.ts:270 — the mode option today (live/snapshot); :326 view.emit byte-compare gate; :368 installSigintHandler (trailer flush goes here); :459-465 snapshot capture slot for shape reference
- cli/board.ts:989-1007 — subagentIndex built at :991-1004 then dropped from stateJson at :1006; :1031 subscribeReadiness call site
- cli/status.ts:397,573 — the only existing BootStatus.rev consumer; the plumbing template
- src/readiness-client.ts onBootStatus callback — where rev arrives client-side

**Optional** (reference as needed):
- test/view-shell.test.ts:700-780 — the injection harness these tests extend
- test/board.test.ts — makeSub/collapseSubagentsByName fixtures for the state-enrichment parity tests
- src/snapshot.ts:277 — the always-parseable-last-line discipline the trailer inherits

### Risks

- cli/board.ts and cli/autopilot.ts carry uncommitted working-tree changes from other in-flight work; rebase carefully and keep this task's board diff scoped to the frames entry + stateJson enrichment.
- The rev-into-emit seam is net-new plumbing; resist widening it into a general BootStatus passthrough — the emitter needs one monotonic number.

### Test notes

Extend the view-shell injection harness: drive a fake subscribe feed through
frames mode, assert envelope stream + trailer via injected IO; assert
snapshot-mode output unchanged (existing parity tests must stay green); board
state-sidecar enrichment asserted with stable ordering over makeSub fixtures.

## Acceptance

- [ ] With a fake feed, frames mode emits parseable envelopes with monotonic contiguous seq and cursor equal to the freshest rev handed to the shell
- [ ] Duration and max-frames bounds terminate with a trailer, and an interrupt during a run still flushes the trailer as the final line
- [ ] Board's per-frame state sidecar carries the subagent index in stable order alongside epics, proven by tests
- [ ] Snapshot and live behavior is unchanged — the existing snapshot parity assertions pass untouched
- [ ] A multi-stream view reports each stream at most once toward readiness/coverage accounting

## Done summary
Added a third createViewShell 'frames' mode emitting one NDJSON envelope per accepted frame through the task-1 emitter (baseline/frame + trailer flushed on max-frames/duration/SIGINT), a noteCursor seam threading BootStatus.rev, and wired board's frames entry (runBoardFrames) plus per-frame stateJson enrichment with the stable-ordered subagent index.
## Evidence
