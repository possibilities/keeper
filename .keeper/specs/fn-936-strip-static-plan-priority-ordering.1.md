## Description

**Size:** M
**Files:** src/db.ts, keeper/api.py, src/reducer.ts, src/derivers.ts, src/daemon.ts, src/tmux-boot-seed.ts, src/git-boot-seed.ts, src/types.ts, src/collections.ts, src/plan-classifier.ts, src/readiness.ts, src/autopilot-worker.ts, src/await-conditions.ts, cli/await.ts, cli/board.ts, src/board-render.ts, src/icon-theme.ts, cli/autopilot.ts, README.md, CLAUDE.md, plugins/keeper/skills/await/SKILL.md, test/db.test.ts, test/collections.test.ts, test/reducer-links.test.ts, test/refold-equivalence.test.ts, test/await-conditions.test.ts, test/await.test.ts, test/readiness.test.ts, test/autopilot-worker.test.ts, test/board.test.ts

### Approach

One atomic keeper-binary change: the v85 schema migration + the orderless
`epics` fold + the full `events.plan_queue_jump` strip + the descriptor flip +
the `orderEpicsForScheduling` seam + every in-binary consumer + all in-keeper
docs + the test rewrites. It MUST land green as one unit — the shared test
fixtures (`makeEpic` sets `sort_path`/`created_by_closer_of` across
readiness/autopilot/board/await suites) couple the data and read layers, so a
partial removal leaves the suite red. Work the Detailed phases in order; the
migration + re-fold determinism is the keystone — verify it before touching
consumers.

DO NOT touch `created_by_close_of` (no second "r") — a DIFFERENT plan-side
field (close-saga audit-follow-up discovery stamp), not ordering.

### Investigation targets

**Required** (read before coding):
- src/db.ts:49 — `SCHEMA_VERSION` (→85); :806-809 `CREATE_EPICS_INDEXES` (`idx_epics_sort_path`, `idx_epics_default_visible(default_visible, sort_path, epic_id)`); :871-891 `CREATE_EPICS` literal (3 cols + `default_visible` VIRTUAL generated col); :1830-1842 `dropColumnIfPresent`; :4690-4721 v81 rewind-and-redrain; :4818-4856 v82 table-rebuild precedent; :635/3884/3894/4434 `events.plan_queue_jump`.
- src/reducer.ts:537-616 `syncPlanLinks` INSERT list + `sort_path` derivation; :5499-5512 EpicSnapshot ON CONFLICT carve-out + shell-insert; :6043-6314 closer/`sort_path`/`queue_jump` derivation + transitive cascade (`restampDescendants` BFS); :6116-6143 `plan_queue_jump` fold read.
- src/collections.ts:188-216 `EPICS_DESCRIPTOR` columns/sortable/defaultSort.
- src/autopilot-worker.ts:1509-1553 `loadReconcileSnapshot` epics read.
- keeper/api.py:361 `SUPPORTED_SCHEMA_VERSIONS` frozenset (add 85); :329 is a comment-only ref (no read).
- src/await-conditions.ts:319-345 `closerChildrenOf`; cli/await.ts:630-640 `resolvedEpicId` + :970-982 `followup`.
- cli/board.ts:473-485, src/board-render.ts:417-424, src/icon-theme.ts:164 — `[slotted-after-closer]` pill.

**Optional:**
- src/types.ts:188-191, 734-769 — `Epic` + `PlanInvocation` fields.
- src/daemon.ts (~40 `$plan_queue_jump: null` bindings), src/tmux-boot-seed.ts:203, src/git-boot-seed.ts:309.

### Detailed phases

