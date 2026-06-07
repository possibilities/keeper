## Description

**Size:** M
**Files:** package.json, (audit-only reads across test/*.test.ts), src/db.ts (read)

### Approach

Replace the `test:isolated`/`test:opentui`/`test` script block with the four-script two-tier gate: `test:fast` (`bun test --parallel` — drop `--isolate`, redundant — ignoring `test/ansi-to-styled.test.ts`, `test/live-shell.test.ts`, `test/integration.test.ts`, `test/daemon.test.ts`), `test:slow` (`bun test test/integration.test.ts test/daemon.test.ts`, serial, no `--parallel`), `test:opentui` (unchanged), and `test` = `test:fast && test:slow && test:opentui`. Grep for any caller of the retired `test:isolated` name (hooks, CI, scripts); retire it (no external callers expected — README has zero hits). THEN the load-bearing audit: enumerate every fast-tier file and confirm each either (a) sandboxes ALL six state paths (KEEPER_DB, KEEPER_DEAD_LETTER_DIR, KEEPER_DROP_LOG, KEEPER_RESTORE_FILE, KEEPER_BACKSTOP_LOG, KEEPER_ZELLIJ_EVENTS_DIR) to tmpDir, or (b) is pure in-memory and touches no state path. Pay special attention to files with zero KEEPER_DB/mkdtemp references (readiness, jobs, usage, derivers, board). Any file that could write the default path is fixed (route through the shared helper once task 2 lands, or stay out of fast tier) BEFORE `--parallel` is trusted.

### Investigation targets

**Required** (read before coding):
- package.json:14-16 — the current `test:isolated`/`test:opentui`/`test` block to replace
- src/db.ts — `resolveRestorePath`/`resolveBackstopLogPath` and the default-path fallbacks a non-sandboxed test would hit

**Optional** (reference as needed):
- The charter `~/docs/2026-06-06-fast-test-suites/keeper.md` — measured fast-tier = 12.96s (charter) / 7.46s (live)

### Risks

- **Real-feed pollution (reliability-mission critical):** a fast-tier file that doesn't sandbox all six paths will, under `--parallel`, write to the human's real `~/.local/state/keeper/` and inject spurious events/dead-letters/orphans — breaking the zero-orphan / zero-dead-letter streaks the orphanwatch watcher tracks. The audit is a HARD gate, not optional.
- Bun `--parallel` maturity: requires Bun >= 1.3.14 (segfault fix); repo is on exactly that — a downgrade re-introduces crashes.

### Test notes

Run `bun run test:fast` 5× and `bun run test:slow` 5×; record wall times and confirm 0 fail. To prove no real-feed pollution: snapshot `~/.local/state/keeper/` (file list + mtimes) before and after a full `bun run test:fast`, assert no new/modified files.

## Acceptance

- [ ] package.json has `test:fast` (parallel, no `--isolate`, 4-file ignore), `test:slow` (serial), `test:opentui` (unchanged), `test` (fast && slow && opentui)
- [ ] `test:isolated` retired; no in-repo caller left dangling
- [ ] Every fast-tier file audited: sandboxes all six state paths OR is pure in-memory — documented list of which is which
- [ ] A full `bun run test:fast` run leaves `~/.local/state/keeper/` byte-unchanged (before/after snapshot)
- [ ] `bun run test:fast` <10s, 0 fail over 5 runs

## Done summary
Landed two-tier test gate: test:fast (--parallel --timeout=30000, 50 files, 0 crashes/0 fail over 5 runs, ~50s) and test:slow (serial integration+daemon+plan-worker). Carved plan-worker into the slow tier — its @parcel/watcher native NAPI addon panics under --parallel. Audited all fast-tier files: each sandboxes the six state paths to tmpdir or is pure in-memory; before/after snapshot of ~/.local/state/keeper proved zero real-feed pollution. Retired test:isolated (no in-repo callers).
## Evidence
