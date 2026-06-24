## Overview

`keeper handoff` lets one agent (usually relaying a human who says "hand this
off") enqueue a contextful document + instructions for a fresh fire-and-forget
claude worker, dispatched by a keeperd worker into the INITIATOR's tmux session.
The enqueue is event-sourced (a sixth mutating RPC → `HandoffRequested` →
a durable `handoffs` projection); the dispatcher mints a durable pre-launch
marker (transactional-outbox) so a crash can't double-launch. The
handoff-er→handoff-ee relationship is a job→job edge (NOT epic-anchored, unlike
planner/refiner), folded purely from `HandoffRequested` + the callee's
`SessionStart` and rendered on the board + dash. A `keeper:handoff` skill drives
it for humans; a `handoff_prompt_prefix` config key boots each handoff-ee into
`/hack`.

## Quick commands

- `keeper handoff --prompt "Investigate X; context: ..." --title "explore X"`  # enqueue
- `keeper handoff show <handoff_id>`   # the dispatched worker's first call — prints the brief
- `keeper board`   # the handoff-from / handoff-to relationship renders on initiator + handoff-ee

## Acceptance

- [ ] An enqueued handoff dispatches a fresh worker into the initiator's tmux session, preloaded (via `/hack`) with the doc
- [ ] The handoff-er→handoff-ee relationship renders on the board AND the dash
- [ ] Re-fold determinism holds (`handoffs` is deterministic-replayed, in all three wipe blocks); folds never throw
- [ ] A daemon restart mid-dispatch neither double-launches nor strands the handoff
- [ ] SCHEMA bump + `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS in one commit; `test:full` green

## Early proof point

Task that proves the approach: `.1` (schema + config + types). If the migration +
from-scratch re-fold round-trip don't hold, the durable-projection classification
is wrong — recover by re-checking the projection-class taxonomy before building
the RPC and worker on top of it.

## References

- Planner/refiner relationship — the SPIRIT being mirrored, but epic-anchored: `src/plan-classifier.ts:195`, `src/reducer.ts:5450` (enrichJobLink), `cli/board.ts:270`
- Autopilot mint-before-launch protocol — the dispatch template: `src/autopilot-worker.ts:1211`
- `set_epic_armed` — the 5-hop mutating-RPC template: `cli/autopilot.ts:470` → `src/server-worker.ts:1978` → `src/rpc-handlers.ts:266` → `src/daemon.ts:2124`
- Dep/overlap context: fn-941 (owns the v86 bump + active `src/daemon.ts` + `cli/board.ts` edits — handoff re-bases its schema version on it), fn-945 (`src/daemon.ts` distinct region + `src/db.ts` comment), fn-943 (strips CLAUDE.md + installs the ≤120-line `commit-work` linter — handoff's CLAUDE.md edit lands after it)

## Docs gaps

- **README.md**: six-surface RPC invariant (was five) + `request_handoff`; worker roster count; config catalogue (+`handoff_prompt_prefix`); a v-NN schema-history entry; board-render narrative; clarify `handoff::` is a SEPARATE spawn-name class
- **CLAUDE.md / AGENTS.md**: minimal surface-count edit (five→six), landing after fn-943's strip within the ≤120-line gate

## Best practices

- **Transactional outbox:** mint the durable `HandoffDispatching` marker BEFORE the spawn; accept at-least-once and guard with a level-triggered bind check ("does a `handoff::<id>` SessionStart exist?") so boot-recovery never double-launches.
- **Side effects outside the fold:** the fold is the pure decider; the worker is the process-manager reactor — a fold that spawns is a re-fold time-bomb.
- **Bounded blob in the event log:** cap the doc (64KB) since it rides inline in `events.data` (the canonical fold source); an uncapped body is a replay time-bomb.
- **Liveness = the bind event, not the tmux window:** a window can outlive the process; `SessionStart` is the authoritative bind signal.
