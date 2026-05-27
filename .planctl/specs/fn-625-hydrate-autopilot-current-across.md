## Overview

The autopilot `--- current ---` frame section only shows dispatches launched in the same process invocation. Prior-run dispatches whose claude/Ghostty sessions are still alive vanish from the UI on restart, even though keeperd's projection still carries the embedded job. Hydrate `dispatchLog` from the existing `dispatch.log` on startup with launches where `fulfilled && !completed && !dry`, latest-per-key, sorted by `ts` ascending — and implement the disappearance trigger that `detectJobTransitions`'s docstring already describes but the code does not, so cross-run state stays honest when a job has since vanished from the projection.

## Quick commands

```bash
bun test test/autopilot.test.ts
bun scripts/autopilot.ts --dry-run
```

## Acceptance

- [ ] `--- current ---` survives an autopilot restart for fulfilled-but-not-completed wet dispatches
- [ ] hydrated entries whose matching job has since disappeared from the projection migrate to `--- completed ---` on the first post-startup snapshot
- [ ] dry-run launches are not restored
- [ ] new `bun:test` cases cover both the hydration filter and the disappearance trigger
