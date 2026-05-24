## Overview

Today keeper derives a per-job `plan_verb` ∈ {plan, work, close} from the
spawn name — sufficient for `worker` / `closer` role tagging but useless for
the creator/refiner distinction, since `/plan:plan` and ad-hoc planning can
happen in any session regardless of how it was spawned. There is no
spawn-name slug to look at for creator/refiner: the only reliable signal is
the actual planctl-CLI footprint observed during the session, gated by
`/plan:plan` windows. This epic ports jobctl's existing classifier wholesale
(`apps/cli_common/cli_common/planctl_invocations.py:304-756`) into a new
`src/plan-classifier.ts`, stamps five sparse derived columns on `events` from
each `PreToolUse:Bash` invocation, and runs a per-session re-derive of
`jobs.epic_links` + `epics.job_links` on every triggering event — coexisting
with today's spawn-name `plan_verb` (worker/closer stay; creator/refiner ride
alongside).

## Quick commands

- `bun test test/derivers.test.ts test/plan-classifier.test.ts test/reducer.test.ts test/db.test.ts test/events-writer.test.ts`
- `sqlite3 ~/.local/state/keeperd/keeper.db "SELECT job_id, plan_verb, plan_ref, epic_links FROM jobs WHERE epic_links != '[]' LIMIT 5"`
- `sqlite3 ~/.local/state/keeperd/keeper.db "SELECT epic_id, json_array_length(job_links) AS n FROM epics WHERE json_array_length(job_links) > 0 ORDER BY n DESC LIMIT 5"`

## Acceptance

- [ ] Every `PreToolUse:Bash` event whose `data.tool_input.command` parses as a planctl invocation lands with the five `planctl_*` columns stamped at hook write time.
- [ ] A session running `/plan:plan` then `planctl epic-create fn-N-foo` lands `jobs.epic_links = [{"kind":"creator","target":"fn-N-foo"}]` and `epics["fn-N-foo"].job_links = [{"kind":"creator","job_id":"<sid>"}]`.
- [ ] A second session running `/plan:plan` then `planctl epic-set-title fn-N-foo "new"` lands `jobs.epic_links = [{"kind":"refiner","target":"fn-N-foo"}]` and the epic's `job_links` gains the refiner entry alongside the creator.
- [ ] A session running `planctl cat fn-N-foo` (read-only verb) inside a `/plan:plan` window produces no epic_links / job_links entry.
- [ ] Re-fold determinism: rewinding `reducer_state.last_event_id` to 0, deleting all `jobs` + `epics` rows, draining to completion reproduces byte-identical `epic_links` + `job_links` arrays.
- [ ] Forward-only migration backfills historical events + projection rows; a re-run on an already-migrated DB is a no-op.
- [ ] Approval RPC round-trip (set_task_approval → atomic write → file-watcher → EpicSnapshot fold) does NOT wipe `epics.job_links` (ON CONFLICT carve-out).
- [ ] `planctl validate --epic <epic_id>` passes on this epic after all tasks land.

## Early proof point

Task that proves the approach: the classifier port (`<epic_id>.2`). The TS
translation of `_compute_plan_windows` + `derive_epic_links` +
`derive_job_links` is the load-bearing piece — every other task is wiring.
If the classifier port fails parity tests against the Python-generated
golden fixture, the rest of the epic doesn't make sense. Recovery: pin
against the Python source and walk the diff entry-by-entry until parity.

## References

- jobctl Python source: `apps/cli_common/cli_common/planctl_invocations.py:304-756` — `_compute_plan_windows`, `derive_epic_links`, `derive_job_links`.
- planctl audit source: `apps/planctl/planctl/audit.py:103-116` — `_derive_ids(target)` rule for splitting `fn-N-foo.3` into `(epic_id, task_id)`. Keeper reuses `parsePlanRef` in `src/derivers.ts:260` for the same split.
- jobctl primer: `/Users/mike/docs/jobctl-and-hooks-tracker-primer.md` — the cross-system map and the section "How transcript info supplements job entities" explaining why the spawn-name verb is necessary-but-insufficient for creator/refiner classification.
- keeper invariants: `/Users/mike/code/keeper/CLAUDE.md` — "cursor + projection advance in the same `BEGIN IMMEDIATE` transaction", "byte-identical re-fold", "no third-party deps in the hook", "schema defaults match the zero-event projection".
- keeper v9→v10 migration precedent: `src/db.ts:600-708` — same-transaction backfill template for derived columns.
- keeper jobs↔epics seam: `src/reducer.ts:724-858` (`syncJobIntoEpic`) — analog for the parallel `syncPlanctlLinks` helper. NOT the seam this epic extends — triggers are disjoint (jobs-write vs planctl-event).

