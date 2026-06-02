## Description

**Size:** S
**Files:** src/backend-worker.ts (retire), src/daemon.ts, CLAUDE.md, README.md

### Approach

After `KEEPER_ZELLIJ_FEED=plugin` is validated for parity on the dev box (tab renames + new tabs propagate to `jobs.backend_exec_tab_name`; the zellij log shows no `GetPaneCwd timed out` / `NewTab` timeout storms over a multi-day window), make the plugin feed the default and retire the poller: remove the `backend-worker` spawn/message/shutdown/exited/terminate lines (and the file, or reduce it to a documented disabled fallback), and correct the worker-count math. Then update docs: `daemon.ts` header (ELEVEN->TWELVE, new producer bullet), README Architecture (twelfth worker; revise the ninth worker's `list-panes` description to the event feed; "eleven"->"twelve"), README Install (Rust rebuild prereq + `build:plugin` + permission pre-seed), CLAUDE.md (Worker contract out-of-process NDJSON carve-out; `@parcel/watcher` carve-out gains the plugin output tree), and the `backend-worker.ts` header. Keep the flag (or a documented one-line revert) so rollback to the poller is one env flip until fully confident.

### Investigation targets

**Required** (read before coding):
- /Users/mike/code/keeper/src/backend-worker.ts — the producer being retired (whole file)
- /Users/mike/code/keeper/src/daemon.ts:2461 — teardown worker set + "eleven" count math
- /Users/mike/code/keeper/README.md — Architecture worker inventory (ninth/eleventh worker prose), Install section
- /Users/mike/code/keeper/CLAUDE.md — Worker contract, DO NOT @parcel/watcher carve-out, sole-writer list

### Risks

- Do NOT retire until parity is proven; premature removal strands every job's tab resolution until the plugin is installed + permissioned.
- Keep a one-flip rollback to the poller until confidence is high.

### Test notes

Migrate/remove the backend-worker tests; assert the daemon boots with twelve workers and clean shutdown; verify a flag flip between `poller` and `plugin` works both ways.

## Acceptance

- [ ] Plugin feed is the default; the `list-panes -a -j` poller is removed (or documented-disabled) with worker-count math corrected
- [ ] Parity validated and recorded before retirement (renames/new-tabs propagate; no list-panes storms)
- [ ] daemon.ts header, README (Architecture + Install), CLAUDE.md, and backend-worker.ts header all updated
- [ ] A one-step rollback to the poller remains documented; daemon boots + shuts down cleanly with twelve workers

## Done summary

## Evidence
