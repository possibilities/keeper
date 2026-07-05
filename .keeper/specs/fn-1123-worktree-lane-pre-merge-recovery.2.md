## Description

**Size:** M
**Files:** src/dispatch-failure-key.ts, src/autopilot-worker.ts, src/daemon.ts, src/dispatch-failure-pill.ts, test/dispatch-failure-key.test.ts, test/autopilot-worker.test.ts, CLAUDE.md, CONTEXT.md

### Approach

Close the routing asymmetry that leaves a `work::` pre-merge failure sticky-forever,
and give a genuine (non-cleanable) lane conflict the same self-clearing +
grace→needs_human treatment the shared main checkout already has — never the dead
no-clear `work-task` arm.

Behavioral contract:

- **New `worktree-lane-*` reason family** minted by `provision()` for the residual
  (non-retry-skip, non-cleaned) failures Task 1 leaves: a persistent divergent-dirty
  base, would-clobber-untracked, off-branch, mid-merge, and `abort-failed`. Distinct
  from `worktree-recover-*`, `worktree-finalize-*`, and the
  `worktree-merge-conflict` merge-escalation token, so it never collides with the
  `close::<epic>` escalation semantics. Predicates live beside the existing ones in
  `dispatch-failure-key.ts`.
- **Verb-agnostic reason-scoped clear**, modeled exactly on `slotOccupancyFailures`:
  a new reason-scoped collection set + a pure positive-evidence level-clear helper
  (mirroring `recoverFailuresToClear` — clears iff resolved AND not still-failing;
  absence RETAINS). This clears a `work::<taskId>` lane-pre-merge row by REASON,
  bypassing the `verb==="work"→work-task` short-circuit, WITHOUT touching
  `routeDispatchFailure` itself — the router's three close arms must stay provably
  disjoint and the `close::<epic>` merge-escalation UPSERT path must stay untouched.
- **Grace→needs_human lane distress**, mirroring `createSharedCheckoutWedgeTracker`
  (in-memory grace + per-key mint-latch, `nowSec` passed in so the grace clock stays
  fold-pure; durable level-clear off the open-distress set). It is a NEW,
  distinctly-scoped surface keyed per lane worktree path — it must NOT be routed
  through the shared-checkout-wedge dir set (that machinery deliberately excludes
  linked-lane paths and targets the default-branch tree). A persistent
  divergent-dirty base past the grace watermark mints the distress; `abort-failed`
  (git could not even abort — a hard wedge) mints an IMMEDIATE visible distress,
  not graced, matching `finalizeEpic`'s precedent.
- **Level-clear via the existing per-cycle recover pass.** The lane-wedge distress
  re-probes and clears through the recover pass that already sweeps every cycle, so
  it self-clears once the worktree is resolved even when the task is cap-gated,
  cooled, paused, or flapping — not only on the next dispatch attempt.
- **daemon.ts exemptions.** Wire the new lane-distress key into the same orphan-GC
  exemption and `retry_dispatch` handling that `isSharedWedgeDistressKey` gets.
- **Change-gated re-emit.** Ride the existing DispatchFailed change-gate (emit on
  first appearance + reason-change + a bounded still-stuck watermark; identical
  re-emits suppressed; a clear is immediate) so a stuck lane mints O(1) events.
- **Docs (part of this task's deliverable, since it corrects the documented state
  machine):** fold the lane pre-merge arm + corrected `work::` clear/escalate
  semantics into the CLAUDE.md Autopilot clause (revise+consolidate, never append;
  keep `bun scripts/lint-claude-md.ts` green), and add a short CONTEXT.md
  "Worktree and merge" entry disambiguating the lane pre-merge arm from Recover
  pass / Merge-gate / Fan-in (choose a verb other than bare "clean"). No
  `docs/problem-codes.md` entry — that registry is for CLI-envelope error codes, not
  board distress rows (the sibling `shared-checkout-wedge` is likewise absent). The
  auto-clean stays inside ADR-0003's existing bounded-self-heal carve-out (no new
  ADR).

### Investigation targets

*Verify before relying — file:line refs drift, and `src/autopilot-worker.ts` has NUL bytes that break BSD `grep`/`rg` (use `grep -a`/`sed`/Read).*

