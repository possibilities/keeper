## Overview

Two robustness edges in the offline-reclaim wrapper (scripts/maintenance-window.ts)
survived the close audit, both on the orchestration safety path the tool exists
to guarantee. The drain gate can return before a launch-window worker binds, and
the post-restart verify probe can spuriously fail a good reclaim. Both fail safe
today (autopilot stays paused, snapshot intact, no data loss), so this is
tightening the tool's happy path, not a data-integrity fix.

## Acceptance

- [ ] The drain gate does not report drained while a launched-but-unbound worker can still bind before the daemon stops.
- [ ] The forensics verify probe does not spuriously fail when the last prompt contains a literal LIKE wildcard.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept   | .1 | awaitDrain gates only board_work_jobs; pending_dispatches launch-window workers can bind after the gate reads zero and be live when stopDaemon boots keeperd. |
| F2 | kept   | .1 | captureForensicsTerm strips /[%_\]/ but search-history escapes those chars for a literal match, so a prompt with a literal wildcard yields a term that no longer matches and fails verify. |
| F3 | culled | —  | "arthack.keeperd" literal duplication is a documented import-cycle-avoidance trade-off with no user impact; hoisting is cosmetic, code left alone. |

## Out of scope

- Hoisting the "arthack.keeperd" label to a shared leaf module (F3, culled — no change until the label churns).
- Any change to buildRealDeps production I/O wiring, which stays a subprocess/daemon boundary untested by the fast tier.
