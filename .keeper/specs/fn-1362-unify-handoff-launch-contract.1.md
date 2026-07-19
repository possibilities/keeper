## Description

**Size:** M
**Files:** cli/handoff.ts, cli/descriptor.ts, src/rpc-handlers.ts, src/handoff-worker.ts, src/exec-backend.ts, test/handoff.test.ts, test/handoff-worker.test.ts, test/exec-backend.test.ts

### Approach

Treat capture and launch posture as independent request axes. Accept either one raw Launch triple through `--preset` or one complete `--model`/`--effort` pair on every Handoff, preserving the existing XOR, pair-completeness, and `parseTriple` validation at both trust boundaries. Carry a selected Launch triple through the shared launch seam so its harness reaches ordinary as well as captured handoffs; an explicit pair overrides model and effort on the `dispatch.handoff` harness, which remains Claude when unpinned. Capture alone continues to derive and carry an envelope path.

### Investigation targets

*Verify before relying — these file:line refs are planner-verified at authoring time, but the repo moves.*

**Required** (read before coding):
- `cli/handoff.ts:209` — client-side capture/selector normalization and request-frame composition.
- `src/rpc-handlers.ts:623` — daemon trust-boundary validation for Handoff fields.
- `src/handoff-worker.ts:296` — launch-spec construction and the capture-gated harness bug.
- `src/handoff-worker.ts:400` — existing row-over-config selector precedence and corrupt-row fallback.
- `src/exec-backend.ts:92` — shared `LaunchSpec` contract.
- `src/agent/launch-config.ts:153` — existing raw Launch triple to `--x-preset` transport pattern.

**Optional** (reference as needed):
- `src/daemon.ts:9421` — envelope-path derivation remains capture-only.
- `src/reducer.ts:7148` — existing independent Projection fields and historical defaults.
- `docs/adr/0033-launch-triples-over-named-preset-catalog.md` — Launch triple grammar and launchability.
- `docs/adr/0040-per-verb-dispatch-table-and-host-agent-pins.md` — `dispatch.handoff` fallback semantics.

### Risks

Ordinary Pi triples currently lose their harness after validation; relaxing only CLI/RPC gates would silently mislaunch them through Claude. Preserve safe fallback for malformed historical selector fields, and do not let explicit launch posture create an envelope or change the immutable Handoff slug lifecycle.

### Test notes

Exercise the complete selector matrix for both capture values at the CLI and RPC seams. Byte-pin the worker-to-launcher argv for ordinary Pi triples, captured triples, explicit pairs over configured harnesses, and absent selectors; retain pure injected-dependency tests with no daemon, subprocess, socket, or Tmux.

## Acceptance

- [ ] Both ordinary and captured Handoff requests accept no selector, one valid Launch triple, or one complete model/effort pair.
- [ ] Mixed Launch triple plus explicit fields, partial model/effort pairs, malformed triples, and malformed direct-RPC fields fail before an Event or launch is produced.
- [ ] An ordinary Pi Launch triple reaches the launcher as Pi with its model and effort intact; explicit pairs retain the resolved `dispatch.handoff` harness.
- [ ] Capture remains the sole cause of an envelope path, and historical absent or malformed selector fields continue to fold and dispatch safely.
- [ ] Focused Handoff and launch-backend tests pass.

## Done summary
Decoupled Handoff launch selection from capture: both ordinary and captured requests accept a raw Launch triple or a complete model/effort pair with identical XOR/pair-completeness validation at the CLI and RPC boundaries, an ordinary Pi triple's harness now survives launch, and capture remains the sole cause of an envelope path.
## Evidence
