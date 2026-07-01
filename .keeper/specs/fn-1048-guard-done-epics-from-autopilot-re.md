## Overview

keeper's autopilot reconciler re-dispatches finished plan epics because the
readiness gate that decides "does this task need a worker"
(`isTaskTerminalCompleted`) keys only on a per-task `worker_phase === "done"`
flag, not on the parent epic's terminal `status:done`. An epic closed without
stamping that per-task flag (legacy imports, or a `keeper plan epic close
--force`) therefore looks like unfinished work; a recency window re-feeds it
into the reconcile snapshot and each dispatch refreshes that window,
sustaining the loop. This work makes a `status:done` epic ABSORBING in the
readiness pipeline — any of its tasks resolves `{tag:"completed"}` — so the
reconciler never re-dispatches work against a finished epic. No data
migration: the guard neutralizes every done epic (all board epics are
`status:done`), leaving legacy snapshots dormant in the projection.

## Quick commands

- `bun test test/readiness.test.ts` — guard + fn-671 regression tests green
- `keeper status` — after deploy, no `work::` re-dispatch for a done epic

## Acceptance

- [ ] A `status:done` epic never yields a `work::` dispatch for any of its tasks (the re-dispatch loop is dead)
- [ ] The fn-671 liveness / per-root-mutex invariant is preserved (a live worker on a done-epic task still holds the root)
- [ ] The readiness predicate taxonomy and the README architecture prose document the "done epic is terminal" invariant

## Early proof point

Task that proves the approach: `.1` — the readiness guard plus its focused
test. If it fails (e.g. an fn-671 test regresses): keep the change to a single
OR-clause on the existing gate condition (`worker_phase === "done" ||
ownEpic.status === "done"`) reusing the liveness clauses verbatim, rather than
a new standalone predicate.

## References

- fn-671 liveness-precedence tests (`test/readiness.test.ts:301/400/420/501/521`) — the per-root-mutex invariant this change must preserve
- Kubernetes reconciler terminal-state no-op / absorbing-state pattern: the authoritative parent status gates work; the subordinate per-task flag does not

## Docs gaps

- **src/readiness.ts (header predicate taxonomy, lines 1-49)**: add a rank entry for the epic-done terminal case in the aligned numbered-rank format; keep the "RANK ORDER IS LOAD-BEARING" warning intact
- **README.md (## Architecture readiness prose, ~line 928)**: revise the existing paragraph to add the sibling invariant "a task whose epic is `status:done` reads `completed`, so the reconciler never re-dispatches work against a finished epic" — revise in place, no standalone paragraph, no fn-ids/dates
- **CLAUDE.md (## Autopilot bullet)**: OPTIONAL one short sentence stating the invariant; skip if it bloats the bullet (lint gate `bun scripts/lint-claude-md.ts`)

## Best practices

- **Terminal state must be absorbing at the READ path**: the reconciler's "needs work" predicate must short-circuit to `completed` for a done epic before any side-effect; a subordinate per-task flag is not absorbing on its own (Kubernetes reconciler no-op pattern)
