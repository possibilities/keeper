## Overview

A `work::`-verb `worktree-merge-conflict` dispatch failure — a completed
dependency lane failing to merge into the epic base before a downstream task
can be dispatched (a worktree fan-in conflict) — today gets NO autonomous
resolver, NO deconflict escalation, and NO active human page. The board pill
is visible (`isJamReason` is verb-agnostic), but the whole autonomous
conflict pipeline (resolver dispatch → deconflict session → botctl page) is
hard-scoped to `verb = 'close'`, so the conflict wedges the board with no
remediation and no notification until a human happens to notice it.

The root cause is a router short-circuit: `routeDispatchFailure` sends every
`verb === "work"` row to a dead `work-task` arm before the merge-conflict
token is ever checked. This epic diverts the work-verb merge-conflict row,
gives it an active page (the must-fix), then a task-scoped autonomous
resolver + deconflict escalation modelled on the mature close-verb pipeline.

End state: a work-verb fan-in conflict is paged once, auto-resolved when
mechanically clear, and escalated to exactly one human page when it is not —
with every existing close-verb behavior and every non-merge-conflict work
failure unchanged.

## Quick commands

- `bun test test/dispatch-failure-key.test.ts test/daemon.test.ts` — the router divert + work-verb sweep unit tiers
- `keeper query dispatch_failures --json` — inspect a live `work::<taskId>` merge-conflict row and its latch columns (`resolver_dispatched_at` / `merge_escalated_at` / `human_notified_at`)
- `bun run test:full` — root + plan + prompt suites green before close

## Acceptance

- [ ] A `work::`-verb `worktree-merge-conflict` row triggers exactly one active botctl page carrying the task id and conflicting files, page-once per row, re-arming on `retry_dispatch`.
- [ ] A mechanically-clear work-verb fan-in conflict is auto-resolved by a `resolve::<taskId>` worker (green-gated, committed, row cleared); a shared-decision conflict is left BLOCKED and escalates to exactly one `deconflict::<taskId>` session, human paged once at its terminal decline.
- [ ] Every non-merge-conflict work failure still classifies exactly as before (board pill / needs-human / jam unchanged); all close-verb behavior is untouched.
- [ ] Folds stay re-fold-deterministic; `bun run test:full` green; forward-facing docs reconcile the close-vs-work asymmetry.

## Early proof point

Task that proves the approach: `.2` (the router divert + active page path). It
is the independently-valuable must-fix and exercises the whole
route→select→sweep→fold→page seam end-to-end. If it fails: the divert is
over-broad (other work failures reclassify) or the page never fires (the
work-notify selector wrongly inherited the resolver-chain precondition) —
fall back to a narrower reason-token match and an independent notify gate.

## References

- `docs/adr/0007-autonomous-escalation-dispatch.md` — the close-verb-scoped escalation Decision this epic amends/supersedes.
- `docs/adr/0017-turn-active-escalation-lifecycle.md` — escalation lifecycle precedent.
- Incident: `fn-1237-matrix-v2-single-host-config.5` sat `[failed:merge-conflict]` with all three latch columns NULL, wedging downstream tasks and epic fn-1238 with zero page; recovered by hand-resolving the fan-in merge + `keeper autopilot retry work::…5`.

## Docs gaps

- **docs/adr/0007-autonomous-escalation-dispatch.md**: its Decision hard-scopes escalation to the close verb; extending to the work verb needs a superseding/amending ADR (authored in task .1).
- **CLAUDE.md** (Autopilot section): consolidate — the close-vs-work asymmetry and the `worktree-lane-premerge`/`worktree-lane-wedge` sentence go stale once work conflicts escalate; prune, keep `lint-claude-md.ts` green.
- **CONTEXT.md**: `Resolver` / `Deconflict session` / `Lane pre-merge` entries are close/epic-scoped; disambiguate the two conflict classes and the fan-in-vs-premerge distinction.
- **plugins/keeper/skills/watch/SKILL.md**: rung-2 / rung-4 describe close-only resolver sequencing; reflect that a `work::<taskId>` conflict is now a live escalation channel; check the `keeper watch --filter` list.

## Best practices

- **Derive the page-once key from conflict identity, never the attempt:** no timestamps/counters in the dedup key — the classic page-storm cause. The `(work,taskId)` PK is the stable identity here. [FireHydrant/PagerDuty]
- **Claim the in-progress latch atomically with the side effect:** the event-sourcing `BEGIN IMMEDIATE` cursor+projection write is the right primitive; the dispatch-claim rides that atomicity, not a separate read. [Temporal/Stitch Fix]
- **Give the resolver latch a TTL/lease:** a crashed resolver holding a bare timestamp latch deadlocks the pipeline — the silent-wedge one layer up. [durable-execution literature]
- **Gate the human stage on a TERMINAL resolver verdict; page on the stable edge:** never page the transient "resolving" state (flapping); the loop stays level-triggered, the page is edge-triggered. [Alertmanager hysteresis]
- **Textual-clean ≠ semantically-clean:** gate every auto-resolution on build+tests green; whitelist safe classes (additive non-overlapping), hard-block auth/crypto/migrations/binary → escalate. [DeployHQ / ASE 2023 MergeGen / MESTRE]
- **Detect with `git merge-tree --write-tree` (index/worktree-free)** so probing never touches a shared checkout; verify its exit-code semantics empirically (they changed between modes). [git-merge-tree docs]
