## Description

**Size:** M
**Files:** src/db.ts, src/reducer.ts, src/collections.ts, src/daemon.ts, cli/autopilot.ts, keeper/api.py, test/autopilot.test.ts, test/schema-version.test.ts

### Approach

Surface the cap value on the autopilot TUI, sourced ENTIRELY over the
socket — the viewer must never read config.yaml. Deliver it as a new
column on the existing `autopilot_state` singleton projection (the proven
server→viewer rig that already carries `paused`), fed by a boot-appended
value-carrying synthetic event.

1. **Schema (src/db.ts):** bump `SCHEMA_VERSION` 59 → 60; add a nullable
   `max_concurrent_jobs INTEGER` column to `autopilot_state` via the ALTER
   slot in `migrate()` (whitelist-only, no backfill — follow the
   v46→v47 / v49→v50 templates). Column DEFAULT NULL = unlimited, matching
   the zero-event projection.
2. **keeper/api.py:** add `60` to `SUPPORTED_SCHEMA_VERSIONS` in the SAME
   change (whitelist, not a floor; `test/schema-version.test.ts` enforces).
3. **New event (src/reducer.ts):** add an `AutopilotCapSet { max_concurrent_jobs: number | null }`
   synthetic event with `extractAutopilotCapSetPayload` (null-tolerant —
   malformed folds to `null`, never throws, cursor still advances) and a
   `foldAutopilotCapSet` arm. The fold UPSERTs `id=1` setting ONLY
   `max_concurrent_jobs` and PRESERVING `paused` on conflict; symmetrically
   confirm `foldAutopilotPaused` preserves `max_concurrent_jobs` on
   conflict (so a play/pause toggle never clobbers the cap). Reads nothing
   outside the payload (re-fold determinism — no `resolveConfig()` in the
   fold).
4. **Boot-append (src/daemon.ts):** at boot, alongside the existing
   `AutopilotPaused{paused:true}` re-arm (before `serverWorker` spawns),
   mint `AutopilotCapSet{ max_concurrent_jobs: resolveConfig().maxConcurrentJobs }`
   — the config is read on main and FROZEN into the payload at mint time.
5. **Wire (src/collections.ts):** add `max_concurrent_jobs` to
   `AUTOPILOT_STATE_DESCRIPTOR.columns` so it rides the subscribe wire.
6. **Viewer (cli/autopilot.ts):** add a `projectMaxConcurrentJobs(rows)`
   coercion mirroring `projectAutopilotPaused` (absent row / NULL / missing
   column → unlimited). Extend `ViewerState` with the cap; fold it into the
   `autopilot_state` subscribe handler; render it next to the pill in the
   `persistentBannerPill` closure AND both `setStatus` call sites
   (~:1218, ~:1261) — `[playing] · max 3`, `· max ∞` when unlimited. NO
   `resolveConfig()` import in the viewer.

### Investigation targets

**Required** (read before coding):
- src/db.ts:61 — `SCHEMA_VERSION`; ~:5054 / ~:5150-5180 — ALTER-slot templates (v46→v47, v49→v50); ~:1410-1430 — `autopilot_state` schema + the comment naming "concurrency caps" as a future column; :4787 — autopilot_state rewind DELETE list (no new entry needed).
- src/reducer.ts:3863-3941 — `AutopilotPausedPayload` / `extractAutopilotPausedPayload` / `foldAutopilotPaused` (UPSERT id=1, preserve-on-conflict template); event dispatch site (~:7914).
- src/collections.ts:718-730 — `AUTOPILOT_STATE_DESCRIPTOR` (version `last_event_id`); :801 REGISTRY.
- cli/autopilot.ts:855-866 — `projectAutopilotPaused` coercion template; :1157-1161 `ViewerState`; :1180 banner pill closure; :1218, :1249-1265 subscribe + :1261 setStatus.
- src/daemon.ts:958-994 — boot-append `AutopilotPaused{paused:true}` re-arm seam.
- keeper/api.py:219-249 — `SUPPORTED_SCHEMA_VERSIONS`.

**Optional** (reference as needed):
- test/autopilot.test.ts — viewer/banner/`projectAutopilotPaused` test patterns.
- test/schema-version.test.ts — the api.py whitelist guard.

### Risks

- **Singleton UPSERT clobber:** the two fold arms (`paused`, `cap`) share `id=1`; each MUST preserve the other column on conflict or a pause toggle resets the cap (or vice versa). Test: fold cap=3, then fold a pause toggle, assert cap survives.
- **Re-fold determinism:** the cap is frozen into the event payload at boot-append mint; a cursor=0 re-fold reproduces it byte-identically. After a config change + restart the new boot-append re-mints — so the column lags config until restart (same contract as `zellijSession`); document, don't "fix".
- **null round-trip:** SQL NULL (not the string "null"), wire-encoded, coerced to `∞` in the viewer. Test the full absent → unlimited path including the boot-race empty-rows case.
- **Forgotten api.py bump** fails every keeper-py read host-wide — land it in the same change.

### Test notes

- test/autopilot.test.ts: `projectMaxConcurrentJobs` maps `3`→3, NULL/absent/empty-rows→unlimited; banner string shows `· max 3` and `· max ∞`; `foldAutopilotCapSet` then `foldAutopilotPaused` preserves cap, and vice versa.
- test/schema-version.test.ts: passes with `SCHEMA_VERSION=60` ∈ `SUPPORTED_SCHEMA_VERSIONS`.
- Re-fold determinism: a cursor=0 re-drain reproduces identical `autopilot_state` rows (existing re-fold test harness if present).

## Acceptance

- [ ] `SCHEMA_VERSION` 60 with a nullable `autopilot_state.max_concurrent_jobs` column (DEFAULT NULL); `60` added to `keeper/api.py` `SUPPORTED_SCHEMA_VERSIONS`.
- [ ] `AutopilotCapSet` event + null-tolerant extractor + fold arm that UPSERTs only its column; both fold arms preserve the other's column on conflict.
- [ ] Boot-append mints `AutopilotCapSet` with the config-frozen value before the server worker spawns.
- [ ] Cap rides the `autopilot_state` wire; viewer renders it next to the pill from the socket only (no config read), `∞` when unlimited.
- [ ] A cursor=0 re-fold reproduces byte-identical `autopilot_state` rows; schema-version and autopilot tests pass.

## Done summary
Surface the autopilot max_concurrent_jobs cap on the viewer banner, sourced entirely over the socket. Schema v60 adds a nullable autopilot_state.max_concurrent_jobs column fed by a new AutopilotCapSet synthetic event (boot-appended with the config-frozen value); the viewer renders '· max N' / '· max ∞' next to the play/pause pill without reading config.
## Evidence
