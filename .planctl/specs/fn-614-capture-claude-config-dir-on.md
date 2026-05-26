## Overview

Capture `CLAUDE_CONFIG_DIR` from the SessionStart hook process environment and project it onto `jobs.config_dir` so jobs/epics can be attributed to the arthack-claude profile they ran under. New sparse `events.config_dir` column, schema bump 21 → 22, latest-write-wins via `COALESCE(excluded.config_dir, jobs.config_dir)` on the SessionStart ON CONFLICT branch. No backfill — pre-feature SessionStart events have no recoverable env. Resume-via-UserPromptSubmit paths that bypass SessionStart keep the prior value (documented accepted gap).

## Quick commands

- `bun test test/db.test.ts test/events-writer.test.ts test/reducer.test.ts` — verifies migration shape + hook capture + re-fold determinism
- `sqlite3 ~/.local/share/keeper/keeper.db "SELECT job_id, title, config_dir FROM jobs WHERE config_dir IS NOT NULL ORDER BY updated_at DESC LIMIT 10;"` — smoke-tests end-to-end attribution after running one real session under the launcher

## Acceptance

- [ ] `process.env.CLAUDE_CONFIG_DIR` is confirmed to inherit into the hook subprocess via a real-session probe BEFORE the schema bump lands.
- [ ] Schema v22: `events.config_dir TEXT` and `jobs.config_dir TEXT` both nullable, both added via `addColumnIfMissing` in lockstep with the `CREATE_EVENTS` / `CREATE_JOBS` literals.
- [ ] Hook stamps `process.env.CLAUDE_CONFIG_DIR || null` (collapses `undefined` and `""` to NULL, strips trailing `/`) into the `$config_dir` binding on `SessionStart` only; every other hook event sends `null`.
- [ ] Reducer's SessionStart fold writes `config_dir = COALESCE(excluded.config_dir, jobs.config_dir)` inside the same `BEGIN IMMEDIATE` transaction as the cursor advance.
- [ ] All five `daemon.ts` synthetic-event sites and the `seed-sweep.ts` positional INSERT are compatible with the new column (named bindings get `$config_dir: null`; positional INSERT omits, per existing convention).
- [ ] Re-fold from scratch reproduces `jobs.config_dir` byte-identically.
- [ ] README "What keeper is" sparse-signals count + enumeration, README "Architecture" v22 clause, and CLAUDE.md "Name scraping" rule are updated in the same PR.

## Early proof point

Task that proves the approach: `<epic_id>.1` (runtime probe). If it fails (env doesn't inherit), the entire approach changes — pivot to `ps -E` / `/proc/<pid>/environ` scraping or drop the feature, depending on root cause.

## References

- `src/db.ts:592-599` — v3→v4 spawn_name migration, the canonical template for sparse-column ALTERs.
- `plugin/hooks/events-writer.ts:372-422` — `spawnInfo` SessionStart-gated scrape; the shape to mirror.
- `src/reducer.ts:2024-2087` — SessionStart fold INSERT … ON CONFLICT block, where the COALESCE goes.
- `src/reducer.ts:2113-2124` — UserPromptSubmit fold; the resume path that bypasses SessionStart (documented accepted gap).
- `src/reducer.ts:1181-1206` — `EmbeddedJobElement` shape; `config_dir` does NOT belong here (subset by design).

## Docs gaps

- **README.md "What keeper is" sparse-signals sentence (line 25-46):** bump count "eight" → "nine", splice `events.config_dir` into the enumeration alongside `spawn_name`.
- **README.md "Architecture" schema-version note (line 448):** add inline "As of schema v22, `jobs.config_dir` captures `CLAUDE_CONFIG_DIR` from the SessionStart environment" clause parallel to the existing v21 `job_links` enrichment note.
- **README.md "Inspect" sample query (line 525-527):** add `config_dir` to the annotated SELECT — first-class session identifier worth surfacing.
- **CLAUDE.md "Name scraping is scoped, not general" rule (line 213-217):** extend to cover `CLAUDE_CONFIG_DIR` env-capture as the second permitted SessionStart-gated read; FORBIDDEN list unchanged.

## Best practices

- **Bun.spawn env inheritance is the default** — Claude Code does not scrub env before spawning hooks. `process.env.CLAUDE_CONFIG_DIR` is the read; no `Bun.spawn({env: ...})` needed [bun.sh/docs/api/spawn].
- **SQLite ADD COLUMN with NULL default is O(1)** — independent of row count. No CHECK, no NOT NULL, no STORED generated, no CURRENT_TIMESTAMP default. Safe on a multi-million-row events table [sqlite.org/lang_altertable.html].
- **Don't re-probe env inside the reducer's fold** — env reads at fold time break re-fold determinism (the daemon's env may differ from the hook's env at capture time). The column value is the only source of truth at fold time.
