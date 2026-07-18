## Description

**Size:** M
**Files:** src/integrity-probe.ts, src/daemon.ts, src/maintenance-worker.ts, test/daemon.test.ts, docs/problem-codes.md

### Approach

One shared agentbot spawn helper becomes the sole page transport: configured
absolute binary path (config-resolved, defaulting to the installed absolute
location; never bare PATH resolution — the LaunchAgent PATH excludes it),
pre-spawn existence/executability probe, array-form argv, and the existing
outcome classifier (spawn-throw/absence = permanent, non-zero = transient). All
raw daemon.ts page spawns and the maintenance-worker sink adopt it so the two
silently-diverging transports collapse into one. A permanently absent binary
degrades with a log-once latch (mirror the paged-once discipline) and the
existing paging-channel distress row — never a per-sweep spam line, never a
crash. Verify the degrade under a stripped launchd-shaped environment. Update the
problem-codes Operator paging section for transport-name consistency.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/integrity-probe.ts:203-256 — sendAgentbotPage, AgentbotPageOutcome, classifyAgentbotPageOutcome (the helper to generalize)
- src/daemon.ts:1556,1582,1608,2917,3115,12796 — the raw page spawn sites to migrate; :698-711 decidePagingChannelDistress
- src/maintenance-worker.ts — its notifier sink

**Optional** (reference as needed):
- test/daemon.test.ts:272+ — the page-helper truth table to extend; test/reducer-projections.test.ts:2117 — non-terminal agentbot-failure marker

### Risks

- A config key nobody sets plus a wrong default silently kills ALL paging — the existence probe plus distress row must make absence loud
- Worker-thread sites must keep imports within their allowed dependency set

### Test notes

Extend the existing truth table: absolute-path resolution order (config over
default), absence yields permanent_failure + one latched log line across repeated
sweeps, transient non-zero unchanged, delivery unchanged. A stripped-env
(launchd-shaped PATH) case proves bare-name resolution is gone.

## Acceptance

- [ ] Every agentbot page site routes through the shared helper with a configured absolute path and existence probe; no bare-name PATH spawn remains
- [ ] A permanently absent binary logs once, mints the existing paging-channel distress, and never crashes or spams
- [ ] The truth-table test covers config-over-default resolution, latched absence, transient, and delivery
- [ ] docs/problem-codes.md paging section names the transport consistently
- [ ] Named test gates for the touched suites pass

## Done summary
Consolidated agentbot paging onto one shared helper: configured absolute binary path (config-over-default), pre-spawn executable probe, array-form argv, and a log-once absence latch feeding the existing paging-channel distress row. All daemon.ts page callers already routed through the single notifyHuman/sendAgentbotPage call site, so migrating it covered every page trigger including the maintenance-worker relay sink. Extended the truth-table test and updated problem-codes.md for transport-name consistency.
## Evidence
