## Description

**Size:** M
**Files:** src/await-conditions.ts, cli/await.ts, plugins/keeper/skills/await/SKILL.md, cli/await.ts (HELP block), README.md, test/await-conditions.test.ts, test/await.test.ts

Add an optional `followup=<id>` field to the single-planctl `complete <epic>`
met line of `keeper await`, naming any follow-up epic(s) a closer minted for
the awaited epic (`created_by_closer_of === <awaited epic id>`). Emit it in kv
mode (comma-joined) and `--json` mode (a typed array), omitted entirely when
there are none. Then teach the `keeper:await` skill's listener step to act on
it. Read-only consumer of the existing `created_by_closer_of` projection — NO
schema/migration/reducer/daemon change.

### Approach

1. **New pure helper** in `src/await-conditions.ts`, next to `findEpicByIdOrBare`
   (:293) / `findTaskById` (:267): `closerChildrenOf(epics: readonly Epic[],
   closedEpicId: string): string[]` — returns the `epic_id`s of epics whose
   `created_by_closer_of === closedEpicId`, sorted by `sort_path` asc, tie-broken
   on `epic_id` (a stable TOTAL-ORDER sort via `slice().sort(...)`, never append).
   Empty/`undefined` input → `[]`; never throws (the emit path is terminal — a
   throw fail-closes the listener). Match by EXACT full id; the CALLER passes the
   resolved full id.
2. **Capture the resolved full epic_id on the slot.** `created_by_closer_of`
   stores the closed epic's FULL id (`plan_ref`), but at the met tick the awaited
   epic has dropped off the board, and the await target may be bare `fn-N`. Add
   `resolvedEpicId: string | null` (boot `null`) to `PlanctlSlotState`
   (cli/await.ts:615-628). In `evalPlanctlSlotSync` (~:1170-1201), for an
   epic-kind target that is present this tick (`presentNow`/`everSeen` path),
   stamp `slot.resolvedEpicId` from `findEpicByIdOrBare(snap.epics,
   slot.target.id)?.epic_id` — EXPORT `findEpicByIdOrBare` from
   `src/await-conditions.ts` (currently module-private) to reuse it; do not write a
   second resolver. The scan key at emit is `slot.resolvedEpicId ?? slot.target.id`
   (the fallback covers the full-id-exact case defensively).
3. **Widen `eventLine`** (cli/await.ts:153-170, the SOLE renderer) input to
   `Record<string, string | string[]>`. kv branch: an array value renders as
   `arr.map(sanitizeValue).join(",")`; a string as today. JSON branch: an array
   value renders as `arr.map(sanitizeValue)` (a JSON array of sanitized strings);
   a string as today. Existing callers pass `Record<string,string>`, which is
   assignable to the widened type — NO call-site changes needed; verify the
   compile.
4. **Wire the scan into `emitAggregateMet`** (cli/await.ts:938-948), the
   `single && slots[0].kind === "planctl"` branch. Additionally gate the append on
   `slots[0].target.condition === "complete"` (that branch ALSO serves
   `unblocked` — an unblocked met must NOT carry followup). Compute `const children
   = closerChildrenOf(latestReadiness?.epics ?? [], scanKey)`; when
   `children.length > 0`, add `followup: children` as the LAST field of the fields
   object (after `detail`). When empty, add nothing — the no-child line stays
   byte-identical.
5. **Docs.** `plugins/keeper/skills/await/SKILL.md`: add `followup=<id>` (optional,
   comma-joined, omitted when none) to the single-planctl met shape in Step 3
   (~:193), and add a listener branch (near Step 4 / the daisy-chain material):
   when the met line carries `followup=…`, surface it to the human and pick by
   context — INSPECT via the CLI (`keeper plan board` nests it under a
   `[slotted-after-closer]` pill, or `keeper plan show <id>`) when they just
   wanted the result, or ARM a fresh `Monitor(keeper await complete <followup>)`
   to daisy-chain when the flow was wait-then-continue / circle-back. `cli/await.ts`
   HELP block (~:83-123): one-line note. `README.md` await section (~:1088-1136):
   one sentence. All forward-facing.

### Investigation targets

