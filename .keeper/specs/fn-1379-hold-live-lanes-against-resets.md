## Overview

A keeper pass `git reset`s a lane worktree while a live session is mid-merge
on it: MERGE_HEAD vanished three times under a live resolver on one lane, and
only an atomic merge+resolve+verify shell invocation could complete. The
per-task recover exclusion is supposed to keep maintenance passes off a lane
a live worker claims; it does not hold. Every lane retry rolls this race
until the exclusion positively holds.

## Quick commands

- `bun test ./test/autopilot-worker.test.ts` — recover/base-freshness pass coverage
- `git -C <lane> reflog` — the witness surface (consecutive `reset: moving to HEAD` entries under a live claim is the defect signature)

## Acceptance

- [ ] The pass that resets live-claimed lanes is identified with event/log attribution
- [ ] No maintenance pass mutates a lane whose task has a live claimed session; a deterministic test proves the hold, including the mid-merge (MERGE_HEAD present) case
- [ ] An excluded pass defers visibly (bounded log/reason), never silently skips

## Early proof point

Task ordinal 1 is the whole epic. If attribution shows the resetter is
external to keeper (not one of our passes), recovery: re-scope to detection —
mint a distress row on any external mutation of a live-claimed lane.

## References

- Lane reflog evidence: consecutive `reset: moving to HEAD` on the fn-4.5 lane during a live resolver session (deconflicter-verified)
- src/autopilot-worker.ts — recover pass + base-freshness producer (the prime suspects)
- src/seed-sweep.ts — the seed/cleanliness sweep family
- Reverse-dep: fn-4-prepare-legacy-corpus-recovery is wired to depend on this epic — its .5 fan-in retry is unreliable until the lane holds still
