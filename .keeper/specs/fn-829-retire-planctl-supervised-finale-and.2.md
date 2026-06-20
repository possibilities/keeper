## Description

**Size:** S
**Files:** plugins/plan/src/{store,discovery}.ts, src/plan-worker.ts

### Approach

Now that every repo is on `.keeper/`, delete the transient `.planctl/` read-fallback from the CLI and the plan-worker. The system reads `.keeper/` only; `LEGACY_DATA_DIR` and the dual-watch go away.

### Investigation targets
**Required**:
- the `LEGACY_DATA_DIR`/fallback sites added in epic 4 (CLI + plan-worker)

### Risks
- Removing the fallback before ALL repos migrated would dark any straggler — confirm epic 5 + keeper's rename all done first.

### Test notes
`bun run test:full`; `rg -n '\.planctl' plugins/plan/src src` → 0. Needs a daemon restart to apply the plan-worker change.

## Acceptance
- [ ] `.planctl/` fallback removed (CLI + plan-worker); `rg '\.planctl' src plugins/plan/src` → 0; `bun run test:full` green
## Done summary
Removed the transient .planctl read-fallback: collapsed DATA_DIR_NAMES to .keeper in the CLI seam (state_path.ts) and the plan-worker, dropped LEGACY_DATA_DIR. The system reads .keeper only; migrated all test fixtures from .planctl to .keeper. Vendored plugins/plan/.planctl subtree guard unchanged.
## Evidence
