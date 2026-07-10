## Description

**Size:** M
**Files:** src/reconcile-core.ts, src/worktree-git.ts, docs/adr/00NN-work-verb-merge-conflict-escalation.md

The load-bearing unknown gating the whole epic: is `worktree-merge-conflict`
on a `work::` key the *correct-but-unserved* sticky class, or a *mis-token*
of the self-clearing `worktree-lane-premerge` family? Pin the producer, settle
the classification, and record the epic's design decisions as an ADR the
downstream tasks consume. Investigation + ADR only — no behavior change here.

### Approach

Trace the producer that mints `DispatchFailed{verb:"work", id:<taskId>,
reason:"worktree-merge-conflict"}` for a fan-in content conflict: start at
`mergeBranchInto` (returns `{kind:"conflict",stderr}`), follow its caller
through the reconcile emit glue that turns provision/finalize/recover
outcomes into `DispatchFailed` events. Confirm the observed classification
against the incident evidence: the row was **sticky** (did not self-clear
when the merge was resolved) and required an explicit `keeper autopilot retry
work::…` — behaving like a served-nowhere `worktree-merge-conflict`, NOT a
self-clearing `worktree-lane-premerge` and NOT the un-retryable
`worktree-lane-wedge` distress row. Also determine whether
`worktree-lane-wedge` actively botctl-pages or only mints a board `needs_human`
row (this decides whether re-routing would have paged for free — evidence says
active paging lives only in the close-scoped notify sweep, so it does not).

Record the verdict plus the four design decisions the planner settled —
identity = task-scoped `resolve::<taskId>` / `deconflict::<taskId>`; columns =
reuse the verb-agnostic latch columns with verb-parameterized folds; page-once
= `human_notified_at` timestamp latch on the `(work,taskId)` row; scope =
extend the escalation pipeline to the work verb — as an ADR that
supersedes/amends 0007. If the trace instead shows a genuine mis-token, the
ADR records the re-route design and flags the downstream tasks for reshape.

### Investigation targets

*Verify before relying — planner-verified at authoring time; the repo moves.*

**Required** (read before coding):
- src/worktree-git.ts:1554 — `mergeBranchInto` `{kind:"conflict"}`; trace its caller into the reconcile driver.
- src/reconcile-core.ts:483 — `laneFailures`; :1113 `WorktreeRecoveryEscalation`; :1140 `laneWedged`/`laneResolved` — the emit glue mapping outcomes to `DispatchFailed{verb,id,reason}`.
- src/dispatch-failure-key.ts:232 — `WORKTREE_LANE_PREMERGE_REASON_PREFIX`; :262 `LANE_WEDGE_DISTRESS_*` (the self-clearing / distress family to distinguish from).
- docs/adr/0007-autonomous-escalation-dispatch.md — the Decision being amended/superseded.

**Optional** (reference as needed):
- docs/adr/0017-turn-active-escalation-lifecycle.md — ADR template + escalation lifecycle.
- src/daemon.ts:10752 — `notifyHumanOfDeconflict` (the only active-paging sweep, close-scoped).

### Risks

- The producer line is genuinely hard to pin (the fan-in merge is invoked through reconcile glue, `mergeBranchInto` has no obvious named caller) — budget trace time; the reason-string format `worktree-merge-conflict: merging <src> into <base> — <stderr>` is the anchor.
- If the verdict is "mis-token", downstream tasks .2/.3 reshape — the ADR must call that out explicitly so the plan is refined before .2 starts.

### Test notes

No code change; the deliverable is the pinned producer (documented in the ADR) and the ADR itself. No test tier.

## Acceptance

- [ ] The producer that mints a work-verb `worktree-merge-conflict` for a fan-in conflict is pinned (file + function named in the ADR).
- [ ] The classification verdict (correct-but-unserved vs mis-token) is recorded with the incident evidence, and whether `worktree-lane-wedge` actively pages is stated.
- [ ] An ADR following the 0007/0017 Status/Context/Decision/Consequences template is committed, marked as amending/superseding 0007, recording the identity / columns / page-once / scope decisions; ADR number left provisional (assigned at merge).
- [ ] The ADR either confirms tasks .2/.3's design assumptions or flags the required reshape.

## Done summary

## Evidence
