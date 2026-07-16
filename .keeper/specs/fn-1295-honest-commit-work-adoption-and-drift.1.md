## Description

**Size:** M
**Files:** src/commit-work/surface.ts, test/commit-work-adoption.test.ts

### Approach

Make positively-terminal evidence reachable on a busy board while
preserving fail-closed for live/ambiguous claimants (ADR 0068 decision 1).
A claim is positively terminal when a terminal event for its session is
ingested at id E, the ingestion cursor has passed E, and no un-ingested
receipt tail exists for THAT session. Two behavior changes: the ordered
proof no longer requires the terminal event to BE the session tail
(unrelated later events must not displace it — the terminal event must
instead be that session's last lifecycle word), and un-ingested receipts
demote only their OWN session's claims instead of every claim. The
classifier runs producer-side on a read-only snapshot, so cursor and
liveness reads are legal; keep every new read inside the existing shared
snapshot to avoid torn reads.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/commit-work/surface.ts:819-829 — hasOrderedTerminalProof; the sessionTailEventId equality to relax
- src/commit-work/surface.ts:361-400 — readReceiptClaims; the unorderedSessions global demotion to scope per-session
- src/commit-work/surface.ts:1056-1074 — the demotion loop consuming unorderedSessions
- src/commit-work/surface.ts:1086-1091 — the head read; where a cursor-freshness read joins the snapshot
- src/commit-work/surface.ts:1169-1185 — defaultClaimLiveness; terminal requires ordered proof + ended/killed

**Optional** (reference as needed):
- src/commit-work/surface.ts:660-669 — the dead-letter fail-closed sink; must stay untouched
- docs/adr/0068-commit-work-vacated-claims-and-honest-drift.md — decision 1 rationale

### Risks

- Relaxing the tail equality must not let a terminal event followed by a LATER resume/mutation of the SAME session read terminal — the per-session tail check is the guard; enumerate resume-after-terminal in the matrix.
- The host-global unorderedSessions demotion also protects the caller's own claims from ordering races; scope the change to foreign-terminal classification only.

### Test notes

Extend the table-driven matrix in test/commit-work-adoption.test.ts:
terminal event + later unrelated event → adoptable; terminal event +
later SAME-session receipt → not terminal; other session's pending
receipt → no effect; cursor behind E → not yet terminal; live/unknown
rows byte-identical to today. Target the file directly; bare `bun test`
is rejected.

## Acceptance

- [ ] A foreign claim with ingested terminal evidence classifies terminal despite later unrelated events and other sessions' pending receipts
- [ ] A claim whose own session has an un-ingested receipt tail or a cursor-unreached terminal event does not classify terminal
- [ ] Every live/ambiguous row of the existing adoption matrix is unchanged
- [ ] The touched suite passes plus the fast gate

## Done summary

## Evidence
