## Description

**Size:** S
**Files:** ~/docs/keeper-durable-awaits.md

### Approach

Write the design proposal (a doc, no keeper code changes) that closes two
diagnosed await gaps. Gap 1, visibility: an epic that is plan-closed but
whose lane has not merged to default is in neither the visible board nor
the landed set — finalize is gated on worktree mode AND an unpaused board,
so on a paused board the epic silently strands, reading as landed to a
human. Propose an additive surface (a needs-human count and/or board
annotation) that names "finalize pending, board paused", handling the
worktree-OFF degrade where done already means landed. Gap 2, durability:
the await condition machinery reconnects forever, but the wait itself is a
per-session Monitor process — session end kills the wait and its follow-up
with no trace and no way to list live waits. Recommend ONE mechanism,
patterned on the existing durable-intent shape (request round-trips
through a synthetic event into a durable projection serviced by a
level-triggered worker with lease + status state machine), or argue a
lighter store (state-dir ledger / request spool) if the event-sourced
shape is overkill; either way it must honor the writes-scope rules (no
ad-hoc write path, plans read-only, live-only signals never in a
deterministic fold). The doc ends with a follow-up epic decomposition
ready to hand to a planner, and commits to one recommended direction.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves. `src/autopilot-worker.ts` contains a NUL byte that makes plain grep treat it as binary and return ZERO matches — use `rg -a` or read it directly.*

**Required** (read before coding):
- src/readiness-client.ts:493-503 — computeLandedEpicIds: the exact visibility gap (worktree ON → lane_merged only; done-but-unmerged epics fall in neither set)
- src/autopilot-worker.ts:6633-6637, 6830-6835 — finalize/LaneMerged gated on worktreeMode && !paused (the stranding mechanism)
- src/rpc-handlers.ts:533-664 + src/handoff-worker.ts:1-160 + src/db.ts:1544-1567 — the request_handoff → HandoffRequested → durable handoffs projection + lease state machine: the durable-intent template
- cli/await.ts:1-51, :886-1016 — the await CLI contract + in-memory SlotState latches that would move daemon-side
- cli/status.ts:193-210, :260-399 — buildStatusEnvelope + needs_human envelope: the additive visibility extension point (golden test/status.test.ts breaks on any new field — required update)
- src/collections.ts:617-826 — collection descriptor registry (a new projection needs a descriptor to be queryable/subscribable)

**Optional** (reference as needed):
- src/daemon.ts:2536-2633 restart ledger; src/baseline-store.ts request spool — the two non-DB durable-store alternatives
- src/await-conditions.ts:1202-1215 landedState; src/dispatch-failure-key.ts reason vocabulary; plugins/keeper/skills/await/SKILL.md; docs/adr/0001, 0003, 0007, 0011

## Acceptance

- [ ] ~/docs/keeper-durable-awaits.md exists and recommends exactly one visibility surface and one durable-await mechanism, each with named integration points verified against current code
- [ ] The proposal demonstrates compliance with the event-sourcing write rules and handles the worktree-off degrade without false pending signals
- [ ] The doc closes with a follow-up epic decomposition a planner can scaffold from directly

## Done summary

## Evidence
