## Description

From F1 (evidence: `plugins/plan/test/consistency-generated-guard.test.ts:190-226`,
`collidingWorkManifests` / `findWorkManifests`): the work-name collision guard
is a test-only walk rooted at `REPO`, so it cannot catch an external `work`-named
plugin in a claude `plugin_scan_dir` re-claiming the name and shadowing the
`--plugin-dir`-selected `work:worker` cell at launch. This is the exact hazard
that gated the source epic (per task .1's done_summary the arthack `work` plugin
in a scan dir blocked the cutover until a rename handoff). A regression would be a
silent wrong-worker spawn — hard to debug. Add a fail-loud dispatch preflight that
probes the actual scan dirs and mints a per-key sticky `DispatchFailed` (cleared by
`retry_dispatch`, mirroring the existing `worker-cell-invalid` / `worker-cell-missing`
shape in `src/autopilot-worker.ts:3472-3505`) when a non-cell `work` manifest would
shadow the constant. Merged finding F4 folds in here: extend coverage to a `work`
manifest in a real scan-dir position, not just the in-repo/synthetic-tmpdir strays
the current guard tests.

## Acceptance

- [ ] Dispatch preflight probes the real scan dirs for a shadowing non-cell `work` manifest and fails loud (sticky DispatchFailed, per-key, retry-clearable) rather than spawning the wrong worker.
- [ ] Determinism preserved: the on-disk probe lives producer-side, never inside pure `reconcile` or a fold.
- [ ] Test covers a `work` manifest in a real scan-dir position (F4), plus the clean no-collision path.

## Done summary
Added a producer-side dispatch preflight in runReconcileCycle that scans the real claude plugin_scan_dirs for a non-cell 'work'-named manifest and mints a sticky per-key work-plugin-shadowed DispatchFailed (retry-clearable) before spawning the wrong worker. Covered by unit + runReconcileCycle tests exercising a work manifest in a real scan-dir position plus the clean path.
## Evidence
