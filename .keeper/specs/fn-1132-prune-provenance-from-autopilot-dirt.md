## Overview

The shared-checkout dirt-grace escalation shipped with a doc comment that
embeds past-tense incident provenance, violating CLAUDE.md rule #0 (code
comments carry forward-facing advice only; history/rationale live in
`docs/adr/`). This is a small standards cleanup: strip the incident clause
from the code comment while preserving its forward-facing intent.

## Acceptance

- [ ] The `SHARED_CHECKOUT_DIRTY_GRACE_SEC` comment carries no past-tense incident provenance
- [ ] The forward-facing rationale ("persistent operator dirt surfaces fast") is preserved
- [ ] The incident rationale is captured in `docs/adr/` or a commit message if not already recorded

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | culled | — | main() dirtyRepos filter coverage gap is theoretical, no user impact; auditor states no action required and the mirrored wedge loop ships untested. |
| F2 | kept | .1 | autopilot-worker.ts:1047 comment embeds past-tense incident provenance, a verified rule #0 violation. |
| F3 | culled | — | fn-id test section header follows the tree's pervasive accepted fn-id-marker convention, not a standards break. |
| F4 | culled | — | duplicated dirt/wedge machinery is deliberate and defensible; actionable only on a hypothetical third sibling. |
| F5 | culled | — | daemon.ts:6315 clears dirt ids via the wedge verb but is correct today (all verbs literal daemon); no current defect. |

## Out of scope

- Test coverage for the main() dirtyRepos filter wiring (F1 — culled)
- Deduplicating the dirt/wedge tracker machinery (F4 — culled)
- Renaming the distress-verb constant at the daemon clear seam (F5 — culled)
