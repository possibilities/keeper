## Description

**Size:** S
**Files:** src/needs-human.ts, cli/status.ts, test/needs-human.test.ts, test/status.test.ts

### Approach

Create a pure module (`src/needs-human.ts`) owning the needs-human classification math every surface derives from. Given dispatch-failure rows plus the snapshot members (dead letters, block escalations, epics' parked questions), it returns: the broad sticky row count, the narrow operator-jam class (rows whose reason cannot self-clear — the `isJamReason` semantics), a most-specific per-row class (finalize-non-ff / instant-death-breaker / other-jam, each row classifying exactly once), the instant-death-wall threshold verdict, the umbrella total honoring the subset non-double-count rule (finalize-non-ff and wall rows are subsets of stuck dispatches, never added twice), and a stable needs-human signature hash over the sorted keyed signal set — the anchor the await `since:` mechanism consumes. Move the wall-threshold constant into this module; import all reason constants from `src/dispatch-failure-key.ts` (never re-hardcode); route close-row keys through `resolveFailureTarget`, never epic-id string matching. `cli/status.ts` then consumes the projector and drops its local duplicated reason constant. The status envelope output must stay byte-identical — this task changes the derivation source, not the shape (STATUS_SCHEMA_VERSION stays 5).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- cli/status.ts:305-355 — the exact aggregation math to lift, including the subset non-double-count comment at :352
- cli/status.ts:76 — INSTANT_DEATH_WALL_KEYS constant to relocate; :86 — the local FINALIZE_NON_FF_REASON duplicate to remove
- src/dispatch-failure-key.ts — the shared reason constants and resolveFailureTarget/classifyDispatchFailure join logic
- src/await-conditions.ts:1032-1040 — isJamReason, the existing narrow jam allowlist; decide whether the projector imports or absorbs it (one source only)
- test/status.test.ts:246 — the plain Row[] literal fixture pattern ({verb, id, reason}) to reuse

**Optional** (reference as needed):
- src/await-conditions.ts:1260 — changedSignature, the precedent for a stable signature hash

### Risks

- Two jam definitions drifting: isJamReason (await) and the projector's jam class must be one source — absorb or import, never duplicate.
- Close-row keys are hashed worktree prefixes (e.g. worktree-finalize:fn-9-x-h1); naive epic-id matching silently misses them ("Gap A" in the status tests).

### Test notes

Fixture tests over hand-written Row[] literals per the status.test.ts pattern (helpers duplicated per file by convention). Pin: broad vs jam classification, most-specific single classification per row, subset non-double-count, wall threshold at the boundary (1 vs 2 breaker keys), signature stability under row reordering, signature change on any add/clear.

## Acceptance

- [ ] A pure projector module exposes the needs-human classification: broad count, operator-jam class, most-specific per-row class, wall-threshold verdict, umbrella total with subset non-double-count, and a stable signature hash
- [ ] keeper status derives its needs_human envelope from the projector with byte-identical output and unchanged schema version
- [ ] All reason constants come from the shared dispatch-failure vocabulary; no re-hardcoded literals remain in the status math
- [ ] Fixture tests pin classification, subset rules, threshold boundary, and signature stability/change behavior

## Done summary

## Evidence
