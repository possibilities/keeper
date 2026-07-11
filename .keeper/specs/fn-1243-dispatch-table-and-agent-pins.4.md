## Description

**Size:** S
**Files:** src/agent/matrix.ts, plugins/plan/src/host_matrix.ts, docs/examples/matrix.example.yaml, test/agent-matrix.test.ts

### Approach

The host matrix v2 gains an optional top-level `agent_pins:` mapping — agent name → `{model, effort}` pair — carried by BOTH island parsers in lockstep under the existing cross-island parity test. Parse validation: pin effort must be a member of the matrix's top-level efforts axis (loud schema-invalid failure naming the pin); model is a non-empty strict-charset token (opaque otherwise); an absent map parses as empty (render-time strictness is task 5's job, so a pins-less v2 file stays valid for launch/dispatch surfaces). The pair shape is deliberate — pins are not triples (frontmatter has no harness axis). `docs/examples/matrix.example.yaml` gains the full 11-agent block with today's values verbatim (close-planner opus/high, docs-gap-scout opus/medium, epic-scout opus/medium, gap-analyst opus/xhigh, model-selector opus/high, panel-judge opus/xhigh, panel-runner opus/xhigh, practice-scout opus/medium, quality-auditor opus/high, repo-scout opus/high, selection-auditor opus/high) under the example's anti-rot test.

### Investigation targets

*Verify before relying — fn-1241 touches src/agent/matrix.ts before this dispatches.*

**Required** (read before coding):
- plugins/plan/src/host_matrix.ts — the plan-island v2 parser (loadHostMatrixV2, HostMatrixV2) this extends
- src/agent/matrix.ts — the launcher-island v2 parser twin; find the v2 allowed-keys set post-fn-1241
- test/agent-matrix.test.ts:850-859 — the matrix.example.yaml anti-rot test gating the example edit
**Optional** (reference as needed):
- The cross-island parity test asserting both parsers agree (locate via the existing matrix suites)

### Risks

- Two parsers must move in lockstep — a field landed in one island only is exactly what the parity test exists to catch; run it locally before finishing.

### Test notes

Parse cases in both islands: valid pins, effort outside the axis (loud, names the pin), malformed pair shape, absent map = empty. Example file loads clean through both parsers.

## Acceptance

- [ ] Both matrix parsers accept and expose the same agent_pins map for the same file; the parity test covers the new field
- [ ] A pin with an effort outside the matrix axis fails matrix load loud, naming the offending pin
- [ ] The committed example matrix carries the 11 seeded pins and passes its anti-rot test

## Done summary
Added agent_pins map to both v2 host matrix parsers (launcher + plan islands), validated pin effort against the matrix's efforts axis, and seeded the 11 static-agent pins into the committed example matrix.
## Evidence
