## Overview

After the tab-renamer worker + `plugin/zellij-bridge` were removed (commits
8b08fd0, 56e9497) the keeper-side zellij feed is dead (0 mints/sec). This
epic removes the now-inert remnants: the feed consumer + its watcher worker,
the `BackendExecSnapshot` extract/fold, the dead `ExecBackend` ops, the
already-inert window-reap, the `keeper plugin-path` CLI, the two dead
`jobs.backend_exec_{tab_id,tab_name}` columns, and the stale docs.

**Load-bearing scope boundary:** `backend_exec_{type,session_id,pane_id}`
(on `events` AND `jobs`), the hook's `ZELLIJ*` env capture, the reducer
COALESCE fold arm (reducer.ts:7320-7369), `restore-worker` session grouping,
and the `v` focus-pane keybind (`focusPane`) are **HOOK-FED and STAY ALIVE**
— only `tab_id`/`tab_name` and the `BackendExecSnapshot` feed are dead.

End state: ~10 daemon workers (down from the drifted "eleven/twelve"), no
zellij feed consumer, no reap, `jobs` carries only the three live backend
coords, and CLAUDE.md/README describe only what remains.

## Quick commands

- `bun run typecheck` — must stay green through both tasks (dead imports/refs gone)
- `bun test test/reducer.test.ts test/daemon.test.ts test/db.test.ts test/jobs.test.ts` — the load-bearing suites
- `bun test test/schema-version.test.ts` — gates the Task 2 keeper-py co-commit
- after deploy: `sqlite3 ~/.local/state/keeper/keeper.db "PRAGMA table_info(jobs);" | grep backend_exec` — should show only type/session_id/pane_id post-Task-2

## Acceptance

- [ ] The dead feed consumer, BackendExecSnapshot extract/fold, renameTab/resolveTabForPane, window-reap, and `keeper plugin-path` are gone; `focusPane` + the live backend coords + the hook ZELLIJ capture remain
- [ ] Historical `BackendExecSnapshot` events fold to an explicit no-op (cursor advances, no jobs write) — a cursor=0 re-fold stays byte-identical
- [ ] `jobs.backend_exec_{tab_id,tab_name}` dropped via a forward-only migration; `SCHEMA_VERSION` bumped AND added to `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS in the same commit
- [ ] Worker-count statements reconciled across daemon.ts / CLAUDE.md / README; kick-worker list is Two (server + plan)
- [ ] `tsc` green; full `bun test` green; daemon boots + shuts down clean with the reduced worker set

## Early proof point

Task that proves the approach: `.1` — specifically the explicit no-op arm + the
rewritten re-fold-determinism test in test/reducer.test.ts. If a cursor=0
re-fold over a log containing a historical `BackendExecSnapshot` diverges, the
arm was deleted (routing into projectJobsRow) instead of replaced with a no-op
— fix by restoring the explicit empty arm.

## References

- Predecessor removals: 8b08fd0, 56e9497 (renamer worker + zellij-bridge plugin).
- CRITICAL (gap-analyst): reducer dispatch reducer.ts:7628-7669 is an if/else-if with NO default no-op — its final `else` runs `projectJobsRow`. Replace the BackendExecSnapshot arm with an explicit empty no-op; do NOT delete it.
- DROP COLUMN supported in-repo via dropColumnIfPresent (db.ts:1773); no indexes on the tab columns (verified) → no rebuild. SCHEMA_VERSION db.ts:61 (currently 54); keeper/api.py SUPPORTED_SCHEMA_VERSIONS api.py:203; test/schema-version.test.ts gate.
- Reap already inert (reads always-NULL backend_exec_tab_id); no re-home source exists post-bridge-removal → removal is the only consistent move.
- epic-scout: all epics done; no deps/overlaps to wire.

## Best practices

- **Replace, don't delete, the fold arm:** a retired event type with rows still in the immutable log must fold to an explicit no-op (return/skip), never fall through to a projection or throw — else re-fold diverges. [event-driven.io; CLAUDE.md re-fold invariant]
- **Schema bump + keeper-py in ONE commit:** test/schema-version.test.ts + the api.py hard whitelist fail every commit-work otherwise. [CLAUDE.md]
- **Worker delete hygiene:** pull the worker from the shutdown await-all barrier, the post-drain kick, the error handler, and release its @parcel/watcher subscription — a postMessage/terminate on an undefined ref throws. [Bun workers; CLAUDE.md worker contract]
- **DROP COLUMN is a B-tree rewrite, not metadata:** fine here (two NULL TEXT cols, no index/FK), but run it inside the forward-only migration tx; VACUUM not worth it for two NULL columns.

## Snippet context

No snippets/bundles: practice-scout searched promptctl ("schema migration", "drop column sqlite", "worker thread spawn shutdown") — all empty; the work is keeper-internal and the specs carry all file:line context inline.
