## Description

**Size:** M
**Files:** plugins/plan/agents/, plugins/plan/template/agents/, plugins/prompt/src/render_plugin_templates.ts, plugins/prompt/test/parity.test.ts, plugins/prompt/test/oracle/, .gitignore

### Approach

Convert the 10 hand-authored `plugins/plan/agents/*.md` to `template/agents/<name>.md.tmpl` — bodies byte-verbatim (verified free of template metacharacters), frontmatter `model:`/`effort:` become injected variables (`agent_model`/`agent_effort`) — and fix `practice-scout.md.tmpl`'s literal opus/"medium" to the same variables. In renderAgents' plain-render branch (templates NOT in the matrix's subagent_templates inventory), look up the pin by template stem in the matrix's agent_pins and bind the two variables; strictVariables already makes a pin-less template with pin variables a loud render failure, and a stem with no pin entry must name the missing agent. The worker fan-out branch is untouched — the 10 templates must never appear in subagent_templates. Rendered agents become host-derived gitignored output with sidecars (exactly the practice-scout + workers/ pattern): remove the 10 tracked .md files from git, add the ignore rule. Re-capture the parity-suite oracle goldens — every rendered agent's provenance/sidecar changes. Body byte-stability matters downstream: the unlanded ADR 0039 Pi renderer reads these rendered files as its source, so render stays upstream of any pi-agent install and bodies stay byte-identical to the sources being converted.

### Investigation targets

*Verify before relying.*

**Required** (read before coding):
- plugins/prompt/src/render_plugin_templates.ts:619-628 — the plain-render else branch (renderOne(tmpl, null)) where pin variables bind; the matrix is already in scope (loadHostMatrixV2 before any render)
- plugins/plan/template/agents/practice-scout.md.tmpl:4-6 — the literal frontmatter to convert
- plugins/prompt/test/parity.test.ts:351-397 + :85 — the rendered-tree golden assertion and SANDBOX_CONFIG_DIR pattern to re-capture under
**Optional** (reference as needed):
- plugins/plan/agents/*.md — the 10 source bodies to carry verbatim
- plugins/prompt/test/oracle/capture.ts — the golden re-capture entry point

### Risks

- The parity goldens assert the ENTIRE rendered agents tree byte-identical — re-capture is mandatory, and the fixture matrix used for capture must include the seeded pins or every agent render fails.
- A fresh clone has no rendered agents until render-plugin-templates runs; promote.sh already renders — confirm no other consumption path reads the agents dir pre-render.

### Test notes

Render against a fixture matrix with pins: all 11 agents render with pinned frontmatter, bodies byte-equal the sources; remove one pin → loud failure naming the agent; a template accidentally listed in subagent_templates does not double-render. Parity suite green after golden re-capture.

## Acceptance

- [ ] All 11 static agents are rendered artifacts: frontmatter model/effort come from agent_pins, bodies byte-identical to the pre-conversion sources
- [ ] A missing pin for a plain-render agent template fails the render loud, naming the agent; the worker cell fan-out is unaffected
- [ ] The rendered agent files are gitignored with sidecars; no hand-authored agent .md remains tracked
- [ ] The render parity suite passes with re-captured goldens under fixture config

## Done summary
Converted the 10 hand-authored plan agents plus practice-scout to pin-driven templates (model/effort injected as agent_model/agent_effort from the host matrix agent_pins, bodies byte-verbatim); renderAgents' plain-render branch fails loud naming any un-pinned agent, rendered agents are gitignored, and the parity/consistency suites + oracle goldens were updated/re-captured.
## Evidence
