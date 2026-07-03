## Description

**Size:** S
**Files:** cli/autopilot.ts (or the shared snapshot viewer path it delegates to), test/

### Approach

Reproduce first: `keeper autopilot` non-TTY snapshot wrote a frame file containing only
"---" during live diagnosis while the daemon was healthy and dispatch history existed. Trace
the snapshot path (viewer → frame writer) to why the dispatch-log frame rendered empty —
empty backing read vs render bug vs timing (single-frame snapshot taken before first
paint) — and fix so a healthy daemon always yields a populated frame (or an honest "no
dispatch rows" line, never bare separators). Add a shape test on the frame writer if the
seam allows.

### Investigation targets

**Required** (read before coding):
- cli/autopilot.ts snapshot/non-TTY path + the keeper-meta frame protocol
- What the dispatch-log viewer reads (the projection/collection backing it)

### Test notes

Frame-writer unit test with seeded rows and with zero rows (honest-empty rendering).

## Acceptance

- [ ] Healthy daemon snapshot yields a populated or honestly-empty frame, never bare separators; test pins it

## Done summary
Fixed the autopilot non-TTY snapshot emitting a bare `---` frame: an empty snapshot render now normalizes to a single honest-empty line via the shared view-shell seam (`snapshotBodyLines` + per-view `snapshotEmptyLine`), so a healthy-but-idle daemon always yields a populated or honestly-empty frame. Added frame-writer shape tests (seeded + zero rows).
## Evidence
