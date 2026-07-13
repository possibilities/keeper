## Description

**Size:** M
**Files:** src/autoclose-worker.ts, src/exec-backend.ts, test/autoclose-worker.test.ts, test/keeper-guard.test.ts

### Approach

Add a dedicated wrapped autoclose bucket to the existing pure decision core. Membership requires positive stopped job state, live resolved tmux topology, birth in the shared `wrapped` Tmux session, and a provider-leg task-title shape; all teardown continues through the current exact pane/window identity rather than reconstructing a target from the title. Apply the existing grace, config, prompt, generation, cap, and autopilot-pause rails, and accept both bare and legacy-prefixed title forms during rollout.

A provider leg owns no Plan readiness row, so its own positive stopped state is the bucket's done signal. Keep cleanup level-triggered and best-effort: an already-absent window is converged, while an exact kill failure preserves eligibility for a later pulse and never changes a captured provider result.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `src/autoclose-worker.ts:1-35` — existing positive-provenance bucket contract and safety rails.
- `src/autoclose-worker.ts:194-340` — bucket membership, stopped-state gating, live topology, prompt, generation, and managed-session checks.
- `src/autoclose-worker.ts:378-425` — grace-map and blast-cap behavior that the new bucket must reuse.
- `src/exec-backend.ts:227-235` — managed tmux session constants and the appropriate home for the shared `wrapped` session name.
- `test/autoclose-worker.test.ts:1-150` — fixture shapes and existing autopilot/panel/escalation bucket matrix.

**Optional** (reference as needed):
- `src/agent/run-capture.ts:38-190` — exact run-owned teardown precedent; autoclose must not recreate targets from titles.
- `src/agent/tmux-launch.ts:503-582` — exact window IDs and shared-session creation behavior.
- `docs/adr/0056-wrapped-provider-leg-window-lifecycle.md` — accepted lifecycle boundary and rollout contract.

### Risks

A session-name-only heuristic could close an unrelated manual window; require the dedicated birth session plus provider-leg task-title grammar and every existing exact topology rail. Do not broaden eligibility to `working`, capture `timed_out`, missing-transcript, or ambiguous states. Closing the last window removes the Tmux session by design and must not be treated as an error.

### Test notes

Extend the pure in/out matrix with bare and legacy provider-leg titles, working/stopped state, wrong birth session, malformed title, prompt-active, unresolved generation, moved pane, disabled config, paused autopilot, grace, and cap cases. Exercise only injected tmux seams; no real subprocess, daemon, Worker, or tmux server.

### Detailed phases

1. Add the canonical shared-session constant and wrapped bucket vocabulary.
2. Extend pure eligibility classification without changing existing bucket semantics.
3. Add exact positive and negative matrix coverage, including legacy convergence and last-window disappearance semantics.
4. Verify existing keeper-managed-session guard coverage includes the new constant where required.

### Alternatives

Persisting a new `dispatch_origin` on provider legs would add fold/schema work for a non-owning Harness session and risk making the child look like a second Board owner. A title-only or session-wide tmux sweep would weaken the exact-identity safety model.

### Non-functional targets

Preserve deterministic candidate ordering, the existing per-pulse kill cap, and one bounded tmux pane sweep per pulse. Add no filesystem, wall-clock, or process-liveness reads to a Fold.

### Rollout

Recognize legacy prefixed titles only for eligibility compatibility; all new launches use bare titles. Existing config and pause controls provide immediate disable/rollback without a migration.

## Acceptance

- [ ] A stopped, prompt-free, exact-topology provider-leg job born in `wrapped` becomes eligible after the configured grace and is targeted by its resolved pane/window identity.
- [ ] Both bare task-ID titles and legacy `wrapped::<task-id>` titles qualify during rollout.
- [ ] Working, prompt-active, malformed-title, wrong-session, unresolved-generation, moved-pane, disabled, paused, and pre-grace cases remain ineligible.
- [ ] Existing autopilot, panel, and escalation bucket decisions remain byte-consistent under their current fixtures.
- [ ] The wrapped bucket remains blast-capped and deterministic when several provider legs become eligible together.

## Done summary
Wrapped autoclose bucket (positive stopped state, exact tmux topology, wrapped birth session, bare/legacy provider-leg title) already landed in f9874e45; verified via targeted tests and diff review, no further changes needed.
## Evidence
