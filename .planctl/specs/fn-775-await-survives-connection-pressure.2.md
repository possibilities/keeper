## Description

**Size:** S
**Files:** skills/await/SKILL.md, src/await-conditions.ts

### Approach

Three revise-in-place corrections, present-tense prose only:
1. skills/await/SKILL.md:130 — the epic already-complete pre-check is
   `epic.status == "done"` (planctl epic statuses are `open` and `done`).
2. skills/await/SKILL.md:219 — the `reason=connect` table row describes
   genuine unrecoverable query-shape errors (malformed subscription, bad
   collection); it carries no connection-capacity language.
3. src/await-conditions.ts:49-50 — the JSDoc for the scope-exempt re-query
   disambiguator states the actual predicate: `status === "done"`.

### Investigation targets

**Required** (read before coding):
- skills/await/SKILL.md:120-140,210-230 — the pre-check block and the reasons table
- src/await-conditions.ts:40-60,483-528 — the JSDoc and the evaluateEpicAwait it describes

## Acceptance

- [ ] No occurrence of a "closed" epic status remains in skills/await/SKILL.md or await-conditions.ts comments
- [ ] reason=connect row mentions only query-shape errors
- [ ] Prose is present-tense; no tombstones

## Done summary
Verified the three revise-in-place doc corrections (SKILL.md epic pre-check status==done, reason=connect query-shape-only row, await-conditions.ts JSDoc status==done predicate) are present in the tree; no 'closed' status literal remains, prose is present-tense. await.test.ts green (80 pass).
## Evidence
