## Description

**Size:** M
**Files:** plugins/plan/src/verbs/close_preflight.ts, plugins/plan/src/audit_artifacts.ts, plugins/plan/test/saga-close-preflight.test.ts, plugins/plan/test/saga-close-finalize.test.ts, docs/adr/

### Approach

The `close-preflight` success envelope gains a nullable `phase_resume` field, sibling
to `blocking_followup` and never a new `CloseOutcome` member. A deterministic
validator in the audit-artifacts layer (mirroring `taskFindingCoversCommitSet`)
grades each close phase from its persisted artifacts: `satisfied` when every file of
the phase is present, schema-readable, and its stamped commit_set_hash equals the
fresh lane-aware hash; `not_needed` when an upstream branch fact makes it
inapplicable (`report.meta.findings == 0` skips plan/selection; `verdict.fatal`
skips selection); else `unfinished`. The first invalid phase invalidates itself and
every downstream phase — a stale Phase-2 stamp grades everything unfinished (full
re-audit). Phase 3.5's selection verdict validates against its own input_hash (the
persisted follow-up document), chained on Phase 3 validity. The envelope carries the
branch facts a content-blind closer needs: per-phase grades, findings count, fatal
flag, followup-present, and the selection-verdict path when fresh. A too-new
artifact schema (`ArtifactSchemaTooNewError`) degrades that phase to `unfinished`,
never a preflight failure. An empty artifact set emits `phase_resume: null` (the
ordinary fresh close). Ship the decision as a new provisional-numbered MADR-style
ADR: durable close-phase artifacts + hash-gated deterministic resume, first-invalid-
downstream invalidation, cross-referencing ADR 0070 (attempt-fenced clears), 0028
(blocking-followup gate), and the 0031→0055 finalize-defers lineage.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/close_preflight.ts:471-490 — `blocking_followup` derivation + envelope fold; the new field lands beside it; fresh commit-set hash computed at :360
- plugins/plan/src/audit_artifacts.ts:251-265 — `taskFindingCoversCommitSet`, the validator shape to mirror; `computeCommitSetHash` :294-308 (canonical, order-independent, schema-version-folded — the ONLY staleness key); `readArtifactJson` :373-386 (schema-gated, null on absent, throws on too-new)
- plugins/plan/src/verbs/close_finalize.ts:723-763 — lane-aware `findCommitGroups(epicId)` derivation the validator MUST reuse (HEAD-only hashing spuriously invalidates every worktree close); MERGE_IN_PROGRESS origin :385-404

**Optional** (reference as needed):
- plugins/plan/test/saga-close-finalize.test.ts:81-159 — `seedBrief`/`seedVerdict`/`seedReportMeta`/`seedFollowupYaml` seeding helpers and `armInProgressOp` (test/fake-vcs.ts) for the typed MERGE_IN_PROGRESS injection
- plugins/plan/src/verbs/submit_common.ts:143 — `resolveAuditContext` stamps commit_set_hash on every artifact at emission

### Risks

- Hash derivation not lane-aware — every worktree close spuriously re-audits
- `findings=0` / `fatal` misgraded as `unfinished` — needless expensive re-spawns
- Selection-verdict staleness keyed on the wrong hash (commit-set vs follow-up-doc input_hash)

### Test notes

Drive the real binary via `runCli` in `withProject`; seed artifacts through the same
src writers the verb reads. Scenarios: all-fresh (every phase satisfied, selection
path emitted); stale commit set (all unfinished); findings=0 (plan/selection
not_needed); fatal verdict (selection not_needed); torn Phase 2 (report.md present,
meta absent — unfinished); too-new schema (unfinished, no throw); empty state
(null). Mandated end-to-end: seed all receipts + `armInProgressOp`, first finalize
fails typed MERGE_IN_PROGRESS, re-run preflight asserts skip-all grades, finalize
exactly once (`gitLogCount` + single follow-up mint).

## Acceptance

- [ ] close-preflight emits a nullable phase-resume envelope field grading each close phase satisfied / not_needed / unfinished with the branch facts (findings count, fatal flag, followup-present, selection-verdict path); absent artifacts yield null
- [ ] A phase is graded satisfied only when all its artifacts are present, schema-readable, and hash-fresh against the lane-aware commit-set hash; the first invalid phase invalidates itself and all downstream phases
- [ ] The selection phase validates against the persisted follow-up document's input hash, chained on plan-phase validity
- [ ] Seeded verb tests cover all-fresh, stale, findings=0, fatal, torn-artifact, too-new-schema, and empty-state scenarios, plus the injected finalize-lock retry proving skip-all grades and exactly one finalization and follow-up mint
- [ ] A new provisional-numbered ADR records the durable close-phase artifact + hash-gated resume decision with its cross-references
- [ ] The plan test gate passes

## Done summary

## Evidence
