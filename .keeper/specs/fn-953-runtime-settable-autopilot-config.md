## Overview

Make all scalar autopilot CONFIG values uniformly runtime-settable so a future
TUI can fully display + configure autopilot, and so adding a new setting never
needs a new RPC. Today `max_concurrent_jobs` is config-file-frozen at boot
(YAML → resolveConfig → AutopilotCapSet) and has no runtime setter, while
paused/mode/armed are live RPCs — an inconsistent split. This unifies the config
half: a single generic `set_autopilot_config` RPC takes a partial patch of config
values, round-trips one `AutopilotConfigSet` event, and upserts the
`autopilot_state` singleton row. Config-file support for these settings is DELETED;
defaults become in-memory code constants used until a value is set. `autopilot_state`
(already on the subscribe socket) is the single live source of truth — the TUI
reads by subscribing, writes via the one RPC. paused/mode (live already) and armed
(per-epic) keep their existing RPCs.

End state: `max_concurrent_jobs` is set at runtime via `set_autopilot_config`,
defaults to its code constant in memory on a fresh DB, and no longer appears in the
config file. Adding a future scalar setting = a column + a patch field, no new RPC.

## Quick commands

- `keeper autopilot config max_concurrent_jobs 8` (or the chosen verb) — sets it live.
- `keeper autopilot` — banner shows the live cap from `autopilot_state`.
- `bun run test:full` — reducer/db/rpc/daemon paths.

## Acceptance

- [ ] A generic `set_autopilot_config` RPC accepts a partial patch of scalar autopilot config values and round-trips ONE `AutopilotConfigSet` synthetic event that upserts `autopilot_state` (preserving unpatched columns).
- [ ] Config-file support for `max_concurrent_jobs` is REMOVED (dropped from `resolveConfig`/`KeeperConfig`); its default is an in-memory code constant; the boot-append-from-config freeze is gone.
- [ ] On a fresh DB (no `AutopilotConfigSet` event) the reconciler + client resolve `autopilot_state.max_concurrent_jobs ?? DEFAULT` in memory; replaying a DB with a set value reproduces it.
- [ ] All three singleton-row folds preserve the columns they don't own (no nulling on a sibling upsert).
- [ ] `keeper autopilot` can set the cap at runtime; the value survives across reconcile ticks and is served on the subscribe socket.
- [ ] CLAUDE.md scoped-write-surface invariant updated for the new `set_autopilot_config` surface; README config-keys prune `max_concurrent_jobs`. Forward-facing.
- [ ] `bun run test:full` green; `SCHEMA_VERSION`/`SUPPORTED_SCHEMA_VERSIONS` handled if a column/migration is touched.

## Early proof point

Prove the round-trip first: `set_autopilot_config {max_concurrent_jobs: N}` → `AutopilotConfigSet` → folded column → reconciler reads it. If the fold doesn't preserve sibling columns (paused/mode), the whole singleton-row approach needs the ON-CONFLICT fix before proceeding.

## References

- `max_concurrent_jobs` plumbing to repurpose: src/db.ts (DEFAULT_MAX_CONCURRENT_JOBS ~:181, KeeperConfig ~:159, resolveConfig ~:217/297-301), src/reducer.ts AutopilotCapSet fold + siblings (~:4120-4182, all three preserve-columns), src/daemon.ts boot-append (~:1967-2004), src/autopilot-worker.ts (workerData→ReconcileState ~:1493/1800), collections.ts column allowlist (:539).
- The scoped RPC write surface lives in the RPC handlers alongside set_autopilot_paused/set_autopilot_mode/set_epic_armed; CLAUDE.md enumerates it.
- This is the foundation the per-root concurrency epic + a future autopilot TUI build on.
