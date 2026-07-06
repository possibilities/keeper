## Description

**Size:** M
**Files:** cli/await.ts, cli/bus.ts, cli/tabs.ts, cli/agent.ts, plugins/plan/src/cli.ts, plugins/plan/src/descriptor.ts, plugins/prompt/src/cli.ts, plugins/prompt/src/descriptor.ts, cli/descriptor.ts, test/keeper-cli.test.ts

### Approach

`--agent-help` (the terse operator runbook) currently exists on 5 of ~32 subcommands. Adopt it across the agent-facing surfaces that lack it: await, bus, agent, tabs (native) and plan, prompt (plugin CLIs — their handlers ride the residual pass-through and must be pure, same discipline as --help). Each runbook is written for an agent operator: the 3-6 invocations that matter, the envelope/exit contract, and the one or two footguns — not a re-render of --help. Post-convergence spellings throughout (durations with units, --format, grouped session verbs where cited). Descriptors gain agentHelp: true for every adopter so `--help --json` advertises which commands carry a runbook, and the ordinal-5 purity walk automatically covers every declared --agent-help.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/handoff.ts / cli/dispatch.ts / cli/commit-work.ts — the existing --agent-help voice and length to match
- cli/await.ts — condition grammar + exit codes the await runbook must compress
- plugins/plan/src/cli.ts + plugins/prompt/src/cli.ts — where the pass-through --agent-help handler hooks in

**Optional** (reference as needed):
- plugins/keeper/skills — skill prose that already teaches these surfaces (the runbook compresses, never contradicts)

### Risks

- Runbook prose drifts from behavior over time — keep each runbook adjacent to its descriptor and cite flags by descriptor name so the purity walk plus review catch dead spellings.

### Test notes

Ordinal-5 walk picks up each new agentHelp: true leaf automatically; add one content assertion per runbook (names its primary verb form) to catch empty stubs.

## Acceptance

- [ ] await, bus, agent, tabs, plan, and prompt each serve --agent-help purely (exit 0, no state/daemon/db access)
- [ ] Each runbook is operator-shaped (key invocations + exit contract + footguns) and uses only post-convergence spellings
- [ ] Descriptors declare agentHelp for every adopter and `--help --json` reflects it

## Done summary

## Evidence
