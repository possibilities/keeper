## Overview

keeper's DB is 2.8 GB; `event_blobs` is 2.34 GB (83%), 99.3% of events relocated
there, growing ~93 MB/day with NO retention. The bloat is PostToolUse `tool_response`
bodies (Edit alone 1.31 GB) the fold provably never reads. This splits the conflated
`data` blob into its two real roles — a typed minimal FOLD CONTRACT (kept) and a
redundant transcript archive (shed) — promotes the single cross-event fold field
(`tool_input.file_path`) to a column, drops `event_blobs`, and adds keeper's first
retention pass. End state: DB ~0.4-0.7 GB, the git-attribution fold's "ARM B"
rowid-join hot path gone, the relocator/COALESCE machinery retired. Panel-vetted
(opus4.8-gpt5.5); the one-way shed of `tool_response` bodies is an accepted human
decision. Forensic transcript depth defers to Claude Code's own `transcript_path`
`.jsonl` (retained per CC's `cleanupPeriodDays`, default 30d, empirically coextensive
with the blob today).

## Quick commands

- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT SUM(pgsize) FROM dbstat WHERE name='event_blobs'"` — blob footprint (0 / table-gone at end)
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db "SELECT COUNT(*) FROM events WHERE hook_event='PostToolUse' AND tool_name IN ('Write','Edit','MultiEdit','NotebookEdit') AND mutation_path IS NULL AND data IS NOT NULL"` — backfill remaining (0 = done)
- `bun run test:full` — MANDATORY before landing any task here
- `keeper autopilot --snapshot` — board/dispatch state
- `launchctl kickstart -k gui/$(id -u)/arthack.keeperd && keeper await server-up` — restart daemon to apply a migration

## Acceptance

- [ ] DB shrinks to ~0.4-0.7 GB; `event_blobs` table is gone; daemon serves normally
- [ ] A from-scratch re-fold reproduces byte-identical projection rows (the sacred invariant) — proven by the differential harness over the full live corpus
- [ ] GitSnapshot folds no longer touch `event_blobs` (ARM B deleted); no multi-second attribution folds under load
- [ ] Forward growth is bounded — retention pass ships ENABLED
- [ ] `keeper search-history`, `claudectl show-session`, subagent-invocations forensics all still work
- [ ] A 0→v74 from-scratch migrate succeeds (the v56/v57/v67 ladder steps that create/read `event_blobs` stay byte-intact; DROP only at the v74 tail)
- [ ] `bun run test:full` green

## Early proof point

Task that proves the approach: `.1` (differential re-fold safety harness). It establishes
the correctness predicate and the current-fold baseline BEFORE any schema change. If it
can't demonstrate a byte-identical differential re-fold over the live corpus — or the
keep-set allow-list can't be shown to cover every fold-read body — the whole shed is
unsafe and the design must change before proceeding past `.1`.

## References

- Panel verdict (opus4.8-gpt5.5): keep-inline over a `fold_payload` JSON column (overflow-page math makes inline free on the hot path); `mutation_path` is the only promoted column.
- README "## Architecture" event_blobs read-contract paragraph (~2601-2623) + restore-snapshot note (~2762) + canonical-fold-source sentence (~1264) — update forward-facing when the contract changes.
- **Overlap (advisory, NOT a blocking dep):** `fn-831` also bumps `SCHEMA_VERSION` + touches `keeper/api.py` + `src/reducer.ts`; `fn-832` touches `src/reducer.ts` + `test/reducer-projections.test.ts`. This epic runs FIRST by human directive, so it claims the next free `SCHEMA_VERSION` integer; whichever of fn-831/fn-832 lands later rebases its integer. keeper epics are serialized single-task-per-repo-root, so there is no concurrent race — every migration task MUST read the live `SCHEMA_VERSION` constant and take the next free integer.
- Separate concern, NOT in scope: the "never-bound circuit breaker" in `foldDispatchExpired` (correctness, not perf).

## Architecture

The `data` blob today serves two roles fused in one column: (1) fold input — read via
~25 typed `extract*()` functions plus the lone `json_extract($.tool_input.file_path)`
in the git-attribution scan; (2) a redundant transcript archive. The relocator
(`src/compaction.ts`) moves cold `data` into the `event_blobs` side table (NULLing
`events.data`), and every fold read resolves via `COALESCE(events.data, event_blobs.data)`
— keeping the `events` table scan-fast but never shrinking the DB. This epic narrows
the canonical fold input: for shed-class events the fold reads typed columns
(`mutation_path` + the existing derived columns), never the blob body; the keep-set
(an explicit ALLOW-list of event types whose body a live fold reads — GitSnapshot,
Commit, UserPromptSubmit, PreToolUse:Agent, Stop, Usage/window/build/dispatch, etc.)
stays inline forever. `event_blobs` is dropped; the relocator becomes a retention pass
that NULLs cold non-keep payloads in place (allow-list, past the cold watermark, past
the cursor), with `auto_vacuum=INCREMENTAL` (baked at VACUUM-INTO time) + per-batch
`incremental_vacuum` reclaiming the freelist.

## Rollout

Phased, daemon is sole migrator (boots paused). `.1` harness first (gate). `.2` adds the
column + forward path online (additive ALTER, no rebuild). `.3` backfills historical
rows online (paced, resumable) then flips attribution to the column. `.4` is the OFFLINE
destructive step (restore keep-set inline → DROP at v74 tail → VACUUM INTO + atomic mv →
deploy COALESCE-free binary) — gated on `.3` complete AND the harness green; rollback =
keep the pre-shed `VACUUM INTO` snapshot until the new binary verifies post-restart.
`.5` enables steady-state retention. The runtime downgrade guard (stored version > binary
`SCHEMA_VERSION` → migrate throws before any `CREATE IF NOT EXISTS`) prevents an old
binary from resurrecting `event_blobs` against a shed DB.

## Alternatives

- **`fold_payload` JSON column for structured events** (GPT-5.5 panelist): rejected — the keep-set lands in SQLite overflow pages (~3 KB avg > 4096 page threshold), so inline costs nothing on the hot path; a re-encoder adds a fresh determinism hazard for ~60 MB.
- **Snapshot/rebaseline (prune events behind a watermark):** rejected — the git-attribution fold reaches arbitrarily far back, so pruning events breaks attribution; column promotion sidesteps it.
- **Promote `prompt` too:** deferred — UserPromptSubmit is keep-inline, so `search-history` keeps working off `events.data` once its dead JOIN is dropped.
