## Overview

The shared-instruction leaf guard makes pi's canonical AGENTS.md leaf
materialize on passthrough launches too (main() feeds
ensurePiStateSharingFn an empty profile list under shouldPassthrough).
The symmetric codex path has a main()-level passthrough test; pi has
only a direct leaf-function unit test, so a re-gate behind
!shouldPassthrough would regress silently. This closes that one
test-coverage asymmetry — behavior is correct, only its regression
guard is missing.

## Acceptance

- [ ] A main()-level test asserts ensurePiStateSharingFn runs on a passthrough pi launch and is fed an empty profile list
- [ ] The new test fails if the pi wiring is re-gated behind !shouldPassthrough

## Audit decisions

| Source | Action | Task | Rationale |
|--------|--------|------|-----------|
| F1 | kept | .1 | pi passthrough state-sharing wiring (main.ts:2725-2726) is untested at the main() level while codex's symmetric path is (agent-codex.test.ts:284); the !shouldPassthrough re-gating regression is demonstrably natural. |

## Out of scope

- Any change to the pi/codex passthrough behavior itself (it is correct as shipped)
- Broadening coverage of the leaf-guard table beyond the pi passthrough gap
