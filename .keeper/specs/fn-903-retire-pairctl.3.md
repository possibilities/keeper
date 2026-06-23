## Description

**Size:** S
**Files:** cli/pair.ts, src/pair-command.ts, cli/await.ts

### Approach

Rewrite the ~13 residual pairctl comments in the keeper pair implementation to FORWARD-FACING
prose: drop the "Ported verbatim from pairctl" / "Mirrors pairctl's X" provenance (which dangles
once pairctl is deleted) and state what the code does in the present tense, keeping the
behavioral description and dropping the cross-reference to the removed package. Per the
forward-facing-prose rule (`keeper prompt render code-comment-style`).

### Investigation targets

**Required:**
- src/pair-command.ts:5,38,62,123,206,237,417,446,462,480,505 (pairctl provenance comments)
- cli/pair.ts:5 ; cli/await.ts:136

### Risks

- Comment-only — do not change behavior, only the prose. Keep any genuinely load-bearing
  invariant the comment states; just drop the "ported from pairctl" framing.

### Test notes

No behavior change; existing pair tests stay green. Grep confirms no live `pairctl` references remain in these three files.

## Acceptance

- [ ] all pairctl provenance comments in the 3 files rewritten forward-facing (no "ported from" / "mirrors pairctl" tombstones)
- [ ] no behavior change; pair tests green

## Done summary
Rewrote the residual pairctl provenance comments in cli/pair.ts, src/pair-command.ts, and cli/await.ts to forward-facing prose, dropping the 'ported from'/'mirrors pairctl' tombstones while keeping behavioral invariants. Comment-only; 39 pair tests green.
## Evidence
