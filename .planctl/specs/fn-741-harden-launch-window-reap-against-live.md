## Overview

The fn-724 pause/boot launch-window reap and the fn-727 completion reap close
zellij worker panes via `ExecBackend.reapSurfaces`. Their safety gate
(`isReapCandidate`) reaps a pane IFF its `(work|approve|close)::<id>` dispatch
key is still present in `pending_dispatches` (`openPendingKeys`). The stated
invariant: `pending_dispatches` rows discharge on `SessionStart` (the reducer
DELETEs the row when a worker binds), so a still-present key == a not-yet-bound
launch-window ghost, never a live worker.

**Incident 2026-06-08:** that invariant broke. While the fn-736 NDJSON hook
deploy froze the event pipeline (no hook events reached `events` for ~35 min),
`SessionStart` never folded, so `pending_dispatches` rows never discharged —
and the pause reap killed LIVE, working panes (`# reap: closed pane …
exited=false`, `[autopilot-worker] pause reap: … reaped=N`). Every pause
(human + operator) reaped running workers mid-task → orphaned claims →
re-dispatch loops. The same window exists under ordinary heavy fold lag (folds
were observed at 5.4s), not just a full pipeline break.

**Fix (defense-in-depth):** the reap predicate must NEVER close a pane that is
demonstrably live. `ZellijPane` already carries an `exited` field from
`list-panes`. Add a hard guard: a pane with `exited === false` is never a reap
candidate, regardless of its `pending_dispatches` membership. This makes the
reap strictly more conservative — worst case a true ghost lingers one extra
cycle — and removes the fold-latency dependency from the highest-blast-radius
close decision. The `pending_dispatches` intersect stays as the primary gate;
the `exited===false` veto is an independent safety net layered on top.

Scope: the shared predicate + its two callers (pause/boot reap, completion
reap) + tests. No change to dispatch, binding, or the reducer. Daemon-side
only — not live until `launchctl kickstart` deploy.

## Quick commands

- `bun test test/autopilot-worker.test.ts`
- `bun test`
- `launchctl kickstart -k gui/$(id -u)/arthack.keeperd`  # deploy (operator runs)

## Acceptance

- [ ] `isReapCandidate` (and the fn-727 completion-reap predicate) return false
  for any pane with `exited === false`, even when the pane's dispatch key is in
  `openPendingKeys` / `completedRowIds`.
- [ ] A pane with `exited === true` or `exited === undefined` plus an open
  pending key is still reaped (ghost behavior preserved — no regression).
- [ ] Tests cover: live pane (`exited:false`) + open pending key → NOT reaped;
  ghost pane (`exited:true`/absent) + open pending key → reaped; the discharged
  (missing-key) live worker case still never reaped.
- [ ] No change to dispatch/bind/reducer; `bun test` green.

## References

- `src/autopilot-worker.ts:396` `isReapCandidate` (the shared gate; comment
  calls it "the highest-blast-radius decision"), `:404` fn-727 completion-reap
  predicate, `:1967` pause-reap usage, `:1928-1995` pause/boot reap block.
- `src/exec-backend.ts:436` `ZellijPane.exited?: boolean`, `:566` / `:647`
  where `exited` is parsed from `list-panes` records (may be `undefined` when
  zellij omits it — treat only an explicit `false` as "demonstrably live").
- `test/autopilot-worker.test.ts` — existing `isReapCandidate` tests to extend.
- Incident: `~/docs/keeper-incident-2026-06-08-continuity.md`.

## Best practices

- Treat ONLY `exited === false` as "live"; `undefined` is unknown (zellij may
  omit the field) and must NOT block the ghost reap, or the reap stops working.
- Keep the predicate pure and shared between worker + tests (the code already
  insists on this). Never widen reap authority — only narrow it.
