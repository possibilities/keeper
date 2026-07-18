## Overview

`closePhaseResume` grades the two selection-phase artifacts
(`followup-brief.json`, `followup-verdict.json`) through the audit-family
schema ceiling `AUDIT_SCHEMA_VERSION`, even though those artifacts carry
their own independent ladders (`SELECTION_BRIEF_SCHEMA_VERSION` /
`SELECTION_SCHEMA_VERSION`). Today every ladder is 1 so nothing misbehaves,
but a future bump of either selection ladder past the audit ladder would make
a legitimately-current selection artifact read as too-new — silently
disabling selection-phase resume and re-spawning the `plan:model-selector`
subagent on every resume. This corrects the cross-family gate so the resume
optimization survives an independent selection-schema bump.

## Acceptance

- [ ] The selection-artifact reads in `closePhaseResume` grade against the
      selection-family schema ceiling, not `AUDIT_SCHEMA_VERSION`.
- [ ] A selection artifact whose `schema_version` exceeds the audit ladder
      but is within its own selection ladder grades `selection: satisfied`
      (given fresh input-hash), not `unfinished`.

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | closePhaseResume gates the SELECTION_*-stamped selection artifacts through the audit ceiling AUDIT_SCHEMA_VERSION; a future selection-ladder bump silently disables selection-phase resume. |
| F2 | culled | — | Prod-unused followupMetaPath helper; cleanliness nit, no impact. |
| F3 | culled | — | Underscore-silenced dead test helper + lint collateral in the feature commit; disclosed, no runtime surface. |
| F4 | culled | — | closePhaseResume long-function altitude call; reads cleanly as a linear cascade, leave as-is. |
| F5 | culled | — | Missing test for safe-degrading mid-chain invalidation branches; no defect shown, budget already 2.2:1. |
| F6 | culled | — | Missing test for the safe empty-decisions branch; branch reads correct, no defect. |

## Out of scope

- Any change to the audit-family artifacts (report/verdict/followup metas), whose shared audit ceiling is correct.
- The test-coverage gaps (F5/F6) and code-cleanliness items (F2/F3/F4) declined at audit close.
