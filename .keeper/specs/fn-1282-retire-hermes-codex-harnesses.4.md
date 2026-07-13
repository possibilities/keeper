## Description

**Size:** M
**Files:** src/agent/harness.ts, src/agent/config.ts, src/agent/main.ts, src/agent/args.ts, src/agent/passthrough.ts, src/agent/launch-config.ts, src/agent/launch-handle.ts, src/agent/run-capture.ts, src/agent/pair-subcommands.ts, src/agent/hermes-capture.ts, src/hermes-trust.ts, src/hermes-shim-contract.ts, plugins/keeper/plugin/hooks/hermes-events-shim.ts, test/agent-hermes.test.ts, test/hermes-shim.test.ts, test/hermes-shim-event-drift.test.ts, test/hermes-trust.test.ts, test/agent-launch-config.test.ts, test/agent-launch-handle.test.ts, test/agent-run-capture.test.ts

### Approach

Remove Hermes from every descriptor, default, command, argv, export capture, trust, hook, shim, plugin, and test path. Delete all Hermes state on this host; preserving standalone Hermes behavior is explicitly out of scope.

### Investigation targets

*Verify before relying — these refs move with the repo.*

**Required** (read before coding):
- `src/agent/harness.ts` — Hermes descriptor.
- `src/agent/launch-config.ts:441` — native argv.
- `src/agent/hermes-capture.ts` — export capture.
- `src/hermes-trust.ts:331` — config writer.
- `plugins/keeper/plugin/hooks/hermes-events-shim.ts` — installed producer.

**Optional** (reference as needed):
- `docs/adr/superseded/0007-positive-evidence-session-adoption.md` — history only.

### Risks

External state can reference absolute shim paths. Cleanup is intentionally destructive but must not touch Claude, Pi, Keeper, or unrelated shell state.

### Test notes

Delete Hermes suites and remove Hermes branches from mixed tests; retain Claude/Pi coverage.

### Detailed phases

1. Remove descriptor/default/axis/help membership.
2. Delete launcher, capture, trust, shim, and plugin code.
3. Remove mixed dependencies and tests.
4. Delete this host's Hermes state and plugin artifacts.

### Alternatives

A no-op shim or deprecation period is rejected; breakage is accepted.

### Non-functional targets

Claude/Pi launch behavior stays stable; no hook points at a deleted Hermes file.

### Rollout

Delete external state before or with the shim; standalone Hermes may fail and is not repaired.

## Acceptance

- [ ] Keeper has no Hermes descriptor, default, launcher, capture, trust, hook, shim, plugin, or tests.
- [ ] Keeper-managed Hermes artifacts and this host's Hermes state are absent.
- [ ] Claude/Pi launch and capture tests pass.

## Done summary

## Evidence
