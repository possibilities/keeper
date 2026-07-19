## Description

**Size:** M
**Files:** src/agent/args.ts, src/agent/main.ts, src/agent/dispatch.ts, src/agent/launch-config.ts, test/agent-args.test.ts, test/agent-account-routing.test.ts, test/agent-metadata-inference.test.ts

### Approach

Add an internal Claude metadata-inference launch mode that reuses the normal Account router and `cswap run <slot> --share-history` wrapper but deliberately omits ordinary Harness-session creation. The mode accepts bounded naming input and returns one schema-constrained Haiku candidate from `claude -p` with safe mode, low effort, no tools, no plugins, no persistence, no fallback, capped output, and one twenty-second attempt.

The launcher independently selects a non-Fable Account route under current routing policy, scrubs inherited Claude session identity and ambient provider/auth overrides, terminates the process tree on timeout or cancellation, and emits only a typed success/failure envelope. It must not mint `--session-id`, `--name`, a birth intent, Keeper Job binding, native transcript, or Session-catalog artifact.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/agent/args.ts:20-162` — wrapper-owned argument parsing and Claude-only validation.
- `src/agent/main.ts:2848-2932` — print launches, model/effort resolution, and stdout discipline.
- `src/agent/main.ts:2989-3058` — mandatory independent Account-route selection before Claude execution.
- `src/agent/main.ts:3189-3277` — ordinary session-id/name generation and plugin discovery that metadata mode must bypass.
- `src/agent/launch-config.ts:417-452` — canonical managed claude-swap argv composition.
- `src/account-router.ts:92-106` — total PII-free Account-route outcome contract.
- `src/account-observation-refresh.ts:131-210` — injected timeout/output-capped subprocess pattern.

**Optional** (reference as needed):
- `src/agent/dispatch.ts:160-223` — wrapper flag help and transport conventions.
- `test/agent-account-routing.test.ts:43-64` — every successful Claude launch byte-pinned through claude-swap.
- `docs/adr/0092-durable-fable-focus-routing.md:5-41` — independent routing and no-affinity invariants.
- `docs/adr/0093-harness-specific-session-rename-inference.md` — accepted metadata-process boundary and limits.

### Risks

Ordinary print mode still creates session identity, plugin discovery, shared-history artifacts, and birth records, so reusing it without an explicit metadata branch violates the no-child-session contract. Inherited API keys, bearer tokens, cloud-provider selectors, or config helpers can silently outrank subscription OAuth. Timeout handling that kills only the wrapper can leave Claude running.

### Test notes

Exercise the launch planner and captured-process seam with injected routing, environment, spawn, clock, stdout, stderr, exit, timeout, and abort dependencies. Assert exact argv/environment, process-tree termination, no ordinary session/birth/plugin calls, bounded output, and typed errors for route/auth/quota/nonzero/malformed/timeout/cancel cases.

### Detailed phases

1. Parse one internal Claude-only metadata mode without exposing it as a normal user workflow or allowing Pi.
2. Build the fixed Haiku print argv and allowlisted environment after independent Account-route selection and inherited-session/auth scrubbing.
3. Capture one bounded process result with structured candidate parsing, timeout/abort process-tree teardown, and no retry/fallback.
4. Prove the metadata branch skips session naming, plugin discovery, birth intent, persistence, and artifact registration while retaining mandatory routing.

### Alternatives

Bare `claude -p` is rejected because it bypasses Keeper routing and may select ambient credentials. Ordinary `keeper agent claude -p` is rejected because it creates a Harness session and catalog artifacts. Calling Anthropic directly is rejected because it bypasses subscription OAuth and Account-route policy.

### Non-functional targets

Hard wall-clock budget is twenty seconds. Captured stdout and stderr are independently capped and never logged with naming input or credentials. One invocation creates at most one Claude process, performs no retry or fallback, and always returns or terminates its process tree.

### Rollout

The internal mode has no standalone discovery surface beyond wrapper help intended for diagnostics. It remains unused until the Claude rename hook lands; removal leaves normal interactive, print, resume, pair, work, and escalation launches byte-identical.

## Acceptance

- [ ] A Claude-only internal metadata mode selects a fresh managed Account route and composes the child through the canonical claude-swap `--share-history` boundary.
- [ ] The fixed invocation uses Haiku, low effort, print mode, safe mode, no tools, no persistence, structured single-name output, no fallback, and a twenty-second hard timeout.
- [ ] Metadata inference cannot inherit the parent Session id or ambient API-key/bearer/cloud-provider route, and an unavailable managed route fails without spawning or falling back.
- [ ] The mode mints no session id/name, birth intent, Keeper Job binding, plugin discovery, native transcript, resumable conversation, or Session-catalog entry.
- [ ] Timeout and cancellation terminate the exact process tree; nonzero exit, auth/quota failure, oversized output, malformed schema, or unusable candidate returns a bounded typed failure and no retry.
- [ ] Existing non-metadata Claude/Pi launch argv and routing tests remain byte-identical, including Fable-focus behavior from the dependency epic.
- [ ] Deterministic in-process tests cover route selection, argv/environment construction, artifact suppression, output caps, process outcomes, timeout, and cancellation without launching a real Claude process.

## Done summary
Added an internal Claude-only metadata-inference launch mode: independent Account-route selection, canonical claude-swap --share-history composition, a fixed Haiku/low-effort/safe-mode/no-tools/no-persistence print invocation with a 20s hard timeout, scrubbed environment/session identity, bounded output capture with process-tree teardown, and typed success/failure envelopes. Skips ordinary session-id/name minting, plugin discovery, birth intent, and Session-catalog artifacts.
## Evidence
