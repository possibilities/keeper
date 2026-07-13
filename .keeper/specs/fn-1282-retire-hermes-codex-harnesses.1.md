## Description

**Size:** M
**Files:** src/agent/harness.ts, src/agent/config.ts, src/agent/triple.ts, src/agent/matrix.ts, src/agent/main.ts, src/agent/dispatch.ts, src/agent/args.ts, src/agent/passthrough.ts, src/agent/launch-config.ts, src/agent/launch-handle.ts, src/agent/state-sharing.ts, src/agent/transcript-watch.ts, src/agent/run-capture.ts, src/agent/pair-subcommands.ts, src/codex-trust.ts, src/pair/panel.ts, cli/agent.ts, cli/descriptor.ts, plugins/plan/src/host_matrix.ts, test/agent-harness.test.ts, test/agent-config.test.ts, test/agent-presets.test.ts, test/agent-matrix.test.ts, test/agent-launch-config.test.ts, test/agent-launch-handle.test.ts, test/agent-codex.test.ts, test/codex-trust.test.ts, test/helpers/agent-main-harness.ts

### Approach

Remove Codex from descriptors, defaults, triples, Providers, commands, panels, argv construction, trust, state-sharing, and run capture. Keep Launch ids opaque so `pi::openai-codex/...` remains Pi, and do not touch the landed `gpt` Worker provider family.

### Investigation targets

*Verify before relying — these refs move with the repo.*

**Required** (read before coding):
- `src/agent/harness.ts:19` — canonical registry.
- `src/agent/harness.ts:304` — unsafe broad Claude fallback.
- `src/agent/config.ts:305` — default catalog.
- `src/agent/launch-config.ts:192` — native builder map.
- `src/agent/main.ts:2931` — Codex launch branch.
- `plugins/plan/src/host_matrix.ts` — independent plan matrix parser.

**Optional** (reference as needed):
- `test/note-workflow.test.ts:52` — retained Pi Codex-named id.

### Risks

Narrowing the union exposes exhaustive switches; remove compile-bound branches atomically rather than retaining an inactive descriptor.

### Test notes

Delete Codex-only launch/trust tests, rewrite mixed tests around Claude/Pi, and prove a Codex harness cannot spawn while a Pi Codex-named id still resolves.

### Detailed phases

1. Narrow registry/config/triple/matrix/help membership.
2. Remove Codex argv, binary, launch, trust, state-sharing, and capture branches.
3. Delete launcher-only modules/tests and remove Keeper-owned Codex links/indexes.

### Alternatives

A permanent active-harness allowlist beside the descriptor registry is rejected as parallel truth.

### Non-functional targets

Cold-start remains DB-free; listing does not probe credentials or launch binaries.

### Rollout

Remove Codex harness rows from live presets/matrix first; leave ambient `.codex` credentials, sessions, and unmarked trust untouched.

## Acceptance

- [ ] Agent commands, presets, matrices, panels, and triples expose no Codex harness.
- [ ] Codex binary, trust, state-sharing, argv, launch, and run-capture paths are absent.
- [ ] Pi `openai-codex/...` triples and the `gpt` Worker provider family still work.
- [ ] Relevant Claude/Pi tests pass and Codex-only launcher tests are removed.

## Done summary
Retired the standalone Codex harness from the registry, config defaults, launch-config builders, argv construction, run-capture, state-sharing, trust, restore, panels, and CLI surfaces, keeping Claude and Pi as the only supported harnesses. Unknown non-empty harness names now throw instead of falling back to Claude. Pi openai-codex/... launch ids and the gpt Worker provider family are untouched. Deleted src/codex-trust.ts, test/agent-codex.test.ts, test/codex-trust.test.ts, and the Codex plan-matrix fixture; renamed it to a Claude/Pi fixture.
## Evidence
