## Overview

The sequenced follow-up to the watch+orient surface: give agents a durable,
subscribable "this epic's lane is merged to the default branch" signal, then
a `landed <epic>` await condition that reads it. This is the signal the
planning daisy-chain actually needs — "plan B against A's MERGED files" —
which `complete` (done-AND-idle) does not guarantee in worktree mode, since a
dependent lane is cut before the upstream's finalize merge lands. fn-1014
built the producer-side merge GATE but deliberately left the durable
observable to this epic. Depends on the core epic for the extended snapshot
(the `worktree_mode` field `landed` degrades on, and the snapshot surface the
merged signal rides).

## Quick commands

- `keeper await landed fn-N-some-epic` — block until that epic's lane is merged to default
- `keeper status --json | jq '.data.board.epics[] | {id, landed}'` — see merge-landed state

## Acceptance

- [ ] A durable, subscribable "epic lane merged to default" signal exists, obeying re-fold determinism + live-only-projection invariants (no git/wall-clock/fs in a fold).
- [ ] `keeper await landed <epic>` fires `met` when the lane is merged (degrades to `complete` semantics when worktree mode is OFF).
- [ ] The planning daisy-chain gate in the plan/hack skills references `landed` where the premise is "author B against A's merged reality."
- [ ] `bun test` green; no new RPC (read-only expansion); the seven-RPC write boundary untouched.

## Early proof point

Task 1 (the durable observable). If a deterministic merged signal can't be
modeled without violating the fold invariants (git-touch in a fold), fall
back to a live-only projection recomputed each cycle (rewind via
`rewindLiveProjection`, never DELETE) — decide that before building `landed`.

## References

- Producer seam: `src/autopilot-worker.ts:1877-1916` (`computeDeferredEpicIds` already probes lane-is-ancestor-of-default git-side each cycle); finalize merge `:2606-2802`.
- fn-1014 built the merge GATE (producer-only ephemeral defer set) and left the durable observable here.
- Snapshot surface + `worktree_mode` field come from the core epic (fn-1015 task 1).

## Docs gaps

- **plugins/plan/skills/plan/SKILL.md (~:572)** and **plugins/plan/skills/hack/SKILL.md (~:199-213)**: repoint the planning-dependent daisy-chain gate from `complete fn-A` to `landed fn-A`. Owned by task 2.
- **plugins/keeper/skills/await/SKILL.md** + **README.md**: add the `landed` condition row/bullet. Owned by task 2.
