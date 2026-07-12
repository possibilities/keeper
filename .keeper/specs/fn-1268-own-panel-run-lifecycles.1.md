## Description

**Size:** M
**Files:** src/agent/main.ts, src/agent/run-capture.ts, src/agent/launch-handle.ts, src/agent/tmux-launch.ts, test/agent-run-capture.test.ts

### Approach

Give every one-shot `keeper agent run` a durable, machine-readable control artifact as soon as its tmux launch succeeds, before transcript capture waits. The artifact must carry only positively attributable teardown handles: exact socket-qualified tmux target, wrapper/run identity, and enough lifecycle state for an owner to request idempotent cancellation without reconstructing display names. Consolidate result emission and teardown behind one finalization path so output-write failure, timeout, `no_message`, cancellation, and ordinary completion all attempt exact reap while preserving answer-before-reap durability.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/main.ts:1219 — output emission currently writes the envelope before invoking best-effort reap and bypasses reap when output writing throws.
- src/agent/main.ts:1253 — `reapThunk` already owns the exact tmux kill command and result-before-teardown ordering.
- src/agent/tmux-launch.ts:559 — launch returns server-global window/pane identity and socket-qualified kill argv.
- src/agent/run-capture.ts:38 — the closed terminal outcome envelope is the durable result contract.

**Optional** (reference as needed):
- src/agent/launch-handle.ts:310 — resolved launch handles already carry the exact kill-window command.
- test/agent-run-capture.test.ts:1021 — atomic output tests provide the injected-effects pattern.

### Risks

A control artifact written too late recreates the partial-launch leak window. Cleanup must never infer ownership from a mutable tmux name or bare PID, and a failed reap must remain inspectable without rewriting a viable answer as success.

### Test notes

Use injected launch and tmux effects. Assert artifact-before-wait ordering, result-before-reap ordering, one cleanup call per terminal path, exact target use, benign already-gone handling, output-write failure cleanup, and no real subprocess or tmux invocation.

### Detailed phases

1. Define and atomically persist the control-artifact schema.
2. Route every capture outcome and output-write failure through one idempotent finalizer.
3. Add a cancellation entry seam that verifies the artifact identity and awaits bounded teardown.
4. Pin event ordering and cleanup cardinality with fake effects.

### Alternatives

Reconstructing tmux targets from `panel::<slug>::<member>` is rejected because display names are not ownership. Killing only the outer wrapper is rejected because the tmux-hosted harness can survive it.

### Non-functional targets

Control writes are atomic, output remains bounded, cleanup is idempotent, and no fast test launches a subprocess or tmux server.

### Rollout

Keep the existing `--reap-window-on-terminal` behavior compatible while the panel engine begins consuming the new control artifact.

## Acceptance

- [ ] A launched one-shot agent exposes an atomic control artifact containing an exact teardown target before capture waiting begins.
- [ ] Every terminal capture outcome and output persistence failure enters one idempotent finalizer that attempts exact teardown.
- [ ] Cancellation and cleanup distinguish already-gone resources from identity mismatch or unresolved teardown.
- [ ] Fast tests prove ordering and cardinality entirely through injected effects.

## Done summary

## Evidence