**Required** (read before coding):
- src/dispatch-failure-key.ts:266-285 — `routeDispatchFailure` and its `verb==="work"→work-task` short-circuit (line ~269); leave it intact, clear by reason instead
- src/dispatch-failure-key.ts:293-310 — `isWorktreeRecoverReason` / `isSlotOccupancyReason` reason-prefix predicates; the new `worktree-lane-*` predicate belongs here
- src/autopilot-worker.ts:4357-4419 — the clear-collection loop; `slotOccupancyFailures` (~4384-4389) is the exact verb-agnostic reason-scoped precedent, and the `work-task` arm (~4410-4414) that currently falls through to no clear
- src/autopilot-worker.ts:500-520 — `recoverFailuresToClear`, the pure positive-evidence level-clear helper to mirror
- src/autopilot-worker.ts:1104-1166 — `createSharedCheckoutWedgeTracker` (in-memory grace + mint-latch + durable level-clear; `nowSec` injected for fold purity) — the pattern for the lane distress
- src/daemon.ts:345-374 — the `isSharedWedgeDistressKey` orphan-GC + `retry_dispatch` exemptions to replicate for the lane key

**Optional** (reference as needed):
- src/dispatch-failure-pill.ts:59 — pill reason-stripping (a new reason prefix ripples here)
- src/autopilot-worker.ts:3638-3760 — `recoverWorktrees` pass-2's transient-kind→reason mapping (template for the lane reason mapping) and the per-cycle sweep the lane re-probe rides

### Risks

- **Routing disjointness** is asserted and load-bearing — a `worktree-lane-*` reason must not collide with `worktree-merge-conflict` (the `close::<epic>` escalation token) or `worktree-recover-*`; keep `routeDispatchFailure` and the close merge-escalation path untouched.
- **Reason-string verbatim ripple** — new/changed `worktree-*` reasons are asserted verbatim across `dispatch-failure-key.test.ts`, `dispatch-failure-pill.ts`(+test), `await-conditions`, and `daemon.ts` escalation gates; enumerate the ripple set before coding.
- **Distress key mis-scoping** — routing the lane distress through the shared-checkout-wedge dir set would corrupt the main-checkout escalation; keep it a distinct per-lane-path surface with its own daemon exemptions, or orphan-GC reaps it / `retry_dispatch` mishandles it.
- **Clear latency** — the level-clear must ride the per-cycle recover sweep, not the dispatch attempt, or a resolved wedge lingers as a false needs_human while the task is gated.

### Test notes

- `test/dispatch-failure-key.test.ts`: the new `worktree-lane-*` predicate, the closed `work::` routing asymmetry (a lane reason clears; the close token still routes to merge-escalation), and disjointness.
- `test/autopilot-worker.test.ts`: the reason-scoped clear set + level-clear (positive-evidence: clears on resolution, retains on absence); the lane grace tracker (graced divergent-dirt vs immediate `abort-failed`); change-gated O(1) re-emit; the per-cycle recover-pass re-probe clearing a resolved wedge while the task is cap-gated.
- Assert the CLAUDE.md lint gate (`bun scripts/lint-claude-md.ts`) stays green after the Autopilot consolidation.

## Acceptance

- [ ] A `work::<taskId>` lane pre-merge failure is cleared by reason through a verb-agnostic reason-scoped scope (never the dead `work-task` arm), while the router's `verb==="work"` short-circuit and the `close::<epic>` merge-escalation path are unchanged and still provably disjoint.
- [ ] A persistent divergent-dirty lane base mints a needs_human distress row only after a grace watermark; an `abort-failed` mints an immediate visible distress; both are keyed to a distinct per-lane surface, exempt from orphan-GC, and never routed through the shared-checkout-wedge set.
- [ ] The lane distress self-clears via the per-cycle recover pass once the worktree is resolved, even when the owning task is cap-gated, cooled, or paused.
- [ ] A stuck lane condition mints O(1) DispatchFailed events (change-gated), not one per cycle.
- [ ] The CLAUDE.md Autopilot section and the CONTEXT.md glossary reflect the lane pre-merge arm and corrected clear/escalate semantics, with the lint and consistency gates green; no problem-codes.md entry is added.

## Done summary

## Evidence
