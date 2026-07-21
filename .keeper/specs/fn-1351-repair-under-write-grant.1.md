## Description

**Size:** M
**Files:** src/daemon.ts, plugins/plan/template/skills/work.md.tmpl, plugins/plan/skills/work/SKILL.md, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json, plugins/prompt/test/oracle/fixtures/check-generated.json, test/daemon.test.ts

### Approach

The repair sweep's actuator changes from session dispatch to grant election: grouping by (canonical repo, fingerprint) exactly as today, it elects one affected blocked task's owner, publishes the single write grant leaf (writable root = the shared checkout, fencing token, expiry, the incident's fenced identities), and records the grant ref on the incident so the owner's claim envelope carries it. The work skill's SHARED_BASE_BROKEN branch forks on that ref: with a grant, spawn plan:repairer under it — reproduce at HEAD, land the gated fix or green no-op through keeper commit-work, then re-probe — and with no grant, park visibly as owned-elsewhere and stop; the daemon's objective baseline-green clear unblocks every parked owner, preserving today's fan-out unblock semantics, the bounded failing-tests digest, the dirty-checkout defer, and the page-once path on terminal failure. Grant release follows claim rules: voluntary on receipt, or by positive claimant-death evidence plus expiry — never silent reassignment while the holder may live.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/daemon.ts:2587 — runRepairEscalationSweep grouping, dirty-checkout defer, and terminal-grace classification being re-actuated
- src/daemon.ts:1682-1693 — the SHARED_BASE_BROKEN routing arm that defers to the repair sweep
- src/grant-leaf.ts — the leaf writer/reader this election publishes through
- plugins/plan/template/skills/work.md.tmpl — where the SHARED_BASE_BROKEN fork lands relative to the blocked phase
- plugins/plan/skills/repair/SKILL.md — the repro-at-HEAD, full-gate-verify, file-non-overlap contract the repairer agent enforces (ported in the agents epic)

**Optional** (reference as needed):
- src/daemon.ts:14011-14027 — legacy dispatchRepair + notifyHumanOfRepair, the page path that survives re-pointed

### Risks

- Election liveness: electing a dead or never-arriving owner strands the repair — the election must re-run on claimant-death evidence, and the attachment bound plus page-once still backstop it
- Two sweeps (legacy session-dispatch and grant election) must never both fire: this epic replaces the actuator wholesale, leaving no dispatch arm behind

### Test notes

In-process: one grant per (repo, fingerprint) under concurrent candidates; parked owners unblock on baseline-green; dead-holder re-election by positive evidence; page-once on terminal repair failure; no session dispatch from the sweep. Render + goldens re-captured.

## Acceptance

- [ ] The repair sweep issues at most one grant per (repo, fingerprint), never dispatches a session, and re-elects only on positive holder-death evidence
- [ ] A granted owner lands the trunk fix in-session through the repairer agent and the objective clear unblocks all parked owners
- [ ] Parked owners surface visibly and never write the trunk
- [ ] All suites green via named gates

## Done summary
Replaced the repair sweep's top-level session dispatch with a single write-grant election per (repo, fingerprint): elects one blocked owner, publishes a fenced grant leaf, and the work skill spawns plan:repairer in-session under that grant while ungranted owners park visibly; objective baseline-green clear unblocks and expires the grant for all parked owners.
## Evidence
