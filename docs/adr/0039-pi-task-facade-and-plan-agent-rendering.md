# 39. Pi Task facade and rendered plan agents

## Status

Accepted. Extended by ADR 0063, which applies the compiler-owned publication
model to the Claude `work:worker` cohort; this record's Pi static-agent and
Task-facade decisions stand.

## Context

Keeper's planning skills are shared Agent Skills whose orchestration names Claude's foreground `Task(subagent_type, description, prompt)` tool and namespaced `plan:*` agents. Pi loads the same skill bodies, while `@tintinweb/pi-subagents` exposes an `Agent` tool plus a versioned cross-extension RPC and discovers custom agents from Pi's agent directory.

Pi does not infer plan-agent translation at runtime. Keeper's compiler owns the role/bundle catalog, renders canonical template bodies through `keeper prompt compile --bundle plan:static --target pi`, and the Task facade recompiles the requested canonical role before every Pi subagent spawn. That path keeps prompt bodies byte-for-byte, translates only launch metadata, and fails loud when the exact model registry entry or provider-equivalence route is missing.

The panel mechanism is already harness-neutral at its process boundary. A panel runner shells `keeper agent panel start` and `wait`, then invokes a judge subagent. It does not require a second Pi-specific panel engine; a Pi-only roster keeps every panel inference on Pi.

## Decision

Keeper's tracked Pi extension registers a foreground tool named `Task`. The facade preserves the shared skill contract and delegates execution through pi-subagents' versioned event-bus RPC:

- every call actively verifies the supported RPC protocol;
- the facade spawns the requested named agent as a foreground Pi subagent;
- sibling Task calls use Pi's parallel tool execution and remain independently correlated by agent id;
- cancellation asks the subagent extension to stop the matching run;
- the tool result's content is exactly the subagent's final answer, while duration, token, and tool-use metadata stays in tool details.

Keeper's Pi prompt compiler owns the static prompt surface. `keeper prompt compile --bundle plan:static --target pi` reads the role/bundle catalog, validates the requested bundle or role as scope, and still publishes the full static role set so one manifest owns all managed outputs. For each static role it:

- snapshots the catalog, host matrix, provider-equivalence map, canonical template source, render inputs, and Task facade path into one fingerprint;
- resolves the role's `agent_pins` entry by exact role name, with no parent-model, fuzzy, or implicit-provider fallback;
- translates the assigned cell through provider equivalence into an exact Pi launch id;
- maps effort to Pi thinking and turn budget (`low`/`medium`/`high`/`xhigh` to 25/40/60/75, with `max` compiling to `xhigh`);
- keeps the canonical template body byte-for-byte while translating only launch metadata and tool names;
- treats `plan:panel-runner` as a Pi-only judge hop that loads Keeper's ephemeral Task facade and exposes only Task;
- refuses unsupported targets, missing catalog entries, invalid equivalence maps, unsupported launch cells, or malformed compiled JSON.

Publication is compiler-owned and lock-scoped. The compiler canonicalizes the output root, takes a target-dir lock, refuses to overwrite unmanaged outputs or sidecars, writes managed sidecars first and outputs second, removes stale managed files, verifies every byte again, and renames the manifest last. A matching manifest/hash/fingerprint hit is a no-op; any drift or check-mode mismatch fails loud. The Task facade preflights the same compiler and CLI absolute paths before launch, recompiles the requested canonical role per Task call, and binds the exact `ctx.modelRegistry.find(provider, id)` object only when that object and the registry's available list both contain the same exact model; anything less is an error, never a parent-model, fuzzy, or implicit-provider fallback.

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
- `keeper prompt compile` is the single source of truth for Pi prompt artifacts; the same bytes and fingerprints gate install, repair, and per-Task recompilation.
- Pi package absence, protocol drift, missing catalog/registry bindings, or provider-equivalence drift becomes a loud Task failure rather than a generic agent fallback.
- Generated Pi agents follow source prompt changes on install and retain a mechanical body-parity test.
- A panel's model diversity is configuration: repeated cold Pi runs are valid independent panelists, while additional Pi-accessible models can broaden the roster without changing the panel engine.
- The tracked Pi extension remains fail-open at load time; a Task invocation itself fails loudly when its required subagent service is unavailable.
