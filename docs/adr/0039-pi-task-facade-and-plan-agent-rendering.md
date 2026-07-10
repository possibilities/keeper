# 39. Pi Task facade and rendered plan agents

## Status

Accepted.

## Context

Keeper's planning skills are shared Agent Skills whose orchestration names Claude's foreground `Task(subagent_type, description, prompt)` tool and namespaced `plan:*` agents. Pi loads the same skill bodies, while `@tintinweb/pi-subagents` exposes an `Agent` tool plus a versioned cross-extension RPC and discovers custom agents from Pi's agent directory.

A Pi planning run can infer the translation itself: issue `Agent` calls, tolerate unknown `plan:*` types falling back to a general-purpose agent, extract result text from the package's status wrapper, and inject `CLAUDE_CODE_SESSION_ID` before plan mutations. That path can scaffold and validate an epic, but its correctness depends on model improvisation. It also discards each specialist's prompt, tool restrictions, thinking level, and turn budget.

The panel mechanism is already harness-neutral at its process boundary. A panel runner shells `keeper agent panel start` and `wait`, then invokes a judge subagent. It does not require a second Pi-specific panel engine; a Pi-only roster keeps every panel inference on Pi.

## Decision

Keeper's tracked Pi extension registers a foreground tool named `Task`. The facade preserves the shared skill contract and delegates execution through pi-subagents' versioned event-bus RPC:

- every call actively verifies the supported RPC protocol;
- the facade spawns the requested named agent as a foreground Pi subagent;
- sibling Task calls use Pi's parallel tool execution and remain independently correlated by agent id;
- cancellation asks the subagent extension to stop the matching run;
- the tool result's content is exactly the subagent's final answer, while duration, token, and tool-use metadata stays in tool details.

Keeper renders the planner-side `plugins/plan/agents/*.md` definitions into the canonical Pi agent directory under `plan:<name>`. The renderer copies each prompt body byte-for-byte and translates only harness metadata:

- Claude model pins are omitted so the configured Pi model is inherited;
- effort maps to Pi thinking;
- denied Claude tools map to Pi built-ins and both subagent entry tools (`Task` and `Agent`);
- each agent receives a bounded turn budget;
- `plan:panel-runner` explicitly loads Keeper's ephemeral Pi extension and exposes only its Task tool for the judge hop, while agents that deny nested delegation cannot escape through either tool name.

Rendered files are Keeper-owned, atomically written, sidecar-marked, and tracked by a manifest so stale outputs are removed without overwriting an unrelated unowned agent. Named Pi profiles share the canonical `agents` directory alongside their existing shared skills and extensions.

The existing panel skill, runner, subprocess fan-out, durable waits, and judge contract remain unchanged. A Pi planning environment selects panel rosters containing only Pi launch triples when Claude inference is not permitted.

Plan mutation resolves identity from `KEEPER_PLAN_SESSION_ID`, then native `CLAUDE_CODE_SESSION_ID`, then `KEEPER_JOB_ID`. The same resolved identity governs invocation payloads, touched paths, and session markers. `keeper commit-work` accepts `KEEPER_JOB_ID` after its existing explicit and Claude-specific sources, allowing plan-time source and ADR commits from a tracked Pi session without impersonating Claude.

## Alternatives considered

- **Maintain separate Pi copies of the hack, plan, and panel skills.** Rejected: orchestration and policy would drift across long, actively maintained skill bodies.
- **Teach the model to translate Task calls into Agent calls.** Rejected as the contract: it works as a fallback, but raw selector output, named-agent fidelity, and tool restrictions should not depend on model interpretation.
- **Import pi-subagents internals directly.** Rejected: the package's event-bus RPC is the explicit versioned integration boundary and keeps Keeper's ephemeral extension self-contained.
- **Build a second panel engine from Pi subagents.** Rejected: the existing panel already supplies independent subprocesses, durable slug reconciliation, bounded waits, and content-blind answer-file handoff.
- **Export `CLAUDE_CODE_SESSION_ID=$KEEPER_JOB_ID` from Pi.** Rejected: a neutral resolver states the real identity source and keeps harness-specific names at their native boundary.

## Consequences

- `/skill:hack` can remain in one Pi conversation, route on the human's assent, and execute the canonical plan skill through specialist Pi subagents.
- The model-selector's raw JSON reaches `apply-selection` without package status prose entering the Task result body.
- Pi package absence or protocol drift becomes a clear Task tool failure rather than a silent general-purpose fallback.
- Generated Pi agents follow source prompt changes on install and retain a mechanical body-parity test.
- A panel's model diversity is configuration: repeated cold Pi runs are valid independent panelists, while additional Pi-accessible models can broaden the roster without changing the panel engine.
- The tracked Pi extension remains fail-open at load time; a Task invocation itself fails loudly when its required subagent service is unavailable.
