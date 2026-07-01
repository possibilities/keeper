## Overview

Autopilot worktree mode today HARD-REJECTS any epic whose tasks resolve to more than one git
toplevel (the `worktree-multi-repo` reject at `src/autopilot-worker.ts:2221`). This epic lets such
an epic run: the PRODUCER partitions the epic's tasks by their RESOLVED git toplevel into per-repo
lane "groups", derives worktree geometry (base branch + ribs + `__close__` sink) INDEPENDENTLY per
group via the existing `deriveWorktreePlan`, keeps ONE plan-close (audit + `status:done`) on
`primary_repo`, and does N per-repo code finalizes. The epic stays a single plan unit (one
`.keeper/` file, one epic row). It is a producer-side generalization only — NO write-path change
(no new RPC/event, no synthetic epics, no fold change) — gated behind a rollout flag defaulting to
today's reject.

## Quick commands

- `bun test test/autopilot-worker.test.ts test/worktree-plan.test.ts test/lane-merged-fold.test.ts`
- `bun test test/schema-version.test.ts`   # SCHEMA_VERSION ↔ SUPPORTED_SCHEMA_VERSIONS parity
- `bun scripts/lint-claude-md.ts`           # CLAUDE.md size gate stays green

## Acceptance

- [ ] With the rollout flag ON, an epic whose tasks span 2 git toplevels provisions per-repo lane groups (base + ribs per repo), instead of a `worktree-multi-repo` reject
- [ ] Each repo's lanes fan into that repo's base and finalize into that repo's LOCAL default independently; the single plan-close runs on `primary_repo` only and gates all finalizes
- [ ] Cross-repo task deps act as pure serialization barriers (no lane-share), enforced by readiness's global `taskById` with zero new code there
- [ ] Per-repo finalize failures land on distinct `close::worktree-finalize:<epic>-<repoHash>` sticky rows — no collision with recover rows or each other — level-cleared when that repo finalizes clean
- [ ] The cross-epic merge-gate defers only the group whose repo has an unmerged same-resolved-repo upstream; a group whose repo has no matching upstream proceeds
- [ ] `await landed` fires only after EVERY group has landed (worktree groups merged to default + serial groups' tasks done)
- [ ] Flag OFF preserves today's exact behavior: single-repo epics byte-identical, `>1` toplevel still rejected
- [ ] Whole-epic reject precedence preserved: any task with a null/unresolvable root → whole-epic `unresolved`; `no-primary-repo` stays whole-epic
- [ ] Re-fold determinism + producer-only invariants intact; a `SCHEMA_VERSION` bump (if any) is paired with `SUPPORTED_SCHEMA_VERSIONS` in `keeper/api.py`

## Early proof point

Task that proves the approach: task `.1` (foundation). If it fails: the clustered classification /
per-group geometry doesn't cleanly reuse `deriveWorktreePlan` — re-read `worktree-plan.ts:224` to
confirm the in-group parent filter drops cross-repo edges, and reconsider whether grouping belongs
in `prepareWorktreeGeometry` vs a new seam feeding it.

## References

- `src/autopilot-worker.ts` (classify/geometry/finalize/merge-gate/landed), `src/worktree-plan.ts`, `src/worktree-git.ts`, `src/reducer.ts`, `src/db.ts`, `src/readiness.ts`, `src/readiness-client.ts`, `src/await-conditions.ts`
- Cross-repo atomicity is industry-normal-to-lack: Gerrit topics ("submission could fail, partial topic submission"), Fuchsia dependent-changes — no tool provides cross-repo atomic landing

## Docs gaps

- **README.md** `## Architecture` worktree section (~3435-3597): lane geometry → per-repo groups; DELETE the "v1 multi-repo unsupported" caveat; merge-gate → per-(epic,repoDir); `await landed` all-groups semantics (also ~1524-1527)
- **CLAUDE.md** "Worktree mode is PRODUCER-ONLY" bullet (~line 119): revise merge-gate sub-clause to per-(epic,repoDir), the `worktree-recover*` scope clause for per-repo keying, add a rollout-flag note — prune, do not append
- **plugins/plan/skills/plan/SKILL.md** (~577) + **hack/SKILL.md** (~205,212): qualify "A's finalize merge" as the per-repo slice B shares with A
- **plugins/plan/CLAUDE.md** (~55-56): add any new worktree-lifecycle slow-tier test block name

## Best practices

- **Half-landed is the normal operating state, not an error:** no tool (Gerrit topics, GitHub merge queue, repo/Bazel) gives cross-repo atomic landing — each repo's finalize is an independent success/failure [practice-scout]
- **Gate downstream same-repo branch cuts on the upstream merge landing on LOCAL default, not on task completion** (merge-inversion hazard) — this is exactly keeper's existing merge-gate [practice-scout]
- **Fan-in merge stays a true `--no-ff --no-edit`; teardown is ancestor-gated; never force-push default; remove the worktree before deleting its branch** [practice-scout]
- **Track per-repo finalize/landed state keyed by (epic, repo_toplevel)**, never reconstruct from git log alone [practice-scout]

## Architecture

One epic → N per-repo groups (partition of `epic.tasks` by resolved git toplevel). Per group:
a base branch `keeper/epic/<id>` + per-forked-task ribs + a `__close__` fan-in sink, all in that
group's own git, derived by `deriveWorktreePlan(epicId, group.repoDir, group.tasks)` unchanged.
Cross-repo `depends_on` edges are auto-dropped from lane geometry (`worktree-plan.ts:224`) and
survive only as readiness serialization barriers. The PRIMARY group additionally dispatches the
single close WORKER (audit + `status:done` to `primary_repo`); every group's `__close__` sink lane
is provisioned by the producer (the rib→base fan-in is producer-side git, not the worker). The
primary close gates ALL groups' finalizes (code must not land to any default before the epic passes
audit); after it succeeds, `finalizeEpic` runs per group INDEPENDENTLY (a stuck group never freezes
a sibling). All of this is PRODUCER-ONLY, re-derived each cycle — never folded.

## Rollout

- Ships behind an `autopilot_state` flag via the generic `set_autopilot_config` RPC (no new RPC),
  DEFAULT OFF = today's `>1` reject. Tests exercise the ON path explicitly via sandboxed
  `autopilot_state`.
- Flipping the default ON is a deliberate operator action after burn-in — OUT OF SCOPE for this
  epic, documented in the worktree section.
- Half-landed epic = a DOCUMENTED stuck-state: the operator retries the failed repo via
  `retry_dispatch` against its per-repo `close::worktree-finalize:<epic>-<repoHash>` row. NOT an
  atomic all-or-nothing gate.
