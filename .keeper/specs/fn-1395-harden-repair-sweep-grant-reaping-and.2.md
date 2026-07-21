## Description

Finding F2. The maintenance-task mint idempotence probe
`hasOpenMaintenanceTask` (`src/daemon.ts`) reads the `epics` projection,
and `runRepairEscalationSweepTick` is scheduled by a bare `setInterval`
(`daemon.ts` ~16884) with no in-flight / reentrancy guard. Between a mint
(`keeper plan scaffold` + `validate` subprocess pair) landing and its epic
folding into the projection — or when a tick runs longer than the ~60s
heartbeat and a second tick overlaps — a subsequent probe reads false and
mints a duplicate maintenance epic for one trunk-red incident. Autopilot
then dispatches both, so two workers race the same trunk-red repair.

Fix: make the sweep tick non-reentrant (an in-flight guard so overlapping
timers no-op) and/or dedup by deterministic maintenance title inside
`keeper plan scaffold` itself, so a not-yet-folded mint cannot be minted
twice. Preserve the existing fail-open mint path (mint_failed -> page once).

Files: src/daemon.ts (runRepairEscalationSweepTick, hasOpenMaintenanceTask,
mintMaintenanceTask), test/daemon.test.ts.

## Acceptance

- [ ] Exactly one maintenance epic is minted per trunk-red incident when the minted epic has not yet folded into the epics projection.
- [ ] Overlapping sweep ticks cannot both mint for the same (repo, fingerprint) group.
- [ ] The fail-open mint path (mint_failed pages once) is preserved.

## Done summary

## Evidence
