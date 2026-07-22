## Description

**Size:** M
**Files:** .github/workflows/ci.yml, package.json, bun.lock, plugins/plan/package.json, plugins/prompt/package.json, docs/testing.md, docs/problem-codes.md

### Approach

Pin the repository and package manifests to Bun 1.3.14, retain the full Ubuntu correctness gate, and add a focused native-lock compatibility job on pinned Ubuntu 24.04 and macOS ARM. The smoke asserts OS, architecture, and Bun version, runs explicit lock test files through a named package command with bounded repetition and a hard job timeout, and has no test or workflow retry. Document the deterministic proof versus native-smoke roles and register distinct machine-facing timeout/inconclusive outcomes with safe recovery guidance.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `.github/workflows/ci.yml:18` — current Ubuntu-only SHA-pinned workflow and full gate.
- `package.json:6` — root Bun runtime pins and script owner.
- `plugins/plan/package.json:21` — Plan engine pin.
- `plugins/prompt/package.json:18` — Prompt engine pin.
- `docs/testing.md:1` — named gates and deterministic proof policy.
- `docs/problem-codes.md:428` — Plan mutation retry codes.
- `docs/problem-codes.md:576` — commit-work lock timeout registry row.

**Optional** (reference as needed):
- `scripts/test-entrypoint.ts:3` — direct explicit-test invocation guard and Bun compatibility note.
- `scripts/test-manifest.ts:20` — package test classification owner.
- `docs/adr/0057-named-fast-gate-and-deterministic-proof-policy.md` — correctness-versus-compatibility proof boundary.

### Risks

A mutable or Intel macOS label would claim coverage without exercising the production ARM ABI, while broad macOS full-suite execution would add cost without improving this boundary's proof. Repetition can amplify wall-clock tests into flakes, so the smoke must select deterministic safety assertions and avoid exact errno/timing claims. Changing the supported Bun runtime requires all manifests and lock metadata to remain consistent.

### Test notes

The focused command should include root canonical/general/commit-work/single-instance suites and the Plan package flock suite, repeat each a bounded 25 times, and fail on the first unsafe or unexpected iteration without automatic retry. CI must fail rather than skip when the runner architecture or Bun version differs from the declared matrix.

### Detailed phases

1. Align root and package-local Bun pins and regenerate only required lock metadata.
2. Add the named focused smoke and pinned Linux/macOS ARM matrix with architecture/runtime assertions and hard timeout.
3. Update testing and problem-code documentation, then run full and focused gates.

### Alternatives

Running the full repository suite on macOS is rejected as disproportionate; the Ubuntu full gate remains authoritative for deterministic correctness. Workflow-level retry and Bun-version dual testing are rejected because they hide failures or preserve an unsupported runtime rather than proving the application contract.

### Non-functional targets

Keep the focused cross-platform job under ten minutes, use least-privilege read-only workflow permissions and SHA-pinned actions, avoid host-wide state, and preserve `.keeper/**` path-ignore behavior. No failure retry may turn a red lock iteration green.

### Rollout

Enable the smoke in the same change as the runtime pin and docs so the newly supported runtime is qualified immediately. If runner availability becomes an operational issue, disable only the compatibility job temporarily; retain the deterministic fault matrix and return-authoritative implementation.

## Acceptance

- [ ] Root, Plan, and Prompt manifests consistently require Bun 1.3.14 and dependency metadata is reproducible.
- [ ] CI retains the full Ubuntu repository gate and adds a focused matrix that positively asserts Ubuntu x64 and macOS ARM runner identities plus the exact Bun runtime.
- [ ] The focused lock smoke repeats the native boundary 25 times under a hard timeout with no test-level or workflow-level retry.
- [ ] Native smoke accepts safe non-acquisition without requiring a fragile errno value, while deterministic tests remain the exhaustive classification proof.
- [ ] Timeout and inconclusive lock outcomes have distinct documented meanings, recovery steps, and retry-safety guidance for root and Plan commands.

## Done summary

## Evidence
