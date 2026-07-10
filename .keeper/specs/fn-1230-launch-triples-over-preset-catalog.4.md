## Description

**Size:** M
**Files:** src/agent/config.ts, src/agent/main.ts, src/agent/launch-config.ts, src/agent/harness.ts, src/agent/state-sharing.ts, cli/dispatch.ts, src/dispatch-command.ts, src/autopilot-worker.ts, src/escalation-config.ts, src/reconcile-core.ts, test/helpers/agent-main-harness.ts, test/agent-config.test.ts, test/agent-presets.test.ts, test/agent-dispatch.test.ts, test/agent-launch-config.test.ts, test/agent-hermes.test.ts, test/dispatch-cli.test.ts, test/autopilot-worker.test.ts, test/escalation-config.test.ts

### Approach

Switch every launch-config consumer to triples and retire the named catalog: presets.yaml parses to exactly six optional keys — the four harness defaults plus worker and escalation, each a triple string whose harness must match its key (defaults) or be claude (worker/escalation warn-and-ignore otherwise, unchanged); the freeform presets mapping, the in-memory matrix augmentation, and preset-name validation retire, with an unknown key (including a leftover presets block) failing loud with a migration hint. The preset/x-preset flag values on agent, run, and dispatch parse as triples; precedence stays explicit flag over triple over harness default; per-harness argv construction is unchanged in shape — the triple's effort routes through the existing effort-to-axis translation onto the harness's own second-axis flag, and the axisless harness emits no effort flag. Worker and escalation resolvers keep their fail-open swallow-to-constants posture, coalescing parsed triple fields onto the existing constants. The reserved-name/profile-dir mirror in state-sharing keeps its current scope (profile dirs never see triples — assert it). Reshape the main-harness test fixture catalog to triple form and update all consumer suites.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/config.ts:278-318 shapes, :328 RESERVED_PRESET_NAMES, :351 PRESET_NAME_PATTERN, :427-448 allowed keys, :467 loadPresetCatalog, :510 augmentCatalogWithMatrix (retire), :549 parseHarnessDefault
- src/agent/main.ts:1885-2018 x-preset/run-preset resolution, :2280/2367/2508/2552 per-harness interactive launch, :576 resolveLaunchConfigSignals
- src/agent/launch-config.ts:204-236 buildAgentLaunchArgv (x-preset pass-through), :249/281/310/343 native arg builders
- cli/dispatch.ts:628-663 preset/worker/escalation layering; src/dispatch-command.ts:355
- src/autopilot-worker.ts:430 resolveWorkerLaunchConfig, src/escalation-config.ts:38, src/reconcile-core.ts:277 WORKER_/ESCALATION_ constants
- test/helpers/agent-main-harness.ts DEFAULT_PRESET_CATALOG — the fixture every launch test rides

**Optional** (reference as needed):
- src/agent/state-sharing.ts:381-389 reserved/profile-dir mirror
- test/agent-hermes.test.ts — hermes launch expectations (model-only argv)

### Risks

- The detached leg re-exec rides the flag value through argv — a triple must round-trip parse-format-parse byte-identically or panel legs re-resolve a different launch
- Fail-open worker/escalation must swallow a malformed triple to constants without a throw reaching the reconciler

### Test notes

Main-harness table: bare harness launch resolves its default triple to the right argv per harness (claude effort flag, codex reasoning config, pi thinking band, hermes model-only); explicit flags beat a triple; malformed default fails loud for agent launches while malformed worker/escalation swallow to constants with one warning. Dispatch: plan-form still claude-only, triple accepted, precedence preserved.

## Acceptance

- [ ] presets.yaml accepts only the six triple-valued keys; any legacy content fails loud with a message naming the new shape
- [ ] A bare launch of each harness resolves its default triple to the correct native argv, and an explicit model/effort flag still wins over the triple
- [ ] Worker and escalation resolution parse triples with the same fail-open constant fallback and non-claude warn-once behavior as before
- [ ] dispatch --preset accepts a triple (claude-only for plan-form) with unchanged precedence layering
- [ ] No code path mints, validates, or resolves a named preset

## Done summary

## Evidence
