## Description

**Size:** M
**Files:** src/live-shell-core.ts, src/live-shell.ts, src/view-shell.ts, src/snapshot.ts, src/clipboard-debug.ts, cli/descriptor.ts, cli/usage.ts, test/live-shell-core.test.ts, test/live-shell.test.ts, test/view-shell.test.ts, test/snapshot.test.ts, test/clipboard-debug.test.ts, test/usage.test.ts, test/keeper-cli.test.ts, test/completions.test.ts, test/help-purity.test.ts

### Approach

Give the shared human viewer shell an explicit latest-only contract instead of approximating it with a one-entry history cap. It keeps one accepted frame plus transient readiness/reconnect/stale overlays, preserves current-frame scrolling and Ctrl-C teardown, and removes every history, selection, copy, and arbitrary-key path. Remove `--watch` from the shared viewer grammar; piped stdout remains a finite snapshot, while machine change streams remain exclusively under `keeper frames`.

Replace indexed human-view artifacts with one atomic per-process `state.latest.json` and `frame.latest.txt` pair. Remove per-frame diffs, the prior-frame scratch file, the append-only frame index, and frame-number chrome; update snapshot metadata as an explicitly revised human/debug trailer rather than preserving stale path fields. Usage countdown/local repaint must update the same current pair without minting Frames history.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/live-shell-core.ts:245 — in-memory history, frame navigation, key dispatch, and overlay state.
- src/live-shell.ts:620 — OpenTUI key translation, scrolling, and teardown wiring.
- src/view-shell.ts:580 — live/snapshot/frames mode separation and sidecar ownership.
- src/view-shell.ts:1197 — indexed state/frame/diff persistence and clipboard coupling.
- src/view-shell.ts:1528 — accepted-frame paint path shared by live viewers.
- src/snapshot.ts:69 — snapshot metadata/trailer contract.
- cli/descriptor.ts:191 — shared viewer flags, including `--watch`.
- cli/usage.ts:47 — Usage semantic emit versus local repaint behavior.

**Optional** (reference as needed):
- src/frames-emitter.ts:30 — independently versioned bounded machine stream that must not change.
- docs/adr/0088-viewer-staleness-and-paint-watchdog.md — stale proof and reconnect invariants.
- docs/adr/0097-sidecar-backed-dynamic-usage-viewer.md — Usage repaint/provenance boundary.

### Risks

The shared shell also drives Frames mode, so history removal must stop at the human-live boundary. Removing application key dispatch must not disable current-content scrolling or Ctrl-C, and local overlays must not become retained prior frames. Atomic replacement must prevent torn files while concurrent viewer processes remain isolated by PID.

### Test notes

Exercise the shell state machine and OpenTUI paint seam directly. Assert one replaceable frame, preserved scroll position with clamping, ignored non-scroll keys, no copy/history navigation, no numbered artifacts, local Usage repaint persistence, finite piped snapshots, `--watch` rejection, and byte-identical Frames emitter behavior.

### Detailed phases

1. Separate latest human state from the Frames-mode emitter and history concepts.
2. Reduce input to scrolling and Ctrl-C; simplify banner/frame numbering.
3. Replace indexed persistence and revise snapshot/clipboard debug consumers.
4. Remove the shared `--watch` grammar and update Usage.
5. Rework focused shell, snapshot, completion, and Usage fixtures.

### Alternatives

A one-frame history cap leaves navigation state and misleading frame banners alive. A one-shot polling wrapper duplicates reconnection and staleness logic. Both are rejected in favor of an explicit latest-human policy inside the existing shell boundary.

### Non-functional targets

Changed frames perform bounded memory work independent of session duration. Current-file writes are atomic and attacker-controlled text never becomes a terminal control sequence or filesystem path component.

### Rollout

No data migration is required. Existing viewer processes keep their loaded behavior until restarted; the machine Frames protocol remains usable throughout.

## Acceptance

- [ ] A live human viewer retains one accepted frame and transient current overlays regardless of session duration; no frame index or history cursor exists.
- [ ] Up/down, page, and mouse scrolling inspect only the current frame and preserve/clamp position across replacement frames; Ctrl-C exits, while all other former application keys are inert.
- [ ] Live and snapshot human viewers write only one atomic per-process current state/frame pair and never create numbered state/frame/diff files, prior-frame scratch, or append-only frame metadata.
- [ ] Usage local meter-age/reset repaints update the visible current frame and its current sidecars without emitting a machine frame.
- [ ] `--watch` is absent from shared viewer parsing/completions and rejected when supplied; non-TTY viewer invocation remains a finite snapshot.
- [ ] Existing Frames bounds, envelopes, sidecar ring, cursor/coverage, and trailer tests remain unchanged and green.
- [ ] The focused shell, view-shell, snapshot, Usage, CLI, completion, and help-purity tests pass.

## Done summary

## Evidence
