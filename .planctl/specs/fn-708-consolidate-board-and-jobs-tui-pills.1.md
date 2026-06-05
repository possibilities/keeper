## Description

**Size:** M
**Files:** src/board-render.ts, test/board.test.ts

### Approach

Build the lossless-consolidation core as pure, unit-tested module
functions in `src/board-render.ts` (the shared `cli/ → src/` home), so
both view tasks (`.2`, `.3`) consume them and `test/board.test.ts` can
assert them directly — mirroring the existing `epicHeaderLabel` /
`renderJobLinkLines` / `subagentLinesFor` extraction pattern.

1. Add a single omit-default primitive (e.g. `pillOrEmpty(value,
   default)` returning `""` at the default, ` [value]` otherwise) and
   use it to rebuild the value-pill helpers.
2. Extract `renderTaskPills(task, verdict)` and
   `renderClosePills(epicRow, verdict)` pure helpers that encapsulate the
   full task-line / close-row pill logic (currently untested closures in
   `cli/board.ts:renderEpicBlock`): runtime_status (omit `todo`;
   relabel `blocked` → `rt:blocked`), worker_phase (omit `open`; render
   `[worker-done]` ONLY when `worker_phase==="done"` AND
   `verdict.tag/reason` ∉ {completed, job-pending, git-uncommitted,
   git-orphans}), approval (omit `pending`; T3: drop `[rejected]` when
   verdict is `blocked:job-rejected`, drop `[approved]` when verdict is
   `completed`), and T2 (close row: do NOT render `[status]`; leave a
   `seg(row.status)`-restore comment for a future custom-filtered view).
3. Update `subagentLinesFor` to drop the status pill when
   `status ∈ {ok, null, empty}` (today a null status emits a literal
   empty `[]` — fold it into the same drop); keep `running` / `failed` /
   `unknown` / `superseded` visible.
4. Add `validatedPill` omit-default behavior (render `[validated]` only;
   `unvalidated` ≡ absence).
5. Add `PILL_COLORS` buckets for the two new tokens: `worker-done` →
   `success` (green, a done signal), `rt:blocked` → `warn` (yellow, like
   `blocked`). Add matching `colorizePillsInLine` test cases.
6. Define the two footer-legend strings (board, jobs) as exported
   constants here so they live in ONE place beside the omit rules and
   cannot drift; the view tasks append them to `bodyLines`.

Keep every helper a pure function of its args (no wall-clock, no env) so
the live-shell byte-compare and the existing test style hold. Verdict is
passed in (already in scope at the call sites) — do NOT add suppression
logic into `src/readiness.ts`.

### Investigation targets

**Required** (read before coding):
- ~/docs/pill-inventory.md — Part 3 recoverability ledger (exact verdict→state pins) and Part 4 render spec
- src/board-render.ts:236-360 — `PILL_COLORS` + `colorizePillsInLine` (token→bucket; prefix branches)
- src/board-render.ts:462-489 — `subagentLinesFor` (the unconditional `[${status}]` at 487 → the `[ok]`/`[]` drop)
- src/readiness.ts:294-298, 215-227, 257-261 — `Verdict` / `BlockReason` / `RunningReason` (the suppression-gating vocabulary)
- src/readiness.ts:1595-1606 — `formatPill` (verdict pill text the legend/suppression align to)
- cli/board.ts:289-340, 642-767 — current `approvalPill`/`validatedPill`/`taskRepoPillSeg` + the `renderEpicBlock` closure logic to lift

**Optional** (reference as needed):
- test/board.test.ts:928-970, 1146-1153 — `colorizePillsInLine` color-regression cases (encode the OLD three-pill task shape; rewrite)

### Risks

- Getting the worker-done gating set wrong is SILENT information loss, not a crash — pin it exactly to "verdict does not pin worker-done." Unit-test each verdict class.
- The collision matrix: after relabeling, re-verify no two fields co-rendering on a row share a token (`worker-done` vs runtime `done`; `rt:blocked` vs verdict `blocked:*`).

### Test notes

Unit-test the new pure helpers exhaustively in `test/board.test.ts`:
every omit-default boundary (value == default → no pill; != → pill),
the T3 suppression per verdict, the worker-done gating across all verdict
classes, the subagent `{ok,null,empty}` drop, and the two new color
buckets. Prefer asserting specific pill presence/absence over brittle
full-line `toBe` where practical, so later formatting changes (tasks .2/.3)
don't churn these.

## Acceptance

- [ ] `pillOrEmpty` (or equivalent) + `renderTaskPills` + `renderClosePills` exist as pure exported helpers in src/board-render.ts
- [ ] worker_phase renders `[worker-done]` iff `done` AND verdict ∉ {completed, job-pending, git-uncommitted, git-orphans}; never bare `[done]`
- [ ] runtime_status omits `todo`, relabels `blocked`→`rt:blocked`; approval omits `pending` + T3 suppression; close helper omits `[status]` (T2) with restore-comment
- [ ] subagentLinesFor drops the pill for status ∈ {ok, null, empty}; keeps running/failed/unknown/superseded
- [ ] PILL_COLORS has `worker-done`→success and `rt:blocked`→warn, with colorizePillsInLine tests
- [ ] board + jobs legend strings exported as single-source constants
- [ ] new helper unit tests green; bun run typecheck clean

## Done summary

## Evidence
