## Description

From audit finding F1 (evidence path: `plugins/plan/src/audit_artifacts.ts`
— `closePhaseResume` selection block, `artifactHasKnownSchema`, and
`readArtifactJson`). `closePhaseResume` reads the selection-phase artifacts
`followup-brief.json` (stamped `SELECTION_BRIEF_SCHEMA_VERSION`,
`plugins/plan/src/verbs/selection_brief.ts`) and `followup-verdict.json`
(stamped `SELECTION_SCHEMA_VERSION`,
`plugins/plan/src/verbs/apply_selection.ts`) via `safeReadArtifact` →
`readArtifactJson` (throws too-new against `AUDIT_SCHEMA_VERSION`) and gates
them with `artifactHasKnownSchema` (ceiling `AUDIT_SCHEMA_VERSION`). Both
are cross-family: a future bump of either selection ladder past the audit
ladder makes a current selection artifact read as too-new →
`selection: "unfinished"` → the `plan:model-selector` subagent re-spawns on
every resume of a valid persisted verdict.

Fix: read/gate the two selection artifacts against the selection-family
ceilings (`SELECTION_BRIEF_SCHEMA_VERSION` / `SELECTION_SCHEMA_VERSION`)
rather than `AUDIT_SCHEMA_VERSION`, keeping the audit-family artifacts
(report/verdict/followup metas) on the audit ceiling as-is. The safe-degrade
direction (unreadable/torn/stale → `unfinished`) must be preserved for the
selection artifacts.

Files: `plugins/plan/src/audit_artifacts.ts` (primary — the selection reads
in `closePhaseResume` and their schema gate).

## Acceptance

- [ ] `closePhaseResume` grades `followup-brief.json` /
      `followup-verdict.json` against their own selection-family schema
      ceilings, not `AUDIT_SCHEMA_VERSION`.
- [ ] A selection artifact within its own selection ladder but above the
      audit ladder grades `selection: satisfied` (given a fresh
      input-hash), not `unfinished`.
- [ ] Audit-family artifacts (report/verdict/followup metas) still gate on
      `AUDIT_SCHEMA_VERSION`; safe-degrade to `unfinished` on unreadable /
      torn / stale selection artifacts is preserved.

## Done summary

## Evidence
