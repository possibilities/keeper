## Overview

Materialize each Claude session's terminal-multiplexer "backend-exec" coordinates as first-class, read-only columns on keeper's `jobs` projection, visible on both the `keeper jobs` CLI and the TUI. The hook captures `backend_exec_{type,session_id,pane_id}` as pure `process.env` reads on every event; a new daemon worker resolves the current tab via `zellij action list-panes -a -j` and feeds it through a synthetic event so the reducer folds `jobs.backend_exec_tab_{id,name}`. Generic `backend_exec_*` naming lets a future tmux/wezterm backend slot in without a schema change. End state: every live agent row shows where it lives (session / pane / tab) sourced from the projection, never computed in the TUI.

Tab/pane **renaming is explicitly out of scope** — this epic only gets the data in place and visible so we can understand it. Renaming is a deliberately deferred future act this data layer unlocks.

## Quick commands

- `cd ~/code/keeper && bun test test/reducer.test.ts test/exec-backend.test.ts test/db.test.ts test/schema-version.test.ts` — full affected test surface
- `keeper jobs` — eyeball the new dim backend segment on live rows (`· zellij <session>/<tab> p<pane>`)
- `zellij --session <name> action list-panes -a -j | jq '.[] | select(.is_plugin==false) | {id, tab_id, tab_name}'` — confirm the resolver's source shape

## Acceptance

- [ ] `events` carries `backend_exec_{type,session_id,pane_id}`; `jobs` carries those three plus `backend_exec_tab_{id,name}`; `SCHEMA_VERSION` is 48 and `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS` includes 48 in the same change.
- [ ] The hook populates the three primary coords on every event as pure env reads (no fork/fs/PPID-walk); a cursor-0 re-fold reproduces byte-identical rows.
- [ ] A daemon worker resolves tab per live (session, pane) via one `list-panes` call per distinct session and feeds `jobs.backend_exec_tab_*` through a synthetic event the reducer folds — the worker never writes the DB directly.
- [ ] `keeper jobs` CLI and the TUI both render the backend coords from the projection (shared `board-render`), gracefully showing nothing when coords are absent.
- [ ] CLAUDE.md invariants (Scraping-is-scoped carve-out + Sole-writer list) and README (sparse signals, worker inventory, schema-v48 changelog, `keeper jobs` bullet) updated to match.

## Early proof point

Task that proves the approach: `T2` (schema/DB contract) followed by `T3` (hook capture + reducer fold) — once the three primary coords land on `jobs` end-to-end and re-fold stays deterministic, the rest (tab worker, render) is additive. If the every-event fold can't stay re-fold-deterministic or trips the cross-language schema gate, stop and reconsider the column-vs-data split before building the worker.

## References

- `config_dir` is the capture→events→jobs template: hook read at `plugin/hooks/events-writer.ts:208-231,572-582`, fold at `src/reducer.ts:5476-5528`, migration block `src/db.ts:3214-3224`.
- Worker→synthetic-event→reducer template: `src/daemon.ts:1566-1634` (gitWorker), `src/git-worker.ts:1061-1072,1521`.
- exec-backend reuse: `src/exec-backend.ts:162` (DEFAULT_EXEC_BACKEND), `:336` (buildZellijListPanesAllJsonArgs), `:348` (ZellijPane), `:372-440` (findPaneByTabName model for findPaneById), `:540-573` (runCapture).
- Render surface shared by CLI+TUI: `src/collections.ts:87-158` (JOBS_DESCRIPTOR.columns), `cli/jobs.ts:141-196` (projectJobRow/renderJobsBody), `src/view-shell.ts`.
- Resolved design calls (gap analysis): store raw `ZELLIJ_PANE_ID` (e.g. `11`), match `list-panes` numeric `id` via normalized equality; tab tombstone = last-known sticks (no clearing snapshot); env absent ⇒ NULL coords (never bogus `type='zellij'`); tab snapshot rides in the synthetic event's `data` JSON, not dedicated event columns.

## Docs gaps

- **README.md**: sparse-signals paragraph (~1-67) — weave in the new `backend_exec_*` columns with a schema-v48 tag; Architecture worker-thread inventory (~769-791) — add the new producer thread; schema changelog prose (~792-1050) — add an "As of schema v48" block; `keeper jobs` example-clients bullet (~557-580) — describe the new rendered fields.
- **CLAUDE.md** (edit in place; AGENTS.md is a symlink): "DO NOT — Scraping is scoped" bullet — carve out `ZELLIJ_SESSION_NAME`/`ZELLIJ_PANE_ID`/`ZELLIJ` as pure every-event reads; "Sole-writer rules" bullet — add the new synthetic event type.

## Best practices

- **Drain stdout+stderr concurrently** on the `list-panes` spawn (pipe-deadlock) and wire an explicit two-phase TERM→KILL timeout — Bun.spawn does not self-escalate. `runCapture` already models the concurrent drain.
- **Non-zero exit = expected "no session" envelope** — log+skip, do NOT post a clobbering/clearing snapshot; treat `list-panes` output (session names, cwd, commands) as untrusted before SQL bind.
- **Per-session in-flight lock + per-tick `isRunning` guard** — `setInterval` does not self-throttle; one `list-panes` per distinct session, dedup at session level.
- **NULL, never empty-string** for absent env coords, so the COALESCE latest-non-null fold can't be clobbered by a null-carrying event.
