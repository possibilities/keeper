## Description

**Size:** M
**Files:** src/reaper-worker.ts (delete), src/daemon.ts, src/db.ts, src/pair-command.ts, cli/pair.ts, src/glob.ts, src/exec-backend.ts, src/autopilot-worker.ts, src/types.ts, src/wake-worker.ts, src/reducer.ts, test/reaper-worker.test.ts (delete), test/config.test.ts, test/pair-command.test.ts, test/pair-cli.test.ts, test/daemon.test.ts

### Approach

Atomic, single-commit removal of all autoclose CODE + TESTS — must leave the build
and full `bun test` suite green (there is no watchdog; one tier; any half-applied
edit is red). Work the daemon worker-fleet 4-link chain, the `KeeperConfig` config
surface, the `resolveDisableAutoclose` matcher, the CLI-side pair reap, then the
tests, then the forward-facing comment scrubs. Re-grep for
`autoclose`/`reaper-worker`/`disable_autoclose`/`resolveDisableAutoclose`/`KEEPER_ENABLE_REAPER`
before committing — only the intentionally-kept overloaded-"reap" + fn-977 sites
should remain.

### Investigation targets

**Required** (read before coding):
- src/reaper-worker.ts — delete whole; confirm its exports (`selectReapCandidates`, `reaperCycle`, `livePaneOwned`, `ReaperWorkerData`, `DEFAULT_AUTOCLOSE_GRACE_SEC`, etc.) have zero remaining importers afterward.
- src/daemon.ts:113, 1797, 1823, 5335-5372, 5708 — the 4-link chain + `import type ReaperWorkerData` + `reaperConfig`/`reaperEnabled`/`KEEPER_ENABLE_REAPER` + the `reaperWorker` onerror/close guards. Remove EVERY lifecycle point, not just the spawn.
- src/db.ts:172, 177, 214, 250-251, 330-342, and the THREE `KeeperConfig` return literals (~256-262 file-absent, ~362-367 catch, ~378-383 final) — drop both fields + the parse + `DEFAULT_AUTOCLOSE_GRACE_SECONDS`. `resolveConfig` STAYS.
- src/pair-command.ts:34, 691-738 — delete `resolveDisableAutoclose` + the section comment + the now-orphaned `compileFnmatch`/`isGlobToken` glob import. Keep `DEFAULT_PAIR_SESSION`.
- cli/pair.ts:58, 67, 77, 190-203, 357-393, 494, 508, 523, 532, 540 — delete `killWindow`, the reap closure + `shouldReap`/`isAutocloseDisabled`/`reapPaneId`, all `reap()` call sites, and the orphaned `resolveConfig` + `resolveDisableAutoclose` imports. KEEP the `DEFAULT_PAIR_SESSION` import. The SIGTERM handler stays minus `reap()` — it MUST still emit `started`-if-needed + `failed` + `exit 1`.
- test/daemon.test.ts:3346, 3451, 3474, 3504-3517 + the `enableReaper` harness param — drop the `reaper-worker.ts`->`reaper` map entry, the opt-in spawn test, the `enableReaper` plumbing, and update the worker-count word "nineteen"->"eighteen" + the `ALL_WORKERS` literal.

**Optional** (reference as needed):
- src/glob.ts:7, src/exec-backend.ts:147-157, src/autopilot-worker.ts:1242, src/types.ts:484, src/wake-worker.ts:46/186, src/reducer.ts:7771/7845/8132 — forward-facing comment scrubs only (no logic change); keep the `AGENTBUS/PAIR/PANELS_EXEC_SESSION` session-name constants in exec-backend.
- test/config.test.ts:16/20/225-314, test/pair-command.test.ts:30/717-756 (keep `DEFAULT_PAIR_SESSION`), test/pair-cli.test.ts (disable-autoclose case), test/reaper-worker.test.ts (delete whole).

### Risks

- **Overloaded "reap" — do NOT over-delete.** KEEP: autopilot completion-reap, server-worker connection reapers (incl. README:1784 "reaper regressed"), seed-sweep pidless reap, bus channel reap, and the `test/handoff-worker.test.ts` fixture string.
- **fn-977 / migration v92 is immutable and STAYS.** The reducer pane-id-recycle terminal-clear, migration v92, and `test/reducer-projections.test.ts:3915-3950` must NOT be removed (forward-only migration + sacred re-fold determinism). Only rewrite their stale "window-reaper" rationale comments (and `test/db.test.ts:2430`) to forward-facing wording that does not name the deleted reaper.
- **Dangling lifecycle handlers / orphaned imports are the silent build-red traps** — an `import type` to the deleted module is TS2307 (biome won't catch it); the `onerror`/`close` guards must go with the spawn.

### Test notes

Run the full `bun test` suite — the worker-fleet count assertion in `test/daemon.test.ts` and the typecheck for orphaned imports are the tripwires. Commit via `keeper commit-work` (runs biome + the matrix). This task is a SINGLE atomic commit — do not split the exported-symbol deletions from their importer/usage sites.

## Acceptance

- [ ] `src/reaper-worker.ts` deleted; no remaining importer of any of its exports.
- [ ] Daemon worker fleet is `ALL_WORKERS` minus `reaper` across all 4 links + the shutdown registry; no `KEEPER_ENABLE_REAPER` reference remains.
- [ ] `disableAutoclose` + `autocloseGraceSeconds` + `DEFAULT_AUTOCLOSE_GRACE_SECONDS` removed from `src/db.ts` (all three return literals in sync); `resolveConfig` intact.
- [ ] `resolveDisableAutoclose` + its orphaned glob import removed from `src/pair-command.ts`; `DEFAULT_PAIR_SESSION` kept.
- [ ] CLI-side pair reap fully removed from `cli/pair.ts` (incl. the SIGTERM-path kill); the SIGTERM handler still emits `failed` + exits 1; no orphaned imports.
- [ ] All 5 test files updated/deleted per the targets; the worker-count word is "eighteen".
- [ ] fn-977 reducer logic + migration v92 + `reducer-projections.test.ts:3915-3950` untouched; all non-window reapers untouched.
- [ ] `bun test` green; `keeper commit-work` lands one commit.

## Done summary
Removed the tmux window-autoclose reaper end to end: deleted src/reaper-worker.ts + its test, pruned the daemon worker-fleet 4-link chain (ALL_WORKERS now eighteen), the disable_autoclose/autoclose_grace_seconds config surface, resolveDisableAutoclose, and the CLI-side pair reap; scrubbed window-reaper rationale from the immutable fn-977/migration-v92 sites, README, and pair/panel skills. Full bun test suite green.
## Evidence
