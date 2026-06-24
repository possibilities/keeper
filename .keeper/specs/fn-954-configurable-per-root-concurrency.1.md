## Description

**Size:** S
**Files:** src/db.ts, src/reducer.ts, src/autopilot-worker.ts, src/protocol.ts, src/server-worker.ts, src/readiness-client.ts, src/collections.ts, cli/autopilot.ts, test/db.test.ts, test/reducer.test.ts, test/readiness-client.test.ts

### Approach

Add `max_concurrent_per_root` as a scalar autopilot config value riding fn-953's
mechanism: a new `autopilot_state.max_concurrent_per_root` column (in-memory
`DEFAULT_MAX_CONCURRENT_PER_ROOT = 1`), included in the `AutopilotConfigSet` patch
schema + preserved by the sibling folds, served on the subscribe socket
(collections allowlist), and threaded into `ReconcileState`. Then thread N to the
CLIENT for board consistency by adding it to `BootStatus` (mirror the
`git_unseeded_roots` pattern: protocol field, server-side stamp from the folded
column, client latch in `onBootStatus` feeding `computeReadiness`). This task does
NOT change the mutex logic — it just makes N available everywhere; the allocator is
task .2. Until .2 lands, N is read but unused (the hardcoded N=1 mutex still runs).

### Investigation targets

**Required** (read before coding):
- fn-953's `AutopilotConfigSet` fold + `set_autopilot_config` patch schema — extend the patch + the fold's preserved-columns set with the new column.
- src/db.ts — `DEFAULT_MAX_CONCURRENT_JOBS` (~:181) as the const template; the `autopilot_state` CREATE (~:1226) + an `addColumnIfMissing` migration (fix-forward, no rewind — the fold never reads it; bump SCHEMA_VERSION + keeper/api.py SUPPORTED_SCHEMA_VERSIONS same commit). collections.ts:539 allowlist.
- src/protocol.ts:106-112 `BootStatus` + src/server-worker.ts:1967 stamp + src/readiness-client.ts:1399/1703 latch — the `unseededRoots`-via-BootStatus template to mirror for `max_concurrent_per_root`.
- src/autopilot-worker.ts:1493/1800 — thread the resolved column ?? DEFAULT into `ReconcileState`.

### Risks

- The sibling-fold preservation rule from fn-953 applies to the new column too — a paused/mode/cap patch must not null it.
- BootStatus is forward-compat (older clients ignore unknown fields); the client must default to 1 when the field is absent.

### Test notes

`bun run test:full`. Cover: column default (fresh DB → 1), `set_autopilot_config {max_concurrent_per_root}` round-trip, sibling preservation, BootStatus stamp+latch defaults to 1 when absent.

## Acceptance

- [ ] `max_concurrent_per_root` column (default 1) settable via fn-953's `set_autopilot_config`; preserved by sibling folds; served on the subscribe socket.
- [ ] N threaded into `ReconcileState` and onto `BootStatus` → latched client-side; absent → defaults to 1.
- [ ] SCHEMA_VERSION + SUPPORTED_SCHEMA_VERSIONS bumped together if a column/migration is added.
- [ ] `bun run test:full` green (mutex behavior unchanged — still N=1).

## Done summary

## Evidence
