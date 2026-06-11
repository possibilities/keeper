## Overview

Single-event reducer folds hold main's `BEGIN IMMEDIATE` writer lock for seconds
(GitSnapshot avg 5.2s/n=1973, SubagentStart avg 2.6s/max 27.6s, Commit avg 2.5s,
PostToolUse avg 0.8s — 4,883 `[fold-slow]` lines), which is the root cause of the
performance babysitter's fold-latency findings (planctl ops taking 10-30s to reach
projections vs the 2s realtime bar) and starves concurrent hook INSERTs toward the
5s busy_timeout dead-letter cliff. End state: steady-state folds under the 2s
realtime bar, no fold over the 5s ceiling, and the babysitter's fold-latency pager
quiet. Diagnose first (statement-level instrumentation), then fix the proven
hotspots — every individual SQL statement EQPs to a sub-ms covering seek from the
CLI, so the in-process cost (statement recompilation, page-cache thrash over the
2.0GB event_blobs table, CPU contention) must be measured, not guessed.

## Quick commands

- `grep '\[fold-slow\]' ~/.local/state/keeper/server.stderr | tail -50` — per-event slow-fold lines
- `grep '\[gitfold-breakdown\]' ~/.local/state/keeper/server.stderr | tail -20` — GitSnapshot per-pass splits (pass1_explicit = 84% of 17s avg across 568 lines)
- `sqlite3 "file:$HOME/.local/state/keeper/keeper.db?mode=ro" "EXPLAIN QUERY PLAN <stmt>"` — verify plans against the LIVE 2.65GB DB (read-only), never a toy fixture
- `bun run test:full` — mandatory before landing (reducer/db are slow-tier covered)

## Acceptance

- [ ] Steady-state folds land under the 2s realtime bar (no `[fold-slow]` line over 2000ms in a representative post-fix soak window, boot-drain excluded)
- [ ] No fold exceeds the 5s hook busy_timeout ceiling in the same window
- [ ] Re-fold determinism proven byte-identical (rewind cursor + DELETE projection + re-drain) for every fold path touched
- [ ] The performance babysitter's fold-latency findings stop arriving for new planctl ops post-land

## Early proof point

Task that proves the approach: `.1` (statement-level instrumentation). If the new
breakdowns fail to localize the cost (everything reads fast in-process too), fall
back to profiling the live daemon (`bun --inspect` / `sample`) before writing any
fix — do not fix blind.

## References

- Babysitter triage round that routed this: `~/docs/babysitters/performance/rounds/1781203504.md` (sketch/2026-06-11-keeper-wake-path-drops, fold-latency half). After this epic lands, re-stamp the routed ledger rows in `~/docs/babysitters/performance/processed.jsonl` with this epic's slug as `resolved_ref`.
- Sibling-agent boundary (confirmed via chatctl with `tmux-session-id-design`): do NOT touch `src/exec-backend.ts`, `src/autopilot-worker.ts`, or `src/daemon.ts` spawn/ingest blocks — the tmux-backend rewrite owns them. `src/reducer.ts`, `src/subagent-invocations.ts` are free; `src/db.ts` is free for INDEX-only migration steps (their db.ts change is config-keys-only). BackendExecSnapshot event contract is unchanged.
- `fn-789-add-tmux-exec-backend` (overlap, trivial): its task .3 ADDS one purely-additive `TmuxPaneSnapshot` else-if arm + a small fill-only fold fn to the reducer dispatch chain (the same region task .1 instruments). No restructuring of existing arms or queries. Whichever epic lands second rebases the dispatch chain trivially — expect the new arm, do not modify it, do not instrument it (it is new and not a measured hotspot).
- BackendExecSnapshot fold is a NO-OP (`src/reducer.ts:6300-6305`, fn-684 retired it) — its 858 historical `[fold-slow]` lines predate retirement. Do not instrument or "fix" it.
- Live DB: `~/.local/state/keeper/keeper.db` — 2.65GB total; `event_blobs` 2.0GB / `events` 262MB (671k rows); WAL small post-TRUNCATE-checkpoint.

## Docs gaps

- **README.md** (Architecture, ~line 1540-1560): GitSnapshot pass narrative + the "4-7s folds" latency claim go stale once pass1 is fixed — revise in place, present tense
- **README.md** (diagnostics prose, ~line 561-565): `KEEPER_TRACE_SERVER` reads as THE fold-diagnostics mechanism; acknowledge the always-on threshold-gated `[*-breakdown]` tag family and name the new tags

## Best practices

- **EXPLAIN QUERY PLAN against the live DB before and after every query change:** look for `SCAN events`, `USE TEMP B-TREE`, `AUTOMATIC INDEX`, and wrong-index seeks; CLI-fast ≠ in-process-fast, so pair EQP with in-process statement timing [sqlite.org/optoverview]
- **Stale ANALYZE stats mislead the planner:** `ANALYZE events` last ran at the last migration; refresh before trusting plans, and weigh a periodic `PRAGMA optimize` against its own lock cost
- **Statement-level timing, not transaction-level:** the transaction total is known; the per-statement split is the unknown [Signal-Desktop sql/util pattern]
- **JSON re-render fan-out is O(children) per fold:** `syncJobIntoEpic`/`syncIfPlanRef` RMW whole JSON arrays; if instrumentation convicts them, prefer bounding/incremental maintenance over read-time redesign in this epic
- **Already shipped — do not re-raise:** `synchronous=NORMAL`, large `cache_size`, `temp_store=MEMORY`, `mmap_size` (db.ts:1047-1066), boot-drain `wal_checkpoint(TRUNCATE)` (fn-785)
