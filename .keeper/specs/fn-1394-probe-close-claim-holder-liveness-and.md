Close-claim arbitration is oldest-marker-wins with no holder-liveness probe,
and kill/terminate paths never clear a session's plan markers, so a killed
closer's marker wins every re-close race until the 7-day stale bound ages it
out (backlog #91, MED-HIGH; live specimen: fn-1387's close deadlocked behind
a killed closer's marker through three successor closers). Evidence:
plugins/plan/src/session_markers.ts:206-233 claimCloseExclusive lowest
(created_at, session_id) wins; :150-189 readRivalCloseClaims skips only
markers older than CLOSE_CLAIM_STALE_MS = 7d (:37, applied :183); marker
cleanup happens only on in-session graceful paths
(close_finalize.ts:149,:372,:1415 + lost-race self-release
session_markers.ts:229) — no daemon, terminate, or reap path clears
~/.local/state/keeper/sessions/<sid>.json.
