## Description

**Size:** M
**Files:** src/reducer.ts, test/reducer-lifecycle.test.ts, test/refold-equivalence.test.ts, README.md

### Approach

Two moves. FIRST, classify the live repro from the event log (read-only): find the session that read stopped-while-working today (title epic-roadmap-assessment), pull its Stop → task-notification → PreToolUse spine, and record in Evidence which UPS variant arrived (expected: a task-notification whose status is neither completed nor failed — e.g. stopped — falling through the classifier, or a suppressed killed variant). If the classifier itself proves to mis-bucket a variant that SHOULD revive (a completed-equivalent), amend src/derivers.ts:345-363 narrowly; otherwise leave the killed-suppression exactly as-is — the new fold arm makes the classifier's gaps harmless.

SECOND, the structural fix: in the PreToolUse/PostToolUse arm of projectJobsRow (src/reducer.ts:8388-8459), add a third UPDATE that un-stops a PLAIN-stopped row: WHERE job_id = ? AND state = 'stopped' (cold for working/terminal rows — preserves the 50+/turn hot-path profile), SET state='working' and stamp active_since (the rising-edge-only discipline the existing CASEs at :8409-8410/:8429-8430 encode — since the WHERE already pins state='stopped', the SET can be unconditional within it). The resurrection guard is the state='stopped' predicate itself: ended/killed rows are untouchable by construction (the :8398-8405 comment explains the CASE-guard rationale — mirror its reasoning in the new arm's comment, forward-facing). Gate syncIfPlanRef(db, jobId, event.id, ts) on changes > 0 exactly like the sibling arms (:8110, :8416, :8436) so the embedded epics.jobs/task.jobs mirrors follow. Order the new arm so it composes with the annotation-clearing arms (a row with an annotation still clears + revives through the existing arms; the new arm handles the both-NULL case they skip).

jobs is deterministic-replayed: everything stays event-carried; extend the refold-equivalence coverage over the new arm.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:8093-8112 — the Stop arm + fn-1008 guard (context for what precedes the stopped state)
- src/reducer.ts:8388-8459 — the tool-event arm to extend; :7989-8011 the UPS revive to mirror semantics from
- src/reducer.ts:7915-7936 + src/derivers.ts:345-363 — the task-notification classifier and killed-suppression
- test/reducer-lifecycle.test.ts:457-469,5990-6200,6447 — the existing Stop/revive/guard test families to extend

**Optional** (reference as needed):
- src/subagent-invocations.ts:171-186,245-276 — the open-turn predicate and freshness anchor (do NOT change; readiness consumes isOpenTurnRow)
- src/dash/view-model.ts:100-126 — robotRung reads state only; no TUI change needed

### Risks

- Resurrecting a row for a genuinely-dead session's late async PostToolUse: bounded by the state='stopped' gate (terminal rows unreachable) and acceptable-by-design for stopped rows — a stray tool event after a real stop flips the row working until the next Stop folds it back; note this tradeoff in the arm's comment
- Touching the shared open-turn predicate would ripple into readiness — out of scope, do not modify

### Test notes

Red-first: Stop-stopped row (both annotations NULL) + PreToolUse → working with active_since stamped; ended and killed rows + tool event → unchanged; annotation-carrying stopped row still revives through the existing arms (ordering test); syncIfPlanRef fan-out observed on the revive; re-fold determinism case. Record the repro classification (event ids, variant) in Evidence.

## Acceptance

- [ ] Plain-stopped rows revive on tool events; terminal rows never do; annotation arms unaffected
- [ ] active_since rising-edge discipline + mirror fan-out preserved; hot path cold for working rows
- [ ] Repro classified in Evidence; classifier amended only if a completed-equivalent variant was mis-bucketed
- [ ] README revival contract consolidated to the intro + cross-refs; full fast suite green

## Done summary

## Evidence
