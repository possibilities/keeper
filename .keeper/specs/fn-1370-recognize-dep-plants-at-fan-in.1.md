## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/worktree-git.ts, test/worktree-isolation.test.ts

### Approach

The lossless-cleanability verdict that feeds the fan-in defer / recover / would-clobber
classification must classify a byte-identical ADR-0074 plant as keeper residue (ignorable,
safely removable before merge), reusing `isWorktreeDepPlant` so plant identity keeps its
single definition. Whether the probe REMOVES the plant pre-merge or merely excludes it
from the clobber set is the worker's judgment — preserve the invariant that anything
NOT byte-identical (retargeted link, real dir/file at the path) stays work product and
still blocks. The wedge escalation path stays intact for genuine residue.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worktree-git.ts:1610 — isWorktreeDepPlant, the sole plant-identity seam (byte-identity contract in its doc comment)
- src/worktree-git.ts:2332-2353 — the teardown-side call pattern to mirror (read raw link target, hand to the seam)
- src/autopilot-worker.ts:6012 — the would-clobber verdict branch in the base-readiness classification
- src/autopilot-worker.ts:2300, :5771, :5970 — the not-losslessly-cleanable consumers (recover pass, fan-in defer)

### Risks

- The probe runs inside the producer (autopilot-worker), never a fold — keep filesystem reads producer-side per the event-sourcing invariants.
- Removing a plant pre-merge must be crash-safe: a re-provision happens on next lane use; verify no consumer assumes the link persists mid-epic.

### Test notes

Deterministic, through the pure git-boundary seam per test doctrine: a fake untracked
listing with (a) a byte-identical plant only → cleanable; (b) plant + real untracked file
→ blocks naming only the real file; (c) retargeted link → blocks.

## Acceptance

- [ ] a lane whose only untracked entry is a byte-identical plant no longer produces a would-clobber/wedge verdict
- [ ] non-identical residue at the plant path still blocks as work product
- [ ] worktree-isolation gates green

## Done summary
isWorktreeDepPlant now backs the fan-in/recover lossless-cleanability probe: a byte-identical ADR-0074 dep plant no longer produces a would-clobber/wedge verdict, while retargeted links or real work at the plant path still block. Added deterministic worktree-isolation coverage for all three cases.
## Evidence
