## Description

**Size:** M
**Files:** cli/keeper.ts, cli/{dispatch,handoff,commit-work,autopilot,statusline-sink,await}.ts, plugins/plan/src/cli.ts

### Approach

Give the hand-rolled dispatcher (cli/keeper.ts, 214 lines, plaintext HELP) a machine face:
`keeper --help --json` emits {subcommands:[{name, summary, verbs?}]} centrally — intercept at
the dispatcher, don't retrofit all 28 subcommand mains; two-level verbs (plan/prompt/agent/
bus/autopilot) enumerate their verb names from a static table the dispatcher owns. Define
--agent-help as the terse operator-runbook form (distinct from --help --json): propagate the
reclaim pattern (cli/reclaim.ts:71) to dispatch, handoff, commit-work, autopilot. Fix
keeper await --help drift: complete = done-AND-idle (await.ts:905) and document the landed
condition. Give statusline-sink a one-line help ("internal statusLine tee; not for agent use")
instead of empty output. Converge the documented exit-code table: publish the shared semantics
in --help --json and reconcile keeper's exit-1 vs plan's exit-2 unknown-command where cheap
(documenting the difference is acceptable; silent divergence is not).

### Investigation targets

**Required** (read before coding):
- cli/keeper.ts — SUBCOMMANDS + HELP structure
- cli/reclaim.ts:71 — the --agent-help pattern to propagate
- cli/await.ts:905 + its HELP text — the drift to fix
- cli/statusline-sink.ts — the empty help

### Risks

- Partial rollout is the failure mode gap analysis flagged: an agent assuming JSON help where only plaintext exists breaks non-deterministically — the central interception avoids per-subcommand drift, and the index must mark which subcommands carry --agent-help.

### Test notes

Shape test for --help --json; keeper-cli test asserts every listed subcommand responds to
--help with non-empty output (catches future statusline-sink-class gaps).

## Acceptance

- [ ] keeper --help --json emits the full command index including two-level verb names
- [ ] --agent-help on dispatch/handoff/commit-work/autopilot; await help states done-AND-idle + landed
- [ ] Every top-level subcommand emits non-empty --help; exit-code semantics published

## Done summary

## Evidence
