## Description

**Size:** M
**Files:** package.json, scripts/test-gate.ts, scripts/test-default.ts, scripts/test-full.ts, scripts/test-manifest.ts, scripts/lint-fast-tests.ts, test/test-gate.test.ts, test/test-full.test.ts, test/test-manifest.test.ts, test/lint-fast-tests.test.ts

### Approach

Make phase membership and package coverage explicit and fail closed: every discovered test file maps to exactly one fast phase, OpenTUI file, or non-correctness diagnostic/benchmark class; no slow correctness class exists. Give the default root runner ownership of the root and serial OpenTUI phases, preserve the full runner's root→plan→prompt package coverage, and emit machine-readable monotonic per-stage/total timings. Add a cheap syntax-aware policy lint that rejects fixed sleeps, real process/git/tmux/daemon launches, large scoped timeouts, production-scale fixtures, and direct full migration in fast tests except reviewed semantic allowlists.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- scripts/test-full.ts:3-32,70-175,177-269 — package plan, env ownership, process groups, timeout, and reporting
- scripts/test-gate.ts:31-68,80-220 — root cap/orphan contract
- test/test-full.test.ts:20-92 — suite coverage/order and slow-env pins
- test/live-shell.test.ts:9-40 — serial non-isolated OpenTUI constraint
- test/helpers/sandbox-env.ts:73-148 — state classes fast tests must isolate

**Optional** (reference as needed):
- docs/adr/0057-named-fast-gate-and-deterministic-proof-policy.md — accepted objectives and hard ceilings
- Bun JUnit/configuration docs — timing artifact capabilities

### Risks

A static manifest can drift while dynamic discovery can silently include forbidden files; structural classification must detect both omission and overlap. Shared-host timing is noisy, so only explicit reference enforcement may fail on performance. A policy lint must parse enough structure to avoid becoming another brittle repo-wide grep.

### Test notes

Test stage plans, zero-discovery, missing file/package, duplicate classification, timing boundary equality, warning/enforced modes, signal/timeout, cleanup failure, and unsupported reference environment through injected runners and clocks.

### Detailed phases

1. Define phase/package manifest and exhaustive classification audit.
2. Add default root orchestration with OpenTUI report-all semantics.
3. Emit stable JSON/JUnit timing artifacts and human summaries.
4. Implement objective/hard budget policy with qualified reference posture.
5. Add structural fast-tier dependency lint and narrow allowlists.

### Alternatives

Loose path substring filters were rejected because they can select unrelated files. Universal hard timing was rejected because contention is not a correctness regression.

### Non-functional targets

Objectives: 10s gate, 12s default, 20s full. Enforced ceilings: 15s, 18s, 30s. Runner overhead outside Bun execution remains negligible and all outputs are size-bounded.

### Rollout

Ship timing in report-only mode. Enable reference enforcement only after ten qualified samples demonstrate P95 at or below each objective.

## Acceptance

- [ ] Every root, plan, prompt, and OpenTUI correctness file belongs to exactly one required phase and omission/overlap/zero discovery fails closed.
- [ ] `bun run test` reports both root and OpenTUI outcomes; `test:full` reports root, plan, and prompt outcomes with bounded process cleanup.
- [ ] Timings are monotonic, machine-readable, and distinguish objectives, hard ceilings, hang deadlines, and unqualified hosts.
- [ ] Reference enforcement applies 15s/18s/30s hard ceilings while ordinary shared runs only warn.
- [ ] The policy lint prevents reintroduction of forbidden slow-test dependencies without an explicit semantic allowlist.

## Done summary
Added an exhaustive phase/package test manifest with fail-closed classification, default root+OpenTUI orchestration, full root/plan/prompt suite reporting, monotonic JSON/JUnit timing artifacts with objective/hard-ceiling budgets, and a syntax-aware fast-test dependency policy lint with a reviewed allowlist.
## Evidence
