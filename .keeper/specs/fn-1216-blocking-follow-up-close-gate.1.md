## Description

**Size:** M
**Files:** src/db.ts, src/plan-worker.ts, src/reducer.ts, src/collections.ts, src/types.ts, src/readiness.ts, test/db.test.ts, test/reducer-projections.test.ts, test/plan-worker.test.ts, test/readiness.test.ts

### Approach

Fold one new nullable epics column, blocks_closing_of (TEXT — the source epic id a blocking follow-up gates), from the plan snapshot into the epics projection, and gate the source's close row on it in readiness. The column is the gate's single committed pointer (docs/adr/0028): the source side is derived read-time — build one reverse index per readiness pass (source epic id -> its open blocking follow-up) over epics with a non-null blocks_closing_of, and plumb it into the close-row evaluator, which today receives no cross-epic lookup. The new close-row predicate blocked:close-followup ranks after the all-tasks-complete predicate and before dispatch-pending: the close row blocks while the follow-up exists and is not (status done AND close-idle, the same liveness bar the dep-on-epic predicate uses). The blocked reason carries the follow-up's epic id for board legibility. The reason kind is informational and non-occupying: it joins the reason union but stays out of the live-work occupant set, so a healthy wait neither holds the per-root mutex nor blocks reaps. A follow-up that is itself gated by its own follow-up is simply not-done — no special-casing, the wait nests naturally. When no epic row points at the source (a deleted follow-up), the index has no entry and the row un-blocks — downstream escalation is the saga verb's job, not readiness's. Schema step: one additive SCHEMA_STEPS entry; the column lands in BOTH CREATE_EPICS literals after the virtual default_visible column; SCHEMA_FINGERPRINT re-pinned; the ladder version is assigned at merge time, never hardcoded in prose or tests. Fold discipline: nullable, no DEFAULT, absent-to-NULL so a from-scratch re-fold is byte-identical; producer extraction mirrors last_validated_at (RawEpic, PlanEpicMessage, buildEpicMessage, and seedFromDb in the identical object-literal slot order); reducer PlanSnapshot plus the EpicSnapshot INSERT / ON CONFLICT scalar set; the epics descriptor gains the scalar column only, never jsonColumns/sortable/filters.

### Investigation targets

*Verify before relying — planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/db.ts:3636-3660 — the epics.question additive SCHEMA_STEPS entry, the exact template to copy
- src/db.ts:3220 and src/db.ts:5126 — both CREATE_EPICS literals; the new column goes after default_visible in each
- src/plan-worker.ts:2012-2034 and src/plan-worker.ts:2817-2864 — buildEpicMessage extraction and the seedFromDb reconstruction whose slot order must match byte-for-byte
- src/reducer.ts:680-709 — projectPlanRow EpicSnapshot INSERT + ON CONFLICT scalar carve-out
- src/readiness.ts:1109-1288 — evaluateCloseRow ladder; the new predicate slots after the dep-on-task synthetic-close predicate near :1249-1260
- src/readiness.ts:996-1036 — predicate 9's done-AND-idle model and its epicHasLiveCloseScopeWork bar to mirror
- src/readiness.ts:1317 — isLiveWorkOccupant; the new reason stays out of it

**Optional** (reference as needed):
- src/collections.ts:232-254 — epics descriptor scalar column list
- test/reducer-projections.test.ts:4681-4714 — fold test template (field-to-column, absent-to-NULL, zero-event default)
- test/plan-worker.test.ts:890-956 — seedFromDb/buildEpicMessage slot-parity test
- test/readiness.test.ts:76-94 — makeEpic fixture; add the field default or fixtures will not typecheck

### Risks

- A seedFromDb slot-order mismatch re-emits one synthetic EpicSnapshot per epic on every boot — the parity test is the guard.
- The reverse index must be built once per readiness pass, never per close row, or the pass goes quadratic on board size.

### Test notes

Pure in-process per the repo test rules: fingerprint recompute, migrated-vs-fresh table parity, fold absent-to-NULL, plan-worker message/seed parity, and readiness fixtures asserting: a gated close row reads blocked:close-followup naming the follow-up; flips ready when the follow-up is done and close-idle; stays blocked while the follow-up is done but close-busy; un-blocks when no row points at it; the reason is non-occupying; and the gated source epic (status open) never evaluates completed.

## Acceptance

- [ ] The epics projection carries a nullable blocks_closing_of column folded from the plan snapshot, NULL for every epic without the field, with the schema fingerprint and migrated-vs-fresh parity suites green
- [ ] A close row whose epic is targeted by an open follow-up's blocks_closing_of reads blocked with a close-followup reason naming that follow-up, and flips ready exactly when the follow-up is status-done with no live close-scope work
- [ ] The close-followup reason does not occupy live-work accounting, and an epic with no pointing follow-up evaluates byte-identically to today
- [ ] The root fast suite is green

## Done summary

## Evidence
