## Description

**Size:** M
**Files:** src/cross-extension-rpc.ts, src/agent-manager.ts, src/types.ts, src/index.ts, src/custom-agents.ts, test/cross-extension-rpc.test.ts, test/agent-manager.test.ts

### Approach

Strengthen pi-subagents' versioned RPC so a foreground named-agent spawn belongs to an opaque hierarchical ownership scope rather than whichever handler happens to receive a stop request. Strictly resolve the requested custom-agent type, preserve the active nested session context, associate child scopes with their parent, and provide acknowledged recursive cancellation that settles only after descendant AgentSessions are terminal. Keep ownership metadata internal to the RPC/runtime; callers continue to express only the generic Task fields.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/cross-extension-rpc.ts:13 — protocol v2 currently exposes unscoped spawn/stop and routes stop by agent ID alone.
- src/agent-manager.ts:146 — records have per-agent AbortControllers but no parent scope or child set.
- src/agent-manager.ts:238 — a parent signal currently aborts only one direct record.
- src/agent-manager.ts:523 — abort marks one record stopped before its async session has necessarily settled.
- src/index.ts:462 — nested extension activation currently depends on a per-instance active context.

**Optional** (reference as needed):
- src/custom-agents.ts:13 — custom-agent discovery supplies the strict named-type catalog.
- branch `fix/nested-subagent-spawn-ctx` — contains a focused nested-context reproduction to incorporate rather than leaving as an uninstalled side branch.

### Risks

Process-global ownership must not cross-contaminate concurrent root sessions. Cancellation acknowledgement cannot mean merely “abort requested,” and unknown agent types must fail rather than silently falling back to general-purpose. Protocol evolution must fail loudly for older Keeper facades.

### Test notes

Cover nested spawn, strict missing-type failure, parent/child scope registration, recursive abort ordering, cancellation before spawn completion, late completion after abort, sibling isolation, duplicate cancel, bounded acknowledgement, manager disposal, and active-context fallback through pure in-process tests.

### Detailed phases

1. Define the next RPC ownership and cancellation envelopes.
2. Land strict type resolution and nested active-context support.
3. Add parent/child scope tracking and recursive all-settled cancellation.
4. Route shutdown/disposal through the same idempotent scope finalizer.
5. Pin protocol and race behavior with package tests.

### Alternatives

A global unscoped agent-ID stop remains too weak for nested ownership. Spawning a detached CLI process for the judge is rejected because it bypasses static-agent policy and in-process Task lifecycle.

### Non-functional targets

Concurrent ownership trees remain isolated; listener and scope retention is bounded; cancellation preserves the originating reason; no test depends on real models or processes.

### Rollout

Ship the protocol and tests in pi-subagents before Keeper changes its required RPC version.

## Acceptance

- [ ] Foreground RPC spawn strictly resolves the requested named agent and returns an opaque owner-scoped handle.
- [ ] Nested Task children register beneath their caller scope without adding fields to the public Task schema.
- [ ] Recursive cancellation is idempotent, preserves its reason, isolates siblings, and acknowledges only after owned descendants settle or report bounded failure.
- [ ] Nested extension activation can spawn a child with a valid active context.
- [ ] Package tests cover protocol mismatch, lifecycle races, strict resolution, and recursive teardown without real inference.

## Done summary
Strengthened pi-subagents' RPC (v2->v3) with strict named-agent resolution, opaque hierarchical ownership scopes via AsyncLocalStorage, nested active-context propagation, and idempotent recursive cancellation that settles only after descendant AgentSessions terminate or report bounded failure.
## Evidence
