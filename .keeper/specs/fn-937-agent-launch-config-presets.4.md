## Description

**Size:** M
**Files:** plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/agents/panel-judge.md

### Approach

Rewrite the panel's hardcoded two-command fan-out into a data-driven loop over a
`panels.<name>` array, consuming the task-1 `presets resolve` JSON contract.

- Replace Step 0's "opus4.8-gpt5.5" narrative (:34) and the two hardcoded
  `keeper pair send … --cli claude` (:66) / `--cli codex` (:72) Monitor calls
  with: resolve `panels.<name>` (default `default`) via
  `keeper agent presets resolve <panel>`, parse the JSON array with `jq`, and
  emit one `keeper pair send <prompt> --preset <member> --read-only --session
  panels --output <member>.yaml` per member — all in ONE turn, preserving the
  parallel fan-out and the two-line Monitor contract. The shared prompt file is
  still written once.
- **Output labels come from PRESET names** (not harness names), so two claude
  panelists with different models are distinguishable; pass the preset-name
  labels to the judge.
- **Backward-compat fallback**: when no `default` panel (or no registry) exists,
  fall back to the legacy `--cli claude` + `--cli codex` two-command form, so the
  panel keeps working with zero config and presets are a pure opt-in upgrade.
- Update `references/panel.md` (~:28-36) panelist-definition bullets and
  `panel-judge.md` (~:20/:33) attribution labels from model-family names to
  preset-name attribution.
- Document an example `presets.yaml` (the `default` panel + its member presets)
  in the panel prose so an operator knows what to define.

### Investigation targets

**Required**:
- plugins/plan/skills/panel/SKILL.md:34, :64-76 — Step 0 narrative + the two Monitor `keeper pair send` blocks.
- plugins/plan/skills/panel/references/panel.md:28-36 — the canonical panelist-definition bullets.
- plugins/plan/agents/panel-judge.md:20, :33 — the panelist attribution labels.

**Optional**:
- The task-1 `presets resolve` JSON shape — the SKILL's `jq` parse must match it exactly.

### Risks

- The `presets resolve` JSON contract (pinned in task 1) must match the SKILL's `jq` parse — a format drift breaks the panel silently.
- Empty panel array → fail loud (task 1's resolve verb); the SKILL must surface that, not hang waiting on a notification that never comes.

### Test notes

- No unit test (skill prose + bash). Smoke: `keeper agent presets resolve default` returns the expected JSON; a two-claude-different-model panel produces two distinguishable `--output` files; with no registry the legacy fallback still fans out claude+codex.

## Acceptance

- [ ] Panel resolves `panels.<name>` and fans out one `keeper pair send --preset <member>` per member in one turn, preserving parallel + the Monitor contract.
- [ ] Two same-harness-different-model panelists are expressible and distinguishable by preset-name labels (to the judge too).
- [ ] With no `default` panel/registry, the panel falls back to the legacy claude+codex form.
- [ ] references/panel.md + panel-judge.md attribute by preset name.

## Done summary

## Evidence