**Required** (read before coding):
- cli/await.ts:938-948 — `emitAggregateMet` single-planctl met branch (append site; gate on `condition === "complete"`).
- cli/await.ts:153-170 — `eventLine` (the SOLE renderer; kv + JSON; widen to `string | string[]`). `sanitizeValue` (:134) strips only CR/LF, so commas survive.
- cli/await.ts:615-628 — `PlanctlSlotState` (add `resolvedEpicId`).
- cli/await.ts:1170-1201 — `evalPlanctlSlotSync` / `presentNow`+`everSeen` (stamp `resolvedEpicId` here).
- cli/await.ts:1428-1470 — met-commit site (deferred re-query pass scans `snap.epics`; `latestReadiness = snap`, both in scope at `emitAggregateMet`).
- src/await-conditions.ts:267,293 — `findTaskById` / `findEpicByIdOrBare` (helper neighbors; export + reuse the latter); Epic import :82.
- src/types.ts:698-726 — `created_by_closer_of` (full `plan_ref`, immutable) + `sort_path`.
- test/await.test.ts:1485-1543 — the epic-complete met test template (`makeMockConnect`/`makeHarness`/`deliverFiveWithEpic`, empty snapshot drop, re-query `result` on the `await-requery-<pid>-epics` socket).
- test/await-conditions.test.ts:71 — `makeEpic(overrides)` fixture (already carries `created_by_closer_of` + `sort_path`).

**Optional** (reference as needed):
- src/collections.ts:206-209 — `default_visible = 1` scan-input scope.
- cli/board.ts:474-477 — `[slotted-after-closer]` pill (the CLI inspect target the skill names).
- plugins/plan/skills/close/SKILL.md:129,140 — scaffold-before-close ordering.

### Risks

- **`eventLine` widening ripples** to every armed/met/failed call site. `Record<string,string>` is assignable to `Record<string,string|string[]>`, so no caller change is needed — but confirm the whole file type-checks; do NOT hand-build any line outside `eventLine`.
- **Mis-gating** would leak `followup` onto the wrong terminal. It must appear ONLY on the single `complete` epic met — not `unblocked`/`started`/task/`monitor-running`/`server-up`/generic-single mets, not the aggregate branch (:964), and not any `failed` path (`deleted`/`stuck`/`not-found`/`timeout`/`unreachable`).
- **Same-frame fold-lag** (best-effort, accepted): if the child epic folds in a LATER frame than the parent's drop, it is silently omitted — the met has latched and the one-shot has exited (no re-poll, per the hard constraint). Document this; do not add a grace window.
- **Bare-id no-op trap**: matching children against a bare `fn-N` target would never match the full-id link. The `resolvedEpicId` capture is what prevents it — cover the bare-id path in a test.

### Test notes

- **Unit** (test/await-conditions.test.ts): `closerChildrenOf` returns matching children sorted by `sort_path` (tie-break `epic_id`); ignores non-matching / null `created_by_closer_of`; `[]`/empty input → `[]`; a `sort_path`-placeholder (`''`) child sorts stably.
- **Integration** (test/await.test.ts, off the :1485 template): (a) complete-epic met with one closer-child present in the SAME frame → met carries `followup=<child>`, exit 0; (b) no child → met line byte-identical to today (no `followup` token); (c) multiple children → comma-joined in `sort_path` order; (d) `--json` → `"followup":[...]` array, omitted when none; (e) bare `fn-N` await still resolves the child (resolvedEpicId path); (f) `unblocked` epic met → NO followup.
- Run `bun run test:full` before landing.

## Acceptance

- [ ] `closerChildrenOf(epics, closedEpicId)` is pure (no I/O, no Date.now), total-order sorted by `sort_path` asc tie-broken on `epic_id`, empty-input-safe, never throws — covered by unit tests.
- [ ] A `complete <epic>` met carries `followup=<id>` (comma-joined, `sort_path` order) when the closer minted follow-up epic(s); omitted ENTIRELY when none, keeping the no-child met line byte-identical.
- [ ] Resolves correctly for both bare `fn-N` and full `fn-N-slug` await targets (resolvedEpicId captured while the epic is on-board).
- [ ] `--json` met emits `followup` as a JSON array; key omitted when no children.
- [ ] `followup` appears ONLY on the single `complete <epic>` met — not on `unblocked`/`started`/task/aggregate/`deleted`/`stuck`/`timeout`/`unreachable` terminals.
- [ ] `keeper:await` SKILL.md documents the `followup=` field (Step 3 met shape) and a listener branch (inspect via CLI vs arm a fresh Monitor, by context); `cli/await.ts` HELP + README await section note the field.
- [ ] `bun run test:full` passes.

## Done summary

## Evidence
