## Description

**Size:** M
**Files:** src/commit-work/surface.ts, cli/commit-work.ts, test/commit-work-adoption.test.ts, test/commit-work.test.ts, docs/problem-codes.md

### Approach

When un-ingested receipts are the ONLY thing blocking an otherwise
terminal foreign adoption, commit-work returns a typed
`receipts_pending` outcome instead of ownership_conflict (ADR 0068
decision 4). The envelope carries the ingest lag (events and seconds)
and an honest stalled-ingester flag derived from daemon liveness, so a
dead ingester reads as a named stall rather than an infinitely
retriable refusal. ownership_conflict correspondingly narrows to
genuinely live or unknown owners. The invoking worker owns bounded
jittered retry — document the recovery in the outcome row; commit-work
itself does not sleep.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/commit-work.ts:408-449 — the CommitWorkOutcome union + result() builder the new outcome extends
- src/commit-work/surface.ts:1372-1391 — unsafeForeignSessions; where pending-receipt-only refusals must be distinguished from live/unknown
- docs/problem-codes.md — the `## keeper commit-work` table shape (outcome/meaning/recovery/retry-safe) and exit-code preamble

**Optional** (reference as needed):
- task 1's landed per-session tail machinery — the classification this outcome names
- docs/adr/0068-commit-work-vacated-claims-and-honest-drift.md — decision 4

### Risks

- The outcome must never fire for the caller's own paths or when the claimant is genuinely live — precondition is pending-receipts-blocking-an-otherwise-terminal-foreign adoption only.
- Do not weaken the dead-letter host-wide fail-closed sink; a poison dead-letter still refuses adoption with its existing story.

### Test notes

Envelope-shape tests in test/commit-work.test.ts (lag fields, stalled
flag both ways); matrix rows in test/commit-work-adoption.test.ts for
pending-receipt-only vs live vs unknown claimants. problem-codes row
added with retry-safe semantics.

## Acceptance

- [ ] An adoption blocked solely by the claimant's un-ingested receipts returns receipts_pending with ingest lag and stalled-ingester honesty, and is retry-safe
- [ ] ownership_conflict no longer names sessions whose only blocker is pending ingestion
- [ ] The problem-codes commit-work table documents the new outcome and the narrowed ownership_conflict in the existing four-column shape
- [ ] The touched suites pass plus the fast gate

## Done summary
Typed receipts_pending outcome distinguishes adoptions blocked solely by un-ingested receipts (with ingest lag + stalled-ingester flag) from genuinely live/unknown owners; ownership_conflict narrowed accordingly; problem-codes documents the new row.
## Evidence
