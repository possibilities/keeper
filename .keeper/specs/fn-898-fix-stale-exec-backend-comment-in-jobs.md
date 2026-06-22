## Overview

The exec-backend abstraction retirement left one stale comment block in the
jobs TUI focus-key handler: it still describes per-row backend resolution and
names the deleted `resolveExecBackend` symbol, contradicting the direct
`createTmuxPaneOps` seam the code now uses. This is a docs-correctness fix to
keep the comment from misleading the next reader into grepping for a symbol
that no longer exists.

## Acceptance

- [ ] The `v`-focus comment in cli/jobs.ts reflects the direct-seam reality and names no deleted symbol

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | cli/jobs.ts:660-667 comment names deleted resolveExecBackend and describes per-row resolution the direct createTmuxPaneOps call no longer does |
| F2 | culled | —  | dead execBackend key in two daemon.test.ts lifecycle tests is silently ignored, zero behavior/user impact |

## Out of scope

- The dead `execBackend: "zellij"` keys in test/daemon.test.ts (culled — silently ignored, no impact; will be swept on next touch)
