## Description

**Size:** M
**Files:** src/plan-worker.ts

### Approach

Update keeper's plan-worker to watch + fold BOTH `.keeper/{epics,tasks,state}` (primary) and `.planctl/…` (transient fallback) so the `epics` projection — and therefore autopilot's board — covers every repo regardless of which dir name it currently uses. Keep `isVendoredPlanPath` pruning the vendored `plugins/plan/.keeper` (and legacy `.planctl`). Re-fold determinism holds (path is a trigger; data still parsed from the file).

### Investigation targets

**Required**:
- src/plan-worker.ts — the `.planctl/{epics,tasks}` watch globs + `isVendoredPlanPath` + the recursive-root discovery

### Risks

- Watching both names must not double-fold the same epic if a repo briefly has both — key by epic id, prefer `.keeper/`.
- This is the change that needs the daemon restart to take effect; until then the running worker watches the old name.

### Test notes

`bun run test:full`. After a (test-harness) restart, a `.keeper/` epic folds into `epics`; a legacy `.planctl/` epic still folds.

## Acceptance

- [ ] plan-worker folds `.keeper/` and `.planctl/`; no double-fold; vendored pruning intact
- [ ] `bun run test:full` green
- [ ] note recorded: a daemon restart is required to apply this watch before the flag-day epic

## Done summary
plan-worker now folds both .keeper/ (primary) and legacy .planctl/ (transient fallback): classify/scan/discover route through DATA_DIR_NAMES, dir-level precedence resolves to .keeper/ when both exist (legacy ignored, no double-fold), vendored prune intact. Daemon restart required to apply the new watch before the flag-day rename.
## Evidence