## Docs gaps

- **`README.md`**: the "sparse signals" callout currently lists two (`slash_command`, `skill_name`); revise to enumerate the five new `planctl_*` columns. The Architecture section's plan-producer paragraph describes `syncJobIntoEpic` fan-out from `plan_ref`-bearing jobs writes; add the invocation-classifier fan-out path (`planctl_op != NULL` event → `jobs.epic_links` + `epics.job_links`). The Inspect section's sample queries reference `plan_verb` / `plan_ref` / `skill_name` / `slash_command`; add representative queries for the new columns + projections.
- **`CLAUDE.md`**: the event-sourcing invariants "projection-driving facts" enumeration must list the new derived columns + the new `syncPlanctlLinks` fan-out at the level of detail matching `slash_command` / `skill_name`. Re-verify "no third-party deps in the hook" stays accurate (the new classifier file is reducer-only; the hook only imports the pure deriver).
- **`src/types.ts`**: `Event` interface gains five sparse fields; `Job` gains `epic_links: Link[]`; `Epic` gains `job_links: Link[]`. Existing `plan_verb` / `plan_ref` TSDoc must be revised to clarify coexistence — spawn-name pair = job's own planctl spawn role; `epic_links` = invocation-classifier cross-references.
- **`src/derivers.ts`**: module-level JSDoc lists three derivers; revise to four. Add TSDoc for `extractPlanctlInvocation` (gate, regex shape, purity invariant, hook + reducer + migration sharing rule).
- **`scripts/jobs.ts` / `scripts/epics.ts`**: client column rendering + module-level comments — at minimum, document the new projection fields in the script comments even if not surfaced in the default render.

## Best practices

- **Hand-rolled regex for the Bash-command parser** (no `shell-quote` or any dep). Module-scope literal so V8/JSC tiers up once at process start. Op character class `[a-zA-Z0-9_-]+` (not `\S+` — avoids matching shell metachars as the op); target group `[^\s;&|]+` (not `\S+` — avoids swallowing trailing `&&` or `;`).
- **Composite partial index `(session_id, id) WHERE planctl_op IS NOT NULL`** for the classifier's per-session ordered scan. Query WHERE clause must syntactically match the index WHERE clause (SQLite matches expression text, not semantics). Seed planner stats with `ANALYZE events;` once in the migration so the partial index is picked on first query post-upgrade.
- **Golden-fixture JSONL parity tests for the Python→TS port** at `tests/fixtures/plan_classifier_cases.jsonl`. Python script generates the fixture; TS test reads it and asserts byte-identical output. Edge cases as explicit fixture entries — empty session, single planctl event, exact-window-boundary, creator-then-refiner-same-epic-multi-window, slash-typed vs model-invoked window opener. Never auto-regenerate fixtures in CI — make regeneration an explicit script call.
- **Translate Python `math.inf` to `Number.MAX_SAFE_INTEGER`**, NEVER to JS `Infinity` (SQLite has no infinity type; bun:sqlite would coerce to NULL).
- **Full-replace, never delta-merge** for `jobs.epic_links` / `epics.job_links` writes. Re-fold determinism requires that re-folding the same events produces the same JSON; delta-merge breaks idempotence (an array would double on re-fold).
- **Use `db.run` (uncached) — NOT `db.prepare(…).run()` — for all migration UPDATEs**. The bun:sqlite statement-cache pin (`src/db.ts:629-639`) is the established precedent.
- **EpicSnapshot ON CONFLICT carve-out must include `job_links`** alongside the existing `jobs` carve-out. Without this, an approval RPC → file write → snapshot fold would wipe the projection. Round-trip test is mandatory.

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/keeper-creator-refiner-from-planctl-mutations` — author-tier handoff bundle from the upstream sketch. Empty snippet set today; rides forward so future `render-spec` calls resolve any additions made post-handoff.
