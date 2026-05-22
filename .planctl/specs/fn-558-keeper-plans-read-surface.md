## Overview

Add a read-only **plans** surface to keeper that parallels the existing
`jobs` surface. A new producer Worker thread (`src/plan-worker.ts`) watches
each project's `.planctl/{epics,tasks}/*.json` under configured roots and
feeds the existing event log; the reducer folds those into two new SQLite
projection tables (`epics`, `tasks`) served over the same read-only
NDJSON-over-UDS subscribe server via two new `CollectionDescriptor`s. End
state: a client can `query`/subscribe `collection: "epics"` or `"tasks"`
exactly like `jobs`, and `scripts/keeper-frames.ts` / `keeper-subscribe.ts`
drive any collection.

The ingestion path is the proven transcript-worker archetype: the worker is
read-only and posts typed snapshot messages to main; **main stays the sole
writer**, inserting synthetic `EpicSnapshot` / `TaskSnapshot` events via
`stmts.insertEvent`, then pumping a wake to fold them. Plans are
state-on-disk, so events are full **snapshots** (idempotent upsert), keeping
re-fold deterministic. The single event log / single cursor / single
`drain()` invariant is preserved — no second reducer.

Projected fields (per the human's spec, plus status on both):
- `epics`: epic_id (pk), epic_number, title, project_dir, status, last_event_id, updated_at
- `tasks`: task_id (pk), epic_id, task_number, title, target_repo, status, last_event_id, updated_at

## Quick commands

- `cd /Users/mike/code/keeper && bun test` — full suite (db, reducer, plan-worker, daemon, collections, integration) green
- `bun run typecheck && bun run lint` — clean
- `bun scripts/keeper-subscribe.ts --collection epics --once` — page the epics projection
- `bun scripts/keeper-frames.ts --collection tasks` — live tasks frame stream

## Acceptance

- [ ] Writing/altering a `.planctl/{epics,tasks}/*.json` under a configured root projects an `epics`/`tasks` row within one watch+fold cycle
- [ ] `query`/subscribe over `collection: "epics"` and `"tasks"` returns `result` + live `patch`/`meta` frames, with NO changes to `src/server-worker.ts`
- [ ] The single event log / one cursor / one `drain()` invariant is intact; a from-scratch re-fold reproduces identical `epics`/`tasks` rows
- [ ] `keeper-frames`/`keeper-subscribe` work against jobs, epics, and tasks; jobs behavior unchanged (back-compat default)
- [ ] Schema migrates v5→v6 with existing rows preserved; `bun test` + typecheck + lint all green
- [ ] The read-only fence holds: the socket carries no plan write path; the plan-worker never writes the DB

## Early proof point

Task that proves the approach: `<epic>.2` (reducer plan fold). Hand-insert a
synthetic `EpicSnapshot`/`TaskSnapshot` event and assert it folds into an
`epics`/`tasks` row with the right columns + monotonic `last_event_id`,
proving the snapshot→synthetic-event→fold→projection path and re-fold
determinism before the watcher or read surface exist. If it fails: the
session_id-as-entity-key + data-blob-snapshot encoding needs rework before
anything downstream is worth building.

## References

- `src/transcript-worker.ts` — the producer-worker archetype to clone (pure core + `seedFromDb` restart-seed + `isMainThread` guard + watcher subscribe/unsubscribe)
- `src/daemon.ts:188-329` — worker spawn/wire/shutdown + synthetic-event insert (the `TranscriptTitle` branch is the model)
- `src/collections.ts:50-106` — `CollectionDescriptor` shape + `REGISTRY`; adding a collection is a descriptor + entry, zero server-worker edits
- `src/db.ts:35-56,229-291` — `resolveDbPath`/`resolveSockPath` resolver model + the forward-only `migrate()` block
- `~/.config/keeper/config.yaml` — the pre-written roots contract (`~/code`, `~/src`); default `~/code` when absent
- planctl JSON shapes — epic: `id`/`title`/`status`/`primary_repo`; task: `id`/`epic`/`title`/`target_repo`/`worker_done_at` (no `status` field — derived)

## Docs gaps

- **CLAUDE.md / AGENTS.md**: add `src/plan-worker.ts` to directory layout + module-entry table; add `epics`/`tasks` to the `collections.ts` row; document `EpicSnapshot`/`TaskSnapshot` in the State machine; bump the `SCHEMA_VERSION` references (5→6) in Event-sourcing invariants; **remove/rewrite the "No prise/env-var integration … plans/planctl_mutations" DO NOT bullet** (this feature legitimizes a read-only plans projection); note the boot spawns FOUR workers; add plan-worker as a second Producer-worker instance in the Worker contract
- **README.md**: update worker-count + "jobs is the first/only collection" prose; **remove the "No plans / planctl_mutations" non-goal bullet**; add a `~/.config/keeper/config.yaml` install note; add epics/tasks inspect examples

## Best practices

- **One recursive watch per root, not per-`.planctl`-dir** — @parcel/watcher is recursive via FSEvents and coalesces off the JS thread; one `subscribe(root)` scales far better
- **Aggressive POSITIVE ignore globs are the #1 perf lever for `~/code`/`~/src`** (`node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`, `target`, `.venv`, `*.tmp`) — the broad roots flood the callback during git/npm ops without them
- **Do NOT reuse the transcript-worker's `**/*.!(jsonl)` negation glob** on the broad roots — parcel breaks on negated patterns (parcel-bundler/watcher #174); filter via an in-callback `.planctl/{epics,tasks}/*.json` path check + positive ignores
- **Treat every watch event as "go look", then fstat+re-read+safe-parse** the current file; route on path+existence, never on `event.type` (planctl writes via atomic `os.replace`, so `update` may surface as create/rename) — planctl writes ARE atomic (mkstemp+fsync+os.replace), so torn reads are designed out; residual risk is read-vs-delete races + user-edited files, handled by safe-parse (skip+log, keep last good, don't emit)
- **Bound the read size** — files live under user-editable HOME; cap before `JSON.parse`, skip-and-log oversize
- **Change-gate emission** (compare parsed `updated_at`/content against the persisted projection) so a daemon restart full-scan doesn't re-emit a synthetic event per plan file every boot
- **Descriptor stays the sole SQL-identifier injection gate** — foreign-process JSON fields (`project_dir`, `target_repo`) are untrusted; bind as params, store opaque, never interpolate or use to drive filesystem reads

## Snippet context

Bundles inherited or curated for this epic:
- `sketch/planctl-plans-read-surface` — the originating sketch handoff (no snippets attached; carries the committed direction)
