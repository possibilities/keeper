## Overview

Collapse keeper's two plan collections into one: embed each epic's tasks as a
JSON-array column on the `epics` projection and drop the standalone `tasks`
collection + table. The read surface then serves the epics→tasks tree as a
single `epics` collection — a task change becomes a targeted `patch` on its
parent epic (the epic's `last_event_id` bumps), and new/removed tasks stop
being membership events. The change is fully filesystem-synchronized: task and
epic file deletions retract their projection state via synthetic tombstone
events (live), and a boot reconciliation sweep retracts anything deleted while
the daemon was down. Default `epics` ordering moves to `epic_number ASC`
(stable creation order — no reordering on task edits).

## Quick commands

- `bun test --isolate` — full suite (db migration, reducer fold, collections decode, plan-worker seed/delete, integration e2e) must stay green
- `bun test --isolate test/reducer.test.ts` — the load-bearing re-fold determinism guard lives here
- End-to-end: start `keeperd`, write/delete `.planctl/{epics,tasks}/*.json` under a configured root, subscribe `{"type":"query","collection":"epics"}` over the UDS and confirm the page rows carry a decoded `tasks` array, a task edit arrives as a `patch` on the parent epic, and a task-file delete splices the element out

## Acceptance

- [ ] `epics` query/subscribe serves each epic with a decoded `tasks: Task[]` array; no `tasks` collection or table remains
- [ ] a task snapshot folds into its parent epic's array (deterministic sort), bumping the epic's `last_event_id` so it `patch`es; a from-scratch re-fold reproduces byte-identical `epics` rows
- [ ] deleting a task/epic file retracts the corresponding array element / epic row (live); deletions during downtime are reconciled on boot
- [ ] default `epics` sort is `epic_number ASC`; task edits never reorder the default view
- [ ] CLAUDE.md / README / keeper-frames reflect the single-collection embedded shape and the v7 schema

## Early proof point

Task that proves the approach: `.1` (embed core — schema v7 + reducer fold + descriptor + seed). If the from-scratch re-fold determinism test can't be kept green after the array fold + migration backfill, the embed strategy is wrong and we reconsider before building deletes on top. Recovery: fall back to the cursor-rewind-and-redrain migration variant (no backfill) so migrated state always equals re-folded state.

## References

- Sketch handoff bundle: `sketch/embed-tasks-in-epic-projection`
- `src/collections.ts:252` — `decodeRow` / `jsonColumns`: the dormant JSON-TEXT read-boundary decode, activated by registering `epics.tasks`
- `src/reducer.ts:233` — `projectPlanRow`: the EpicSnapshot/TaskSnapshot fold to convert to array read-modify-write
- `src/db.ts:418` — the migrate() comment that explicitly calls out version-guarding a non-idempotent data backfill
- `src/protocol.ts:208` — `MAX_LINE_LENGTH` 1 MiB cap (the embedded-array patch-frame ceiling)

## Docs gaps

- **CLAUDE.md** (symlinked AGENTS.md): largest blast radius — `src/db.ts` entry (SCHEMA_VERSION 6→7, v7 drops `tasks` table + adds `epics.tasks` JSON column), `src/collections.ts` entry (REGISTRY three→two descriptors, `epics` gains a `jsonColumn`), `src/reducer.ts` entry + State machine (TaskSnapshot folds into the parent epic array; new TaskDeleted/EpicDeleted tombstone events), schema version-history block, event-sourcing invariants ("identical rows" now means epics with embedded arrays), plan-worker entry + Producer-worker archetype (onDelete now emits retractions + boot reconciliation), DO NOT section (`epics`/`tasks` peer-projection language)
- **README.md**: architecture section (tasks embedded in epics), no-plan-write-path mention, Inspect section (`SELECT … FROM tasks` query is wrong after the migration — rewrite to `json_each(epics.tasks)` or remove)
- **Inline**: `src/collections.ts` file-top + `decodeRow` "dormant infrastructure" note; `src/types.ts` `Task` (now the element shape of `Epic.tasks`) + `Epic` (gains `tasks`); `src/db.ts` CREATE_EPICS / CREATE_TASKS / v7 migration comment; `src/reducer.ts` fold comments

## Best practices

- **Build the array deterministically from a stable sort key, never by append.** Re-sort `(task_number, task_id)` on every fold so replay reproduces byte-identical JSON; appending duplicates on re-fold. [event-sourcing idempotency consensus]
- **Do the JSON surgery in JS, not SQL.** No JSON1 is used anywhere in `src/` today; `json_set`/`json_insert` rewrite the whole blob per event (O(n²) write amplification over an epic's life). Read the TEXT, parse, splice by `task_id`, re-stringify, write once — all inside the open transaction. [SQLite json1 docs, DoltHub benchmark]
- **Version-guard the migration backfill.** The migrate() ALTER block is un-version-gated because every step is idempotent — a data backfill + DROP TABLE is not. Guard on `schema_version < 7`; sequence ADD COLUMN → backfill (`WHERE tasks IS NULL`) → DROP TABLE IF EXISTS in one transaction. [keeper db.ts:418 comment, forward-only migration guidance]
- **The backfill's array ordering MUST equal the reducer's fold sort** (`ORDER BY task_number, task_id` inside `json_group_array(json_object(...))`), or a migrated row differs from a re-folded one and the determinism guard fails on day one. [practice-scout, non-obvious]
- **Fail soft per-row at the read boundary** (`decodeRow` → `[]` on NULL/parse-failure), and treat a malformed stored array as `[]` *inside* the fold transaction too — a throw inside BEGIN IMMEDIATE rolls back the cursor and wedges the reducer. [keeper "one bad row never wedges" invariant]
- **Size-bound the embedded array** so a pathological epic can't push a `patch`/`result` frame past the 1 MiB NDJSON cap and close subscriber connections. [practice-scout, keeper protocol.ts cap]

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/embed-tasks-in-epic-projection` — the originating sketch handoff (carries the direction + touchpoints; no snippets attached)
