## Description

**Size:** M
**Files:** src/db.ts, src/types.ts, test/db.test.ts

The foundation: a config-driven roots resolver, the v5→v6 schema for the
two new projection tables, and the `Epic`/`Task` TS row shapes. No fold, no
worker, no read surface yet — just the data definitions everything else
builds on.

### Approach

In `src/db.ts`, beside `resolveDbPath`/`resolveSockPath`, add
`resolveConfig()` (reads `~/.config/keeper/config.yaml` via the native
`Bun.YAML.parse` — NO new dep; honor a `KEEPER_CONFIG` env override for
hermetic tests; missing file → `{ roots: ["~/code"] }`) and
`resolvePlanRoots()` (returns `config.roots`, expands a leading `~` to
`$HOME`, drops non-existent dirs with a skip-and-log so one bad root never
silences the others — tolerate late appearance like the transcript root).
The resolver is pure-ish (one file read); `~`-expansion + existence-filter
live here so the worker receives clean absolute path strings.

Bump `SCHEMA_VERSION` 5 → 6. Add `CREATE TABLE IF NOT EXISTS epics` and
`tasks` constants modeled on `CREATE_JOBS`, plus any indexes
(model on `CREATE_EVENTS_INDEXES`), inside the existing single-transaction
`migrate()` block. Columns: `epics(epic_id TEXT PRIMARY KEY, epic_number
INTEGER, title TEXT, project_dir TEXT, status TEXT, last_event_id INTEGER,
updated_at REAL NOT NULL DEFAULT 0)`; `tasks(task_id TEXT PRIMARY KEY,
epic_id TEXT, task_number INTEGER, title TEXT, target_repo TEXT, status
TEXT, last_event_id INTEGER, updated_at REAL NOT NULL DEFAULT 0)`. New
`CREATE TABLE IF NOT EXISTS` is naturally idempotent and forward-only — no
backfill (tables start empty). Add `Epic` + `Task` interfaces to
`src/types.ts` matching the column shapes.

### Investigation targets

**Required** (read before coding):
- src/db.ts:35-56 — `resolveDbPath`/`resolveSockPath` resolver pattern (env override → default)
- src/db.ts:229-291 — `migrate()`: single-transaction DDL, `addColumnIfMissing`, unconditional version stamp, the "idempotent, not version-gated" rationale
- src/db.ts:102-115 — `CREATE_JOBS` column-def style + defaults matching the zero-event projection
- test/db.test.ts (the "v3→v4" / "v4→v5 rows preserved NULL" tests, ~lines 218/315) — the version-pair migration test shape to mirror for v5→v6
- ~/.config/keeper/config.yaml — the roots contract already on disk

**Optional:**
- src/transcript-worker.ts:84-89 — `resolveWatchRoot` (the `~`/default pattern, single-root analog)

### Risks

- `Bun.YAML.parse` shape: confirm it returns `{ roots: string[] }` for the
  on-disk file and tolerates a missing `roots:` key (→ default). A
  malformed YAML must not throw past the resolver — guard + default.
- Keep the `epics`/`tasks` column defaults consistent with the zero-event
  reading the reducer will rely on (NULL status/number before any fold).

### Test notes

Add to `test/db.test.ts`: a v5→v6 migration test (build a v5 DB, migrate,
assert `epics`/`tasks` exist and prior rows survive) and `resolveConfig` /
`resolvePlanRoots` cases (missing file → `~/code`; `KEEPER_CONFIG`
override; `~` expansion; non-existent root dropped; multi-root). Use the
existing `mkdtempSync` + env-override hermetic pattern.

## Acceptance

- [ ] `SCHEMA_VERSION === 6`; `migrate()` creates `epics` + `tasks` idempotently inside the existing transaction
- [ ] A v5 DB migrates to v6 with existing rows preserved (test asserts)
- [ ] `resolveConfig()` parses the YAML via `Bun.YAML.parse` with no new dependency; missing file → `["~/code"]`; `KEEPER_CONFIG` overrides
- [ ] `resolvePlanRoots()` expands `~`, drops non-existent dirs, returns absolute strings; one missing root doesn't drop the others
- [ ] `Epic`/`Task` types in `src/types.ts` match the table columns; `bun run typecheck` clean

## Done summary
Bumped SCHEMA_VERSION 5→6 with idempotent CREATE TABLE for epics/tasks projection tables + tasks(epic_id) index; added resolveConfig()/resolvePlanRoots() (Bun.YAML.parse, KEEPER_CONFIG override, ~-expansion, skip-non-existent roots, default ~/code) and Epic/Task types.
## Evidence
