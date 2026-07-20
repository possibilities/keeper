## Description

**Size:** M
**Files:** integrations/pi-codex-pool/src/auth.ts, integrations/pi-codex-pool/src/pool.ts, integrations/pi-codex-pool/src/index.ts, src/codex-pool-proof-window.ts, integrations/pi-codex-pool/test/provider-pool.test.ts, integrations/pi-codex-pool/test/seams.test.ts

### Approach

Two bounded production seams, both inert unless the codex-pool proof
window is armed and `KEEPER_JOB_ID` is set. The forced-refresh seam lives
in the companion's credential layer: on demand it bypasses the near-expiry
short-circuit and drives a real token rotation through the existing
single-flight coalescing, guaranteeing either an actual stored-credential
change (so the refresh-observation hook fires) or a loud typed
seam-inconclusive outcome — never a silent no-op. The fault-injection seam
wraps the pooled-stream delegate: it emits faults constrained to the
classifiable enum, both pre-output and mid-stream after substantive
output has been exposed (the delegate sits above transport, so a wrapper
can pass through genuine substantive events then yield a classified
error). Seam arming state extends the dep-free shared window leaf; seam
inputs are bounded single JSON records treated as attacker-influenced.
The companion import graph stays node:*-only throughout.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- integrations/pi-codex-pool/src/auth.ts:509 — the near-expiry short-circuit the seam must bypass; single-flight coalescing at :445-450
- integrations/pi-codex-pool/src/index.ts:408-427 — refresh observation fires only on an actual stored-credential change
- integrations/pi-codex-pool/src/pool.ts:12-22,85-124 — CodexDelegate injection point; classifyPoolFailure enum; retryable/substantive helpers
- src/codex-pool-proof-window.ts — the dep-free window leaf to extend with seam state
- docs/adr/0098-machine-runnable-codex-pool-proof.md — the seam contract this task implements

**Optional** (reference as needed):
- integrations/pi-codex-pool/test/provider-pool.test.ts:577-602,739-795 — the stub refresh/fault patterns the production seams generalize

### Risks

- A forced refresh returning an identical credential silently fails the independent-credentials clause — the seam must distinguish rotated / already-fresh / failed and report each distinctly
- Terminal fault classes (invalid_grant family) against a real account could require re-auth; the seam must never drive a terminal fault at a real credential store entry

### Test notes

Companion suites via `bun run test:pi-codex-pool`. New seam tests assert:
inertness when the window is unarmed or job-id absent; exactly one
refresh in flight per alias under concurrent forced refreshes; every
classifiable fault class emittable including mid-stream-after-substantive;
seam-inconclusive surfaces as its own typed outcome.

## Acceptance

- [ ] Both seams are no-ops outside an armed proof window and outside a keeper job context
- [ ] A forced refresh performs a real rotation observable by the refresh-observation hook, or reports a typed inconclusive outcome — never a silent no-op
- [ ] Concurrent forced refreshes on one alias provoke exactly one in-flight refresh, asserted by test
- [ ] The fault seam can emit every classifiable fault class, both pre-output and after substantive output has streamed
- [ ] Seam inputs are bounded single JSON records; out-of-enum fault requests are rejected loudly
- [ ] The companion test gate is green and the extension import graph reaches no bun builtin

## Done summary
Added forced-refresh and fault-injection proof seams to the pi-codex-pool companion, both gated on an armed proof window plus a keeper job id; forced refresh coalesces concurrent calls into one rotation with rotated/inconclusive/failed typed outcomes, the fault seam emits every classifiable fault class pre-output and mid-stream after substantive output, and companion tests plus the bun-free lint gate are green.
## Evidence
