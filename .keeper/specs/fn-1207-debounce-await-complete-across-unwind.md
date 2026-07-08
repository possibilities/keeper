## Overview

keeper await complete can fire in the brief done+idle window before the machine gate unwinds a premature done stamp (observed live: tasks flapping completed→running→completed during close-out reconciliation). fn-1200 landed a verdict-side terminality latch; this epic verifies what unwind window remains observable to the await surface and, if one remains, adds a stability confirmation so met only fires on a completion that survives the reconcile.

## Quick commands

- `bun test test/await-conditions.test.ts` (or the await fixture suite)

## Acceptance

- [ ] The remaining unwind window (or its absence) is established with a reproducing fixture and documented
- [ ] If a window remains: a completion that regresses within the confirmation window never fires met; a stable completion fires with bounded added latency
- [ ] Await semantics never fire earlier than today

## Early proof point

Task that proves the approach: `.1`. If fn-1200's latch fully closed the window: close as a verified no-op with the fixture as regression coverage.

## References

- Incident: fn-1193.2/.6 done-unwind round-trips observed on the live board; fn-1200.3's latch landed after
- Stability-window practice: N consecutive observations + a monotonic watermark that must not regress; N of 2-3 suffices for single-pass flips [practice-scout]

## Docs gaps

- **plugins/keeper/skills/await/SKILL.md** (complete semantics lines): revise if the confirmation window changes observable timing

## Best practices

- **Define the window in signals await actually observes** (subscribe snapshots + per-row last_event_id), never daemon reconcile ticks it cannot see [gap-analyst]
