## Description

**Size:** M
**Files:** src/daemon.ts, src/autoclose-worker.ts, src/dispatch-command.ts, cli/dispatch.ts, src/exec-backend.ts, src/reconcile-core.ts, test/daemon.test.ts, test/exec-backend.test.ts

### Approach

Remove the out-of-band actuators wholesale: the shared escalation session launcher, both resolver dispatchers and their inline brief builders, the resolver-dispatch and merge-escalation sweeps for both verbs, the legacy unblock dispatch arm and the repair session dispatcher, the global escalation cap with its occupancy and per-checkout probes, and the autoclose escalation bucket. The page-once notify sweeps survive, re-pointed at incident state. The dispatch verb surface shrinks: escalation verbs leave the manual dispatch positional grammar, the launch-config floors, and the dispatch table; the retry wire keeps work, close, and approve. The empty role-marker env carrier leaves the launch argv builder. Legacy drain is passive: rows with stamped latch markers and any still-live legacy session finish through the exit watcher and jobs projection exactly as today — nothing force-kills, nothing re-pages. Two landed surfaces simplify the removal: the generic terminal pane teardown already owns escalation-verb panes (prune the four escalation verbs from its verb set as they stop minting, and retire the now-redundant autoclose escalation bucket in the same stroke), and the recover pass's resolver-liveness race guard goes vacuous once resolve sessions stop minting — remove the dead predicate rather than leaving it.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:4401, :14310, :13432, :3710, :3813 — the launcher, both resolver dispatchers, both inline brief builders
- src/daemon.ts:2894 and :4176-4248 — the cap, occupancy, and per-checkout probes
- src/autoclose-worker.ts:383-402 — the escalation bucket
- src/dispatch-command.ts:58-85 — retry wire verbs and the escalation-verb taxonomy
- cli/dispatch.ts and src/dispatch-launch-config.ts — positional grammar, cwd resolution arms, and floors for the retiring verbs
- src/exec-backend.ts:1411 — the role-marker carrier

**Optional** (reference as needed):
- src/daemon.ts:12890-12893 — readLiveEscalationJobs and remaining verdict pollers to excise

### Risks

- The notify sweeps must keep firing for both legacy-stamped rows and incident rows during drain — deleting a selector the notify path shares with a dispatch path would silence page-once
- Removal order matters for tests: sweeps reference deps that reference the launcher; excise leaf-first so each intermediate state compiles and its suite passes

### Test notes

Update the daemon suites to assert absence: no dispatch arm reachable for any escalation verb, notify sweeps still page from incident state, retry wire rejects retired verbs, launch argv carries no role marker. Named gates.

## Acceptance

- [ ] No escalation session can be dispatched by daemon sweep or manual verb, and the launch surface carries no role marker
- [ ] Page-once keeps firing for undrained legacy rows and for incident rows throughout
- [ ] The retry wire accepts only work, close, and approve
- [ ] All updated suites green via named gates

## Done summary
Retired out-of-band escalation actuators (launcher, resolver dispatchers+sweeps, legacy unblock arm, repair dispatcher, global escalation cap, autoclose bucket); dispatch verb surface shrunk to work/close/approve. Operator-adopted from wedged leg dae10f2a.
## Evidence
