## Description

**Size:** M
**Files:** integrations/pi-codex-pool/src/index.ts, integrations/pi-codex-pool/src/proof.ts, integrations/pi-codex-pool/test/provider-pool.test.ts, integrations/pi-codex-pool/test/proof.test.ts, src/agent/main.ts

### Approach

Make the armed proof window able to produce its report: when (and only
when) the launch-scoped proof window is active, the companion
instruments the pooled routing/stream clauses and produces the
live-proof report through the landed collector exports
(collectLiveProof / scanProofArtifacts / writeLiveProofReport —
atomic, private, bounded, allowlisted). The exact trigger shape
(a registered companion command beside codex-pool-observe, or
automatic finalize at window close) must follow the API shape
proof.ts's own tests exercise — read them first; do not invent a
second collection scheme. Touch src/agent/main.ts only if the trigger
genuinely needs a launch-side surface; prefer companion-only. The
fail-closed capture/verdict/activate gates are untouchable: this task
makes honest evidence producible, never easier to fake.

### Investigation targets

*Verify before relying — these refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- integrations/pi-codex-pool/test/proof.test.ts — the intended collector API usage; your wiring must match it
- integrations/pi-codex-pool/src/proof.ts — collector/scanner/writer exports and their allowlisted schema
- integrations/pi-codex-pool/src/index.ts — proof-window gating (the mode selection and window-active check) and the codex-pool-observe command registration pattern
- src/codex-pool-proof-window.ts — the dep-free leaf the extension imports; the extension must keep importing ONLY this leaf from keeper src
- docs/install.md codex-pool section — the documented report path and capture chain your output must satisfy

**Optional** (reference as needed):
- src/codex-pool-activation.ts captureCodexPoolProof — what the capture verb validates on read
- test/codex-pool-activation.test.ts — gate regression tables that must stay green

### Risks

- LANE PRECONDITION: verify on your lane that src/codex-pool-proof-window.ts exists and index.ts imports the leaf, not src/codex-pool-activation.ts. If it does not, your lane pre-dates an operator hotfix — STOP and message keeper-phase12-supervisor over the bus; do not reconstruct the import.
- The extension runtime has no bun builtins: any import reaching bun:* kills every keeper pi launch at load (this outage already happened once today). The bun-free acceptance test is load-bearing.
- Collection must be inert outside an armed window — zero overhead, zero report writes, no behavior change for native/active modes.
- Report content is secret-sensitive: only the allowlisted schema, never raw provider errors, tokens, or identity material; scanning stays mandatory.

### Test notes

Deterministic extension-seam tests with stubbed providers — no real
accounts, no live OAuth, no network. Named gates only.

## Acceptance

- [ ] With an armed proof window, the companion produces a live-proof report at the documented path and permissions that the landed capture verb accepts end-to-end in a deterministic harness test (stubbed provider; no real accounts).
- [ ] Without an armed window (native and active modes), no report is produced, no collector code runs, and existing behavior is unchanged — proven by tests.
- [ ] A test walks the extension's transitive import graph and fails if it reaches any bun-only builtin.
- [ ] The capture, verdict, and activation gates' fail-closed semantics are unchanged and their existing regression tables stay green.
- [ ] The named focused gates and the typecheck are green.

## Done summary

## Evidence
