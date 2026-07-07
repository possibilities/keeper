## Overview

Design-investigation epic: produce the written proposal that makes keeper
awaits durable beyond their arming session and makes a plan-closed epic with
an unmerged lane visible on a paused board, so "closed" is never mistaken
for "landed". Implementation is decomposed from the doc's findings via a
follow-up plan.

## Quick commands

- `ls ~/docs/keeper-durable-awaits.md` — the deliverable exists
- `rg -a "worktreeMode && !state.paused" src/autopilot-worker.ts` — the finalize gate the doc must explain (note: `-a` required, the file trips grep's binary heuristic)

## Acceptance

- [ ] A design doc exists at ~/docs/keeper-durable-awaits.md recommending one visibility surface and one durable-await mechanism, each grounded in verified current code
