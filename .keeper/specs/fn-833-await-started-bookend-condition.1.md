## Description

**Size:** M
**Files:** src/await-conditions.ts, cli/await.ts, plugins/keeper/skills/await/SKILL.md, README.md, test/await-conditions.test.ts, test/await.test.ts

### Approach

Add `"started"` as a third `PlanctlCondition` and mirror `complete`
end-to-end.

In `src/await-conditions.ts`: widen the `PlanctlCondition` type
(line 102). Add a pure `taskStarted(task)` helper —
`(task.jobs?.length ?? 0) > 0 || task.runtime_status === "in_progress"
|| task.runtime_status === "done" || task.worker_phase === "done"`
(explicit set membership on the opaque `runtime_status` string, never
`!== "todo"`). Add a pure `epicStarted(epic)` helper: true if
`(epic.jobs?.length ?? 0) > 0` OR any task satisfies `taskStarted` —
compose the FULL task predicate; do NOT import `readiness.ts`'s
`epicWorkStarted` (unexported, only checks `jobs.length`). Mirror its
`!== undefined` shell-row guard style. Wire both into
`evaluateTaskAwait` (447) and `evaluateEpicAwait` (484), returning
`met` / `waiting` only, and evaluate the started predicate BEFORE any
stuck/blocked branch (a blocked task that already ran reads `met`,
mirroring `unblocked`'s workable→stuck→waiting order). Extend
`absentBranch` (519) so `condition === "started"` returns `met` on the
present-then-absent path exactly like `complete` (a popped-off item was
necessarily started); monotonic, so it never needs the `deleted`
re-query.

In `cli/await.ts`: add `"started"` to `PLANCTL_CONDITIONS` (229) AND
both literal-union checks at 705 (`hasPlanctl` stream selection) and
741 (slot construction) — missing 705 leaves `started` parsing but
opening no stream (hangs at `armed`). Add a `started <id>` line to the
`HELP` block (run biome after — the help text attracts lint nits).

Docs: add a `started <id>` row to the SKILL.md condition table
(54-61) + the "## When this fires" list; fold `started` into the
Step-1 pre-check planctl family (80-130) — change "applies only to
`complete` / `unblocked`" to include `started`, add an "already
started → nothing to await, offer to run the follow-up now" clause,
and a `--require-transition` warning (a monotonic latch has no second
edge, so `started <id> --require-transition` against an
already-started target hangs until timeout). Update `README.md`
(~1074 "Six conditions" → seven) + one example; do NOT add a ticket id
to the README prose.

### Investigation targets

**Required** (read before coding):
- src/await-conditions.ts:102,447,484,513-529 — PlanctlCondition,
  evaluateTaskAwait / evaluateEpicAwait, absentBranch (extension site).
- src/readiness.ts:1285-1295 — epicWorkStarted (mirror the
  undefined-guard style; compose, don't import).
- cli/await.ts:229,705,741 — PLANCTL_CONDITIONS + the two
  literal-union edit sites.
- test/await-conditions.test.ts:55-134,239-251 — makeTask / makeEpic /
  makeEmbeddedJob fixtures + the run() / evaluate template.
- test/await.test.ts:156,406-450,877+ — singleArgs / planctlSeg helpers
  (widen the `"complete"|"unblocked"` literal to add `"started"`),
  MockSocket deliver, the armed-then-met integration template.

**Optional** (reference as needed):
- plugins/keeper/skills/await/SKILL.md:54-61,80-130 — condition table +
  Step 1 pre-check.
- README.md:1066-1122 — await prose block (carries latent ticket-id
  bloat; do not add to it).
- src/types.ts:810-844 — Task fields (runtime_status opaque string,
  worker_phase string|null, jobs EmbeddedJob[]).

### Risks

- Two cli literal-union edit sites (cli/await.ts:705 AND 741) — missing
  705 makes `started` hang at `armed` forever with no stream.
- Test-helper type widening — singleArgs / planctlSeg pin
  `"complete"|"unblocked"`; widen or the typecheck fails.
- absentBranch monotonic correctness — without the `started` arm, a
  popped-off-board started target yields a spurious `deleted` (exit 4).
- Determinism — keep the predicate pure (no Date.now/env/fs); branch on
  an explicit `{in_progress, done}` set, not `!== "todo"`.

### Test notes

Pure truth-table in test/await-conditions.test.ts: task started via
each arm independently (jobs non-empty / runtime_status=in_progress /
runtime_status=done / worker_phase=done), task not-started (all
defaults → waiting), a blocked-but-ran task (jobs present +
runtime_status=blocked → met, never stuck), a never-ran blocked task
(→ waiting/stuck per existing). Epic: a task-started case, an
epic.jobs-present case, an all-todo case (→ waiting). Runner in
test/await.test.ts: parse `started fn-…` / `started fn-….M`;
armed→immediate-met when already started; the popped-off-epic `met` via
absentBranch; start-and-finish-between-polls (single post-completion
frame still fires met). `bun run test:full` is mandatory (both files
are slow-tier).

## Acceptance

- [ ] `evaluateAwaitCondition` returns `met` for a `started` task when
      any of {jobs non-empty, runtime_status in {in_progress, done},
      worker_phase=done}; `waiting` when none.
- [ ] `evaluateAwaitCondition` returns `met` for a `started` epic when
      any task is started or epic-level jobs are present; `waiting`
      otherwise.
- [ ] `started` is evaluated before the stuck branch (a blocked task
      that already ran reads `met`).
- [ ] `absentBranch` returns `met` for `started` on the
      present-then-absent path (popped-off ≠ deleted).
- [ ] The cli parses `started <id>` (task + bare epic), opens the
      readiness stream, and emits `armed` + terminal `met`; an
      already-started target fires immediate `met` (no refuse-upfront).
- [ ] HELP, SKILL.md (table + "when this fires" + pre-check +
      `--require-transition` warning), and README await prose all list
      `started`.
- [ ] No Date.now/env/fs in the pure predicate; `bun run test:full`
      passes.

## Done summary
Added monotonic 'started' bookend condition to keeper await — pure taskStarted/epicStarted predicates (job-presence OR runtime_status in {in_progress,done} OR worker_phase=done), wired through both eval arms + absentBranch (popped-off ⇒ met, no re-query), plus the two cli literal-union sites, HELP, SKILL.md, README, and full truth-table + runner tests.
## Evidence
