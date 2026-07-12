## Description

**Size:** M
**Files:** plugins/keeper/pi-extension/task-facade.ts, src/agent/pi-plan-agents.ts, scripts/install.sh, test/pi-task-facade.test.ts, test/pi-plan-agents.test.ts

### Approach

Update Keeper's Pi Task facade to consume the owner-scoped RPC while preserving the exact public `{subagent_type, description, prompt}` schema and final-text result contract. Strictly fail missing named agents, await recursive cancellation acknowledgement, preserve cancellation typing/reason, reject late or empty completion after abort, and retain wildcard extension loading plus the runner/judge tool restrictions. Verify installation selects a pi-subagents revision containing the nested-context and scoped-cancellation contract.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/keeper/pi-extension/task-facade.ts:195 — direct Task execution currently correlates one agent ID and uses `Promise.race` against fire-and-forget stop.
- plugins/keeper/pi-extension/task-facade.ts:314 — the facade exposes exactly the three generic Task fields and parallel sibling execution.
- src/agent/pi-plan-agents.ts:146 — Pi rendering preserves the shared body and exposes only facade Task while loading wildcard extensions.
- scripts/install.sh:173 — install verification pins selected dependency fixes but not nested Task context or ownership.

**Optional** (reference as needed):
- test/pi-task-facade.test.ts:120 — fake event-bus tests establish result and cancellation correlation patterns.
- test/pi-plan-agents.test.ts:59 — renderer tests pin Task capability and judge denial.

### Risks

Wrapping `AbortError` as an ordinary error breaks native cancellation semantics. Stop acknowledgement must come from the scope that owns the agent, and the compatibility layer must not expose Pi IDs or protocol vocabulary in shared prompts or Task parameters.

### Test notes

Test exact schema parity, strict named-agent failures, nested judge ownership, cancellation-before/after-spawn races, acknowledged recursive stop, late-result suppression, AbortError preservation, concurrent tree isolation, renderer body parity, and installation drift detection with fake events only.

### Detailed phases

1. Bump and validate the scoped RPC protocol.
2. Replace fire-and-forget direct stop with owner-scoped cancellation settlement.
3. Preserve native Task result and abort semantics across all races.
4. Pin renderer/install compatibility and negative Pi-vocabulary assertions.

### Alternatives

Extending the shared Task schema is rejected. Importing pi-subagents internals directly is rejected in favor of its versioned RPC boundary.

### Non-functional targets

The extension remains node-only, isolated, fail-open at load time, and fail-loud when an invoked Task cannot satisfy the required protocol.

### Rollout

Require the new protocol only after the upstream package task lands; protocol mismatch must prevent judge launch rather than degrade silently.

## Acceptance

- [ ] Pi exposes the unchanged three-field Task tool and returns only the named child's final text on success.
- [ ] Missing agent types and RPC drift fail before a generic fallback or successful Task result.
- [ ] Task cancellation reaches the owning recursive scope and does not settle until acknowledged terminal cleanup or bounded failure.
- [ ] Cancellation reason/type and sibling isolation survive spawn, completion, and abort races.
- [ ] Generated runner and judge definitions retain shared body parity, wildcard extension loading, and intended delegation restrictions.

## Done summary

## Evidence
