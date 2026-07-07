## Overview

The turn-active escalation lifecycle scopes stage-3 paging to a block instance, but
the instance-scoped read includes NULL-stamped (corroboration-miss) rows for EVERY
instance. A stale NULL row from a resolved prior instance can therefore leak into a
newer instance's read, page the human prematurely, and latch the notify marker so the
genuine re-block page is suppressed. This follow-up closes that isolation hole without
regressing the intended NULL fallback (a genuine corroboration-miss must still be seen
by its OWN instance), and lands the cross-instance contamination test the audit flagged.

## Acceptance

- [ ] A NULL-stamped row from a resolved prior instance no longer matches a newer
      non-null instance's scoped stage-3 read.
- [ ] A genuine corroboration-miss session is still classified/paged for its own
      instance (no regression to the NULL-fallback intent).
- [ ] A regression test covers the cross-instance NULL-contamination path.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | daemon.ts:2222 `escalation_instance = ? OR escalation_instance IS NULL` leaks a stale NULL row from a resolved prior instance into a newer instance's stage-3 read, firing a premature declined page and latching human_notified_at. |
| F2 | culled | — | needs-human.ts:196 blockedWork 'homed' label-vs-code mismatch only diverges in the rare torn-down-epic state; the orphaned sticky is already surfaced elsewhere. Below the keep bar. |
| F3 | merged-into-F1 | .1 | F3 (the NULL cross-instance contamination test) is the coverage for F1's fix; folded into F1's task, same root cause and file touch. |
| F4 | culled | — | F4 is a test for the culled F2 concern; no test warranted for a non-defect. |

## Out of scope

- The `blockedWork` "homed" doc-label precision (F2) — a torn-down-epic-only count nuance already surfaced via `orphanedFailureRows`.
- Any rework of the turn-active occupancy model itself — the isolation fix is scoped to the NULL-inclusion predicate.
