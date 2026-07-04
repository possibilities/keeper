## Description

**Size:** M
**Files:** src/autopilot-worker.ts, src/reconcile-core.ts, test/autopilot-worker.test.ts, test/daemon.test.ts

### Approach

Three interlocking contract changes to the recover surface, mirroring shapes that
already exist on the finalize side:

1. **Tri-state epic probes.** Extract one pure frame->verdict helper (e.g.
`epicFrameVerdict(res): "done" | "open" | "absent" | "inconclusive"`) consumed by BOTH
`isEpicDoneById` and its documented clone `epicPresentAndNotDone`: a result frame whose
row has `status === "done"` -> done; a result frame with a row not done -> open; a result
frame with NO row -> absent (authoritative — the pk-lookup bypasses the OPEN scope and
every recency floor); a non-result frame -> inconclusive. The helper is pure so an error
frame is testable without engineering a live query failure. Pass-2 consumes the verdict:
done -> attempt the merge; absent -> skip the merge AND record a positive resolved
observation for that (epic,repo); inconclusive -> DEFER (no merge attempt, no
observation — open rows retained). Pass-3's presence probe maps inconclusive ->
preserve (its current coercion reads an error as sweep-eligible — the probe's own
doc calls that the most dangerous misread).

2. **Separate escalations channel.** `recoverWorktrees` returns
`{ failures, escalations, resolved }` instead of a bare failure list. The pass-2
`conflict` arm moves to `escalations` ({ epicId, reason, dir }) with the reason built
exactly like finalize's close-sink conflict (`worktree-merge-conflict: merging <base>
into <default> — <stderr>`); every transient degrade arm stays in `failures` with its
`worktree-recover-*` reason. The emit glue mints escalations as DispatchFailed on the
BARE `close::<epic>` id (verb close) — routing precedence then classifies them
merge-escalation (outside both auto-clear scopes), the resolver-dispatch and
merge-escalation sweeps select them unchanged, `keeper autopilot retry close::<epic>`
(hardcoded in the resolver brief + human escalation) drops them, and a finalize
close-sink row for the same epic UPSERT-converges rather than double-minting.
Additionally gate pass-2's merge attempt per-epic on `hasActiveResolver` exactly as
pass-1 gates its abort — a retargeted conflict now dispatches a resolver for a done
epic, and pass-2 must not re-attempt the same base->default merge while that resolver
is live (the gated skip yields no observation, so rows are retained for free).

3. **Positive-evidence clear.** `recoverFailuresToClear` clears an open recover id only
when it appears in the cycle's `resolved` observation set (merge succeeded this cycle,
base observed ancestor-of-default, or epic authoritatively absent), keyed per-(epic,repo)
through the SAME id helper the mint uses (the lockstep rule). Absence from BOTH the
fresh-failure set and the resolved set retains the row. Keep the fresh-failure set as a
never-clear-what-still-fails guard. Content conflicts are structurally outside this
predicate (they left the recover scope), matching the close-sink never-auto-dismissed
guarantee.

The recover worker still writes nothing to keeper.db — failures, escalations, and
resolved observations all flow through the existing emit deps to main; the DispatchFailed
change-gate applies unchanged.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves. NOTE: src/autopilot-worker.ts and src/reconcile-core.ts contain NUL bytes — use `rg -a` (never grep), and prefer `awk 'NR>=a && NR<=b' file | tr -d '\000'` for range reads.*

**Required** (read before coding):
- src/autopilot-worker.ts:3572 — the silent-skip site (`if (!(await isEpicDone(...))) continue`) that becomes the tri-state branch
- src/autopilot-worker.ts:3955-4002 — isEpicDoneById + epicPresentAndNotDone (documented clones; keep symmetric via the shared helper)
- src/autopilot-worker.ts:3652-3657 — the conflict arm to retarget; :3592-3593 the not-ahead/merged exits that become positive observations
- src/autopilot-worker.ts:485-500 — recoverFailuresToClear (the absence-based predicate to rewrite); call site + emit glue :5006-5049
- src/autopilot-worker.ts:2508-2541 — the finalize trichotomy + the CORRECT positive `finalizedClean` clear loop (the pattern to mirror); :2640-2644 the exact conflict reason string
- src/dispatch-failure-key.ts:268 — routeDispatchFailure precedence (finalize-ID -> recover-reason -> merge-escalation token); tokens at :28-54
- src/autopilot-worker.ts:3426 — recoverWorktrees signature (the seam widening: isEpicDone type, return shape, hasActiveResolver already threaded for pass-1)
- test/autopilot-worker.test.ts:8171,8446+ — makeRecoveryGit + the direct recoverWorktrees tests to extend

**Optional** (reference as needed):
- src/autopilot-worker.ts:4241-4290 — snapshot classifier routing rows into the two auto-clear scopes (should need NO change — routing does the work)
- src/daemon.ts:1030,1373,1264 — selectPendingMergeEscalations / selectPendingResolverDispatches / runMergeEscalationSweep (id-agnostic; match reason leading-token on close-verb rows); retry_dispatch re-arm :1022-1026,:1364
- test/daemon.test.ts:4242+,4314 — sweep test patterns + the row-insert helper carrying both once-marker columns
- src/reconcile-core.ts:933 — WorktreeRecoveryFailure type; :341 recoverFailureDispatchId

### Risks

- Routing precedence mis-key: a conflict minted with a recover-prefixed reason or a per-(epic,repo) id routes straight back into the auto-clear scope — the dispatch-failure-key routing tests are the tripwire, and the early proof point.
- The resolved-set keying must go through the same id helper as the mint; a hand-built key strands rows un-clearable (the helper's own doc states the lockstep rule).
- Pre-existing old-scheme conflict rows (recover-keyed, recover-reasoned) fall under positive-evidence clearing and persist until their base resolves or retry_dispatch — acceptable; none are live today.
- Widening the recoverWorktrees return shape touches every direct test and the fake driver; keep the change mechanical (failures-only callers destructure).

### Test notes

Pure fast-tier only (fake git via makeRecoveryGit, injected probes, in-memory rows; no
real git/daemon). Matrix: conflict -> escalations channel + close::<epic> mint + routes
to merge-escalation + selected by both daemon sweeps + retry_dispatch re-arm; every
transient arm -> failures channel unchanged; clear predicate {merged, not-ahead, absent}
x {open row present/absent} x {fresh failure present/absent}; tri-state probe mapping
incl. error frame (via the pure helper) and empty-rows-authoritative-absent; pass-2
resolver-gated skip retains rows; pass-3 inconclusive preserves; the incident regression
pin (test title carries the epic id + "incident reproduction" per repo convention):
sibling epic's conflict re-reported while this epic's probe returns inconclusive ->
this epic's open row RETAINED, no merge attempt, no clear.

## Acceptance

- [ ] A recover pass-2 content conflict produces a close-verb DispatchFailed on the bare epic id with a worktree-merge-conflict leading reason; it classifies to the merge-escalation scope, both daemon sweeps select it, no auto-clear touches it, and retry_dispatch drops and re-arms it.
- [ ] Every transient recover degrade keeps its per-(epic,repo) recover key, reason prefix, and level-clear behavior.
- [ ] An open recover row clears only on a same-cycle positive observation (merged, ancestor-of-default, or authoritatively-absent epic); absence of any report retains it, pinned by an incident-shaped regression test.
- [ ] The epic-done and epic-presence probes share one pure verdict helper distinguishing done, open, authoritatively-absent, and inconclusive; inconclusive defers pass-2 (no merge, rows retained) and preserves in pass-3.
- [ ] Pass-2 skips the merge attempt for an epic with a live resolver.
- [ ] `bun test` green.

## Done summary

## Evidence
