## Overview

keeper's board lags reality by minutes because plan-worker realtime wakes are missed and recovery falls to slow heartbeats. Measured (backstop.ndjson): git/transcript/plan heartbeats fire `class:missed-wake`; one plan-heartbeat rescue showed `staleness_ms:210665` (3.5 min). Confirmed mechanism: the broad `~/code` watch IGNORES `.git` (`IGNORE_GLOBS`), so the per-repo `.git/logs/HEAD` reflog watch is the ONLY FSEvents commit signal — and it exists ONLY while a repo has a pending planctl path (`reconcileReflogWatches` diffs `pendingRepos()`). A commit in a no-pending repo has no reflog watch and no DB write, so it's invisible until the git-worker's 60s heartbeat. This epic drives fold-latency p95 to single-digit seconds via SAFE levers only (reliable wakes + safe cadence), DIAGNOSTIC-FIRST and PROVEN against a controlled latency harness. Re-fold determinism and the fn-629 in-HEAD gate are UNTOUCHED; optimistic pre-commit fold is explicitly out of scope.

## Quick commands

- `bun test test/plan-worker.test.ts`
- `bun test`
- `bun scripts/backstop-stats.ts`  # staleness p50/p95/p99 surface
- `launchctl kickstart -k gui/$(id -u)/arthack.keeperd`  # deploy: reload the daemon

## Acceptance

- [ ] Fold-latency p95 driven to single-digit seconds (target <= 5s, the existing FOLD_LATENCY_REALTIME_THRESHOLD), PROVEN by a controlled before/after harness — for the previously-slow no-pending-repo-commit path.
- [ ] Determinism, the fn-629 in-HEAD gate, the poll-is-trigger-only contract, the RPC surface, and the hook are all unchanged.
- [ ] No fn-712/fn-716 storm regression; keeperd restarted to deploy.

## Early proof point

Task that proves the approach: `.1` (the measured diagnosis + harness). If `.1` shows the dominant cost is NOT addressable by a safe lever (e.g. it's fundamentally the commit-in-HEAD wait), STOP and re-evaluate — that would mean only the risky optimistic-pre-commit-fold road remains, which is a separate decision, not this epic.

## References

- Latency lineage to read first: fn-705 (realtime triggers: db-poll + reflog), fn-712 (anti-storm scoped recheck), fn-716 (git schedule floor), fn-720 (backstop telemetry), fn-733 (babysitter fold-latency detectors). All done — this epic consumes/sharpens them.
- Confirmed: `IGNORE_GLOBS` excludes `.git` (plan-worker.ts:419,440) → broad watch can't see `.git/logs/HEAD`; reflog watch is the only FSEvents commit signal, pending-repos-only (`reconcileReflogWatches` :2943).
- Determinism invariant (CLAUDE.md): folds see only committed state; the in-HEAD gate stays; the poll is a TRIGGER (gate-respecting, no DB write). No kernel watchers on keeper's own DB.

## Docs gaps

- **README.md `## Architecture` (~1140-1177)**: names `PLAN_DB_POLL_MS` (100ms), `RECONCILE_HEARTBEAT_MS` (5s "should-never-fire"), and the historical "up-to-60s fold lag" — revise to current-state if any cadence changes.
- **cli/keeper-watch.ts (~240,258)**: `STALENESS_ALARM=30_000`, `FOLD_LATENCY_REALTIME_THRESHOLD=5` carry calibration JSDoc — revise if the realtime bar or cadences change (grep -a; file has a binary byte).

## Best practices

- **FSEvents is a hint, not a guarantee** (coalesced/reordered/dropped) — watcher-is-hint, poll-is-truth; keep the poll fallback.
- **Watch the directory, not the file, for `.git/logs/HEAD`** (git atomically renames it — a file/inode watch goes silently stale). Already correct in-repo.
- **Avoid overlapping subtree watches** — they trip fseventsd bad-state/registration failures (which mute ALL watchers). The broad watch ignoring `.git` is why per-repo reflog watches don't overlap it.
- **Monotonic clock (`performance.now`) for durations**, wall-clock only for labels/cross-process.
