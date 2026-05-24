## Overview

Add a richer readiness pill (`[ready]` / `[completed]` / `[blocked:<reason>]`) to every task row, synthetic close row, and epic header in `scripts/board.ts`. The pill is computed by a pure-function pipeline `computeReadiness(epics, jobs, subagentInvocations) → { perTask, perEpic, perCloseRow }` in a new `scripts/readiness.ts` module. Replaces the `[validated]` / `[unvalidated]` pill that ships in fn-599 task .1 — `epic-not-validated` becomes one blocked-reason among many in this epic's richer pipeline. The verdict is exposed as a discriminated union so the same pure function can later power dispatch decisions in `scripts/autopilot.ts` (out of scope here).

Hard-deps three upstream epics that supply the inputs:
- fn-598 (creator/refiner `epic.job_links` for `planner-running` predicate — tasks all done in-tree).
- fn-599 (`Epic.last_validated_at` projection + initial board.ts pill we supersede + `scripts/jobs.ts` / `scripts/epics.ts` pruning).
- fn-600 (`subagent_invocations` collection for `sub-agent-running` predicate).

## Quick commands

- `bun test test/readiness.test.ts`
- `bun scripts/board.ts`  # connects to keeperd, watch live pills

## Acceptance

- [ ] `scripts/readiness.ts` exports a pure `computeReadiness(epics, jobs, subagentInvocations)` returning a per-row verdict map keyed by epic_id / task_id / close-row id. Verdict shape is a discriminated union: `{tag: "ready" | "completed" | "blocked", reason?: BlockReason}`. A separate exported format helper produces the pill string from the verdict — no string-coupling inside the predicate logic.
- [ ] The 10-predicate pipeline matches spec exactly, evaluated first-match-wins: `terminal-completed`, `epic-not-validated`, `planner-running`, `own-approval` (`job-rejected` ordered above `job-pending`), `own-progress-main`, `own-progress-sub`, `dep-on-task`, `dep-on-epic`, `dep-on-task-synthetic-close`, `single-root`. Synthetic close row's `depends_on` is synthesized as "all real tasks in the epic" — cross-epic deps cascade transitively through tasks, so close has no own `dep-on-epic`.
- [ ] `single-root` runs as a post-pass over the per-row verdicts (not inside the per-row loop). Groups would-be-`[ready]` rows by `task.target_repo ?? epic.project_dir` mirroring `scripts/autopilot.ts:206-210` exactly (both null AND empty-string fall through). First row per root in board traversal order keeps `[ready]`; the rest become `[blocked:single-root]`.
- [ ] Epic header rollup: `[ready]` if any task or the close row is `[ready]`; `[completed]` if close row is `[completed]`; otherwise `[blocked:<reason of first non-completed row in traversal order>]`. Traversal = pre-sorted tasks then synthetic close row.
- [ ] `scripts/board.ts` opens a third subscription to `subagent_invocations`. First-paint gate expands to "all three got first `result`" (strict — accept indefinite dark board over wrong-state render). `teardownConnection` resets the third state. Render pipeline calls `computeReadiness` once inside `emitFrameIfChanged` before building the body.
- [ ] Pill renders after `[status] [approval]` on task rows, close row, and epic header. When `[blocked]`, the reason renders in parens on a continuation line BELOW the row.
- [ ] Defensive default for a row in the renderer that misses a verdict lookup (and vice versa): `[blocked:unknown]` — visible (bug indicator if it appears) and inert (autopilot won't dispatch).
- [ ] `subagent_invocations` rows with `status === 'running'` AND matching `job_id` block; any other status (`ok`, missing row) passes silently.
- [ ] Dep ids absent from `epics.byId` count as satisfied (mirror existing `board.ts:296-297` convention — done+approved off the board).
- [ ] `test/readiness.test.ts` covers: the predicate-ordering matrix (every pairwise ordering — `job-rejected` over `job-pending`, `terminal-completed` over `own-progress-main`, etc.), the single-root post-pass with multi-root and single-root scenarios, epic header rollup edge cases (zero tasks, all completed except close, mixed states), missing-input defensive defaults, and dep-absent-from-collection semantics.
- [ ] `bun test`, `bunx biome check --no-errors-on-unmatched src test scripts`, and `bunx tsc --noEmit` all pass.
- [ ] `planctl validate --epic <epic_id>` passes.

## Early proof point

Task `<epic_id>.1` is the whole epic — its `test/readiness.test.ts` predicate-ordering matrix is the proof that the pipeline matches spec. If a fixture for the predicate-ordering matrix can be authored and made green, the rest of the work (board.ts wiring, format helper, pill rendering) is mechanical on top.

## References

- `scripts/board.ts:201-230` — `CollectionState` factory; add third state here.
- `scripts/board.ts:280-333` — `renderEpicBlock` / `renderJobLines`; pill insertion + continuation line.
- `scripts/board.ts:397-407` — `renderBody`; stash readiness map for renderers.
- `scripts/board.ts:500-516` — `emitFrameIfChanged`; first-paint gate + `computeReadiness` invocation.
- `scripts/board.ts:553-596` — `handleFrame`; route the third collection.
- `scripts/board.ts:598-611` — `teardownConnection`; clear third state.
- `scripts/autopilot.ts:206-210` — single-root predicate to mirror exactly.
- `src/types.ts:35-38` — `JobLinkEntry` (creator/refiner edges).
- `src/types.ts:247-255` — `EmbeddedJob` (state vocabulary).
- `src/types.ts:279-325` — `Epic` (after fn-599: includes `last_validated_at`).
- `src/types.ts:359-387` — `Task`.
- microsoft/lage `SimpleScheduler.getReadyTargets()` — pure-function readiness pattern.
- nrwl/nx `canBeScheduled()` — dual-gate plus parallelism mutex (analog of single-root).
- rust-lang/cargo `DirtyReason` — discriminated union with structured payloads pattern.

## Docs gaps

- **`README.md`** (Example clients section, ~lines 242-295): the description of `scripts/board.ts` becomes stale — pill vocabulary now includes `[ready]` / `[completed]` / `[blocked:<reason>]` (was just `[validated]` / `[unvalidated]` after fn-599). Update the prose to name the richer pill and the three-collection subscribe. No new query block needed in Inspect.
- **`README.md`** ("Two collections register today" paragraph, ~lines 58-65): noun-side count update to "three" belongs to fn-600 (the epic that ADDS the collection). This epic confirms board.ts is now a three-collection client; no separate prose ownership here.
- **`CLAUDE.md`** carve-out paragraph: no change (no new projection writes; this epic is pure client-side rendering).

## Best practices

- **Encode verdict as a discriminated union, not a string.** The pill text is a serialization. Internal predicate code branches on tag, not parsed string. Mirrors rust-lang/cargo `DirtyReason`.
- **Pre-compute the single-root active set before the per-row pipeline runs.** Single-root needs to see which would-be-`[ready]` rows compete; runs as a post-pass, NOT folded into per-row evaluation. Mirrors nrwl/nx's TOCTOU-safe `scheduleRoots()` pass.
- **Order `job-rejected` ABOVE `job-pending` in the own-approval predicate.** Rejected is more actionable and more alarming; if `pending` is checked first it silently shadows a rejected state.
- **Never trust `epic.status === "done"` alone for `[completed]` rollup.** The planctl file write races the reducer. Roll up from children (tasks + close row) and confirm via embedded jobs state.
- **Walk one dep level only for `dep-on-task` / `dep-on-epic` reason display.** Full-chain walks are O(n²), produce strings that stale every time any intermediate dep changes, and confuse the reader. Mirrors nrwl/nx and microsoft/lage.
- **Scope single-root mutex to `project_dir`, never global.** Global mutex would serialize the entire board across unrelated repos.
- **`computeReadiness` must be pure** — no `Date.now()`, no DB reads, no closure over external state. Deterministic over its inputs so a test fixture pins a verdict for a given snapshot.
- **Guard each predicate body with safe defaults at the boundary** — never throw inside `computeReadiness` (a throw in `emitFrameIfChanged` would kill the render loop). Unknown / malformed input falls through to the next predicate or to `[blocked:unknown]`.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/board-readiness-pill` — author-tier handoff bundle from the upstream sketch. Empty snippet set today; rides forward so future `render-spec` calls resolve any additions made post-handoff.
