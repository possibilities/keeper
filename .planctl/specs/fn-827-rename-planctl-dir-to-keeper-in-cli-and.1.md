## Description

**Size:** M
**Files:** plugins/plan/src/{store,discovery,state_path}.ts + every `.planctl` literal site, env/lock/commit-prefix sites

### Approach

Introduce a `DATA_DIR = ".keeper"` constant (+ `LEGACY_DATA_DIR = ".planctl"`). Replace every bare `.planctl` literal in the plan CLI with resolution that prefers `.keeper/` and falls back to `.planctl/` for reads/walk-up; `init` and all writes use `.keeper/`. When both exist at one root, `.keeper/` wins deterministically. Rename `PLANCTL_*` env reads → `KEEPER_PLAN_*`, `planctl-commit.lock` → `plan-commit.lock`, `chore(planctl):` → `chore(plan):`.

### Investigation targets

**Required**:
- plugins/plan/src/store.ts:201-231 (walk-up to `.planctl/`), :327 (lock path)
- plugins/plan/src/discovery.ts:57,81,146,228,261,289 (`.planctl` join sites)
- plugins/plan/src/commit.ts (`chore(planctl):`, `planctl-commit.lock`), the `PLANCTL_*` env reads

### Risks

- Bare literal scattered widely — a missed site silently reads the wrong dir. Grep `rg -n '\.planctl' plugins/plan/src` to 0 (except the legacy-fallback constant).
- Deterministic precedence when both dirs exist (agent worktrees, mid-migration).

### Test notes

`bun run test:full`. A fixture repo with only `.planctl/` resolves (fallback); a fresh `init` creates `.keeper/`; one with both prefers `.keeper/`.

## Acceptance

- [ ] `DATA_DIR=.keeper` with transient `.planctl` read-fallback; writes/init use `.keeper/`; precedence deterministic
- [ ] `KEEPER_PLAN_*` env, `plan-commit.lock`, `chore(plan):`; `rg '\.planctl' plugins/plan/src` only the legacy constant
- [ ] `bun run test:full` green

## Done summary

## Evidence
