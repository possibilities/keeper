## Description

Make close-claim arbitration liveness-aware in
plugins/plan/src/session_markers.ts:

- Extend the marker schema so a writer records its own pid + process
  start-time alongside session_id/created_at (schema_version bump; readers
  tolerate old markers by falling back to today's stale-bound behavior).
- readRivalCloseClaims (:150-189) probes each rival marker's holder with a
  pid + start-time recycle check (the dep-free src/proc-starttime.ts
  pattern); a provably-dead holder's marker is treated as abandoned —
  ignored for arbitration and removed with one bounded log line. An
  inconclusive probe (no pid fields, probe error) defers to the stale
  bound, never treats the holder as dead.
- claimCloseExclusive (:206-233) wins against abandoned markers in the same
  pass; a live holder still wins by (created_at, session_id) exactly as now.
- Shrink CLOSE_CLAIM_STALE_MS (:37) from 7 days to a bound that only
  backstops un-probeable markers (24h), and name the constant's role in a
  short comment stating the constraint.

Keep tests deterministic and in-process: inject the liveness probe as a
pure seam (function parameter or module seam consistent with existing
session_markers tests); never probe real processes in correctness tests.

Files: plugins/plan/src/session_markers.ts,
plugins/plan/test/ (session-marker arbitration tests).

## Acceptance

- [ ] A dead holder's marker loses arbitration in the same pass (test via
      injected probe) and is removed with bounded logging.
- [ ] A live holder still wins oldest-first; ties break on session_id.
- [ ] Old-schema markers (no pid fields) degrade to stale-bound behavior.
- [ ] Inconclusive probes never classify a holder dead.
- [ ] CLOSE_CLAIM_STALE_MS shrunk to the backstop bound with tests updated.

## Done summary
Made close-claim arbitration in session_markers.ts liveness-aware: markers now record pid + process start-time, readRivalCloseClaims probes rival holders via a pid/start-time recycle check (injected pure seam), a provably dead holder's marker is treated as abandoned and removed with bounded logging while inconclusive probes defer to the stale bound, claimCloseExclusive wins against abandoned markers in the same pass, and CLOSE_CLAIM_STALE_MS shrank from 7d to 24h as the un-probeable-marker backstop.
## Evidence
