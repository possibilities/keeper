## Description

**Size:** M
**Files:** src/reducer.ts, src/readiness.ts, test/reducer-plan.test.ts, test/reducer-projections.test.ts, README.md

Fix the fold-ordering race in `projectJobsRow` so an autopilot worker binds to
its task even when its `UserPromptSubmit` event folds before its `SessionStart`.
Forward-only: no schema change, no migration, no `SCHEMA_VERSION` bump, no re-fold.

### Approach

In `src/reducer.ts` `projectJobsRow`, SessionStart arm:
1. **Widen the `priorJob` pre-INSERT SELECT** (currently `SELECT 1 AS one` at ~6237-6240)
   to read the current `plan_verb`/`plan_ref`. Keep `isSpawnInsert = priorJob == null`
   (still keyed on row ABSENCE — a seed row with NULL pair is NOT a spawn-insert).
2. **COALESCE-fill the pair** in the `ON CONFLICT DO UPDATE SET` clause (~6249-6284):
   add `plan_verb = COALESCE(jobs.plan_verb, excluded.plan_verb)` and the same for
   `plan_ref`. Order is load-bearing: `jobs.col` (existing) FIRST = fill-only-when-NULL,
   preserving set-once. `excluded.plan_verb`/`excluded.plan_ref` already carry the
   parsed spawn-name pair (bound at params ~6296-6297). Fill BOTH columns (paired-NULL
   invariant; `planVerbRefFromSpawnName` returns both-or-neither, so they never desync).
