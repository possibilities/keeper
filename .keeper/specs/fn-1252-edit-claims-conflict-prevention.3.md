## Description

**Size:** S
**Files:** src/db.ts, src/reducer.ts, src/autopilot-worker.ts, test/autopilot-worker.test.ts

### Approach

Add two durable `autopilot_state` config fields — a drift behind-count threshold and a
merge-base-age (days) threshold — set via the GENERIC `set_autopilot_config` RPC (a partial
autopilot_state patch; NO new RPC — a new setting is a column + patch field, per the
writes-are-tightly-scoped invariant). Add columns via `addColumnIfMissing` (pattern
db.ts:3524/:3800) + one `SCHEMA_STEPS` entry (version assigned at MERGE time, never
hardcoded; re-pin `SCHEMA_FINGERPRINT`). The base-freshness gate is DEFAULT OFF (sentinel/0
disables), opt-in like `worktree_mode`; when unset, the drift probe (`.2`) and refresh (`.4`)
are inert. Suggested enabled defaults ~behind 15 / age 5 days (tunable; there is no universal
value).

### Investigation targets

*Verify before relying — the repo moves.*

**Required:**
- src/db.ts:3524, :3800 — `addColumnIfMissing` prior art (`merge_escalated_at`, `human_notified_at`)
- src/db.ts — the `autopilot_state` schema + `SCHEMA_STEPS` ladder tail
- the `set_autopilot_config` handler + the `autopilot_state` column set it patches

### Risks

The migration ladder is a singleton — the `SCHEMA_STEPS` version is assigned at merge, never hardcoded (docs/adr/0020). Shares the db.ts schema ladder with `.6` (dep edge serializes them).

### Test notes

Config round-trips through `set_autopilot_config`; default OFF disables detection + refresh; re-fold determinism preserved.

## Acceptance

- [ ] Two durable autopilot_state fields (drift behind-threshold, drift age-threshold) are settable via the EXISTING `set_autopilot_config` RPC — no new RPC surface.
- [ ] The gate is OFF by default; when off, no drift detection or refresh occurs.
- [ ] The schema change is one forward-only `SCHEMA_STEPS` entry with `SCHEMA_FINGERPRINT` re-pinned.

## Done summary
Added drift_behind_threshold and drift_age_threshold_days to autopilot_state (SCHEMA_STEPS v119, FINGERPRINT re-pinned), settable via the existing set_autopilot_config RPC with default-OFF sentinel/0-disables semantics; added a resolveDriftThresholds resolver in autopilot-worker.ts for .2/.4 to consume.
## Evidence
