## Description

**Size:** M
**Files:** src/codex-pool-proof-window.ts, src/codex-pool-activation.ts, integrations/pi-codex-pool/src/index.ts, integrations/pi-codex-pool/src/proof.ts, integrations/pi-codex-pool/test/provider-pool.test.ts, integrations/pi-codex-pool/test/proof.test.ts, src/agent/main.ts

### Approach

Two moves, in order. FIRST, perform the proof-window leaf extraction on
your lane (this is pre-authorized supervisor direction, not a deviation
— an operator hotfix with identical content exists only as claim-wedged
uncommitted working-tree state and is NOT on main): create dep-free
`src/codex-pool-proof-window.ts` (imports NOTHING) holding, moved
verbatim from `src/codex-pool-activation.ts`:
CODEX_POOL_WORKFLOW_SCHEMA_VERSION, CODEX_POOL_PROOF_WINDOW_DURATION_MS,
CODEX_POOL_PROOF_WINDOW_ENV, the CodexPoolProofWindowState interface,
record, exactKeys, armCodexPoolProofWindow, codexPoolProofWindowActive.
`codex-pool-activation.ts` imports these from the leaf and re-exports
them unchanged (its own record/exactKeys local copies are deleted; all
other exports stay); the extension imports ONLY the leaf — its import
of `../../../src/codex-pool-activation.ts` must not survive, because
that module graph reaches FileLock and bun:ffi, which kills every Pi
extension load (this outage happened today).

SECOND, make the armed proof window able to produce its report: when
(and only when) the launch-scoped proof window is active, the companion
instruments the pooled routing/stream clauses and produces the
live-proof report through the landed collector exports
(collectLiveProof / scanProofArtifacts / writeLiveProofReport —
atomic, private, bounded, allowlisted). The trigger shape (a
registered companion command beside codex-pool-observe, or automatic
finalize at window close) must follow the API shape proof.ts's own
tests exercise — read them first; do not invent a second collection
scheme. Touch src/agent/main.ts only if the trigger genuinely needs a
launch-side surface; prefer companion-only. The fail-closed
capture/verdict/activate gates are untouchable: this task makes honest
evidence producible, never easier to fake.

### Investigation targets

*Verify before relying — these refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- src/codex-pool-activation.ts — the proof-window constants, state interface, record/exactKeys helpers, and the two window functions to move; note its FileLock import is exactly why the extension must never import this module
- integrations/pi-codex-pool/test/proof.test.ts — the intended collector API usage; your wiring must match it
- integrations/pi-codex-pool/src/proof.ts — collector/scanner/writer exports and their allowlisted schema
- integrations/pi-codex-pool/src/index.ts — proof-window gating (mode selection, window-active check) and the codex-pool-observe command registration pattern
- docs/install.md codex-pool section — the documented report path and capture chain your output must satisfy

**Optional** (reference as needed):
- src/codex-pool-activation.ts captureCodexPoolProof — what the capture verb validates on read
- test/codex-pool-activation.test.ts — gate regression tables that must stay green

### Risks

- The extension runtime has no bun builtins: any transitive import reaching bun:* kills every keeper pi launch at load. The bun-free acceptance test is load-bearing; the leaf extraction is its foundation.
- Collection must be inert outside an armed window — zero overhead, zero report writes, no behavior change for native/active modes.
- Report content is secret-sensitive: only the allowlisted schema, never raw provider errors, tokens, or identity material; scanning stays mandatory.
- If the operator hotfix lands on main mid-task, your fan-in may meet byte-identical content — a clean merge; do not treat it as a conflict signal.

### Test notes

Deterministic extension-seam tests with stubbed providers — no real
accounts, no live OAuth, no network. Named gates only.

## Acceptance

- [ ] A dep-free proof-window leaf module exists; the activation module re-exports its surface unchanged; the extension's keeper-src imports resolve to the leaf only.
- [ ] With an armed proof window, the companion produces a live-proof report at the documented path and permissions that the landed capture verb accepts end-to-end in a deterministic harness test (stubbed provider; no real accounts).
- [ ] Without an armed window (native and active modes), no report is produced, no collector code runs, and existing behavior is unchanged — proven by tests.
- [ ] A test walks the extension's transitive import graph and fails if it reaches any bun-only builtin.
- [ ] The capture, verdict, and activation gates' fail-closed semantics are unchanged and their existing regression tables stay green.
- [ ] The named focused gates and the typecheck are green.

## Done summary

## Evidence
