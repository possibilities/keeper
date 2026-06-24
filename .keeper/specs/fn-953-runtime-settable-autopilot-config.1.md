## Description

**Size:** M
**Files:** src/rpc-handlers.ts, src/reducer.ts, src/db.ts, src/daemon.ts, src/autopilot-worker.ts, cli/autopilot.ts, CLAUDE.md, README.md, src/types.ts, src/protocol.ts (if the RPC frame type lives there), test/reducer.test.ts, test/db.test.ts, test/rpc-handlers.test.ts (or the autopilot RPC test file), test/autopilot.test.ts

### Approach

Introduce ONE generic mutating RPC `set_autopilot_config` that accepts a partial
patch (a subset of the known scalar autopilot config columns; for now just
`max_concurrent_jobs`, extensible later) and round-trips a single
`AutopilotConfigSet` synthetic event. The fold upserts the `autopilot_state`
singleton row, setting only the patched columns and PRESERVING every other column
(mirror the existing AutopilotCapSet/ModeSet/Paused preserve-other-columns
discipline). Then DELETE config-file support for `max_concurrent_jobs`: remove it
from `resolveConfig`/`KeeperConfig`, keep `DEFAULT_MAX_CONCURRENT_JOBS` as the
in-memory default, remove the boot-append that froze the config value, and have the
reconciler + client resolve `autopilot_state.max_concurrent_jobs ?? DEFAULT`. Retire
`AutopilotCapSet` (replaced by `AutopilotConfigSet`) — its only producer was the
boot-freeze. Add a `keeper autopilot` setter verb that emits the RPC. Leave
paused/mode (live RPCs) and armed (per-epic) untouched.

### Investigation targets

**Required** (read before coding):
- src/reducer.ts:4120-4182 — `foldAutopilotCapSet` + `foldAutopilotModeSet`/`foldAutopilotPaused`; the singleton-row UPSERT + preserve-other-columns ON CONFLICT pattern the new `AutopilotConfigSet` fold must follow (and which existing folds must keep preserving any column).
- the RPC handler module (set_autopilot_paused / set_autopilot_mode / set_epic_armed) — the scoped mutating-RPC pattern to mirror for `set_autopilot_config` (validate patch → mint synthetic event → ack).
- src/db.ts:159/181/217/297-301 — `KeeperConfig.maxConcurrentJobs`, `DEFAULT_MAX_CONCURRENT_JOBS`, the `resolveConfig` read sites to delete; the `autopilot_state.max_concurrent_jobs` column (keep) + collections.ts:539 allowlist (keep).
- src/daemon.ts:1967-2004 — the AutopilotCapSet boot-append-from-config to REMOVE; :3645/3671 the apConfig→workerData thread (maxConcurrentJobs no longer sourced from config).
- src/autopilot-worker.ts:1493/1800 — `ReconcileState.maxConcurrentJobs` now resolves from the folded column ?? DEFAULT (not from config).
- CLAUDE.md — the "RPC may write ONLY these five surfaces" invariant block (becomes six; `set_autopilot_config` is the general config surface future settings ride). README config-keys block (~:427-491) prunes `max_concurrent_jobs`.

### Risks

- Historical replay: an OLD DB has `AutopilotCapSet` events; the new code must still fold them (keep the fold arm, or migrate). A DB with no config event must resolve the in-memory DEFAULT — verify a fresh-DB reconcile is byte-identical to today's default behavior.
- Singleton-row preservation: a patch that sets only `max_concurrent_jobs` must NOT null `paused`/`mode`; conversely a paused/mode fold must preserve the cap. This is the load-bearing fold correctness.
- If a new column or migration is touched, bump `SCHEMA_VERSION` + `keeper/api.py` SUPPORTED_SCHEMA_VERSIONS same commit (test enforces). The `max_concurrent_jobs` column already exists, so likely NO migration — confirm.
- Removing config-file support is a behavior change for anyone setting `max_concurrent_jobs` in YAML — it now needs the runtime RPC. Note in the commit/docs.

### Test notes

`bun run test:full`. Cover: the RPC patch round-trip (set → event → folded column → reconciler reads); sibling-column preservation (set cap doesn't clear paused/mode and vice versa); fresh-DB resolves DEFAULT; an `AutopilotConfigSet` replay reproduces the value; the CLI verb emits a well-formed frame.

## Acceptance

- [ ] `set_autopilot_config` RPC validates + round-trips a partial patch via one `AutopilotConfigSet` event; fold upserts only patched columns, preserves the rest.
- [ ] `max_concurrent_jobs` removed from `resolveConfig`/`KeeperConfig` + the boot-append freeze; default is the in-memory constant; reconciler/client resolve `column ?? DEFAULT`.
- [ ] Sibling folds (paused/mode) preserve the cap column and vice versa; fresh-DB reconcile is byte-identical to today's default.
- [ ] `keeper autopilot` setter verb sets the cap at runtime; banner reflects it.
- [ ] CLAUDE.md write-surface invariant + README config-keys updated forward-facing.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
