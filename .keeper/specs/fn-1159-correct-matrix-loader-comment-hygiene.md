## Overview

The fail-loud matrix.yaml fix left two comments out of step with the code and
with the house rules. This follow-up corrects both: strip banned past-tense
provenance and a dangling audit-id from the cross-island parity-test comment,
and realign loadHostMatrix's doc-comment with its actual three-way return
branch. Comment-only work — no behavior change.

## Acceptance

- [ ] The parity-test comment carries only forward-facing advice — no past-tense provenance, no audit finding-id — per CLAUDE.md rule #0.
- [ ] loadHostMatrix's doc-comment describes all three branches: absent/not-a-file returns null, empty/whitespace present file returns null, malformed shape or unreadable present file throws.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | Parity-test comment (src-subagents-config.test.ts:155-158) carries past-tense provenance + a dangling (F1) audit id, violating CLAUDE.md rule #0. |
| F2 | kept | .1 | loadHostMatrix doc-comment (subagents_config.ts:217-222) contradicts its own body (:243-245 empty/whitespace present file returns null, not throws). |

## Out of scope

- Any behavior change to loadHostMatrix / loadMatrix or the parity tests — the fail-loud fix itself audited clean and ships as-is.
- Test Budget, Test Gaps, Security — auditor found nothing material.
