## Overview

The board corpus has grown well past what anyone has measured (live DB ~1.0 GB, 1257 done epics, 771,056 events) and keeper's own invariant names history/board-size-scaling folds a re-fold time-bomb. This epic measures the real cost — per-event fold cost and a true replay-from-zero — and remediates only confirmed scaling folds. "Document the measured headroom and change nothing" is an explicitly acceptable outcome.

## Quick commands

- `bun scripts/serve-fold-load.ts --db <copy>` — fold timing harness (must be fixed first; currently throws on stale plan-column names)
- `sqlite3 -readonly ~/.local/state/keeper/keeper.db 'select count(*) from events'` — corpus size sanity check

## Acceptance

- [ ] serve-fold-load.ts runs green against a copy of the current live DB
- [ ] A true replay-from-zero measurement exists: total wall time plus per-fold p50/p95, with a two-point slope comparison (first half vs second half of the corpus)
- [ ] Every fold breaching the thresholds (per-event p95 slope >20% between halves, or total replay >10 minutes on this machine) is either remediated with a sanctioned shape or explicitly justified
- [ ] Measured numbers and the re-run procedure are recorded durably (script header + epic evidence)

## Early proof point

Task that proves the approach: `.1` (the measurement itself). If it fails: fall back to timing drain() over the tail window only and flag the replay-from-zero mode as its own follow-up.

## References

- src/reducer.ts:8768 (applyEvent), :9140 (drain) — the fold entry points
- Already-remediated exemplars: GitAttribMemo (reducer.ts:1214), syncPlanLinks per-key replace-merge (:6999-7009), MonitorProvenanceMemo (:8547)
- CLAUDE.md event-sourcing invariants — the sanctioned bounding shapes (id-watermark memo, recencyBound serve-only, per-key replace-merge)
- The 437s syncPlanLinks incident (fn-1052 lineage) — the precedent this audit guards against

## Docs gaps

- **CLAUDE.md** (event-sourcing bullet): grows ONLY if a genuinely new bounding pattern gets codified — otherwise leave untouched

## Best practices

- **Separate SQL read cost from fold cost:** a "slow fold" is frequently a slow SELECT in disguise — benchmark them independently [phiresky.github.io/blog/2020/sqlite-performance-tuning]
- **Checkpoint the WAL before a replay session:** reader cost is proportional to WAL size; run PRAGMA wal_checkpoint before timing [sqlite.org/wal.html]
- **The two-point slope test is the honest scaling detector:** flat per-event cost between corpus halves = bounded fold; growth = accumulating-state scan
