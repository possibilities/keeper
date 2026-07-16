# 0068 — Commit-work vacated claims and honest drift refusals

## Status

Accepted. Provisional number — fan-in renumbering per ADR 0020/0022. Amends
[ADR 0063](0063-commit-work-explicit-adoption-and-atomic-publication.md):
narrows its "only positively terminal claims are adoptable" clause and its
"any later DB event or unordered receipt keeps its claims unknown" rule
without weakening the fail-closed core.

## Context

Commit-work's ownership evidence keeps the fail-closed property for live and
ambiguous claimants — correct and non-negotiable. But on a busy multi-agent
board three structural effects made foreign-TERMINAL claims effectively
unadoptable, forcing operators to land verified work with raw git and hand
SIGTERMs (eleven times in one day, corpus in the operator remediation log):

- The ordered-terminal proof required the terminal event to BE the session
  tail; any later unrelated event displaced it, so genuinely-dead claimants
  read unknown forever.
- Any un-ingested receipt demoted EVERY claim of that session (and after a
  daemon restart, effectively every session) to non-terminal — a host-wide
  adoption blackout misreported as `ownership_conflict` against dead sessions.
- A stopped-but-resident or orphaned claimant had no sanctioned discharge
  path; the ownership record could outlive both the process and the registry
  rows with no clear verb.

Separately, publication CAS refused on drift that could not affect the
selection: `.keeper` runtime churn and HEAD advances not touching the
selected paths.

## Decision

1. **Terminal-evidence soundness is per-session and cursor-fresh.** A claim
   is positively terminal when a terminal event for its session is ingested
   at id E, the ingestion cursor has passed E, and no un-ingested receipt
   tail exists for THAT session. Unrelated later events no longer displace
   the proof; other sessions' pending receipts no longer demote it.
2. **Vacated claims.** A claimant proven gone by the pid-and-start-time
   witness (pid absent, or start time mismatched) classifies its claims
   adoptable, read-side only: no new RPC surface, no schema step, and the
   durable record persists. A stopped-but-resident claimant with a matching
   start time is never auto-vacated — it is resumable, and fail-closed holds.
3. **`keeper session terminate <session>`** is the sanctioned operator verb
   for stopped-resident claimants: an identity-rechecked TERM-then-KILL of
   the claimant process. It signals a process; it never writes the DB — the
   terminal evidence folds from the session's own exit like any other death.
4. **Receipts-pending is a typed outcome, not an ownership conflict.** When
   un-ingested receipts are the only thing blocking an otherwise-terminal
   foreign adoption, commit-work returns `receipts_pending` carrying the
   ingest lag and an honest stalled-ingester flag; the invoking worker owns
   bounded jittered retry. `ownership_conflict` narrows to genuinely live or
   unknown owners.
5. **Publication CAS is selection-scoped.** The private-index compare ignores
   exactly the classifier's excluded prefix (`.keeper`); a HEAD advance whose
   delta does not intersect the frozen selection triggers a bounded internal
   re-freeze-and-retry on the moved tip instead of a refusal. The moved ref
   is never rolled back, and the whole-tree hook/config mutation defense is
   unchanged.
6. **No authority relaxation.** `task_unbound` and the plan-guard bypass stay
   unwired: adoption plus vacated-claim classification covers the operator
   flow from the operator's own session, and a claimant-supplied assertion
   never proves terminality.

## Consequences

- Workers commit their own verified work without operator intervention once
  a dead claimant's evidence is ingested; the operator ritual reduces to
  `keeper session terminate` for resident zombies.
- A wedged ingester surfaces as a named stall in `receipts_pending` envelopes
  instead of an unbounded honest-looking retry.
- The `ownership_conflict` outcome regains precision: seeing it means a live
  or unknown owner, actionable as such.
- The jam gate stays repo-scoped (distress rows carry no path data); its
  refusal envelope gains recovery hints instead of path-scoping.
