## Description

**Size:** M
**Files:** src/bus-worker.ts, scripts/repro-serve-wedge.ts, test/bus-worker.test.ts

### Approach

Remove every synchronous blocking call from the bus-worker serve event loop. The reproduced
wedge mechanism: `opRegister` runs `resolveHarnessIdentity`, which calls `ppidViaPs` — a
synchronous `Bun.spawnSync(["ps", ...])` per ancestry hop (up to 40) — on the serve thread,
during the boot reconnect stampede when every watcher's identity is cold. Sync spawn parks the
kqueue loop; JS-level socket events stop firing; kernel accepts pile up as unserviced fds.

Contract for the fix (resolved during planning):
- The ancestry walk goes fully async (array-form `Bun.spawn`, await exited, read stdout) —
  a per-pid memo alone is NOT the fix (every respawn is all-cold); memoize on top if cheap.
- Register ordering: the ack DEFERS until the walk resolves. Walk completions apply serially
  on the loop (JS single-thread makes completions serial; two in-flight walks for the same
  (pid,start_time) resolve as today's sequential re-registers — later completion takes over).
- A conn that closed while its walk was in flight drops the registration silently — no ack,
  no registry entry, no throw to the serve loop.
- Fail-open-to-floor preserved exactly: any spawn failure/parse miss terminates the walk
  gracefully and falls back to the client-provided floor identity.
- ANTI-SPOOF INVARIANT UNCHANGED: the walk roots at the server-resolved peerPid, never a
  client-claimed pid.

Method — red first: extend scripts/repro-serve-wedge.ts so its harness server gains the
production per-register work (configurable sync-spawn ancestry hops, per-accept getsockopt
FFI probe) plus a boot reconnect-stampede dimension (N clients connect+register near-simultaneously
at bind). Demonstrate the wedge RED against the pre-fix serve shape, land the fix, show GREEN.
If red cannot be reproduced synthetically, instrument the live daemon path with per-conn
accept/open/data/ack stderr breadcrumbs and diagnose against the production crash-loop (it IS
the repro). If, after the spawn is off-loop, a concrete Bun.listen-specific defect remains,
the node:net listener swap is the sanctioned fallback — and file a minimal upstream repro.

Update the harness usage-comment header to describe the new dimensions.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/bus-worker.ts:549-589 — resolveHarnessIdentity + ppidViaPs (the sync spawn, the anti-spoof doc)
- src/bus-worker.ts:812-876 — opRegister flow: identity resolution, takeover eviction, bus.db cache write, ack ordering
- src/bus-worker.ts:1187 — peerPidForFd per-accept FFI getsockopt (suspect #3; check buffer/return-code hygiene while there)
- scripts/repro-serve-wedge.ts — existing four load dimensions, probeRealRead/decide* faithful copies; the harness server is a bare Bun.listen with NO register work today
- test/bus-worker.test.ts — pure-seam tests with injected getPpid/isPidAlive; extend for the async walk

**Optional** (reference as needed):
- src/tmux-control-worker.ts:398, src/usage-scrape-runner.ts:381 — worker-side async Bun.spawn precedents
- src/daemon.ts:1811-1879 — probeSocketRead (the real-read probe the harness mirrors)

### Risks

- Async register introduces in-flight state on the serve loop; keep the completion handler
  total (no throw paths) and the registry mutation atomic per completion.
- The harness may not go red on Bun 1.3.14 (prior attempt failed without the register-work
  dimensions); the live-daemon breadcrumb fallback is in-scope, not a blocker.

### Test notes

Unit-test the async walk seam with an injected async getPpid (fast, no subprocess); the
stampede/wedge proof lives in the manual harness, never the fast tier. Live verification:
daemon uptime spans several former wedge cycles (>=10 min) with `keeper bus list` answering
throughout; watchdog fatalExit count in server.stderr stops growing.

## Acceptance

- [ ] The repro harness gains register-work, stampede, and per-accept-probe dimensions; it demonstrates the wedge against the pre-fix serve shape and passes green after the fix (or, if synthetic red proved impossible, live breadcrumb evidence pinpointing the mechanism is recorded)
- [ ] No synchronous subprocess call remains anywhere on the bus-worker serve path
- [ ] Register semantics hold: acks carry resolved identity, takeover eviction still fires, spawn failures fall back to floor identity, the ancestry walk roots at the server-resolved peer pid
- [ ] On the live host the daemon holds uptime across several former wedge cycles with `keeper bus list` answering continuously
- [ ] bun test green

## Done summary
Moved the bus-worker register ancestry walk (ppidViaPs/resolveHarnessIdentity) off the serve event loop to async Bun.spawn, so the boot reconnect stampede no longer parks the kqueue loop; opRegister defers its ack until the walk resolves and drops a conn that closed mid-walk, with fail-open-to-floor and the anti-spoof peer-pid root unchanged. The repro harness gains register-work/stampede/getsockopt dimensions plus an event-loop-lag detector — RED on the sync shape, GREEN with --async-register; bun test 5626 pass / 0 fail.
## Evidence
