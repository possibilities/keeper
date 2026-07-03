## Description

**Size:** M
**Files:** src/agent/harness.ts (new), src/agent/config.ts, src/agent/dispatch.ts, src/agent/launch-config.ts, src/agent/args.ts, src/agent/passthrough.ts, src/agent/run-capture.ts, src/agent/transcript-watch.ts, src/agent/main.ts, src/pair/panel.ts, test/agent-harness.test.ts (new)

### Approach

Introduce one per-harness descriptor registry (a dep-free module) as the single
source of per-harness behavior: binary resolution, native launch-arg builder,
second-axis kind (effort | thinking | none), no-approval/trust posture, resume
argv shape, transcript discovery + stop-parse hooks, passthrough/arg tables, and
capability flags (at minimum: capturable, mints_own_session_id, hook_mechanism).
Derive the existing parallel unions (PresetHarness, AgentKind, AgentCli, and the
run-capture agent set) from the registry so a harness name exists in exactly one
place, and fold the inline `if (agent === ...)` branches into descriptor lookups.
Behavior for claude/codex/pi must remain byte-identical — the byte-pin suite is
the contract. Panel eligibility becomes capability-derived: replace the
claude|codex name literal with a "descriptor is capturable" check, which lifts
pi's panel bar by design (human directive: capability gates, never policy).
An unknown harness tag degrades inert / fails loud at config load exactly as
unknown preset harnesses do today.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/config.ts:213 — PresetHarness union; :307/:320 validation sets; :385-398 second-axis cross-validation; :508/:554 panel-launchable gates (the literals to replace)
- src/agent/launch-config.ts:27-33 — AgentCli/AGENT_CLIS; :191-287 native-args dispatch and the three native*Args builders
- src/agent/main.ts:1539 — binary ternary; :291 resolveCodexBin (the resolver pattern descriptors absorb)
- src/agent/args.ts:174-221 — per-harness continue/resume/fork/headless predicates
- src/agent/passthrough.ts — three per-harness command/option tables
- src/agent/transcript-watch.ts:213-329 — per-harness transcript discovery + stop parsers
- src/agent/run-capture.ts:122 — AGENT_KINDS near-copy
- test/agent-byte-pin.test.ts — the argv byte-pins that must stay green unmodified

**Optional** (reference as needed):
- src/agent/dispatch.ts:16 — AgentKind union + USAGE text
- src/pair/panel.ts — panel member validation call sites

### Risks

- Refactor churn across ~10 files; any byte-pin drift is a behavior change, not a test to update
- Panel-gate lift changes panel.yaml validation errors — pi members must become valid without loosening unknown-name failures

### Test notes

All existing agent-* suites stay green; only panel-gate cases change expectation
(pi member valid). Add registry unit tests: every descriptor field defined for
all harnesses; unknown harness fails loud at load.

## Acceptance

- [ ] One descriptor registry is the single source of per-harness launch/capture/resume behavior; the parallel harness unions are derived from it, not hand-maintained
- [ ] Launch argv for claude, codex, and pi is byte-identical to before (byte-pin suite green and unmodified)
- [ ] A pi preset is accepted as a panel member and panel legs launch it; panel eligibility reads a descriptor capability, not a harness-name list
- [ ] An unknown harness name in presets or panel config fails loud at load

## Done summary

## Evidence
