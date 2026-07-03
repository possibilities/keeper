## Description

**Size:** M
**Files:** src/bus-worker.ts, src/seed-sweep.ts, scripts/repro-serve-wedge.ts, test/bus-worker.test.ts

### Approach

Second pass — the first fix was necessary but insufficient, disproven live. What landed
(KEEP): the register ancestry walk runs off the serve loop (async ppidViaPs). What the
live daemon proved after that fix deployed to main: the bus serve path STILL goes mute
from bind on every boot (fresh incarnation on the fixed code: bus list "no response
within 5000ms" at ~80s uptime; watchdog fatalExits continue).

The missed site: `readOsStartTime` is a synchronous `Bun.spawnSync(["ps", ...])`
(src/seed-sweep.ts:101) and still executes ON the serve loop — `enrichPeerFromJobs`
calls `readStartTime(pid)` per jobs-row hit as its pid-reuse defense
(src/bus-worker.ts:497, wired at :848), so every register that reaches a row hit still
parks the kqueue loop exactly like the walk did. Secondary residents on the hot path to
audit: the per-accept `peerPidForFd` FFI getsockopt (src/bus-worker.ts:1212) and any
other synchronous subprocess/FFI reachable from accept/open/data handlers.

Contract: remove EVERY synchronous subprocess call from code reachable by the serve
loop's socket handlers — grep-provable (no Bun.spawnSync in any module path invoked from
the bus-worker serve handlers). The pid-reuse start_time validation MUST survive as a
defense (async probe or deferred validation), as must the anti-spoof rooting and the
fail-open-to-floor identity fallback. Extend scripts/repro-serve-wedge.ts with the
start-time-probe-per-row-hit dimension (the harness's register work must mirror the
REAL opRegister cost profile including enrichment), show it red against the current
code, green after. If the wedge STILL reproduces with zero sync subprocess work on the
loop, instrument per-conn accept/open/data/ack breadcrumbs and diagnose against the
production crash-loop before choosing the node:net fallback.

Note: the fix deploys to the live daemon only when an operator merges the epic lane to
main — live-host verification is the operator's post-deploy step, not this task's
acceptance. Acceptance here is code-level + harness-level.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/seed-sweep.ts:101-130 — readOsStartTime spawnSync (the missed sync spawn)
- src/bus-worker.ts:470-500 — enrichPeerFromJobs + the start_time pid-reuse defense at :497
- src/bus-worker.ts:820-880 — the current (post-first-fix) opRegister async flow, where :848 wires readStartTime
- src/bus-worker.ts:1200-1220 — peerPidForFd FFI per-accept
- scripts/repro-serve-wedge.ts — the register-work dimensions added by the first pass; extend with the row-hit start-time probe

**Optional** (reference as needed):
- test/bus-worker.test.ts — injected getPpid/readStartTime seams from the first pass

### Risks

- The start_time probe is a pid-reuse SECURITY defense — moving it async must not create
  a window where a recycled pid binds a stale identity un-validated.
- If the true trigger is Bun-internal (re-arm loss under stampede), no amount of
  off-loop work fixes it — the breadcrumb instrumentation branch is in-scope.

### Test notes

Unit-test the async enrichment seam with injected readStartTime; harness proves the
wedge mechanism red-to-green; fast tier stays subprocess-free.

## Acceptance

- [ ] No synchronous subprocess call is reachable from the bus-worker serve handlers (register/subscribe/publish/list/accept), grep-provable across their whole import path
- [ ] The pid-reuse start_time defense, anti-spoof rooting, and fail-open floor identity all survive with tests
- [ ] The repro harness gains the row-hit start-time-probe dimension, goes red against pre-fix code and green after
- [ ] bun test green

## Done summary

## Evidence
