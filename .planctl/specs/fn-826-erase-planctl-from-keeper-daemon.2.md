## Description

**Size:** S
**Files:** src/plan-worker.ts, src/git-worker (the `planctl-commit-changed` consumer), any internal name-tolerant readers

### Approach

Make the daemon-internal consumers tolerant of both commit-event-type names: the plan-worker / main fold both `planctl-commit-changed` and `plan-commit-changed`. Make `isVendoredPlanctlPath`/`isVendoredPlanPath` recognize both the legacy `.planctl` and new `.keeper` vendored sub-path (so the vendored prune survives the later dir rename). Additive only — no producer emits the new event-type name yet (that's the flip epic). Re-fold unaffected (event-type is a worker IPC trigger, not minted projection data).

### Investigation targets

**Required**:
- src/plan-worker.ts (`planctl-commit-changed` consumer + `isVendoredPlanctlPath`)

### Risks

- The vendored-path tolerance must cover `plugins/plan/.planctl` AND `plugins/plan/.keeper` so the prune holds across fn-827/fn-828.

### Test notes

`bun run test:full`. A `plan-commit-changed` message folds identically to `planctl-commit-changed`.

## Acceptance

- [ ] daemon folds both commit-event-type names; vendored-prune recognizes both `.planctl` and `.keeper`
- [ ] `bun run test:full` green

## Done summary

## Evidence
