## Description

**Size:** M
**Files:** src/codex-account-observation-refresh.ts, src/codex-account-observer-worker.ts, src/agent/main.ts, test/codex-account-observation-refresh.test.ts, test/codex-account-observer-worker.test.ts

### Approach

Today a refresh cycle whose observer run yields no observation returns the
stale sidecar silently — no log, no counter, nothing an operator can read;
the production consequence was an invisible pool collapse. The contract
after this task: (1) each failed refresh attempt logs ONE bounded line
(reason-classed: spawn/timeout/unavailable-envelope/parse) from the
observer worker cycle; (2) consecutive-failure state is durably readable —
a small sidecar (e.g. next to the observation sidecar, worker-owned,
producer-side, never a fold input) recording consecutive failure count and
last failure class/time; (3) `keeper agent accounts check` surfaces that
state in the codex capacity block so a stale observation is diagnosable
from the operator's standing health read. Do not mint daemon distress rows
or touch reducer/daemon surfaces — that integration is an explicit
follow-up; this task keeps to the refresh/worker/CLI-inspection files.
Respect the existing worker log discipline (one bounded console.error per
event, no payload echo).

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/codex-account-observation-refresh.ts:71-120 — refreshCodexObservationIfStale silent null-return path
- src/codex-account-observer-worker.ts:55-90 — the 30s cycle + its catch
- src/agent/main.ts:620-660 — codex session-routing inspection assembled for accounts check

**Optional** (reference as needed):
- src/codex-account-router.ts:480-560 — how health/fresh/verdict are derived for the capacity block
- test/codex-observer-envelope-landing.test.ts — end-to-end envelope landing seam

### Risks

The refresh function is shared by the CLI pre-refresh path (activate/verify)
and the daemon worker; failure-state writes must be safe under both callers
and under the existing refresh flock.

### Test notes

Drive the refresh seam with an injected always-failing runner and assert
the failure sidecar increments, the log line is bounded and single, and a
subsequent success resets the counter; assert the accounts-check
inspection includes the failure state via its unit seam.

## Acceptance

- [ ] A failed refresh cycle produces exactly one bounded reason-classed log line and increments a durable consecutive-failure record
- [ ] A successful refresh resets that record
- [ ] `keeper agent accounts check --json` exposes the consecutive-failure state in the codex capacity block
- [ ] No daemon, reducer, or dead-letter surface is touched; focused tests for the refresh and worker files pass

## Done summary
Failed codex observation refresh cycles now log one bounded reason-classed line and persist a durable consecutive-failure sidecar (reset on success); keeper agent accounts check surfaces that state in the codex capacity block.
## Evidence
