## Description

**Size:** M
**Files:** test/integration.test.ts, test/plan-worker.test.ts, test/daemon.test.ts, scripts/soak-slow-tests.ts, package.json, README.md, CLAUDE.md

### Approach

With the in-process harness + watcher seam from `.2`, lighten the slow
tier so it is parallel-safe, then prove it with the soak harness.

1. **Convert the daemon-dependent integration tests** that only assert UDS
   query/RPC/fold (`integration.test.ts:475, 628, 804, 1012, 1104, 1207`)
   to `withInProcessDaemon`. KEEP ~4 true subprocess smoke tests for the
   real process boundary: `:288` (hook→event→fold→exit 0), `:1610`
   (restart-reconcile), `:1813` (SIGKILL exit-watcher), `:2015` (argv
   assertion).
2. **Convert the worker-spawn tests** in `plan-worker.test.ts`
   (`:2693/2760/2864/2948/3536`) and `daemon.test.ts` to the no-addon-dlopen
   path where possible; keep the single native-addon smoke
   (`plan-worker.test.ts:3489`) isolated. The pure `PlanScanner` layer is
   already parallel-safe.
3. **Recompose `package.json`** — flip `test:slow` to `--parallel` over the
   now-light tier (drop the fallback `&& plan-worker serial` split); keep
   the `test:soak` script.
4. **Rewrite `scripts/soak-slow-tests.ts`** — its header narrative and
   `TIER_PHASES` const bake in the now-stale "plan-worker STAYS SERIAL /
   Bun 1.3.14's fix doesn't cover the addon" fallback. Re-point at the
   lightened single-phase parallel tier.
5. **Soak ≥20x = 0 fails;** confirm umbrella green; fix README (~L510-528)
   + CLAUDE.md Test-isolation prose that implies the slow tier is serial.

### Investigation targets

**Required** (read before coding):
- test/helpers/in-process-daemon.ts — the `.2` harness to migrate onto
- test/integration.test.ts — convert :475/628/804/1012/1104/1207; keep :288/1610/1813/2015 as subprocess
- scripts/soak-slow-tests.ts — header + `TIER_PHASES` to rewrite (currently the stale fallback split)
- package.json:11-16 — `test:slow` / `test:soak` / the umbrella `test`

**Optional** (reference as needed):
- test/plan-worker.test.ts:2693/2760/2864/2948/3536 (Worker spawns), :3489 (addon smoke)
- README.md ~L510-528, CLAUDE.md Test isolation section

### Risks

- A converted test may still need the live `.planctl` watch (e.g.
  `integration.test.ts:1207` plan-worker fold) — use the `.2`
  manual-rescan/poll seam instead of the native subscribe.
- Contention wall-time spikes (fn-722.7: 10s→36s under box load) are
  environmental; the soak gates on pass/fail ONLY, never timing.

### Test notes

- Verification IS the soak: ≥20 consecutive parallel runs, 0 failures;
  paste the summary table as Evidence. Mirror the repo's "0 flakes over N
  consecutive runs" vocabulary (fn-722 / fn-683). Confirm `bun run test`
  umbrella green.

## Acceptance

- [ ] Slow-tier daemon-dependent tests run via the in-process harness; ~1-2 true subprocess smoke tests retained for the process boundary
- [ ] `package.json` `test:slow` runs `--parallel` over the lightened tier (no serial plan-worker split); `test:soak` retained
- [ ] `scripts/soak-slow-tests.ts` header + `TIER_PHASES` rewritten to the lightened parallel tier (no stale "plan-worker serial" narrative)
- [ ] A ≥20-iteration parallel soak completes with 0 failures (summary table in Evidence)
- [ ] `bun run test` umbrella green
- [ ] No README/CLAUDE.md prose left asserting the slow tier is inherently serial

## Done summary

## Evidence
