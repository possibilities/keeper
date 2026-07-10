## Description

Finding F1 (Consider, Axis 1). Evidence path: at ac9f4876,
src/agent/main.ts:2719-2726 wires the pi branch as
ensurePiStateSharingFn(shouldPassthrough ? () => [] : deps.listProfilesFn, actionLog)
so the canonical pi AGENTS.md leaf materializes on passthrough
launches, fed an empty profile list. The codex sibling has a
main()-level passthrough test (test/agent-codex.test.ts:284,
"the canonical AGENTS.md leaf-guard fn runs on a passthrough launch",
asserting codexStateSharingCalls toHaveLength 1), but
test/agent-pi.test.ts has no equivalent — line 246 only unit-tests
the leaf function directly and the passthrough block (154-244) never
asserts the guard reaches passthrough through main().

Files:
- test/agent-pi.test.ts (add the assertion; mirror the codex passthrough test's harness shape)

## Acceptance

- [ ] A test drives a passthrough pi launch through main() and asserts ensurePiStateSharingFn is invoked exactly once
- [ ] The test asserts the fn is fed an empty profile list on passthrough (the () => [] arm), so a re-gate behind !shouldPassthrough fails it

## Done summary
Added a main()-level pi passthrough test in test/agent-pi.test.ts asserting ensurePiStateSharingFn runs exactly once, fed the empty-profile-list arm, mirroring codex's symmetric passthrough guard test.
## Evidence
