## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/config.ts or config.yaml surface (the knob), test/ (composition-map test extension)

### Approach

A config-flagged sub-gate at the sole discovery seam (agent/main.ts:2194-2228 area): when
the launch is a WORKER and the gate is enabled, discovery emits only keeper-owned plugin
dirs (plugins/keeper, plugins/plan) plus the per-cell --plugin-dir — third-party scan-dir
results are stripped from the worker argv. Interactive launches never gated. The knob lives
in keeper's launcher config surface (NOT autopilot_state — this is launch config, not
reconciler state; investigate the right home: plugins.yaml sibling key or config.yaml),
default OFF. Extend the composition-map standing test to pin the per-channel plugin set in
BOTH gate states. The gate depends on tasks .1/.2 because isolation without them stalls
workers (permissions) or degrades renders (corpus).

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts:2194-2228 — discovery seam + how sources flow to discoverPlugins
- src/agent/plugins.ts discoverPlugins — where the strip composes
- docs/plugin-composition-map.md + its test — the pin to extend

### Risks

- The gate must strip SCAN results, not the plugin_dirs a machine explicitly hard-lists; document the boundary in the knob's help.

### Test notes

Pure discovery tests (injected sources, both gate states, worker vs interactive); no live launch.

## Acceptance

- [ ] Gate strips third-party plugins from worker argv when ON; interactive unaffected; OFF is byte-identical to today
- [ ] Composition test pins both states; knob documented

## Done summary
Config-flagged worker plugin-isolation gate (worker_plugin_isolation in plugins.yaml, default off): a keeper-automated worker launch (keyed on --dangerously-skip-permissions) drops plugin_scan_dirs results while keeping hard-listed plugin_dirs + per-cell dir; interactive never gated. Composition-map test and doc extended to pin both gate states.
## Evidence
