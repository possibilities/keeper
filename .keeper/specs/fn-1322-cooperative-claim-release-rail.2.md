## Description

**Size:** M
**Files:** cli/commit-work.ts, test/commit-work.test.ts, test/pi-commit-work-tool.test.ts

### Approach

Attach ADR 0078's typed request-release pointer to the
ownership-conflict refusal at ALL FOUR emit sites (initial surface,
post-lint, before-publication, generic — the reason fields already
discriminate them): the pointer names the claimant session identity,
the contended paths, the release verb invocation the claimant would
run, and the requester protocol — send ONE bounded advisory notice
over the existing bus chat rail (send-only; delivery is best-effort
and never load-bearing), wait the stated grace, re-run commit-work,
and on a still-live conflict stamp BLOCKED with the request evidence
so the existing escalation ladder carries it (no new paging
machinery). A durable DECLINE recorded by the claimant surfaces on the
refusal as a distinct annotation the requester honors with
attempt-budgeted backoff — never a tight re-ask loop. The pointer is a
new FIELD on the existing ownership_conflict outcome (the closed
outcome union does not fork), and the pointer's samples respect the
existing conflict sample bounds. The Pi-side commit-work tool surface
pins the envelope shape — co-update its expectations in the same
change.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/commit-work.ts:807-836, :848-916, :1573-1608 + src/commit-work/surface.ts:1798-1810 — the four ownership_conflict emit sites
- cli/commit-work.ts:416-458 — the closed CommitWorkOutcome union + result() builder (extend fields, never fork)
- cli/commit-work.ts:733-767 — selectedForeignConflicts (the claimant+paths aggregation the pointer consumes); :863 the SAMPLE_LIMIT bound
- test/pi-commit-work-tool.test.ts — the pinned Pi-side envelope surface (co-update)
- docs/adr/0078-cooperative-claim-release.md — the requester protocol contract
- Task 1's landed release-record surface — the verb syntax the pointer names

**Optional** (reference as needed):
- src/provider-leg-death-notice.ts:203-284 — truncateUtf8/boundedString for any new bounded strings

### Risks

- Missing one emit site makes the rail silently unavailable on that refusal path — all four carry the pointer or none do
- The pointer must never imply the requester may signal the peer — its protocol text routes to the notice + ladder only

### Test notes

Envelope assertions at each emit site (pointer present, bounded,
correct claimant/paths); the DECLINE annotation path; the Pi tool
surface expectations updated in the same change.

## Acceptance

- [ ] Every ownership-conflict refusal, from any of its emission points, carries the typed request-release pointer with claimant identity, contended paths, and the stated requester protocol
- [ ] A durable decline surfaces as a distinct annotation and the stated protocol directs attempt-budgeted backoff, never immediate re-request
- [ ] The Pi-side tool surface expectations match the extended envelope; the outcome union is extended, not forked
- [ ] The full fast correctness gates stay green

## Done summary

## Evidence
