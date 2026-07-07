## Description

**Size:** M
**Files:** plugins/plan/audit-policy.yaml, plugins/plan/src/models.ts, plugins/plan/src/brief.ts, plugins/plan/src/selection_sidecar.ts, plugins/plan/src/verbs/assign_cells.ts, plugins/plan/scripts/audit-policy-check.ts, plugins/plan/test/consistency-audit-policy.test.ts, plugins/plan/test/src-brief-claim.test.ts

### Approach

The plan-time sizing seam. A new audit-policy.yaml maps selection signals to audit decisions: which tiers are audit-flagged (ship conservative: max only, xhigh commented ready) and the close-depth band thresholds (task count, diff LOC, touched-repo count) consumed later at close. Drift-gate it the way model-selector.yaml is gated: a check script + consistency test assert every tier in the subagents matrix has an explicit flagged/unflagged mapping and every band names a valid depth. assign-cells applies the policy when it writes cells: a task whose selected tier is policy-flagged gets audit_required stamped on its task JSON (normalizeTask defaults the field null/false — additive, definition-carried, never a live probe). The claim brief gains an audit_required field read straight off the task JSON — present-but-empty-style stable key, mirrored in the Python brief twin if one is live (verify; record absence otherwise). A missing or malformed policy file at assign-cells time degrades to no task flagged, logged in the selection sidecar provenance as degraded, never an error.

### Investigation targets

*Verify before relying — the repo moves; the selection-review removal may have relocated lines.*

**Required**:
- plugins/plan/model-selector.yaml + scripts/model-guidance-check.ts + test/consistency-model-selector.test.ts — the policy-config + drift-gate pattern to mirror
- plugins/plan/src/verbs/assign_cells.ts (or the verb file the deletion leaves) — where cells land on task JSONs; the stamping site
- plugins/plan/src/models.ts:63-73 — normalizeTask defaulting pattern
- plugins/plan/src/brief.ts:24-60 — assembleBrief stable-key discipline (snippet_context precedent) and any Python twin
- plugins/plan/src/selection_sidecar.ts — provenance block for the degrade record

### Risks

- The selection surface is mid-refactor (selection-review removal uncommitted at planning time) — re-read the live verb files before editing; line refs above are advisory.
- Byte-parity: if a Python assemble_brief twin is live, the new key must serialize identically.

### Test notes

Consistency test drives the drift gate; brief tests cover flagged/unflagged/absent-policy; assign-cells saga test asserts the stamp and the degrade.

## Acceptance

- [ ] A policy file maps every configured tier to an explicit audit decision and defines depth bands; the drift gate fails on an unmapped tier or invalid band
- [ ] assign-cells stamps audit_required on tasks whose selected tier is policy-flagged; absent or malformed policy degrades to no flags with provenance recorded
- [ ] Claimed briefs carry the flag with a stable key set, byte-parity preserved with any live Python twin
- [ ] Plan suite green

## Done summary
Add drift-gated audit-policy.yaml (tier_audit map + close-depth bands); assign-cells reads it degrade-soft to stamp audit_required on policy-flagged tiers and records applied/degraded provenance in the selection sidecar; the claim/resume brief carries the flag as a stable key.
## Evidence
