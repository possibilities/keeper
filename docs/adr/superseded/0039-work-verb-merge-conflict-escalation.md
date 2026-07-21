# 39. Work-verb fan-in merge-conflict escalation

## Status

Superseded by [ADR 0089](../0089-in-session-escalation-subagents.md): the resolver →
deconflict → page pipeline this record extended to the `work` verb now runs as an
in-session merge-resolver/deconflicter Task subagent pair inside the owning `/work`
session, sharing one incident with the `close` path rather than a separate dispatched
`work`-scoped session. The rest of this record describes the dispatched-session machinery
it replaced. Amended 0007 (autonomous escalation dispatch), also superseded.

## Context

A worktree fan-in content conflict — a completed upstream sibling that will not merge
cleanly into a downstream task's base lane — surfaces on the board but gets no resolver,
no deconflict, and no active page: the whole conflict pipeline is hard-scoped to
`verb = 'close'`, so it wedges the board and every dependent until a human notices. Task
.1 settles the unknown before any behavior change: is the `work::`
`worktree-merge-conflict` the correct-but-unserved sticky, or a mis-token of the
self-clearing `worktree-lane-premerge` family?

**Producer (pinned).** `mergeBranchInto` (`src/worktree-git.ts`) returns `{kind:"conflict"}` on
a fan-in merge. `createWorktreeDriver`'s `provision` method (`src/autopilot-worker.ts`) drives
the dependent lane's `preMerges`; a source that clears the base-readiness guards but then
conflicts returns `{ok:false, reason:"worktree-merge-conflict: merging <rib> into <base-lane> —
<stderr>"}` (no `dir`, so `runWorktreeProducerStep` defaults it to the lane path); the launch
loop mints `DispatchFailed{verb:"work", id:<taskId>, reason, dir:<lane>}`.

**Verdict: correct-but-unserved sticky.** The leading token is exactly
`MERGE_ESCALATION_REASON_TOKEN` — what close-sink conflicts carry, not the self-clearing
`worktree-lane-premerge-*` (the merge itself conflicts, not an uncleanable base). The snapshot
builder self-clears only `worktree-lane-premerge` (`laneFailures`), so this row is sticky;
`routeDispatchFailure` short-circuits every `verb=="work"` row to the retryable `work-task`
arm BEFORE the token gate, so its natural `(work, taskId)` key enters `failedKeys` (holding out
the task + dependents) yet clears on `retry_dispatch`. Incident: `fn-1237-…-config.5` sat
`[failed:merge-conflict]` (all three latch columns NULL), wedged epic fn-1238, cleared only via
`keeper autopilot retry work::…5` — retryable + sticky, not the un-retryable `worktree-lane-wedge`.

**`worktree-lane-wedge` does NOT actively page.** Active agentbot paging lives only in the
close-scoped notify sweeps (`unblock::`/`repair::`/`deconflict::`, gated on a session's
terminal decline/death via `human_notified_at`). The `daemon`-verb lane-wedge distress is
a board `needs_human` surface only — re-routing there would not page for free; a dedicated
page is required.

## Decision

Extend the escalation pipeline to the work verb along four axes.

1. **Identity, task-scoped.** `resolve::<taskId>` / `deconflict::<taskId>`, parallel to
   the close path's epic-scoped sessions. The row PK `(work, taskId)` is the conflict
   identity; the session-dedup key is verb-qualified so `resolve::<epic>` and
   `resolve::<taskId>` never collide.
2. **Columns — reuse, verb-parameterized.** Reuse the verb-agnostic
   `resolver_dispatched_at → merge_escalated_at → human_notified_at` latch columns (no new
   table); the folds hardcode `WHERE verb='close'` today and are parameterized (or given a
   work-scoped synthetic-event twin).
3. **Page-once — `human_notified_at` on `(work, taskId)`.** The dedup key is the conflict
   identity (the PK), never an attempt timestamp/counter; `IS NULL`-gated, terminal-only;
   `retry_dispatch` re-arms the chain so a genuine re-conflict re-pages.
4. **Scope — the served pipeline.** Task .2: a new `DispatchFailureRoute` variant diverts
   ONLY a `verb=="work"` + `worktree-merge-conflict` row out of `work-task` (other work
   rows unchanged), plus an INDEPENDENT notify sweep that pages straight away — not gated
   on the resolver columns nothing stamps in a page-only tier. Task .3: `resolve::<taskId>`
   and a `deconflict::<taskId>` sequenced behind its terminal verdict, the .2 page then
   gating on `merge_escalated_at`.

## Consequences

- A work fan-in conflict is now paged once, auto-resolved when mechanically clear, else
  escalated to one human page. The exact-leading-token divert leaves every
  non-merge-conflict work failure and all close-verb behavior byte-identical.
- **Confirms tasks .2/.3** — correct-but-unserved means router-divert + served pipeline,
  not a re-route/reshape: the `verb=="work"` short-circuit is the root cause; the
  page-only tier must be independent of the resolver columns; the latch columns are
  verb-agnostic with `verb='close'`-hardcoded folds; a `stickyWorkInstanceFor`
  instance-scope + verb-qualified session key are required.
- **Caution for .3:** the WORK row's `dir` is already the lane worktree where the conflict
  sits and `<base>` is the base-lane branch, so `resolve::<taskId>` works in that `dir`
  directly, not the close path's default-branch-assuming `mergeConflictBaseCheckout`. Close-only
  CLAUDE.md/CONTEXT.md/watch docs reconcile in task .4.
