## Description

**Size:** M
**Files:** scripts/git-worker-cpu-soak.ts (new)

### Approach

Build a fresh diagnostic harness (a `#!/usr/bin/env bun` `.ts` script,
NOT a reuse of `scripts/soak-slow-tests.ts` — that is a test-rerun flake
harness, not a DB-write driver). The harness: (1) drives a sustained
multi-agent write storm against the LIVE daemon at a configurable rate ×
root count (faithful path: emit through the real hook NDJSON feed so the
hook→ingester→data_version chain is exercised, since that is the exact
bug path); (2) samples CPU over the window — the daemon PID AND aggregated
`git` child-process CPU (spawned git is charged to git PIDs, so a daemon-
only sample under-reports); (3) measures observation latency for a genuine
foreign change in a subscribed root (to baseline the drop-recovery cost).
Model CLI flag parsing on `scripts/bench-latency.ts` (`parseArgs` from
`node:util`, `--duration`/`--json`/`--quiet`), and the pure-aggregator +
padded-table summary on `scripts/backstop-stats.ts`. Then ANALYZE FSEvents
coverage: enumerate whether any `git status`-affecting mutation to an
already-subscribed root produces NO FSEvents on either the worktree or the
git-common-dir sub — prove the worktree + git-dir subs are exhaustive for
`git status` state (working tree + HEAD + index), or surface the residual
class.

### Investigation targets

**Required** (read before coding):
- src/git-worker.ts:2784-2804 — the poll loop + fan-out (the measured cost)
- src/git-worker.ts:2478-2548 — `subscribeRoot` worktree + git-dir FSEvents subs (the coverage claim to prove)
- src/git-worker.ts:2810-2839 — heartbeat backstop (the retained net)
- scripts/bench-latency.ts — passive live-daemon measurement; CLI parsing + pure-summary separation to model
- scripts/soak-slow-tests.ts — reusable Bun.spawn phase-runner + pure-aggregator + padded-table skeleton ONLY (not a write driver)

**Optional** (reference as needed):
- scripts/backstop-stats.ts — pure aggregator core + padded summary table renderer
- test/helpers/sandbox-env.ts — `sandboxEnv(...)` if the harness spawns a sandboxed daemon rather than the live one

### Risks

- @parcel/watcher has known macOS instability under exactly the high-churn
  load being driven — if FSEvents itself flakes at soak rates, the coverage
  proof must record that (it is the trigger for the .3 heartbeat-staleness
  fallback).
- Faithfulness vs speed: synthesizing `events` rows directly is faster but
  skips the hook→ingester path where the bug lives — prefer the faithful
  hook-feed driver.

### Test notes

Harness is a diagnostic script, not a unit test; its output (before-CPU
baseline + FSEvents coverage verdict) is the evidence gate for .2. Pin the
measured numbers into the .1 done-summary.

## Acceptance

- [ ] `scripts/git-worker-cpu-soak.ts` drives a multi-agent write storm against the live daemon and samples daemon PID + aggregated git-child CPU over the window.
- [ ] Measured evidence shows the data_version snapshot fan-out is the dominant CPU cost (before-CPU baseline captured under the storm, correlated with the fan-out rate).
- [ ] FSEvents coverage is proven: any `git status`-affecting change class for an already-subscribed root that is invisible to BOTH the worktree and git-common-dir subs is enumerated, or shown empty. The verdict is recorded as the go/no-go for the drop in .2.
- [ ] Foreign-change observation latency under the storm is measured (baseline for the drop-recovery tradeoff).

## Done summary
Built scripts/git-worker-cpu-soak.ts — the fn-748 evidence gate. (1) Faithful hook-feed write storm against the live daemon (PID-attributed git-child descendant tree, 30ms churn poll for short-lived git-status spawns the 1s ps misses). Measured: daemon CPU 6.6-24.5% baseline → 80-101% peak under 9-14 roots at 5/root/s (~30-70 foreign writes/s) — reproduces the 144% fan-out class; the data_version poll/fan-out scheduling machinery is the dominant cost even when fn-716 throttles raw git count to ~0. (2) FSEvents coverage VERDICT: FSEVENTS-EXHAUSTIVE — all six git-status axes (working-tree untracked/modified/deleted via the worktree sub; index/.git/index, HEAD-commit/refs/heads, HEAD-switch/.git/HEAD via the git-common-dir sub) land under a watched non-ignored path. No FSEvents-invisible-but-data_version-visible class — GO for the .2 drop. (3) Foreign-change latency: 135-301ms fast-path (SessionStart probe); worst case under FSEvents-only is the 60s heartbeat. Commit 5aae081.
## Evidence
