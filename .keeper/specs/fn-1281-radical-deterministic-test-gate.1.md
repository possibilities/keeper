## Description

**Size:** M
**Files:** package.json, bunfig.toml, plugins/plan/package.json, plugins/plan/bunfig.toml, plugins/prompt/package.json, plugins/prompt/bunfig.toml, scripts/test-entrypoint.ts, scripts/test-gate.ts, test/test-gate.test.ts, plugins/keeper/plugin/hooks/wrapped-guard.ts, plugins/keeper/plugin/hooks/escalation-guard.ts, test/wrapped-guard.test.ts, test/escalation-guard.test.ts

### Approach

Establish `test:gate` as the explicit root fast-phase contract and make each package's aggregate scripts delegate to named gates rather than raw discovery. Register a synchronous, side-effect-free Bun preload in root, plan, and prompt that rejects any direct invocation lacking both sanctioned aggregate posture and explicit `*.test.ts` paths; consume and clear any aggregate marker before test code can inherit it. Reconcile the wrapped/escalation quote-aware command classifiers so bare/broad `bun test` is denied while explicit files and named `bun run` gates remain allowed.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- package.json:18-21 — current root/OpenTUI/full command topology
- scripts/test-gate.ts:31-68,188-220 — argument injection and child environment
- test/test-gate.test.ts:17-76 — pure gate argument contract
- plugins/plan/bunfig.toml:1-4 — existing package test preload that must retain matrix setup
- plugins/keeper/plugin/hooks/wrapped-guard.ts:482-569 — quote-aware Bun command classification
- plugins/keeper/plugin/hooks/escalation-guard.ts:572-678 — role-aware Bun allowlist

**Optional** (reference as needed):
- test/live-shell.test.ts:9-40 — why OpenTUI cannot join isolated parallel execution
- node_modules/bun-types/docs/runtime/bunfig.mdx — pinned Bun preload contract

### Risks

Bun coordinator and worker argv shapes may differ; prove both before selecting the marker/classifier shape. The guard is ergonomic, not hostile-input security. Plan's host-matrix preload must remain ordered and effective.

### Test notes

Add table tests for root/package cwd, wrappers, multiple explicit files, and broad/name/watch/coverage forms. Run one manual executable smoke proving bare rejection occurs before any test file loads; do not add a recursive suite-spawn test to the fast gate.

### Detailed phases

1. Add named scripts without changing membership.
2. Implement and pin pure invocation classification.
3. Register package-local preloads and preserve plan matrix setup.
4. Align agent command guards and their fixtures.
5. Smoke pinned Bun behavior from each package cwd.

### Alternatives

Exact-two-token rejection was rejected because `bun test --timeout=...` is still accidental aggregate discovery. Shell aliases were rejected because agents and CI do not share a host shell configuration.

### Non-functional targets

Rejection adds no filesystem, DB, network, renderer, subprocess, timer, or lock work and prints one actionable line.

### Rollout

Keep the existing aggregate behavior behind the new names until task 2 migrates automation consumers.

## Acceptance

- [ ] Root, plan, and prompt expose stable named fast gates and existing sanctioned aggregate commands delegate to them.
- [ ] Direct Bun discovery without explicit `*.test.ts` files fails before tests load and names the correct aggregate replacement.
- [ ] Explicit test files remain runnable from the correct package cwd, including multiple files and file-scoped name filters.
- [ ] Wrapped and escalation guards deny bare/broad discovery but allow named gates and explicit targeted tests.
- [ ] Plan's host-matrix preload and the root OpenTUI split remain intact.

## Done summary
Established bun run test:gate as the stable root fast-phase contract with plan/prompt package scripts delegating to their own named gates; a shared scripts/test-entrypoint.ts sentinel wired via each package's bunfig.toml rejects direct aggregate bun test discovery before any test loads while explicit *.test.ts targets remain runnable, and the wrapped/escalation Bash guards were reconciled to deny bare/broad discovery while allowing named gates and explicit targeted tests.
## Evidence