1. **Migration (src/db.ts, keeper/api.py).** Bump `SCHEMA_VERSION` to 85; add 85 to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` (same commit). In the v84→v85 block: DROP `idx_epics_sort_path` + `idx_epics_default_visible`; v82-style table-rebuild of `epics` (CREATE new without the 3 cols, re-declaring the `default_visible` generated col; INSERT SELECT kept cols; DROP; RENAME); recreate `idx_epics_default_visible` as `(default_visible, epic_number, epic_id)` + every other kept epics index. Drop `events.plan_queue_jump` (DROP any index on it first; DROP COLUMN, or rebuild if blocked). Then the FULL v81-style rewind-and-redrain (reducer_state last_event_id=0; DELETE the deterministic projections — jobs/epics/subagent_invocations/usage/profiles/dispatch_failures/autopilot_state/pending_dispatches/dispatch_never_bound/armed_epics/builds; raise the live-only git floor + set seed_required per `rewindLiveProjection`; commit_trailer_facts NOT wiped). Update `CREATE_EPICS` + `CREATE_EPICS_INDEXES` literals lockstep with the new shape.
2. **Fold (src/reducer.ts).** Remove the `sort_path`/`queue_jump`/`created_by_closer_of` derivation + the whole transitive cascade; remove the three cols from the `syncPlanLinks` INSERT list, the shell-insert, and the EpicSnapshot ON CONFLICT carve-out; remove the `plan_queue_jump` fold read. Verify no INSERT/UPDATE still names a dropped column (a fold throw wedges the reducer).
3. **events strip.** src/derivers.ts:389-524 remove the `queue_jump` envelope field/derivation; remove `plan_queue_jump` from every `events` INSERT binding in src/daemon.ts (~40), src/tmux-boot-seed.ts, src/git-boot-seed.ts.
4. **Descriptor + types.** src/collections.ts: `defaultSort` → `{column:"epic_number",dir:"asc"}`; drop `sort_path` from `sortable`; drop all 3 from `columns`. src/types.ts: drop the 3 `Epic` fields + `PlanInvocation.queue_jump`. src/plan-classifier.ts:19,28 comment cleanup.
5. **Seam + consumers.** Add `orderEpicsForScheduling(epics)` to src/readiness.ts (identity over the creation-order seed; documented as the future runtime-priority hook). Thread it through `loadReconcileSnapshot` (src/autopilot-worker.ts), cli/board.ts, and cli/autopilot.ts so all consumers order through one site. Remove the `[slotted-after-closer]` pill (cli/board.ts, src/board-render.ts, src/icon-theme.ts). Remove `closerChildrenOf` (src/await-conditions.ts) + the `followup` field and `resolvedEpicId` plumbing (cli/await.ts).
6. **Tests.** Rewrite test/collections.test.ts (assert `epic_number asc` default; `sort_path` NOT sortable/served). test/db.test.ts (column-shape fixtures; re-point the `idx_epics_*` EXPLAIN-QUERY-PLAN tests to the new index). test/reducer-links.test.ts (remove the cascade/derivation suites). test/refold-equivalence.test.ts — REPLACE the cascade byte-identity test with a from-scratch orderless re-fold guard whose golden fixture INCLUDES legacy queue_jump/sort_path events, proving the new fold ignores them. test/await-conditions.test.ts + test/await.test.ts (remove followup/closerChildrenOf). Mechanical `makeEpic` fixture cleanup across readiness/autopilot/board suites. Where practical, run order-sensitive suites under `PRAGMA reverse_unordered_selects=ON` to catch implicit `sort_path`-order reliance.
7. **Docs (in-keeper).** README.md: board-pill format string, schema-history blocks (DELETE backward narration), index defs, fold-column list, the `ORDER BY sort_path` example queries → `epic_number`, close-saga `created_by_closer_of` ref. CLAUDE.md: any `sort_path`/`slotted-after-closer` reference. plugins/keeper/skills/await/SKILL.md: drop the `[slotted-after-closer]` pill line. Forward-facing only (no "used to" narration).

### Risks

- Re-fold determinism is the keystone — any non-byte-identical `epics` row after re-fold fails the guarantee; the orderless fold must reproduce the same rows minus the dropped columns. Build derived arrays from stable total-order sorts only.
- `events.plan_queue_jump` is a column drop on the LARGE events table — heavier than the epics drop; ensure any index on it is dropped first.
- NULL `epic_number` shell rows sort first under `epic_number ASC` — matches the old `sort_path=''` first-sort, so verify no visible-set change, only order; tie-break on `epic_id`.
- A leftover dropped-column reference in any fold INSERT throws inside the fold → reducer wedge. Grep all SQL strings for the three names + `plan_queue_jump`.

### Test notes

`bun run test:full` is mandatory (db/reducer/worker/await paths). Route through the package.json script (gate), never raw `bun test`. The re-fold equivalence guard is the highest-signal check.

### Rollout

Lands after fn-934's schema bump (epic dep). On boot to v85 the daemon re-folds from cursor 0 once. No downgrade path.

## Acceptance

- [ ] `SCHEMA_VERSION=85`; `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` includes 85 (same commit); `test/schema-version.test.ts` green.
- [ ] `epics` has no `sort_path`/`queue_jump`/`created_by_closer_of`; `idx_epics_sort_path` gone; `idx_epics_default_visible` redefined without `sort_path`; via table rebuild.
- [ ] `events` has no `plan_queue_jump`; all ~40 daemon/boot-seed bindings + the fold read removed.
- [ ] v85 does the full v81-style rewind-and-redrain; a from-scratch orderless re-fold (incl. legacy queue_jump/sort_path events) reproduces `epics` byte-identically.
- [ ] `EPICS_DESCRIPTOR` defaultSort `epic_number asc`; `sort_path` not sortable; 3 cols dropped from `columns`.
- [ ] `orderEpicsForScheduling` exists in readiness and is the single ordering site for board + autopilot + cli/autopilot.
- [ ] `[slotted-after-closer]` pill + `closerChildrenOf`/`followup` removed; `Epic`/`PlanInvocation` fields dropped.
- [ ] `created_by_close_of` untouched.
- [ ] README + CLAUDE.md + await SKILL.md forward-facing, no dangling references.
- [ ] `bun run test:full` green.

## Done summary
Stripped all static priority/ordering machinery: v85 migration drops epics.sort_path/queue_jump/created_by_closer_of + events.plan_queue_jump via table rebuild + full rewind-and-redrain; orderless syncPlanLinks fold; EPICS_DESCRIPTOR defaultSort epic_number asc consumed through new readiness orderEpicsForScheduling seam (board/autopilot); removed [slotted-after-closer] pill, closerChildrenOf, await followup, /plan:next coupling.
## Evidence
