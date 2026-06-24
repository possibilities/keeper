## Description

Pin two untested modal-host invariants in test/agent-modal-host.test.ts
using the existing in-process harness (emitData → onData, recording stdout
array, modalHosted/buildOverlay seams).

F3 (kept, evidence: runModalHost try/catch around buildOverlay in
src/agent/modal-host.ts → overlay=null fallback): pass a buildOverlay that
rejects, then assert the hotkey still no-ops/fires onHotkey and the child
still exits cleanly — the stated non-fatal-build-failure resilience claim.

F4 (merged into F3, evidence: onData suppression branch
src/agent/modal-host.ts:202-206, `if (overlay?.isOpen) return`): stub a
buildOverlay returning isOpen:true, emit child data via h.pty.emitData, and
assert h.stdout stays empty — the complement of the existing "child output
streams verbatim to parent stdout" test (line 345). Both findings share the
same file and the same untested-invariant root cause and land as one
test-coverage commit.

Files run on the serial test:opentui chain and stay in the fast-tier ignore
list per the OpenTUI native-loader convention.

## Acceptance

- [ ] Test: rejecting buildOverlay falls back to overlay=null, hotkey safe, child exits cleanly.
- [ ] Test: data emitted while overlay.isOpen is dropped (stdout empty); streaming resumes after close.
- [ ] No production code change; existing assertions unweakened.

## Done summary
Added two in-process tests in test/agent-modal-host.test.ts pinning the modal-host resilience invariants: a rejecting buildOverlay falls back to overlay=null (hotkey stub fires, child exits cleanly) and child output is dropped while overlay.isOpen then resumes when closed. Test-only, no production change.
## Evidence
