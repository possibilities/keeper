## Overview

fn-990 fixed the worktree finalize routing but its base-teardown sweep is too
broad and one push-timeout window strands a merge. This epic closes both, plus a
stale doc. Recover pass-3 tears a base/rib down gated only on is-ancestor-of-default
— but a lane is BORN at the default tip (reflexive ancestor), so an OPEN epic's
base (and a clean fresh rib) is destroyed mid-flight. And a base merged to LOCAL
default whose push then timed out is, next cycle, torn down without the merge ever
reaching origin. End state: pass-3 preserves an active epic's lanes (tri-state on
epic activity) and never deletes a base whose merge isn't on origin; finalize docs
match the projection-done gate.

## Acceptance

- [ ] pass-3 PRESERVES an open epic's reflexive-ancestor base/rib; still SWEEPS a merged base/rib whose epic is absent (reaped) OR done
- [ ] a base merged to local default but not yet on origin is re-pushed before teardown (no silently-stranded merge)
- [ ] the README worktree section describes the projection-done (isEpicDone) finalize gate, with no reference to the removed epicBaseHasDoneState lane-read
- [ ] finalize-side reasons stay outside the worktree-recover* auto-clear scope; recover-side keep it

## Early proof point

Task that proves the approach: `.1` (the tri-state pass-3 guard + the present-not-done probe). If it fails: the projection-presence probe can't be threaded cleanly → fall back to a status-enum probe widening isEpicDone.

## References

- A blind multi-model panel confirmed fn-990's routing fix is correct and isolated these as the only remaining blockers; a gap-analyst pass pinned the pk-bypass-probe requirement and the pass-3/F3 coupling. Builds on fn-990.
