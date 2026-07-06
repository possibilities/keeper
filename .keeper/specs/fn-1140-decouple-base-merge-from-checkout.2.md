## Description

**Size:** S
**Files:** src/autopilot-worker.ts, src/dispatch-failure-key.ts, src/daemon.ts, test/autopilot-worker.test.ts

### Approach

Once the base merge is working-tree-free (task .1), a dirty or mid-merge shared
checkout no longer blocks the daemon's merge — so the `shared-checkout-dirty` and
`shared-checkout-wedge` (mid-merge) needs_human distress signals become FALSE
POSITIVES (they announce a block that no longer exists — the exact false-positive
class that motivated this work). Neuter the false-positive mint: stop feeding the
shared-checkout dirty/mid-merge trackers observations that no longer represent a
real block (the merge proceeds regardless), and DRAIN any such rows already open
on the board so an operator is not left with an un-clearable daemon-verb row.

Keep this a NEUTER, not a full teardown: recover pass-1's abort of interrupted
merges in LANE worktrees stays (lanes still get real mid-merge state); the
genuinely-inert dead code (the unreachable `MergeLaneResult` arms, the
main-checkout mid-merge self-heal, the distress-family constants/predicates) and
the CLAUDE.md/CONTEXT.md revise-and-prune are the sequenced FOLLOW-UP, not this
task. If a probe naturally goes silent post-decouple, this task confirms it and
drains open rows rather than adding code.

### Investigation targets

*Verify before relying — file:line planner-verified at authoring time. Use `grep -a`/ripgrep on src/autopilot-worker.ts.*

**Required** (read before coding):
- src/dispatch-failure-key.ts:147 `SHARED_WEDGE_DISTRESS_*` and :179 `SHARED_DIRTY_DISTRESS_*` (constants + `isSharedWedgeDistressKey`/`isSharedDirtyDistressKey`)
- src/autopilot-worker.ts `createSharedCheckoutWedgeTracker` (~1191) and the shared-checkout dirty/mid-merge probe that feeds it + its snapshot open-distress set
- src/autopilot-worker.ts:4439 `recoverSharedCheckoutMidMerge` (the main-checkout mid-merge trigger that loses meaning)
- src/daemon.ts:7344 the distress mint + :359/:388 the orphan-GC exemptions (drain path for open rows)

### Risks

- Draining open rows must target only the shared-checkout dirty/wedge families (disjoint id prefixes) — never a live lane-wedge or genuine merge-conflict row.
- Do not over-reach into full machinery removal here (that is the follow-up); the goal is: no new false-positive mint + existing rows cleared.

### Test notes

Pure fast tier: assert a dirty/mid-merge shared-checkout observation no longer produces a `shared-checkout-dirty`/`-wedge` mint post-decouple, and that an already-open such row is emitted for clear. Model via the existing tracker/snapshot fakes.

## Acceptance

- [ ] A dirty or mid-merge shared checkout no longer mints a `shared-checkout-dirty`/`shared-checkout-wedge` needs_human distress row (no false positive for a checkout state that no longer blocks the base merge)
- [ ] Any such distress row already open is drained/cleared, not left un-clearable
- [ ] Recover pass-1's lane-worktree interrupted-merge abort is unchanged
- [ ] `bun test test/autopilot-worker.test.ts` is green

## Done summary
Neutered the shared-checkout dirty/mid-merge distress false positives: the recover cycle now feeds the wedge/dirty trackers no observations (single sharedCheckoutDistressObservations seam, no false-positive mint, level-clear still drains) and the boot orphan-GC drains any open shared-checkout-wedge/-dirty row (lane-wedge/stale-base/crash-loop stay exempt). Recover pass-1 lane abort unchanged.
## Evidence
