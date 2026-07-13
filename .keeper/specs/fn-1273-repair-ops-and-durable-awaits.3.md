## Description

**Size:** S
**Files:** cli/restart.ts, cli/keeper.ts, docs/problem-codes.md, test/restart-verb.test.ts

### Approach

A new `keeper daemon restart` CLI verb (lazy-imported router entry): compute the
gui/<uid>/arthack.keeperd domain live, `launchctl kickstart -k` it, then poll readiness —
socket answers AND boot-status shows caught-up — with per-probe timeouts, jittered
backoff, and N consecutive successes, bounded overall (non-zero exit on timeout).
Connection-refused during the window is transient (the new boot blocks on the old
daemon's flock until released). Surface a throttled respawn (crash-looping daemon pushed
out by launchd's throttle) distinctly from a slow boot — probe `launchctl print` state
and/or the restart-ledger crash-loop signal. Document in the verb's help that plist
changes need bootstrap/bootout, not kickstart. Never opens the DB, never adds an RPC.
Add the problem-codes daemon-restart family (kickstart-failed, health-timeout,
throttled-respawn).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- plist/arthack.keeperd.plist — the label + documented kickstart line
- cli/keeper.ts:568-600 — the lazy-import router map pattern
- cli/status.ts:1-101 — bounded subscribeReadiness connect pattern; src/server-worker.ts:2157 readBootStatus (generation/catching_up = the healthy gate)
- src/daemon.ts:2536-2633 — the restart-ledger crash-loop distress (throttled-respawn signal source)

### Risks

- Reporting healthy on a socket that answers pre-fatalExit — the caught-up boot-status gate, not mere connection, is the success criterion.

### Test notes

Pure tests over an injected prober/spawner seam (no real launchctl/daemon): success path
needs N consecutive healthy probes; refused-then-healthy passes; throttle signal maps to
its distinct exit; overall bound enforced.

## Acceptance

- [ ] `keeper daemon restart` exits zero only after the daemon answers healthy and caught up, within a bounded wait
- [ ] A throttled respawn surfaces as its own failure, distinct from a generic timeout, and kickstart-vs-bootstrap boundaries are documented
- [ ] The verb never touches the DB and adds no RPC; problem-codes gains the restart family

## Done summary
Added keeper daemon restart CLI verb: kickstarts the LaunchAgent via launchctl kickstart -k, then bounded-polls the socket for consecutive caught-up health probes with jittered backoff, distinguishing a launchd throttled respawn from a plain health timeout. Never opens the DB or adds an RPC. Documented the kickstart-failed/health-timeout/throttled-respawn problem-code family.
## Evidence
