## Description

**Size:** M
**Files:** src/agent/launch-handle.ts, src/agent/launch-config.ts, src/agent/main.ts, src/birth-record.ts, test/agent-launch.test.ts

### Approach

Empirical diagnosis first, in this order; the fix lands wherever the
evidence points (the Files list above names the suspect surfaces — the
actual fix may touch a subset). (1) Reproduce OUTSIDE the shim: run the
exact pi-native argv (the -na/--model/--thinking/--name form plus the
-e extension path) in a foreground shell with the PROVIDER_LEG_* env
tuple set FOR THAT INVOCATION ONLY — never export the tuple into the
session and NEVER run a valid tuple through `keeper agent run` (the
shim publishes a real birth record before its grant wait; a hand-repro
through it litters the board and shows a false 30s grant-timeout
signature instead of the real 2-4s death). Read pi's own stderr.
(2) Establish the pane-fate facts: whether a dead leg pane persists
(dispatched windows are remain-on-exit off and the execve into pi
removes the login-shell backstop), what pane_dead_status reports, and
whether the observed kills are child self-exits or parent-initiated
(ownership-cascade teardown) — signal-vs-code discipline, 134 vs 137,
error-vs-exit disjointness. (3) Bisect the axes between the known-good
unwrapped baseline and the wrapped launch: the -e extension load, the
--system-file contract (untested in both good smokes), the env tuple,
and the grant path. (4) Name the root cause with the captured evidence
and fix it at the authoritative seam — the pi-argv composer, the
launch-handle tuple stamping (the launcher start-time probe returning
null in the dispatched context is a named suspect), the shim gate, or
the cascade — never by loosening the wrapped-guard allowlist (it
validates a different layer). (5) Pin the failing component with an
in-process regression test (sandboxed, no real tmux/daemon/pi in the
correctness tier). Record the scoped repro transcript and the
component-level proof as Evidence; the FULL wrapped-path smoke is the
operator's post-deploy step, not this task's acceptance.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/agent/main.ts:3058-3138 — the shim gate: fail-closed parse → birth publish → 30s grant wait → process.execve into pi; the stage map the diagnosis walks
- src/agent/launch-handle.ts:277-329 — owner-tuple stamping; the start-time probe at :287-294 returns {ok:false} on null — a prime suspect in the dispatched context
- src/agent/launch-config.ts:333-356, :457-462 — nativePiArgs + piExtensionArgs (-e; existsSync guards absence, not a throwing extension)
- src/birth-record.ts:133-177 — PROVIDER_LEG_* constants + parseProviderLegLaunchCarrier (fail-closed)
- src/exec-backend.ts:426-434 — remain-on-exit off for dispatched windows; :614-621 pane_dead sweep; :733 classifyCloseKind second probe
- docs/adr/0071 — the ownership/cascade contract the fix must not violate
- plugins/plan/template/_partials/worker-implement-wrapped.md:24-46 — the manifest launch prose (keep in sync if flags change; touching partials leaves host manifests stale — the operator recompiles after landing)

**Optional** (reference as needed):
- src/autoclose-worker.ts:607-630 — the cascade teardown path (suspect #1's second face)
- src/agent/harness.ts:164-183 — the pi HarnessDescriptor flag facts (a pi-version flag-drift fix belongs here)

### Risks

- A hand-repro that touches the shim with a valid tuple mints board litter (a synthetic leg job) — the raw-argv path is the sanctioned repro; if the shim path MUST be exercised, coordinate with the operator first
- The death may only reproduce inside real dispatch (grant-path dependent) — the epic's early-proof fallback covers it; do not guess a fix without a reproduction
- Do not equate the fix with guard loosening or manifest prose edits — the guard validates the keeper-agent layer and prose cannot kill a boot

### Test notes

The regression pin tests the failing component in-process (e.g. the
tuple-stamping seam or argv composer with injected inputs), sandboxed
per the isolation rules. Evidence carries the repro transcript, the
pane-fate facts, and the before/after component behavior.

## Acceptance

- [ ] The root cause of the 2-4s wrapped-leg death is named, with captured reproduction evidence distinguishing child self-exit from parent-initiated kill
- [ ] The fix lands at the authoritative seam with an in-process regression test pinning the previously-failing component; the wrapped-guard allowlist is not loosened
- [ ] The pane-fate facts (dead-pane persistence, pane_dead_status behavior for the leg path) are recorded in Evidence for the forensics task to consume
- [ ] The full fast correctness gates stay green

## Done summary
Root cause: a born provider leg folded without a working lifecycle state, so the ownership cascade saw no live leg and tore it down 2-4s post-launch pre-transcript. Fix seeds a born leg as working in the reducer so teardown waits for a real stop; pinned with an in-process regression test.
## Evidence
