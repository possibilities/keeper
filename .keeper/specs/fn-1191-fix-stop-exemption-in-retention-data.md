## Overview

The retention data-loss sentinel (`countAbsentBlobs` in `src/compaction.ts`)
now AND-NOTs `RETENTION_NULL_TOLERANT_KEEP_PREDICATE`, which lists `Stop`
among the body-absent-tolerant keep-set classes. But a session's FINAL Stop
body feeds `computeMonitors` -> `jobs.monitors`, a byte-identical re-fold
charter projection — so the exemption blinds the sentinel on the one exempted
class whose body genuinely feeds a deterministic-replay fold input, and its
justification comment (plus the source task's done-summary) asserts the
opposite. Resolve the mismatch: either narrow the exemption to keep `Stop`
flagged, or keep the exemption and correct the false re-fold-safety claim,
spelling out why a final-Stop `'[]'` divergence is acceptable.

## Acceptance

- [ ] The Stop clause of `RETENTION_NULL_TOLERANT_KEEP_PREDICATE` no longer
      rests on a false "no fold reads its body" rationale — either `Stop` is
      removed from the exemption (sentinel keeps flagging it) or the
      justification is corrected to state that its body feeds `jobs.monitors`
      (a byte-identical charter projection) and why the divergence is benign.
- [ ] A pinning test NULLs a final-Stop body carrying live `background_tasks`
      monitors and re-folds (cursor=0), asserting the chosen behavior.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Stop fold (reducer.ts:8608) feeds event.data.background_tasks into computeMonitors -> jobs.monitors, a byte-identical re-fold charter projection; the exemption comment claiming its body no fold reads is false for a final Stop and blinds the sentinel on a charter fold input. |
| F2 | merged-into-F1 | .1 | F2 (Test Gap: no test proving Stop-exemption benign-ness) shares F1's root cause, the Stop clause's re-fold safety; folded into F1's task, which adds the NULLed-final-Stop-body re-fold pinning test. |

## Out of scope

- The four confirmed-correct exemptions (SubagentStop, modern PostToolUse:Agent, ResumeTargetResolved, SessionStart) — verified re-fold-safe against the reducer, left as-is.
- Any change to `computeMonitors` or the `jobs.monitors` charter itself.
