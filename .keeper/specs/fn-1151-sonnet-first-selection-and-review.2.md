## Description

**Size:** M
**Files:** plugins/plan/src/verbs/selection_review.ts, src/plan-worker.ts, src/reducer.ts, src/db.ts, src/collections.ts, keeper/api.py, test/schema-version.test.ts fixtures, plugins/plan verb registry

### Approach

Mirror the parked-question path end to end for a new per-epic selection_review record.
A new plan verb `keeper plan selection-review <epic>` with exactly-one-of set / --clear:
set stores a small size-capped JSON payload (verdict counts summary + reviewed-at) into
the gitignored per-epic state overlay; clear nulls it. Both are readonly invocations
landing zero commits, like epic-question. plan-worker coerces the overlay field
fail-safe to null; the reducer folds it onto a new nullable TEXT epics column alongside
question (deterministic fold — event data only, never clock/fs); collections serve the
column. The db.ts column is a forward-only migration: bump SCHEMA_VERSION and add the
version to SUPPORTED_SCHEMA_VERSIONS in keeper/api.py in the SAME commit — the
schema-version test enforces the pairing.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plugins/plan/src/verbs/epic_question.ts:1-109 — the overlay set/clear verb to mirror (char cap at the write boundary, readonly invocation)
- src/plan-worker.ts:142-149 and :764-793 — overlay ingest + fail-safe coercion pattern
- src/reducer.ts:604-627 — the question fold, the deterministic template to sit alongside
- src/collections.ts:247-250 — how the question column is served

**Optional** (reference as needed):
- src/db.ts — addColumnIfMissing migration site + SCHEMA_VERSION
- keeper/api.py — SUPPORTED_SCHEMA_VERSIONS whitelist
- test/schema-version.test.ts — the pairing gate

### Risks

- The fold must stay deterministic and never throw — malformed overlay JSON folds to
  null with the cursor advancing, exactly like a malformed question.
- fn-1146 also adds to src/db.ts; the epic dep serializes the epics, but read the schema
  surface as it stands when this task runs.

### Test notes

Verb set/clear round-trip against a sandboxed state tree; coerce fuzz (malformed JSON,
oversize payload); fold determinism unit; schema-version pairing test.

## Acceptance

- [ ] Setting a review on an epic surfaces the payload on the epics projection and
      clearing removes it; both operations land zero git commits.
- [ ] Malformed or oversize overlay content folds to null without dead-lettering or
      halting the cursor.
- [ ] The schema version bump is whitelisted in the python API in the same commit and
      the schema-version pairing test passes.

## Done summary

## Evidence
