## Description

**Size:** M
**Files:** plugins/plan/src/verbs/ (new epic-level verb), plugins/plan/src/cli.ts, plugins/plan/skills/close/SKILL.md, src/plan-worker.ts or src/reducer.ts (fold surface), cli/status.ts (pill render), test/ (fold + verb tests)

### Approach

Give an epic-level parked question a sanctioned home. New plan CLI verb (e.g. keeper plan
epic-question <epic> "<question + unstick sentence>" / clear) writing plan STATE (the plan
CLI is the plan write path — no RPC involved); the plan worker folds it into the epics
projection like runtime status; keeper status renders it as a needs-human-class pill so the
board shows a parked closer instead of calm. Wire the close skill's QUESTION protocol to
call it when parking and clear it on resume. Scope tightly: one nullable question field on
the epic overlay, fold-safe defaults (never throw; absent folds to none), refold-equivalence
green. Do NOT mint dispatch_failures rows for this (that family is producer-owned dispatch
semantics) and do NOT add an RPC.

### Investigation targets

**Required** (read before coding):
- How runtime_status/worker_phase overlay flows: .keeper/state → plan-worker snapshot emit → fold → status render (trace one existing field end to end and mirror it)
- plugins/plan/src/verbs/block.ts — the task-level sibling verb shape
- cli/status.ts needs_human block — where the pill surfaces

### Risks

- The fold is on the deterministic-replayed path — schema defaults must match the zero-event projection; run refold-equivalence.
- Keep the question text bounded (cap length at the verb) so the projection stays lean.

### Test notes

Plan-suite verb tests (set/clear/cap); fold test seeding the snapshot event; status shape
test for the pill; refold-equivalence.

## Acceptance

- [ ] Verb sets/clears an epic-level question; folds deterministically; board + status surface it as needs-human
- [ ] Close skill parks through it and clears on resume; no new RPC; no dispatch_failures coupling
- [ ] Both suites green including refold-equivalence

## Done summary

## Evidence
