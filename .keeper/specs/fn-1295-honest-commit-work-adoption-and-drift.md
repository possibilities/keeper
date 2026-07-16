## Overview

Commit-work's fail-closed ownership evidence made foreign-TERMINAL claims
effectively unadoptable on a busy board and refused publication on drift
that could not affect the selection. This epic lands ADR 0068: per-session
cursor-fresh terminal evidence, read-side vacated claims plus a sanctioned
`keeper session terminate` operator verb, a typed receipts-pending outcome
with an honest stalled-ingester story, and selection-scoped publication
CAS with bounded internal rebase-retry. Fail-closed for live and ambiguous
claimants is untouched throughout.

## Quick commands

- `bun test ./test/commit-work-adoption.test.ts` — the ownership/liveness matrix
- `bun test ./test/commit-work.test.ts` — outcome envelopes + gates
- `bun run test:gate` — full fast gate before close

## Acceptance

- [ ] A foreign claim whose terminal evidence is ingested becomes adoptable regardless of later unrelated events or other sessions' pending receipts
- [ ] An adoption blocked solely by un-ingested receipts returns the typed receipts-pending outcome carrying ingest lag and a stalled-ingester flag, never ownership_conflict against a dead session
- [ ] A claimant proven gone by the pid-and-start-time witness classifies adoptable with no new write path; a stopped-resident claimant with matching start time stays refused
- [ ] `keeper session terminate` performs an identity-rechecked TERM-then-KILL of a named claimant session and never writes the DB
- [ ] Publication CAS ignores excluded-prefix churn and internally retries over a non-overlapping HEAD advance; genuine selection overlap still refuses; the hook/config mutation defense is unchanged
- [ ] Live/ambiguous fail-closed behavior is byte-for-byte preserved across the adoption matrix

## Early proof point

Task that proves the approach: ordinal 1 (terminal-evidence soundness). If
the per-session tail + cursor-freshness rework cannot preserve the full
fail-closed matrix, stop and re-open ADR 0068's decision 1 before
touching outcomes or CAS.

## References

- docs/adr/0068-commit-work-vacated-claims-and-honest-drift.md (the decision record; amends 0063)
- docs/adr/0063-commit-work-explicit-adoption-and-atomic-publication.md (authority + frozen-identity invariants that stay whole)
- ~/docs/keeper-review-remediation.md (the 11-incident evidence corpus)

## Docs gaps

- **docs/problem-codes.md**: narrow the ownership_conflict row, add the receipts_pending row, reconcile surface_changed/ref_conflict wording (tasks 2 and 4 own their rows)
- **CONTEXT.md**: add Vacated claim + Receipts-pending terms WITH the ≤140-line prune the domain-docs lint requires (task 3 owns it)

## Best practices

- **Cursor-freshness gating:** a cold projection must not manufacture liveness verdicts; convergence is evidence-driven (cursor reaches head), never a fixed sleep [Chubby/ZooKeeper grace]
- **pid + start-time witness:** bare pid liveness is unsound under reuse; `src/proc-starttime.ts` is the local seam [Kleppmann]
- **Assumptions-vs-actions CAS:** refuse only when drift intersects the claimed selection; rebase-retry with jitter and a cap otherwise [Iceberg, git force-with-lease]
- **No claimant-supplied terminality:** receipts are attacker-influenceable; terminality derives only from ingested id-ordered events
