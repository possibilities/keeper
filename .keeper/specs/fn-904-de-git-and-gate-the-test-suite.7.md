## Description

**Size:** M
**Files:** plugins/plan/test/harness.ts, plugins/plan/src/commit_lookup.ts, plugins/plan/src/verbs/reconcile.ts, plugins/plan/src/verbs/worker_resume.ts, plugins/plan/src/verbs/gist.ts

### Approach

Finish de-gitting the plan suite by faking the remaining git READS and the
external-command spawns, then quarantine residuals. Route the in-verb git
reads — `commit_lookup.ts:61` (trailer lookup), `reconcile.ts:138/192/231`
(repo/head/log/blob, source-commit find, state-head visibility),
`worker_resume.ts:33/57` (status/diff/source-sha) — through the same VCS
facade, with a `fakeSourceCommit(repo, messageWithTrailers)` helper to seed
source commits the reads return. Replace `pathShim()`'s executable fake
binaries (`harness.ts:608`) with an external-command driver registry
(command name + argv capture + stdout/stderr/exit) used by `gist.ts`'s `gh`
/ opener spawns. Finally, ensure the DEFAULT `bun test --timeout 30000` in
`plugins/plan` does not compile, spawn the binary, run real git, or execute
shims — any test that exists specifically for those behaviors goes to
`KEEPER_PLAN_RUN_PROCESS` / `KEEPER_PLAN_RUN_SLOW`, or is deleted if speed
wins over the coverage.

### Investigation targets

**Required** (read before coding):
- plugins/plan/src/commit_lookup.ts:61, verbs/reconcile.ts:138/192/231, verbs/worker_resume.ts:33/57 — the in-verb git reads to fake
- plugins/plan/src/verbs/gist.ts:135/178 — the `gh`/open external spawns
- plugins/plan/test/harness.ts:608 (`pathShim`) — the executable-shim mechanism to replace
- plugins/plan/test/harness.ts `SLOW_ENABLED` / `KEEPER_PLAN_RUN_SLOW` — the existing slow-bucket gate to mirror for a process bucket

**Optional** (reference as needed):
- plugins/plan/test/saga-reconcile.test.ts, saga-find-task-commit.test.ts — the heaviest real-git readers (already partly slow-gated)

### Risks

- reconcile / commit-lookup encode real git semantics (trailer parsing,
  source-commit resolution) — synthetic seeding can drift from reality.
  Capture goldens where the semantics matter; accept the drift risk
  (Pantera) and slow-quarantine the few that must stay real.

### Test notes

The acceptance bar is the default `bun test` in `plugins/plan` doing zero
real git / zero binary / zero shim — assert via a hygiene grep + a clean
run with no `dist/` build present.

## Acceptance

- [ ] In-verb git reads (commit_lookup, reconcile, worker_resume) run against the fake VCS / seeded source commits
- [ ] `pathShim` replaced by an external-command registry; gist `gh`/open spawns faked
- [ ] Default `plugins/plan` `bun test` does zero real git, zero binary spawn, zero shim — verified with no `dist/` build present
- [ ] Residual real-process / real-git tests live behind `KEEPER_PLAN_RUN_PROCESS` / `KEEPER_PLAN_RUN_SLOW`

## Done summary
Routed the remaining in-verb git reads (commit_lookup/reconcile/worker_resume) through an extended PlanVcs facade and gist's gh/opener spawns through a new PlanExec facade; replaced the executable PATH shim with an in-memory command-driver registry and seeded source commits/committed task JSON via the fake VCS. Default plugins/plan bun test now spawns zero real git, zero binary, zero shim (verified no dist/), with residual real-git behind KEEPER_PLAN_RUN_SLOW/KEEPER_PLAN_RUN_PROCESS.
## Evidence
