## Description

Originating finding F1 (Consider). Evidence path: `plugins/keeper/skills/pair/SKILL.md:118`
asserts "A claude preset's `effort` is dropped (the headless claude pair path
has no effort flag)". This is wrong on two counts: (1) the pair claude partner
launches as an INTERACTIVE TUI (not headless `--print`) via
`keeper agent claude --agentwrap-preset <name>` (`src/pair-command.ts:205-235`,
`nativeClaudeArgs`), and (2) the launcher's `agent === "claude"` block resolves
`defaultEffort = resolvedPreset?.effort ?? yamlEffort` and pushes `--effort`
(`src/agent/main.ts:1314-1330`). So a claude preset's `effort` IS honored on a
pair launch.

Correct ONLY the line-118 parenthetical about a claude PRESET's effort. Do NOT
touch the separate, CORRECT claims at SKILL.md:121 and :157 that passing the
explicit `--effort` flag with `--cli claude` is an arg fault (exit 2) — that
pair-CLI flag genuinely is codex-only (`cli/pair.ts:320`); only a preset's
effort field rides through the launcher.

## Acceptance

- [ ] SKILL.md:118 states a claude preset's `effort` is honored (pushed by the launcher), not dropped
- [ ] The explicit `--effort` + `--cli claude` arg-fault claims at lines 121 and 157 remain unchanged
- [ ] The corrected text matches the actual launcher behavior at src/agent/main.ts:1314-1330

## Done summary
Corrected SKILL.md:118 to state a claude preset's effort is honored (pushed by the launcher), not dropped; left the explicit --effort + --cli claude arg-fault claims at lines 121 and 157 unchanged.
## Evidence
