## Description

**Size:** M
**Files:** src/agent/launch-config.ts, src/agent/main.ts, src/agent/args.ts, src/agent/dispatch.ts, cli/descriptor.ts, scripts/install.sh, package.json, test/agent-account-routing.test.ts, test/agent-pi.test.ts, test/install.test.ts, README.md, docs/install.md, docs/problem-codes.md, docs/plugin-composition-map.md, docs/testing.md

### Approach

Install and load the repository-owned companion only for tracked `keeper agent pi` processes, preserving the existing node-only Keeper extension as a separate `-e` source island. Thread the initial sanitized routing/fallback context into Pi without credentials, expose a read-only diagnostic that reports Claude and Codex account health without conflating their route types, and keep non-Codex models and standalone Pi byte-neutral. Package absence, incompatibility, and stale state produce bounded problem codes and a visible native Codex fallback rather than a silent balancing claim.

Expose one versioned operator workflow whose landed commands cover interactive alias enrollment, read-only pool/proof status, bounded live-proof capture, pure verdict/sanitation, activation, immediate verification, rollback, and recovery-required status. Enrollment never runs under captured stdout/stderr. Activation accepts only a fresh passing report bound to the current code revision, configuration, host-local opaque alias set, and restored healthy state; it atomically refuses stale/incomplete/failed/unknown/unsanitized evidence and rolls back when reload or immediate verification fails. Runtime pool failures after activation still follow ADR 0090's visible native fail-open policy—the activation gate itself remains fail-closed.

Update installer verification to pin the companion manifest/source contract and keep the live pi-subagents checkout on its integration lineage. Do not switch that checkout to a clean upstream proposal branch; any new pi-subagents issue/PR remains separately owned and watched by `pi-subagents-fork-upstream-sync`. Consolidate current-state docs around setup, privacy, retry cutoff, root/child inheritance, diagnostics, proof/activation commands, testing, rollback, and the separate live activation gate.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/agent/launch-config.ts:488` — current existence-gated Pi extension arming.
- `src/agent/main.ts:2386` — read-only account routing diagnostic.
- `src/agent/main.ts:3094` — current Pi single-account boundary.
- `src/agent/dispatch.ts:421` — `accounts check` command dispatch.
- `scripts/install.sh:85` — local Pi package provisioning and duplicate-source removal.
- `scripts/install.sh:139` — live pi-subagents branch/sync/contract checks.
- `test/agent-account-routing.test.ts:332` — Pi currently bypasses Claude routing.
- `test/agent-pi.test.ts:133` — tracked Pi `-e` extension argument tests.
- `integrations/pi-codex-pool/src/proof.ts` — task 1's landed proof/report authority; verify after the dependency task lands.

**Optional** (reference as needed):
- `docs/plugin-composition-map.md` — current tracked-Pi composition map.
- `/Users/mike/docs/pi-codex-provider-routing-proof.md` — proof evidence; do not copy scratch paths into user docs.
- `docs/adr/0090-keeper-managed-pi-codex-account-pool.md` — current ownership, activation, and fallback contract.

### Risks

- Pi's extension loader fails open; launcher and runtime diagnostics must not claim pooling when the companion failed to register.
- Installer source-marker drift can either reject a valid package or allow an incompatible Pi/pi-subagents combination.
- Reusing Claude's `Account route` attribution would misstate a process that can change Codex aliases during its lifetime.
- A stale report or non-atomic reload can leave reported and effective activation state inconsistent.
- Documentation can accidentally promise live activation before the dependent proof completes.

### Test notes

Pin exact Pi argv/environment behavior for Codex and non-Codex models, companion present/missing/incompatible cases, native fallback, read-only diagnostics without pressure, standalone absence, and installed-source markers. Pure operator-workflow tests use fake proof reports and injected config/reload seams to cover fresh pass, every refusal class, concurrent activation, interruption, rollback, and recovery-required outcomes. Keep all correctness tests sandboxed; never read the developer's real Pi auth or Codex usage.

### Detailed phases

1. Provision and verify the companion package without changing standalone Pi.
2. Add tracked-launch arming, route/fallback context, and read-only diagnostics.
3. Add versioned enrollment, proof/status, activation, verification, rollback, and recovery command contracts.
4. Add problem codes and compatibility gates across Pi and pi-subagents revisions.
5. Consolidate installation, composition, testing, privacy, and rollout docs.

### Alternatives

Fold the implementation into `plugins/keeper/pi-extension/keeper-events.ts` — rejected because that source island intentionally remains node-only and fail-open. Install the companion globally — rejected because standalone Pi must remain outside Keeper policy. Let the live task mutate config directly — rejected because activation must consume a tested report contract through one atomic seam.

### Non-functional targets

Launch argv stays array-built and shell-free; diagnostics and proof reports are bounded and PII-free; package loading adds no secrets to pane environments; installer checks are idempotent and do not mutate clean upstream PR branches.

### Rollout

Land with native fallback and a visible activation-pending status. The dependent live-proof epic enrolls the second account and invokes the landed workflow; removing the companion `-e` path or running the rollback command restores native behavior.

## Acceptance

- [ ] `keeper agent pi` loads the companion and tracked Keeper extension as separate explicit sources, while standalone Pi, non-Codex models, metadata commands, and package commands retain their current behavior.
- [ ] Missing, incompatible, or unhealthy pool machinery emits a bounded sanitized diagnostic and visibly falls back to native `openai-codex` without claiming a balanced route.
- [ ] A read-only account diagnostic reports separate Claude launch-routing and Codex session-routing health without creating pressure, exposing PII, or reading raw credentials.
- [ ] Versioned operator commands expose interactive enrollment plus noninteractive status, proof capture/verdict, activation, immediate verification, rollback, and recovery; activation accepts only a fresh passing report bound to unchanged revision/config/aliases and is atomic against interruption or concurrent mutation.
- [ ] Failed activation, reload, or immediate verification leaves native behavior authoritative and returns an explicit rollback-complete or recovery-required state rather than an ambiguous active status.
- [ ] Installation pins and verifies the companion plus required Pi/pi-subagents contracts idempotently while leaving clean upstream proposal branches separate from the live integration checkout.
- [ ] README, install, problem-code, composition, and testing docs state current setup, privacy, root/child coverage, retry cutoff, fallback, proof/activation workflow, and rollback without copying scratch-history prose.
- [ ] Named launcher, installer, package, proof, and account-routing gates pass entirely against sandboxed state.

## Done summary
Arm proof-gated Pi Codex account pooling: tracked keeper agent pi launches load the companion and Keeper extension as separate sources with capacity-aware routing context and native fail-open; added versioned enroll/status/proof/activate/verify/rollback/recovery workflow gated on a fresh proof report bound to revision/config/aliases, separate Claude/Codex diagnostic reporting, installer contract pins, and consolidated activation-pending docs.
## Evidence
