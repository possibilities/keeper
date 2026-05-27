## Overview

Add a pure-function readiness predicate that mechanically blocks worker-task and close-row approvals when the worker's worktree has uncommitted dirty files or the project has orphan files. Lifts the inferred git check out of the /plan:approve skill (which used an LLM-as-judge cascade) into keeper's deterministic readiness pipeline so the autopilot dispatcher never opens a /plan:approve Ghostty window for a job whose git state would just trigger a rejection downstream. Two new `BlockReason` kinds (`git-uncommitted`, `git-orphans`) surface as `[blocked:git-*]` pills on board.ts via the existing `blocked:*` warn-bucket colorizer fallback.

## Quick commands

- `bun test test/readiness.test.ts test/reducer.test.ts`
- `cd /Users/mike/code/arthack && bun test apps/planctl/skills/approve/scripts/render-context.test.ts`
- Smoke: with a dirty file in keeper's worktree, `bun scripts/board.ts` shows `[blocked:git-uncommitted]` on any task whose latest worker job touched the repo; autopilot's `[dry]` mode logs no approve-dispatch for that row.

## Acceptance

- [ ] Mechanical `git-uncommitted` / `git-orphans` gate blocks autopilot's `/plan:approve` dispatch for worker-tasks (gate in `evaluateTask`) and close rows (gate in `evaluateCloseRow`) whose latest worker left dirty files or whose project has orphans.
- [ ] /plan:approve skill cascade trimmed from four rules to two (Rule 0 keeperd-unavailable + Rule 1 needs-human, formerly Rule 3). render-context.ts no longer queries `git_status`.
- [ ] Re-fold determinism preserved: rewind cursor + `DELETE FROM jobs` + redrain reproduces byte-identical row JSON including the two new columns.
- [ ] `bun test` passes in both repos with no regressions in existing predicate-ordering or reducer fan-out tests.

## Early proof point

Task that proves the approach: `<epic_id>.1`. If it fails: the keeper-side mechanical gate isn't viable as specified — most likely the `syncJobIntoEpic` blast radius is wider than the brief assumes, or the `GitRootDropped` enumeration strategy needs rethinking. Skill trim (task .2) is reactive to whatever shape .1 lands in.

## References

- keeper/CLAUDE.md "Event-sourcing invariants" — the BEGIN IMMEDIATE rule the new fan-out must respect.
- keeper/src/readiness.ts module docstring — the canonical predicate-ordering spec; insertion point between predicate 6 (sub-agent-running) and predicate 7 (own-approval-pending) mirrors the predicate-7 race rationale at lines 267-279.
- arthack/apps/planctl/skills/approve/SKILL.md — the four-rule cascade the trim collapses to two.

## Docs gaps

- **/Users/mike/code/keeper/CLAUDE.md** (Event-sourcing invariants): weave the GitSnapshot → jobs fan-out into the existing enumeration sentence as a fourth fan-out path alongside `syncJobIntoEpic` / `syncPlanctlLinks` / `syncJobLinksOnJobWrite`.
- **/Users/mike/code/keeper/src/readiness.ts** (module docstring): bump "twelve ordered checks" to the new count and insert the two new predicate entries; add JSDoc glosses for the two new `BlockReason` kinds.
- **/Users/mike/code/keeper/src/db.ts** (v27 migration step): multi-paragraph comment per the v24/v25 precedent style explaining the new columns, the lockstep with `CREATE_JOBS`, and the migration semantics.
- **/Users/mike/code/keeper/src/reducer.ts** (GitSnapshot arm): inline comment documenting the new fan-out and the same-transaction invariant.
- **/Users/mike/code/arthack/apps/planctl/skills/approve/SKILL.md** + **scripts/render-context.ts** docstrings: "Four-rule cascade" → "Two-rule cascade"; front-matter description trim.

## Best practices

- **Denormalize counts into the projection when the count is a predicate input, not a display label.** Once a readiness predicate branches on a value, that value belongs on the projection row, not in a joined table. [practice-scout, verified against keeper's existing `last_validated_at` and `job_links` denormalization patterns]
- **Place the gate AFTER session-running predicates (5/6) and BEFORE approval-pending (7).** Same race rationale as predicate 7's own comment: `worker_phase==="done"` can race ahead of Stop/SessionEnd, so the gate must wait until the session is actually idle before evaluating git state. Otherwise a stale dirty-tree reading fires during the worker's mid-yield Stop and the pill flaps. [practice-scout]
- **Watch for thrashing.** Gate fire/clear oscillation during active human editing could trigger duplicate dispatches if downstream wasn't idempotent. autopilot's `dispatchedKeys` re-dispatch guard already suppresses duplicates within and across runs, so the oscillation is benign for the dispatch surface — but worth a smoke test against a tight `git checkout`/`git stash` loop before declaring done. [practice-scout]
- **Start payload-less; add count/path payload later only when a consumer branch-matches on it.** Day-1 lock to `{kind: "git-uncommitted"}` / `{kind: "git-orphans"}` matches the existing payload-less `job-running`/`sub-agent-running` shape; richer payload waits for a use case (e.g. board.ts wanting to render `[blocked:git-uncommitted (3)]`). [practice-scout, brief-confirmed]
- **Deferred future work** — practice-scout flagged but brief deferred: (a) a `git_snapshot_at` column on `jobs` to distinguish "confirmed clean N seconds ago" from "never sampled" (would require threading `now` into `computeReadiness` and breaking its pure-function signature; defer until staleness false-passes surface in practice); (b) a per-task/per-epic override flag for false-positive blocks (existing escapes — `git commit`, direct `planctl approve` — cover the case for day 1).
