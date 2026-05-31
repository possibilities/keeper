## Overview

A keeperd restart starves concurrent Claude Code hooks into
`insert:SQLITE_BUSY` dead letters: each bounce is a write-lock contention
window where a hook can't grab the single SQLite writer within its ~2.4s
budget. This is the dominant remaining Mechanism-A drop source after fn-656
fixed steady-state fanout — 7+ genuine drops since the 14:29 deploy,
clustered around restarts; observed mid-bounce with two daemon pids and the
replay RPC itself timing out (main saturated). WAL mode gives NO writer FIFO
fairness, so the daemon's tight boot-drain `BEGIN IMMEDIATE` loop re-grabs
the lock before a sleeping hook's busy-handler retry fires. End state: a
bounce no longer drops hooks — the boot/catch-up window yields the writer
often enough (and holds it briefly enough) that a concurrent hook always
gets a slot, WITHOUT wedging boot or breaking re-fold determinism.

## Quick commands

- `grep '\[fold-slow\]' ~/.local/state/keeper/server.stderr | tail` — per-fold write-lock hold (≥200ms)
- `bun test test/daemon.test.ts` — boot-drain + the new starvation repro
- after a deliberate bounce: `uv run python3 -c "<count genuine insert:SQLITE_BUSY in hook-drops.ndjson since boot>"` — must be 0

## Acceptance

- [ ] Write-lock hold during a real bounce is MEASURED and the dominant hold localized (per-fold drain loop / end-of-boot checkpoint / post-serving git burst / old↔new coexistence)
- [ ] A deterministic starvation repro in `test/daemon.test.ts` shows a concurrent writer hitting SQLITE_BUSY during an UNPACED boot drain and ZERO under the fix
- [ ] Re-fold determinism preserved: pacing lives OUTSIDE the fold transaction; a from-scratch re-fold reproduces byte-identical projections
- [ ] Boot never wedges: pacing is capped/suppressed so a large backlog (incl. from-scratch re-fold ~150k events) still catches up to head in bounded time
- [ ] Post-deploy: zero genuine `insert:SQLITE_BUSY` drops across multiple observed bounces
- [ ] Single drain code path preserved (boot-phase parameter OK; no forked boot path)

## Early proof point

Task that proves the approach: `.1`. Its Phase 1 (measure + deterministic
starvation repro) is the keystone — if the repro can't reproduce starvation
against the unpaced drain, the hypothesis is wrong and we re-localize before
writing any fix.

## References

- Evidence + trace: `~/docs/keeper-reliability/findings.md` (2026-05-31 "bounce-window contention") + `streak.md`
- Boot sequence: `src/daemon.ts` `runDaemon` ~:579 (migrate → `withBootDrainCheckpointTuning`(drain→`seedKilledSweep`→drain) ~:619 → workers; server-worker `acquireLock`+bind spawns AFTER the drain — the structural crux), `drainToCompletion` ~:122, `withBootDrainCheckpointTuning` ~:166
- Drain seam for a post-COMMIT yield: `src/reducer.ts` `drain()` per-fold loop ~:5599-5638 (one `BEGIN IMMEDIATE` per event; lock released between)
- Prior art: commit d3aa981 (WAL autocheckpoint disabled during boot drain) — build on it
- Test precedent: `test/daemon.test.ts` drives drain/sweep against a tmp DB without workers; has a `busy`-counter fixture ~:190
- Hook budget: `plugin/hooks/events-writer.ts` `HOOK_BUSY_TIMEOUT_MS=1200` ~:407 + one retry ≈ 2.4s; raising it risks the 1.5s SessionEnd budget (defense-in-depth only)

## Best practices

- **Yield between catch-up transactions** (an OS-level sleep, not `setImmediate` — the hook is a separate process and `bun:sqlite` blocks the JS thread). This is the #1 non-obvious fix: WAL has no writer FIFO fairness.
- **End-of-boot checkpoint:** prefer `wal_checkpoint(PASSIVE)` over `TRUNCATE` under concurrent hooks (TRUNCATE waits for writers, can block a full busy_timeout) — or defer TRUNCATE until after serving.
- **Measure, don't speculate:** localize the hold (start-of-boot vs per-fold vs end-of-boot TRUNCATE vs post-serving git burst) BEFORE choosing the fix; the fix differs entirely by location.
- **Don't batch events per transaction** to "speed up" boot — longer holds worsen per-event starvation. One event per txn stays.

## Docs gaps

- **CLAUDE.md**: "Drain folds one event per transaction … never starve" (~:197) — revise to the actual post-fix cadence/guarantee. "One drain code path … do not add a separate boot path" (~:195) — tighten to permit stateless, re-fold-deterministic boot-phase gating inside the single loop. `busy_timeout` PRAGMA note (~:326) if the value changes.
- **README.md**: Architecture boot-sequence prose (~:79-82, ~:1009-1015) — name the boot constraints (autocheckpoint-off-during-drain, any new pacing/checkpoint cadence).

## Alternatives

- **Structural (higher-leverage, larger):** acquire the ownership lock BEFORE the boot drain so the old daemon fully releases first and the new main never contends live writers during catch-up. Bigger change to the bounce semantics (what if the old daemon is wedged?); evaluate after measurement shows whether old↔new coexistence is the actual hold.
- **Defense-in-depth only:** raise the hook `busy_timeout`. Legitimate but NOT a fix (no FIFO guarantee) and risks the 1.5s SessionEnd budget. Defer unless the daemon-side fix proves insufficient.

## Architecture

The single writer is `main`. Boot work (migrate → drain → seedKilledSweep →
drain → scanDeadLetterDir) runs synchronously on main BEFORE the
server-worker (which owns `keeperd.lock`) spawns — so a bounce overlaps the
old daemon's tail and contends live hooks with no mutual exclusion. The fix
space is: (a) yield the writer between boot folds; (b) make the end-of-boot
checkpoint non-blocking; (c) reorder lock acquisition before the drain;
measurement picks among them.

## Rollout

Verify on a DB copy / instrumented bounce first. Deploy via a normal keeperd
bounce; immediately confirm clean resume (cursor→head, socket binds) AND zero
new genuine drops across several subsequent bounces. Rollback is reverting
the drain-pacing change (isolated to the drain path + boot wrapper); the
starvation test guards regression.
