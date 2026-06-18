## Overview

Switch the data-dir convention from `.planctl/` to `.keeper/` in the plan CLI and keeper's plan-worker, with a TRANSIENT `.planctl/` read-fallback so existing boards (still on `.planctl/` until the flag-day epic) stay readable — and so autopilot's board never goes dark across the rename. New writes go to `.keeper/`. Also renames `PLANCTL_*` env → `KEEPER_PLAN_*`, the auto-commit lock `planctl-commit.lock` → `plan-commit.lock`, and the commit prefix `chore(planctl):` → `chore(plan):`. The fallback is removed in the final epic once every repo has migrated.

## Quick commands

- `cd /tmp/x && git init && keeper plan init && ls -la` — a fresh project gets `.keeper/`, not `.planctl/`
- `keeper plan status` in a repo still on `.planctl/` — still resolves (fallback)
- `bun run test:full`

## Acceptance

- [ ] the plan CLI reads `.keeper/` (primary) then `.planctl/` (transient fallback); writes/init create `.keeper/`
- [ ] keeper's plan-worker watches/folds BOTH `.keeper/{epics,tasks,state}` and `.planctl/…` during the migration window
- [ ] `PLANCTL_*` env → `KEEPER_PLAN_*`; `plan-commit.lock`; `chore(plan):` commit subject
- [ ] `bun run test:full` green; a repo on either dir name resolves

## Early proof point

Task `.1` (CLI). If the walk-up resolution gets ambiguous when BOTH dirs exist in one tree, prefer `.keeper/` deterministically and ignore `.planctl/` when `.keeper/` is present at the same root.

## References

- `.planctl` literals: `plugins/plan/src/{store,discovery}.ts` + others (bare string, not a constant — introduce `DATA_DIR`).
- plan-worker watch: `src/plan-worker.ts` (`.planctl/{epics,tasks}`, `isVendoredPlanPath`).

## Rollout

Autopilotable as CODE. SUPERVISED DAEMON-RESTART CHECKPOINT after this epic so the plan-worker re-watches `.keeper/` before the flag-day epic renames any dir. The CLI half is live-from-source (effective immediately); the plan-worker half needs the bounce.
