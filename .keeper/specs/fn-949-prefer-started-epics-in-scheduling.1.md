## Description

**Size:** S
**Files:** src/readiness.ts, src/board-render.ts, src/icon-theme.ts, cli/board.ts, README.md, test/readiness.test.ts, test/board.test.ts

### Approach

Add a pure `isEpicStarted(epic)` near `orderEpicsForScheduling` in
src/readiness.ts, keyed on REAL touch only: `epic.jobs`/`epic.job_links`
non-empty OR any `task.jobs` non-empty OR any `task.runtime_status != "todo"`.
Do NOT count the resting `worker_phase` ("open" on fresh task shells) — that
would mark every epic started and make the tiering a no-op; verify the field's
resting value and include it only if it's null/absent on a never-worked task.
Replace `orderEpicsForScheduling`'s identity body with a STABLE TOTAL-ORDER
sort: `tier (started=0, unstarted=1) → epic_number ASC (null sorts last) →
epic_id` (the unique final tiebreak so order is cycle-invariant regardless of
input order). Pure comparator, snapshot the tier per epic before sorting, null-
safe on every field (the board calls the seam via an untyped `snap.epics as
Epic[]` cast — a `.length` on `undefined` in the comparator would throw and
break render), return a fresh array. All three consumers inherit the reorder.
Add a `startedPill(isStarted)` mirroring `armedPill` (src/board-render.ts:286),
a glyph in src/icon-theme.ts, and append it in the cli/board.ts epic header.
Hard-categorical — no aging/floor (the per-root mutex self-bounds it). Update
the seam JSDoc (drop "identity passthrough today"/"future home") and the README
pill enumeration, forward-facing only.

### Investigation targets

**Required** (read before coding):
- src/readiness.ts:86-102 — `orderEpicsForScheduling` JSDoc + identity body (the seam to fill + docstring to update).
- src/readiness.ts:1216-1404 — `applySingleTaskPerRootMutex`: pass-2 walks `epicsArr` in order ("first ready row per root wins"); the armed two-pass at ~:1380/1394 ALSO walks that order, so started-first composes inner-to-eligibility. The order-dependent consumer the reorder feeds.
- src/types.ts:698 (`epic_number: number | null`), :707 (`Epic.jobs`), :715 (`job_links`), :821 (`worker_phase`), :828 (`runtime_status`, default "todo"), :837 (`Task.jobs`) — the predicate fields; epic_number nullability is the NaN trap.
- src/board-render.ts:286 (`armedPill` omit-default template), :58 (`pill()`).
- src/icon-theme.ts:134-136 — the pill→glyph map (add a `started` glyph).
- cli/board.ts:481-482 (epic-header pill assembly), :546 (seam call; `row` is `Record<string,unknown>` here — cast like `validatedPill`).

**Optional:**
- src/autopilot-worker.ts:1646 — `loadReconcileSnapshot` seam call (no change; verify it orders before `computeReadiness`).
- src/readiness-client.ts:153 — client `Epic` type (same shape; confirm the predicate fields are present client-side so the board computes `isEpicStarted` identically).
- cli/autopilot.ts:138 — viewer seam call (inherits the reorder).

### Risks

- The composed reorder→mutex is the load-bearing integration. The EXISTING per-root mutex tests pass PRE-ORDERED arrays and are insulated — they will NOT catch a regression here. New coverage must assert the COMPOSED outcome (started epic's ready task wins the shared root over an unstarted same-root sibling).
- Comparator must be a total order: null `epic_number` → `NaN` under subtraction (coerce null to sort last); a unique `epic_id` final tiebreak prevents cross-cycle oscillation (the `dedupedEpics` input order varies each tick).
- Predicate false-positive: counting the resting `worker_phase` or fresh shells marks every epic started → Rule #1 becomes a no-op. Key on job-association + `runtime_status != "todo"`; verify worker_phase before including it.
- Null-safety inside the comparator/predicate: treat missing arrays as empty; a throw in `Array.sort`'s comparator crashes the board/reconcile read path.

### Test notes

`bun run test:full` (readiness/autopilot/board). New tests:
- `isEpicStarted` truth table: no jobs + all-todo → unstarted; any `job_links`/`task.jobs`/non-todo `runtime_status` → started; resting `worker_phase` alone → NOT started; null/malformed fields → no throw.
- `orderEpicsForScheduling`: started-first; creation order within tier; null `epic_number` sorts last; `epic_id` tiebreak; same output on a shuffled input (cycle-invariance).
- Composed reorder→mutex: started epic beats a lower-`epic_number` unstarted sibling on a shared root; eligible+unstarted still beats ineligible+started (armed precedence); a pass-1 live occupant is not preempted by a started sibling.
- `startedPill`: renders only at the started value (omit-default), mirroring the `armedPill`/`validatedPill` pill tests (test/board.test.ts).

## Acceptance

- [ ] `isEpicStarted` pure + null-safe; started iff any associated job OR any `runtime_status != "todo"`; resting `worker_phase`/fresh shells = unstarted.
- [ ] `orderEpicsForScheduling` is a stable total-order sort (started-first, `epic_number ASC` null-last, `epic_id` tiebreak); pure; fresh array.
- [ ] Composed reorder→mutex verified: started wins a shared root over an unstarted sibling; composes inner to armed eligibility; pass-1 occupant not preempted.
- [ ] `[started]` pill via the omit-default template; renders only when started; glyph in icon-theme.
- [ ] No ordering logic added in any consumer; seam JSDoc + README pill enumeration updated forward-facing.
- [ ] Hard-categorical (no anti-starvation guard).
- [ ] `bun run test:full` green.

## Done summary

## Evidence
