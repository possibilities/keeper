## Description

**Size:** M
**Files:** plugins/plan/src/{emit,invocation,commit,cli}.ts + verbs, src/{reducer,types,derivers}.ts, src/plan-worker.ts + src/git-worker, test/**

### Approach

Rename the stdout envelope key `planctl_invocation` → `plan_invocation` on BOTH sides together: the CLI emit (`plugins/plan/src/emit.ts`/`invocation.ts`) and the reducer/types/derivers that parse it. Rename the internal event type `planctl-commit-changed` → `plan-commit-changed` (git-worker emit + plan-worker/reducer consume). Rename `isVendoredPlanctlPath` → `isVendoredPlanPath`. These are name-only contract renames — no behavior change — but emit and consume MUST land in one commit so a worker's envelope is always parseable.

### Investigation targets

**Required**:
- plugins/plan/src/emit.ts + invocation.ts — the envelope producer
- src/reducer.ts, src/types.ts, src/derivers.ts — the envelope consumer (`planctl_invocation`)
- src/plan-worker.ts — `planctl-commit-changed` + `isVendoredPlanctlPath`
- the git-worker that emits `planctl-commit-changed`

### Risks

- Producer/consumer must rename together — a half-rename makes every plan verb's envelope unparseable. One commit.
- The conformance test (epic 1) asserts the trailer key — update it to `plan_invocation`.

### Test notes

`bun run test:full`. Confirm a `keeper plan` verb emits `plan_invocation` and the reducer folds it; `rg -n "planctl_invocation|planctl-commit-changed|isVendoredPlanctlPath"` returns 0.

## Acceptance

- [ ] `plan_invocation` on emit + consume, renamed in one commit; conformance test updated
- [ ] `plan-commit-changed` event end to end; `isVendoredPlanPath` renamed
- [ ] `rg` for the old names returns 0; `bun run test:full` green

## Done summary

## Evidence
