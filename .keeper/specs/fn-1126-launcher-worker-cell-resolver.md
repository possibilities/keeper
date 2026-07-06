## Overview

Manual `keeper dispatch work::fn-N.M` launches a plan worker with no per-cell `--plugin-dir` — the orchestrator has no work:worker to spawn, contradicting the composition docs; only autopilot's reconcile path resolves the cell. Extract one launcher-owned resolver (pure compose + the two on-disk guards, reject-as-data) into a shared producer-side helper both callers consume: autopilot keeps its sticky DispatchFailed mapping byte-identical, dispatch threads the cell and fails loud, the transport stays untouched. Manual `work::` into a worktree-mode board gains a fail-closed refusal (`--force` overrides) instead of today's silent worktree-less launch; true lane-joining parity stays out of scope until the recovery chain settles.

## Quick commands

- `bun test test/worker-cell.test.ts test/dispatch-cli.test.ts test/autopilot-worker.test.ts test/exec-backend.test.ts` — helper contract, dispatch threading, producer parity pins, argv byte-pins
- `keeper dispatch work::<todo-task> --dry-run` — reflects the resolved cell --plugin-dir, or the refusal/reject that a real run would hit

## Acceptance

- [ ] Manual dispatch of a plan task launches with the task's resolved worker-cell plugin, or exits non-zero with an actionable reason on any resolution reject; autopilot's sticky-failure behavior is byte-unchanged; both paths share one resolution seam
- [ ] Manual `work::` while the board is in worktree mode refuses loud with both recoveries named, `--force` deliberately overrides, and `close::`/resume/free-form paths are untouched
- [ ] Docs describe the shared resolution route and the refusal accurately, forward-facing

## Early proof point

Task that proves the approach: `fn-1126-launcher-worker-cell-resolver.1`. If the byte-identical extract proves impossible without reworking the pins: fall back to dispatch calling the pure compose + duplicated probes inline (no shared module) and record the divergence for a later consolidation pass.

## References

- Settled seam (design-reviewed): shared helper `src/worker-cell.ts` — NOT exec-backend (narrow import budget; transport already wired and byte-pinned), NOT the harness descriptor (dep-free per-harness island), NOT reconcile-core (I/O-free reducer import; the pure `workerCellPluginDir` compose stays there). Helper owns the decision; each caller owns its failure surface.
- Settled topology: this epic deliberately carries NO dep on fn-1123/fn-1125/fn-1127/fn-1130 despite sharing src/autopilot-worker.ts — it lands first, surgical, and fn-1123 carries the reverse edge; fn-1129's overlap (composition-map + dispatch verbs) is ordered transitively behind fn-1123.
- `fn-1129-autopilot-escalation-agent-dispatch` (overlap) — also edits docs/plugin-composition-map.md and cli/dispatch.ts; sequenced behind fn-1123 → behind this epic transitively.

## Docs gaps

- **docs/plugin-composition-map.md**: launch-channel table (~:60-77) — revise-not-append so both work-launch paths read as one shared resolveWorkerCell route; refresh drifted code anchors; add one line for the worktree-mode refusal
- **plugins/plan/template/skills/work.md.tmpl**: the "launcher resolves the cell" claim becomes true — verify accuracy post-change, edit only if the refusal changes when a work plugin loads
- **CONTEXT.md**: add the missing "Worker cell" glossary entry (term is used inside the Tier definition but never defined; this change makes it first-class)

## Best practices

- **Closed literal-union reasons + assertNever at both callers:** the compiler becomes the parity net — a new reject reason breaks compilation at any unmapped surface [TS discriminated-union practice]
- **Characterize before cutting:** golden-pin the producer's emitted DispatchFailed objects for a fixture matrix pre-refactor; assert outputs, never call sequences [Feathers characterization testing]
- **Try-the-real-op over exists-then-act:** the manifest probe before child launch is textbook TOCTOU; prefer handling ENOENT at use where feasible [CWE-367]
- **Split probe cost by caller cadence:** producer injects its per-cycle memoized shadow probe, CLI injects a fresh scan — never a readdir-per-launch in the hot loop [repo probe-cost invariant]
