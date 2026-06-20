## Description

**Size:** M
**Files:** `src/types.ts`, `src/plan-worker.ts`, `src/reducer.ts`, `src/collections.ts`, `test/plan-worker.test.ts`, `test/reducer.test.ts`, `test/collections.test.ts`

### Approach

Flow the `approval` field end-to-end through keeper's read side, defaulting missing values to `"pending"` so the change is forward-compat with files that do not yet have the field. Steps: (a) add `approval` to `Epic` and `Task` interfaces in `src/types.ts`; (b) extend `PlanEpicMessage` / `PlanTaskMessage` and `RawEpic` / `RawTask` shapes in `src/plan-worker.ts`; (c) update `buildEpicMessage` / `buildTaskMessage` to coerce + default to `"pending"` (coerce invalid enum values to `"pending"` with a stderr log -- the CLAUDE.md "safe value" invariant); (d) update `seedFromDb` to reconstruct `approval` field-identically (otherwise every plan file re-emits a synthetic snapshot on every boot -- the change-gate trap called out at `plan-worker.ts:759-764`); (e) extend `PlanSnapshot` interface in `src/reducer.ts` and add `approval` to both the EpicSnapshot fold (`reducer.ts:328-351`) and the TaskSnapshot RMW path (`reducer.ts:371-389`); (f) add `approval` to `EPICS_DESCRIPTOR.filters` and `defaultFilter` (compose as `{ status: "open", approval: { ne: "approved" } }` -- AND), confirming the descriptor's filter machinery supports two-key defaults; (g) descriptor tests for the new approval filter.

### Investigation targets

**Required** (read before coding):
- `src/plan-worker.ts:91-122` -- `PlanEpicMessage` / `PlanTaskMessage` shapes (extend, do not parallel)
- `src/plan-worker.ts:274-309` -- `RawEpic` / `RawTask` + `asString` / `asStringArray` coercion helpers (reuse for `approval` coercion)
- `src/plan-worker.ts:625-662` -- `buildEpicMessage` / `buildTaskMessage` (where coerce + default lands)
- `src/plan-worker.ts:759-840` -- `seedFromDb` (CRITICAL field parity; the change-gate trap is called out in code comments at 759-764)
- `src/reducer.ts:280-451` -- `extractPlanSnapshot`, `projectPlanRow`, the EpicSnapshot upsert and TaskSnapshot RMW paths
- `src/collections.ts:149-195` -- `EPICS_DESCRIPTOR` (where filter + defaultFilter live)

**Optional:**
- `src/types.ts:192-246` -- Epic and Task interface bodies (reference)

### Risks

- **`seedFromDb` parity trap** -- if the seed reconstruction does not reproduce `approval` byte-identically with what `buildEpicMessage` / `buildTaskMessage` produce, every plan file re-emits a synthetic snapshot on every boot (events table grows unboundedly). Existing test pattern at `test/plan-worker.test.ts` already covers similar parity; extend.
- **Descriptor filter composition** -- confirm `EPICS_DESCRIPTOR.defaultFilter` machinery supports two-key AND composition (`status` + `approval`). If it does not, add composition or change one to a non-default filter.

### Test notes

Add to existing test files (do not fork): (a) `buildEpicMessage` / `buildTaskMessage` default missing `approval` to `"pending"` and coerce invalid values to `"pending"` with a log; (b) `seedFromDb` produces the same field set as `build*Message` (boot does not re-emit synthetic snapshots); (c) reducer fold writes `approval` to the projection on both EpicSnapshot and TaskSnapshot paths, preserves it on TaskSnapshot RMW that does not touch the field; (d) re-fold from scratch reproduces `approval` byte-identically (this is the determinism extension); (e) descriptor accepts `filter: { approval: { eq } / { ne } / { in } }`.

## Acceptance

- [ ] `approval` field is on `Epic` and `Task` types
- [ ] `buildEpicMessage` / `buildTaskMessage` default missing approval to `"pending"`; coerce invalid enum values to `"pending"` with a stderr log
- [ ] `seedFromDb` produces field-identical output (no synthetic re-emit on boot in the existing test)
- [ ] Reducer folds approval into the epics projection on both snapshot paths
- [ ] Re-fold from scratch reproduces approval byte-identically
- [ ] `EPICS_DESCRIPTOR` accepts `approval` as a filter and applies `{ status: "open", approval: { ne: "approved" } }` as the composed default

## Done summary
Schema v13 epics.approval column + read-side plumbing: types, plan-worker coerce-and-seed (missing → 'pending' silent, invalid → 'pending' with stderr log via scanner logger sink), reducer fold on both EpicSnapshot/TaskSnapshot paths, daemon snapshot blob, EPICS_DESCRIPTOR filter + composed { status: 'open', approval: { ne: 'approved' } } default. seedFromDb reconstructs approval field-identically so boot scan does not re-emit; re-fold from scratch reproduces approval byte-identically.
## Evidence
