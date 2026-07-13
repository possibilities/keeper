## Description

**Size:** S
**Files:** src/agent/launch-config.ts, test/agent-launch-config.test.ts, test/agent-run-capture-golden.test.ts, test/birth-record.test.ts, test/autoclose-worker.test.ts

### Approach

Fix the generic tracked-Pi launch contract: whenever a keeper-launched Pi process has an explicit Tmux session, inject that exact session through the existing process-scoped carrier consumed by the births tree. Launches without an explicit session remain unstamped. Remove the stale assumption that Pi is untracked while preserving harness-neutral birth-record construction and avoiding server-wide tmux environment mutation.

Keep daemon autoclose fail closed. The immutable Tmux birth session is only one ownership fact and must still be corroborated by current session membership, canonical Generation, exact pane identity, single-pane window, and prompt-free stopped state. The change is prospective; older NULL birth records are not mutated or inferred.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/agent/launch-config.ts:194-248` — shared agent argv builder and Claude-only session-carrier branch.
- `src/birth-record.ts:228-309` — harness-neutral environment-to-birth provenance path.
- `src/agent/main.ts:3382-3442` — non-Claude child spawn and birth-draft emission.
- `src/autoclose-worker.ts:296-409` — panel birth-session and live-topology corroboration rails.
- `test/agent-launch-config.test.ts:533-604` — stale Pi-untracked assertions and exact argv fixture.

**Optional** (reference as needed):
- `test/agent-run-capture-golden.test.ts:228-254` — Pi launch argv golden.
- `test/birth-record.test.ts:211-309` — environment-derived session and Pi birth fixtures.
- `test/autoclose-worker.test.ts:304-327` — positive panel provenance classifier case.
- `docs/adr/0051-panel-run-ownership-and-task-cancellation.md` — prospective tracked-Pi provenance decision.

### Risks

A broad session carrier must not mark a launch that has no explicit Tmux session or confuse current placement with frozen birth provenance. The carrier is coordination metadata, not sole authorization; weakening Generation or live-topology checks would turn it into an unsafe cleanup capability. Exact argv goldens are intentionally coupled and must change only by the new Pi carrier.

### Test notes

Pin Pi argv with and without explicit session, verify the carrier reaches the pure birth draft unchanged, and feed the resulting frozen field through the existing panel autoclose classifier with all other rails valid. Preserve Claude behavior and ensure no accidental carrier appears on unrelated sessionless launches. No real subprocess, daemon, Worker, or tmux server.

### Detailed phases

1. Generalize process-scoped Tmux session injection to tracked Pi launches with explicit sessions.
2. Update exact argv and golden fixtures while removing stale untracked-Pi commentary.
3. Add a cross-seam birth-to-panel-autoclose regression proving positive provenance plus existing corroboration.
4. Assert prospective-only behavior for absent session inputs and older NULL births.

### Alternatives

Special-casing only the `panels` session was rejected because the missing fact belongs to the generic tracked-Pi launch contract. Replacing frozen birth provenance with current tmux location was rejected because a moved or foreign window could satisfy it.

### Non-functional targets

Injection remains an argv array/process environment operation with no shell expansion or server-wide state mutation. Existing carrier ordering stays deterministic for golden stability.

### Rollout

New tracked Pi launches with explicit sessions become autoclose-eligible when every existing topology rail passes. Existing jobs with NULL birth session remain unchanged and may require exact operator cleanup.

## Acceptance

- [ ] Every keeper-launched tracked Pi process with an explicit Tmux session receives that exact process-scoped birth-session carrier.
- [ ] A tracked Pi launch without an explicit Tmux session remains unstamped.
- [ ] The carrier reaches the immutable birth record through the existing harness-neutral path without direct jobs writes.
- [ ] A stopped Pi panel job with valid exact topology and the stamped `panels` birth session passes the existing daemon autoclose classifier.
- [ ] Missing birth provenance, NULL Generation, wrong live session, prompt-active, multi-pane, or non-stopped states remain ineligible.
- [ ] Claude launch behavior and unrelated non-Pi launch behavior remain unchanged.

## Done summary

## Evidence
