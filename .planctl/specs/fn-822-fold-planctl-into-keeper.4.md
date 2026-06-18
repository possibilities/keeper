## Description

**Size:** S
**Files:** package.json (test scripts), test/plan-contract.test.ts (new), keeper CLAUDE.md test-tier note

### Approach

Make the shared `.planctl/` contract testable in one place — the payoff the whole fold exists for. Add a top-level test invocation that runs keeper's suite and (optionally) the subtree's planctl suite from `plugins/plan/`. Confirm planctl's compiled `promote` still runs unchanged from `plugins/plan/scripts/promote.sh`. Add `test/plan-contract.test.ts`: drive `planctl scaffold` (or the compiled binary) to write a `.planctl/` epic into a sandboxed root, then assert keeper's plan-worker folds it into the `epics` projection — the producer (planctl) and consumer (keeper plan-worker) exercised in one repo, one test.

### Investigation targets

**Required**:
- package.json — `test` (fast, path-ignores) vs `test:full` scripts; where the plan-contract test must land to gate CI
- src/plan-worker.ts — the `.planctl/{epics,tasks,state}` parse + fold contract to assert against
- plugins/plan/scripts/promote.sh — confirm `repo_root` derivation still works from the subtree location

**Optional**:
- test/helpers/sandbox-env.ts, test/helpers/retry-until.ts — sandbox the `.planctl` root; poll the projection, don't sleep

### Risks

- The cross-contract test touches the daemon/worker path → must run under `test:full` (fast tier ignores it), else it doesn't gate CI.
- planctl's auto-commit needs a real git repo; sandbox the contract test's `.planctl` root in its own throwaway repo.

### Test notes

Use `retryUntil` for the fold assertion (the plan-worker is async). Confirm `bun run test:full` is the CI entry for this epic's changes.

## Acceptance

- [ ] a single top-level command runs keeper's suite (and surfaces planctl's suite from `plugins/plan/`)
- [ ] `test/plan-contract.test.ts`: planctl writes a `.planctl/` epic → keeper plan-worker folds it → `epics` projection asserted
- [ ] planctl's compiled `promote` runs unchanged from `plugins/plan/`
- [ ] the contract test gates under `bun run test:full`

## Done summary
Added test/plan-contract.test.ts: drives the real planctl producer (init + scaffold) to write a .planctl epic, then asserts keeper's plan-worker folds it into the epics projection — producer and consumer in one repo. Gated under test:full (fast tier path-ignores it); promote runs unchanged from plugins/plan/.
## Evidence
