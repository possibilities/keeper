## Overview

Give every tracked Pi session the same command-mode `Monitor` primitive Keeper skills already use under Claude. The Pi host adapter owns process lifetime, event injection, generic task cancellation, and background-task snapshots so the shared skill contract remains harness-neutral; declarative plugin monitors and the existing Pi Agent Bus inbox are unchanged.

## Quick commands

- `bun test ./test/pi-monitor-facade.test.ts ./test/pi-extension.test.ts ./test/reducer-projections.test.ts ./test/refold-equivalence.test.ts`

## Acceptance

- [ ] Tracked Pi exposes command-mode `Monitor` with the shared four-field contract and early task-id return, while untracked or degraded extension loads remain fail-open.
- [ ] Monitor stdout and terminal state arrive as automated task notifications with bounded buffering, timeout ownership, exact cancellation, and no stale delivery after session replacement.
- [ ] Pi Stop snapshots classify tool-launched monitors as `monitor` while retaining the Agent Bus child as `ambient`, making existing Keeper monitor provenance, occupancy, and `monitor-running` checks work without a harness branch.
- [ ] Shared Keeper skills require no Pi-specific prose or fallback path.

## Early proof point

Task that proves the approach: task 1. If the isolated controller cannot reproduce the command lifecycle with pure injected seams, stop before binding it into the Pi extension and narrow the contract rather than hiding divergence in integration code.

## References

- `docs/adr/0039-pi-task-facade-and-plan-agent-rendering.md`
- `docs/adr/0043-pi-agent-bus-session-child.md`
- `plugins/keeper/skills/await/SKILL.md`
- `plugins/keeper/pi-extension/bus-inbox.ts`
- Pi extension API: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md

## Best practices

- **Session ownership:** start resources only from a tool call and release them on every session-shutdown reason; late callbacks must be generation-fenced.
- **Bound model-visible output:** frame complete lines, batch short bursts, cap line/queue growth, and surface terminal suppression rather than silently buffering forever.
- **One cancellation root:** timeout, explicit stop, session replacement, and quit converge through one idempotent process-tree teardown.
- **Host-side parity:** translate the existing shared contract in the Pi adapter; do not fork skills or reimplement Keeper projections.
