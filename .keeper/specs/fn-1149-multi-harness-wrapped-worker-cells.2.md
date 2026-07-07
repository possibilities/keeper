## Description

**Size:** S
**Files:** src/agent/harness.ts, src/agent/launch-config.ts, src/agent/passthrough.ts, src/agent/main.ts, test/agent-launch-config.test.ts

### Approach

Add `effortAxisMap: Record<KeeperEffort, string> | null` to HarnessDescriptor — the
per-harness translation of keeper's five efforts (low/medium/high/xhigh/max) onto the
harness's second-axis vocabulary. codex and pi both use the band names
minimal/low/medium/high/xhigh (verified against current docs and pi --help), so both maps
are identity except max→xhigh; claude and hermes carry null (claude effort passes through
natively, hermes has no second axis). Apply the map at argv-build time wherever a keeper
effort reaches a harness: codex emits `-c model_reasoning_effort="<mapped>"`, pi emits
`--thinking <mapped>` (fixing pi silently dropping --effort today). The map is total over
the five keeper efforts; an unknown effort token is a caller bug and stays the existing
validation error. No harness-name switches: consumers read the descriptor field.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/harness.ts:62-158 — descriptor shape and the add-a-fact-per-harness pattern
- src/agent/launch-config.ts:256-267 — the raw codex effort emit this replaces
- src/agent/passthrough.ts:454-500 — PI_THINKING_TOKENS and pi second-axis handling

**Optional** (reference as needed):
- src/agent/main.ts:1120-1235 — the run handler where preset/flag effort resolves

### Risks

- Existing presets carrying harness-native effort values must keep working — the map
  applies to keeper-effort inputs, not already-native tokens; decide and test the
  precedence explicitly.

### Test notes

Per-harness argv assertions: codex --effort max → model_reasoning_effort="xhigh";
pi --effort high → --thinking high; claude passthrough unchanged; hermes ignores.

## Acceptance

- [ ] keeper agent run codex with keeper effort max composes model_reasoning_effort xhigh.
- [ ] keeper agent run pi with a keeper effort emits the mapped --thinking value instead of dropping it.
- [ ] claude and hermes launch argv are byte-identical to before.
- [ ] The map lives on the descriptor and no consumer adds a harness-name switch.

## Done summary

## Evidence