3. **Widen the discharge-on-bind gate** (~6318-6327) from
   `isSpawnInsert && plan_verb != null && plan_ref != null` to
   `(isSpawnInsert || priorJob.plan_ref == null) && plan_verb != null && plan_ref != null`
   — i.e. also discharge on the NULL->non-NULL heal transition. The "was-NULL" half MUST
   read the PRE-UPSERT `priorJob.plan_ref` (the widened SELECT), never a post-UPSERT read
   (which is always non-NULL and would wrongly discharge a genuine resume's re-pending row).
   The DELETE keys on the just-parsed `(plan_verb, plan_ref)`, which equals the COALESCEd
   result precisely because the heal branch only fires when prior was NULL.
4. The existing `syncIfPlanRef` call at the tail of the SessionStart arm (~6329) re-reads
   the now-healed row and fans it into `epics.tasks[].jobs[]` — no new sync code needed.

Then reconcile the stale `approve` comments (the regex `SPAWN_VERB_REF_RE` at
`src/derivers.ts:34` is `(plan|work|close)` and MUST NOT change — `approve` is intentionally
dead): `src/reducer.ts` ~6227, `src/readiness.ts:669`, `test/reducer-projections.test.ts:1327`.
Revise the reducer set-once / discharge-gate comments (~6227-6240) to state the new
COALESCE-heal behavior (forward-facing — state the invariant, no fn-number / change history).
Update the forward-facing README prose at `README.md` :16-19, :2008, :2615 to reflect
heal-on-resume; no "as of vN" marker (no schema change).

Leave `title` / `title_source` / `name_history` untouched on the resume branch — they are
precedence-owned and out of scope. This task heals only `plan_verb`/`plan_ref` + discharge.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:6207 — `projectJobsRow`; SessionStart arm at :6212, UserPromptSubmit arm at :6332.
- src/reducer.ts:6237 — the `priorJob` `SELECT 1 AS one` to widen.
- src/reducer.ts:6249 — the `ON CONFLICT DO UPDATE SET` clause (no plan_verb/plan_ref today); params at :6296-6297.
- src/reducer.ts:6318 — discharge-on-bind block + its set-once gate.
- src/reducer.ts:6376 — UserPromptSubmit fork-seed INSERT (the NULL-pair row-minter; gated event.pid != null).
- src/reducer.ts:4896 — `syncIfPlanRef`; the `row.plan_ref != null` fan-out gate at :4914.
- src/derivers.ts:34 — `SPAWN_VERB_REF_RE` (read-only; do NOT touch). `planVerbRefFromSpawnName` at :96.
- test/reducer-projections.test.ts:1300 — discharge-on-bind test template to copy (reverse the event order); `dispatchedEvent`:1087, `getPendingDispatch`:1113.
- test/reducer-projections.test.ts:1359 — the resume-must-not-discharge invariant; must stay GREEN and UNMODIFIED.

**Optional** (reference as needed):
- test/reducer-plan.test.ts:1010 — existing set-once test (must stay green); derivation tests :934-1073.
- test/reducer-plan.test.ts:337 — the rewind+redrain re-fold-determinism idiom to copy.
- src/readiness.ts:669 — `dispatch-pending` verdict + its stale `approve::` comment.

### Risks

- **Gate keyed on post-UPSERT `plan_ref` instead of pre-UPSERT** — the single highest-risk detail: a post-UPSERT read is always non-NULL after the COALESCE, so the heal-discharge clause would fire on EVERY resume and break the `:1359` invariant. Read the prior pair in the widened SELECT, before the UPSERT.
- **Reversed COALESCE order** (`excluded` first) silently becomes always-overwrite, clobbering set-once and failing `reducer-plan.test.ts:1010`.
- **Throw inside the fold** — the widened SELECT returns NULLs cleanly on a seed row; ensure the `priorJob` typing handles both `null` (no row) and `{plan_verb: null, plan_ref: null}` (seed row) without a throw.

### Test notes

- The discharge/heal test belongs in `test/reducer-projections.test.ts` (it needs `dispatchedEvent`/`getPendingDispatch`, which do not exist in `reducer-plan.test.ts`). A pure column-heal assertion fits `reducer-plan.test.ts`.
- New ordering test: fold `Dispatched(work, <ref>)` → `UserPromptSubmit` (with pid, no spawn_name) → `SessionStart` (spawn_name `work::<ref>`, same pid) in that id order, then assert: (a) `plan_verb`/`plan_ref` healed; (b) `pending_dispatches` row discharged; (c) the board-level outcome — readiness no longer returns `dispatch-pending` for the task; (d) a rewind+redrain reproduces byte-identical `jobs` + `pending_dispatches` (mandatory re-fold idiom from `reducer-plan.test.ts:337`).
- Do NOT edit `:1359` or `:1010` to accommodate the fix — they pin the invariants the fix must respect.
- `bun run test:full` before landing (daemon/db/reducer path).

## Acceptance

- [ ] In the SessionStart resume branch, `plan_verb`/`plan_ref` are COALESCE-filled with `COALESCE(jobs.col, excluded.col)` order (fill-only-when-NULL), filling both columns together.
- [ ] The discharge-on-bind gate also fires on the NULL->non-NULL heal transition, keyed on the PRE-UPSERT prior `plan_ref` read by the widened `priorJob` SELECT.
- [ ] New test in `test/reducer-projections.test.ts`: UserPromptSubmit(pid)-before-SessionStart binds the pair AND discharges the pending row AND clears `dispatch-pending`, with a rewind+redrain determinism assertion.
- [ ] Column-heal assertion added in `test/reducer-plan.test.ts`.
- [ ] `reducer-plan.test.ts:1010` (set-once) and `reducer-projections.test.ts:1359` (resume-no-discharge) still pass, unmodified.
- [ ] Stale `approve` comments reconciled to the `(plan|work|close)` whitelist at `src/reducer.ts` ~6227, `src/readiness.ts:669`, `test/reducer-projections.test.ts:1327`; the `SPAWN_VERB_REF_RE` regex is unchanged.
- [ ] Reducer set-once/discharge comments (~6227-6240) and README prose (:16-19, :2008, :2615) revised forward-facing to reflect heal-on-resume; no schema bump, no migration, no re-fold.
- [ ] `bun run test:full` passes.

## Done summary

## Evidence
