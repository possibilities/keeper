## Description

**Size:** S
**Files:** src/autopilot-worker.ts, test/autopilot-worker.test.ts, README.md

### Approach

Replace the hardcoded `WORKER_MODEL = "sonnet"` (:282) / `WORKER_EFFORT = "max"`
(:283) with a `worker` preset that COALESCES onto those same constants as the
fallback, so behavior is byte-identical when no registry/preset exists.

- Resolve the `worker` preset via the dep-free `src/agent/config.ts`
  `loadPresetRegistry` (the daemon process may call config.ts — it is db-free —
  but MUST NOT pull `src/db.ts`). Compute `model = preset?.model ?? "sonnet"`,
  `effort = preset?.effort ?? "max"`.
- Feed the resolved `{model, effort}` into BOTH `buildWorkerCommand` (:263-276,
  shell, pushes `--model`/`--effort` :271) AND `buildPlannedLaunchSpec`
  (:293-300, structured), so the drift-guard parity (:278-292) holds.
- **Fail-safe**: a missing or malformed registry must never throw into the
  dispatch path — catch `ConfigError`, log, fall back to the constants. The
  daemon cannot crash on a bad `presets.yaml`.
- Re-resolve per dispatch (cheap single-file parse) so a preset edit is picked
  up without a daemon bounce; no file-watch.
- **Determinism note for the worker**: presets change which model RUNS, never
  what gets folded; the resolved model/effort never enters `events` as a fold
  key. No RPC writes a preset. Re-fold stays byte-identical.
- **Docs**: update the README autopilot-launch prose to name the `worker`-preset
  resolution path instead of implying a hardcoded model.

### Investigation targets

**Required**:
- src/autopilot-worker.ts:263-300 — `WORKER_MODEL`/`WORKER_EFFORT`, `buildWorkerCommand`, `buildPlannedLaunchSpec`, and the :278-292 drift-guard comment.
- test/autopilot-worker.test.ts:67-68 (constant imports), :640, :2305-2316, :2681-2693 — the byte-pin argv strings.

### Risks

- Drift-guard parity: both builders MUST move to the resolved preset together or the parity test fails.
- Daemon resilience: a `ConfigError` from the registry must be swallowed-to-constants in the dispatch path, not propagated.

### Test notes

- No `worker` preset / no registry → byte-pins stay green (resolves to sonnet/max).
- A `worker` preset overriding model/effort → BOTH `buildWorkerCommand` and `buildPlannedLaunchSpec` reflect it identically.
- Malformed registry → falls back to constants, no throw.
- `bun run test:full` (daemon/worker path).

## Acceptance

- [ ] Autopilot resolves a `worker` preset that defaults to `sonnet`/`max`; existing byte-pin tests pass unchanged with no registry.
- [ ] Both worker-command builders read the same resolved values (drift-guard parity preserved).
- [ ] A missing/malformed registry falls back to constants without throwing into the dispatch path.
- [ ] README autopilot-launch prose names the `worker`-preset path.

## Done summary
Autopilot resolves a 'worker' preset for --model/--effort, coalescing per-field onto WORKER_MODEL/WORKER_EFFORT (sonnet/max) with a fail-safe swallow of ConfigError so a bad presets.yaml never crashes dispatch. Both worker-command builders read the same resolved values via the snapshot, preserving drift-guard parity.
## Evidence
