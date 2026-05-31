## Overview

The ~200-line TUI shell lifecycle scaffolding (sidecar writers, emitLifecycle,
scheduleFlashRestore, handleCopyKey, SIGINT handler, color gate) is copy-pasted
across cli/board.ts, cli/jobs.ts, and at least three more siblings
(git.ts, usage.ts, autopilot.ts). Extract a createViewShell({ script, renderBody })
factory into src/ so each view becomes a thin caller and divergence risk is eliminated.

## Acceptance

- [ ] createViewShell factory lives in src/ and owns the shared lifecycle, sidecar writes, and key handlers
- [ ] board.ts and jobs.ts are thin callers of createViewShell; no ~200-line harness duplication
- [ ] Remaining siblings (git.ts, usage.ts, autopilot.ts) migrated or explicitly deferred with rationale
- [ ] No behavior change: bunx tsc --noEmit passes, bun test suite passes

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1     | kept   | .1   | Auditor-verified ~200-line harness copy-pasted across ≥5 TUI siblings; divergence risk is concrete — a sidecar-format fix landing in one sibling but not others would be a user-visible bug |
| F2     | culled | —    | Tier_0; auditor explicitly accepts the test gap as reasonable for a TUI shell harness; no concrete user-visible defect today |

## Out of scope

- Any behavior changes to the TUI views
- New feature work on the TUI siblings
