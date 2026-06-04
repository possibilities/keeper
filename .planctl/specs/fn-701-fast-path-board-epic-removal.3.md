## Description

**Size:** M
**Files:** src/daemon.ts, src/plan-worker.ts, src/git-worker.ts, test/

### Approach

Fix the `@parcel/watcher` concurrent-dlopen race that crash-loops the
daemon at boot (`napi_register_module_v1 not found`, observed on bun 1.3.14
-> residual Bun #15942 many-worker-spawn fragility; Bun v1.3.5 already
fixed the original main+worker double-load case). Pre-warm
`@parcel/watcher` once on the main thread before spawning the watcher
workers — this forces a serialized first dlopen (it does NOT share
`napi_env`; each worker still imports its own, but the addon is initialized
once already). If the repro survives pre-warm, additionally stagger the
spawn of the parcel-loading workers (plan, git, transcript, usage,
dead-letter, zellij) by a tick or spawn them sequentially during boot.

Keep the fail-closed `process.exit(1)` -> launchd restart for a GENUINE
permanent load failure (no in-process self-heal), but make it a LOUD boot
assertion: log the bun version and a clear "watcher addon failed to load
after pre-warm" before exiting, so a recurrence is diagnosable instead of a
silent crash-loop. Investigation MUST first confirm the repro on the
daemon's actual bun (1.3.14) and whether pre-warm alone eliminates it
(it may make staggering unnecessary).

### Investigation targets

**Required** (read before coding):
- src/plan-worker.ts:1990-2094 — @parcel/watcher import().then().catch() -> process.exit(1)
- src/git-worker.ts:2249-2303 — identical load idiom + .catch -> process.exit(1)
- src/daemon.ts:1907 (planWorker) / :2158 (gitWorker) and the full spawn block (~1426-2905) — spawn ordering; pre-warm goes before these
- The daemon LaunchAgent — confirm the bun binary + version the daemon actually runs (shell bun = 1.3.14)

**Optional:**
- src/transcript-worker.ts / usage-worker.ts / dead-letter-worker.ts / zellij-events-worker.ts — other `@parcel/watcher` importers (same race surface)

### Risks

- A shared pre-load helper must not violate the Worker contract — each worker still owns its own subscription; pre-warm is dlopen-only, not a shared watcher.
- If pre-warm alone fixes it, do NOT over-engineer staggering; measure first.
- The loud assertion must still escalate to `fatalExit` on a real permanent failure — do not downgrade a genuine missing-addon to a warning.

### Test notes

- A dlopen race is hard to regression-test directly; add a boot smoke test that spawns the worker set and asserts all watcher workers reach "subscribed" without exit, run repeatedly.
- At minimum, a unit test for the loud-assertion log line on a forced load failure.

## Acceptance

- [ ] `@parcel/watcher` is pre-warmed on main before the watcher workers spawn
- [ ] Worker spawns that load the addon are staggered/sequenced if pre-warm alone is insufficient (decision recorded from the repro check)
- [ ] A genuine load failure logs a loud boot assertion (bun version + context) before the existing `process.exit(1)` / launchd restart
- [ ] Repro confirmed (or shown fixed) on the daemon's actual bun version
- [ ] No in-process worker respawn introduced

## Done summary
Pre-warm @parcel/watcher on main (synchronous require) before the worker spawn block to fix the napi_register_module_v1 concurrent-dlopen crash-loop (residual Bun #15942); repro confirmed on bun 1.3.14, pre-warm alone closes it (no staggering). Loud boot assertion + fatalExit on a genuine load failure. README @parcel/watcher load-ordering note added.
## Evidence
