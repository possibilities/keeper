## Description

**Size:** M
**Files:** README.md, CLAUDE.md, docs/install.md, docs/examples/matrix.example.yaml, docs/problem-codes.md, docs/plugin-composition-map.md, docs/adr/0010-host-provider-matrix-and-wrapped-worker-cells.md, docs/adr/0021-transcript-only-background-agent-gating.md, docs/adr/0033-launch-triples-over-named-preset-catalog.md, docs/adr/0034-resume-by-name-resolves-through-bus-identity.md, docs/adr/0035-shared-global-harness-instruction-source.md, docs/adr/0036-required-host-matrix-v2-with-launch-id-entries.md, docs/adr/0040-per-verb-dispatch-table-and-host-agent-pins.md, plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/dispatch/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/template/agents/panel-judge.md.tmpl, plugins/plan/agents/panel-judge.md, plugins/plan/skills/model-guidance/references/gpt-5.3-codex-spark.md, plugins/plan/skills/model-guidance/references/gpt-5.4.md, plugins/plan/skills/model-guidance/references/gpt-5.4-mini.md, plugins/plan/skills/model-guidance/references/gpt-5.5.md, plugins/plan/skills/model-guidance/references/gpt-5.6-sol.md, plugins/plan/skills/model-guidance/references/gpt-5.6-luna.md, plugins/plan/skills/model-guidance/references/gpt-5.6-terra.md, plugins/plan/model-selector.yaml, plugins/prompt/test/oracle/fixtures/render-plugin-templates.json

### Approach

Prune every current contract presenting Hermes/Codex as supported, regenerate managed artifacts, and retarget retained model guidance to Pi. Preserve ADR/migration history, Pi model names, CodexBar routing, and the `gpt` Worker provider family.

### Investigation targets

*Verify before relying — these refs move with the repo.*

**Required** (read before coding):
- `README.md`, `CLAUDE.md`, and `docs/install.md` — current contract.
- `docs/examples/matrix.example.yaml` — Provider example.
- `plugins/keeper/skills/pair/SKILL.md` — partner contract.
- `plugins/plan/skills/panel/references/panel.md` — panel examples.
- `plugins/plan/model-selector.yaml` — guidance hashes.

**Optional** (reference as needed):
- `docs/adr/0058-claude-and-pi-supported-harness-boundary.md` — accepted decision.
- `docs/adr/0038-external-capacity-and-per-launch-account-routing.md` — preserve.

### Risks

Global lexical deletion would remove live Pi models, vendor quotes, CodexBar, and sanctioned history.

### Test notes

Regenerate through canonical renderers, re-pin changed guidance hashes, and use the full suite for docs/parity gates.

### Detailed phases

1. Prune README/install/help/guardrail prose.
2. Mark only genuinely superseded ADR portions.
3. Narrow pair/panel templates and regenerate outputs.
4. Retarget model guidance to Pi and re-pin hashes.
5. Classify final grep and run full tests.

### Alternatives

Deleting all ADR/model-card Codex text is rejected.

### Non-functional targets

Docs stay forward-facing and concise; generated artifacts retain parity.

### Rollout

Reinstall completions/templates; record final grep survivors by namespace in evidence.

## Acceptance

- [ ] README, install, help, skills, and examples describe Claude/Pi only.
- [ ] Guardrails contain no live Hermes/Codex harness writer rules.
- [ ] Templates, generated agents, hashes, and fixtures are in parity.
- [ ] Pi Codex model names, CodexBar, migration history, and ADR history remain where correct.
- [ ] No unintended support remains and `bun run test:full` passes.

## Done summary

## Evidence
