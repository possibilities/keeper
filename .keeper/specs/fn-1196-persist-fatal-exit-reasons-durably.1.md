## Description

**Size:** S
**Files:** src/daemon.ts, test/daemon.test.ts

### Approach

Thread an optional `reason` through `fatalExit` (backward-compatible — existing bare `fatalExit()` call sites in worker files stay valid and record no reason) and enrich restart-ledger entries from bare epoch-ms numbers to objects carrying the timestamp plus the reason. The ledger write on the fatal path must be synchronous and atomic (tmp+rename) so the reason lands before `process.exit(1)`. The crash-loop decision keeps operating on timestamps only — the reason field is forensic payload, never an input to the counter. The parser must coerce legacy on-disk shapes (bare `number[]`, and mixed arrays) so a deploy that itself crash-loops still counts boots correctly at the one moment it matters. As a bounded side-investigation, confirm the actual log-loss mechanism (launchd opens StandardOutPath append — the loss is likely unflushed stdout at crash or external rotation orphaning the fd) and record the finding in the Done summary; add truncate-in-place rotation only if that finding shows it is needed and cheap.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:11042 — fatalExit(): currently no reason arg; db.close() + process.exit(1)
- src/daemon.ts:3229-3336 — the five ledger pure fns (parseRestartLedger, updateRestartLedger, decideCrashLoop, readRestartLedger, writeRestartLedger) + RESTART_LEDGER_CAP/CRASH_LOOP_THRESHOLD/CRASH_LOOP_WINDOW_MS
- src/daemon.ts:6380-6423 — boot-fold + crash-loop distress mint/clear (must stay ts-only)

**Optional** (reference as needed):
- src/keeper-state-dir.ts — ledger path resolution
- test/helpers/sandbox-env.ts — already sandboxes the restart-ledger path

### Risks

- Anything else reading the raw `number[]` ledger shape would break on objects — grep consumers before reshaping; the ledger is a state-dir sidecar, not a fold, so no migration is needed.
- Reason strings originate from error paths and are attacker-influenced — bound their length and emit as one JSON value, no interpolation.

### Test notes

Extend the existing ledger pure-fn units in test/daemon.test.ts: object entries round-trip; legacy number[] and mixed arrays coerce; decideCrashLoop verdicts are byte-identical for identical ts sequences regardless of reason fields; updateRestartLedger caps and prunes as before.

## Acceptance

- [ ] fatalExit accepts an optional named reason and the restart ledger's newest entry carries that reason after a fatal exit (proven at the pure-fn seam)
- [ ] A legacy bare-number ledger file parses cleanly and the crash-loop decision for it is unchanged from today
- [ ] Crash-loop decision output is identical for identical timestamp sequences with and without reason fields
- [ ] The fatal-path ledger write is synchronous and atomic
- [ ] keeper fast suite green

## Done summary
Threaded an optional named reason through fatalExit, enriching the SAME restart-ledger entry boot-fold already wrote for this process (never a second entry — crash-loop boot count untouched) via a synchronous, atomic tmp+rename write landing before process.exit. Ledger entries grow from bare number[] to RestartLedgerEntry[] ({ts, reason?}), dual-reading legacy bare-number and mixed-shape ledgers; decideCrashLoop is unchanged (bare timestamps only), so the verdict is byte-identical with or without reason fields. Wired named reasons into the three watchdog escalations (git-seed, tmux-control, serve-liveness) and the uncaughtException/unhandledRejection handlers; all other bare fatalExit() call sites are untouched per the backward-compat contract. Side-investigation: log rotation already truncates server.stderr in-place weekly (plist/arthack.keeperd.logrotate.plist truncates then kickstarts, never renames), so the StandardErrorPath fd is never orphaned by rotation — no new rotation work needed. The real log-loss mechanism is unflushed stdout/stderr at the crash instant, which is exactly why the ledger write is its own synchronous file I/O rather than relying on console output surviving process.exit.
## Evidence
