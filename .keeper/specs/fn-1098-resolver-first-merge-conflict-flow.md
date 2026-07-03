## Overview

On a sticky worktree-merge-conflict, the human/planner escalation sweep and the
resolve::<epic> resolver dispatch fire on the same row seconds apart — witnessed live: the
planner and the autonomous resolver concurrently re-created and resolved the SAME conflict
in the SAME base worktree, each believing it owned the resolution (benign only because both
produced identical content). Chosen flow (human directive, mirroring the blocked-worker
escalation pattern): the resolver owns merge conflicts — it runs the better-suited model for
that task class; the creator/planner escalation fires ONLY after the resolver stamps BLOCKED
(not-mechanically-clear) or its job dies, expected to be a far edge case.

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT id, merge_escalated_at, resolver_dispatched_at FROM dispatch_failures"` — both stamps on one sticky row is the anti-pattern this epic removes

## Acceptance

- [ ] A sticky merge conflict dispatches the resolver without notifying the planner; the planner escalation fires only on the resolver's BLOCKED stamp or job death
- [ ] An operator pausing autopilot mid-conflict cannot silently race an in-flight resolver
