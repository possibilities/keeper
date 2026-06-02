## Overview

keeper records every Claude Code hook event but never surfaced the background "monitor" shells a session is running — the plugin-armed chatctl bus, an agent-armed `keeper await`, a backgrounded `bun test`. This adds a live per-job `monitors` projection folded from the `background_tasks` snapshot on Stop events (`type:shell` only), each entry tagged with three-way provenance — `monitor` (Monitor tool), `bash-bg` (Bash `run_in_background`), `ambient` (plugin/harness-armed) — surfaced in the expanded `keeper jobs` view. Live-only, drop-when-dead: the set is a full snapshot-replace each Stop and clears to `[]` on SessionEnd/Killed.

## Quick commands

- `bun test test/reducer.test.ts test/derivers.test.ts test/schema-version.test.ts` — fold + deriver + schema sync green
- `keeper jobs` then expand a session running monitors — the Monitors section shows three-way labels

## Acceptance

- [ ] `jobs.monitors` folds from each Stop's `background_tasks` (type:shell) with three-way provenance; live-only, drop-when-dead.
- [ ] Schema v51 lands cleanly on fresh AND migrated DBs; keeper-py whitelist updated; cursor=0 re-fold is byte-identical.
- [ ] The expanded `keeper jobs` view renders the live monitor set.

## Early proof point

Task that proves the approach: `.1` (the data-layer fold + the cursor=0 re-fold-determinism test). If it fails — in-fold events scan too costly even indexed, or the backfill is non-convergent — fall back to recomputing provenance from a narrower signal, or ship Monitor-only provenance for v1.

## References

- `name_history` projection (src/reducer.ts:6775-6862, src/db.ts:661) — closest per-job JSON-array precedent (append+cap; monitors is snapshot-replace instead).
- fn-678 `pending_dispatches` — prior level-triggered projection precedent.
- Investigated live session 3c515d7a (chatctl `ambient` + agent `keeper await`; one keeper-await died and dropped from the live list while chatctl + the other survived) — the motivating case.

## Docs gaps

- **keeper/api.py**: `SUPPORTED_SCHEMA_VERSIONS` gains `51` (whitelist-only comment) — SAME change as the schema bump (task 1; hard invariant, test/schema-version.test.ts enforces).
- **README.md**: add an "As of schema v51" changelog block; revise the `jobs.ts` CLI bullet row-anatomy to include the monitors segment (task 2).

## Best practices

- **Empty snapshot is authoritative (the snapshot paradox):** an empty/missing `background_tasks` must replace to `'[]'`, never no-op — else a dead monitor lingers forever.
- **Correlate via `events.id` total order:** the launch event (Monitor/Bash PostToolUse) always precedes the Stop that lists its id; recompute provenance from an in-fold scan with `id < current` — reads the immutable log, re-fold-safe, no carry-forward needed.
- **Snapshot-replace is not append:** build the array fresh from each Stop's snapshot (stable sort by id), never mutate the prior array.
- **No DB-liveness / fs / wall-clock probe inside the fold:** drop-when-dead derives from the Stop's own empty snapshot, not a process probe.
