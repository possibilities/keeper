## Description

**Size:** M
**Files:** src/worktree-git.ts, src/autopilot-worker.ts, src/derivers.ts, src/db.ts, src/reducer.ts, cli/escalation-brief.ts, test/db.test.ts

### Approach

Make the conflicted file set a structured fact instead of prose trapped in git
stderr. At the merge seam that classifies a fan-in conflict, capture the conflicted
paths (unmerged-status diff in the merge dir, before any cleanup/abort), bounded to a
sane cap, and thread them through the producer's failure reason into the
DispatchFailed synthetic event payload as a conflict_files array — work-verb fan-in,
close-sink, and recover-backstop sites alike. Add a conflict_files TEXT column
(JSON array) to dispatch_failures via one additive SCHEMA_STEPS entry with the
SCHEMA_FINGERPRINT re-pinned; the step's version is assigned at merge time (the
ladder is a singleton resource and a sibling epic is in flight — never hardcode the
next number). The fold copies payload to column reading ONLY event data — absent
field folds to empty, malformed folds safe, never throws — so re-fold stays
deterministic. The escalation brief prefers the structured field when present and
keeps the stderr-regex fallback for legacy rows.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/worktree-git.ts — mergeBranchInto's conflict classification, the capture seam
- src/autopilot-worker.ts:4159-4174 and :6001 — the fan-in and recover-backstop sites whose reasons become DispatchFailed events; how the launch loop mints the event
- src/db.ts — the SCHEMA_STEPS ladder tail, addColumnIfMissing precedent (merge_escalated_at / resolver_dispatched_at), SCHEMA_FINGERPRINT pin, and the dispatch_failures fold's write site in src/reducer.ts
- cli/escalation-brief.ts:424 — parseMergeConflictReason and the incident envelope the structured field joins

**Optional** (reference as needed):
- docs/adr/0020-schema-version-renumber-at-merge-time.md — the merge-time renumber contract
- test/db.test.ts — the fingerprint pin assertion that re-pins with the step

### Risks

- The capture runs inside a wedged merge state — it must never leave additional residue (read-only probe before the existing cleanup path) and must tolerate capture failure by folding to empty rather than losing the conflict row
- Sibling epic fn-1239 lands its own ladder step — expect a merge-time version renumber, keep the step additive-idempotent

### Test notes

Fold tests: payload with files → column populated; legacy payload without the field →
empty, no throw; re-fold byte-identical. Escalation-brief tests: structured field
preferred, regex fallback intact. Fingerprint test re-pinned in the same change.

## Acceptance

- [ ] A fan-in merge conflict produces a dispatch_failures row whose conflict_files lists the conflicted paths, and a re-fold reproduces it byte-identically
- [ ] Historical events without the field fold to an empty list without error; the fold never throws on malformed data
- [ ] The escalation brief envelope carries the structured conflicted-file list when present and falls back to stderr parsing otherwise
- [ ] The schema ladder gains exactly one additive step with the fingerprint re-pinned, its version documented as merge-assigned

## Done summary

## Evidence
