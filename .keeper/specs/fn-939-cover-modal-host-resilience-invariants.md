## Overview

The --agentwrap-modal PTY host ships with two stated invariants that have no
direct in-process coverage: the non-fatal buildOverlay-failure fallback and
the child-output suppression while the modal owns the screen. Both protect a
human's live claude session on an experiment-flagged surface, and both are
silently regressable on the next touch. This follow-up pins them with small
in-process tests using the harness seams that already exist.

## Acceptance

- [ ] A buildOverlay that rejects falls back to overlay=null without wedging the passthrough; child still exits cleanly.
- [ ] Bytes emitted while overlay.isOpen are NOT written to parent stdout; verbatim streaming resumes when closed.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | modal-overlay.ts close() ?1004 asymmetry: only remedy is a redundant comment on already-documented code (lines 344-346, 371-373); agent redraw re-asserts focus-reporting, no leak. |
| F2 | culled | — | modal-host.ts finally off-then-on dance: only remedy is a consolation comment; re-attach is harmless (process exits next line), destroy-first ordering already commented at 330-332. |
| F3 | kept | .1 | buildOverlay THROW-path fallback (runModalHost overlay=null) is a stated non-fatal-build-failure invariant with no direct test; a regression would wedge the passthrough on a renderer fault. |
| F3 | merged-into-F3 | .1 | F4 (no in-process assertion that onData drops bytes while overlay.isOpen, modal-host.ts:202-206) merges into F3: same root cause, same file test/agent-modal-host.test.ts, one test-coverage commit. |

## Out of scope

- The two culled Consider comments (F1, F2) — redundant documentation on already-commented code.
- Any change to modal-host.ts / modal-overlay.ts production behavior; this is test-only coverage.
