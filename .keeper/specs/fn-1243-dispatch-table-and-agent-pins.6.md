## Description

**Size:** M
**Files:** plugins/prompt/test/, docs/install.md, docs/plugin-composition-map.md, docs/problem-codes.md

### Approach

Close the loop. Drift gate: a host-blind test (fixture matrix via the sandboxed config-dir pattern) asserting the partition invariant — every plain-render agent template has exactly one agent_pins entry and every entry has exactly one template (total, disjoint; the subagent_templates fan-out inventory excluded), and rendered frontmatter equals the pin (render into a temp dir, compare). Docs sweep, forward-facing prose only: docs/install.md's host-config walkthrough replaces the worker/escalation wiring step with the seeded dispatch: table, adds the agent_pins step, and folds in the two-file migration (leftover-key hint, re-render step); docs/plugin-composition-map.md's worker-vs-escalation resolver passage becomes the per-verb dispatch table and its agent-rendering description gains render-time pin injection; docs/problem-codes.md gains the dispatch-triple lint finding rows under the providers check section. No fn-ids or history narration in any doc — rationale lives in ADR 0040.

### Investigation targets

*Verify before relying — fn-1241's task 2 edits install.md's shadow-logging claims before this dispatches.*

**Required** (read before coding):
- docs/install.md:60-96 — the host-config walkthrough to rewrite (post-fn-1241 state)
- docs/plugin-composition-map.md:122-124 — the escalation-independence passage to replace
- docs/problem-codes.md:87-117 — the providers check findings table to extend
- plugins/prompt/test/parity.test.ts:85 — the sandboxed-config-dir fixture pattern the gate reuses
**Optional** (reference as needed):
- The landed task-3 lint refs (label names feed the problem-codes rows)

### Risks

- Doc drift against fn-1241's parallel install.md edits — write against its landed text.

### Test notes

The gate must fail on: an 11th template with no pin, a 12th pin with no template, a hand-edited rendered frontmatter diverging from its pin. It must pass on the committed example matrix + template set, host-blind.

## Acceptance

- [ ] The drift gate fails on a template/pin partition violation or a rendered-frontmatter mismatch and passes on the committed set, without reading the live ~/.config
- [ ] install.md walks an operator through the dispatch table and agent_pins setup including the migration from the retired keys
- [ ] plugin-composition-map.md and problem-codes.md describe the per-verb table, pin injection, and the new lint findings as current behavior

## Done summary
Added a host-blind drift-gate test asserting the template↔agent_pins partition (total, disjoint, frontmatter-equals-pin) and swept install.md/plugin-composition-map.md/problem-codes.md to describe the dispatch: table + agent_pins as current behavior, including the worker/escalation migration hint.
## Evidence
