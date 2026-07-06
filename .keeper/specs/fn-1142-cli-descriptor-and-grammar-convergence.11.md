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
Adopted --agent-help (terse operator runbook) on the 6 agent-facing surfaces that lacked it: await, bus, agent, tabs (native) + plan, prompt (plugin CLIs). Each routes the runbook purely before any deps/daemon/db/state access (exit 0). Descriptors declare agent_help:true for every adopter (cli/descriptor.ts native entries), so keeper --help --json now advertises 11 runbook-bearing commands (prior 5 + these 6) and the ordinal-5 purity walk covers each. Runbooks are operator-shaped (key invocations + exit contract + footguns) and use only spellings live at this base: unit-required durations (await --timeout 5m; verified bare numbers are rejected with a unit hint) and --format json|yaml|human (plan/prompt); deliberately avoided the unlanded --dir->--run-dir/--cwd renames (task .8, not a dep of .11) by addressing agent panel via stable --slug. Wiring: native runbook consts routed in each CLI's pure parse+main (await/bus/tabs), src/agent/dispatch.ts KEEPER_AGENT_RUNBOOK + agent-help Dispatch kind routed in cli/agent.ts routeMetaBeforeDeps (and src/agent/main.ts for exhaustiveness), plan/prompt pre-command --agent-help early-return in main(). Tests: agent_help set expanded to 11 in test/keeper-cli.test.ts + one content assertion per runbook (names its primary verb form) across test/{await,bus-cli,tabs,agent-dispatch}.test.ts and plugins/{plan,prompt}/test. Verification: all 6 runbooks render + exit 0; typecheck + biome lint green (root + both plugins); new tests green (392 root / 55 plan-cli-help / 46 prompt-cli). test:full has 6 PRE-EXISTING failures outside this task's surface, left unfixed per lead: (1) plan src-api-spine.test.ts is a KEEPER_PLAN_WORKTREE env leak from running inside a worker session (passes with the var unset; daemon baseline at base 7458c427 is green), (2) 5 prompt render/parity golden failures are corpus<->golden drift over 'keeper baseline' guidance text in files I never touched (re-vendor is task .10, pending).
## Evidence
