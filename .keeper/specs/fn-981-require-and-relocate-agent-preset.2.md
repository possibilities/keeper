## Description

**Size:** S
**Files:** src/agent/main.ts (or cli/agent.ts), cli/pair.ts, cli/dispatch.ts, plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/dispatch/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/agents/panel-runner.md, test/agent-presets.test.ts

### Approach

With the catalog now required, agents must be able to discover which presets exist so they
pass real names. Add a discovery surface and point every agent-facing doc at it.

- **`keeper agent presets list`:** a new subcommand alongside `presets resolve` (src/agent/main.ts `runPresetsResolve` ~670 / the `presets` dispatch in cli/agent.ts) that enumerates catalog presets (name + harness/model/effort) and panel names. Human-readable by default, `--json` for machine consumption. Reuses `loadPresetCatalog`/`loadPanelSelections` from task 1; a missing catalog yields task 1's migration-hint error (so `presets list` is the discovery entry point), not a crash.
- **Skill + help docs:** update plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/dispatch/SKILL.md, plugins/plan/skills/panel/SKILL.md, plugins/plan/skills/panel/references/panel.md, plugins/plan/agents/panel-runner.md, and the `--help`/`--agent-help` strings in cli/pair.ts + cli/dispatch.ts: state that presets live in `~/.config/keeper/presets.yaml`, that `--preset <name>` needs a real catalog entry (exit 2 otherwise), and to run `keeper agent presets list` to see what's available. Delete panel.md's "Zero-config fallback" section (~44-47); add the missing/invalid-config exit-2 condition to panel-runner.md (~74/87).
- **Advice surface:** check `keeper prompt find-snippets` for a canonical pair/panel/agent usage snippet; if one exists, add the `presets list` discovery line there too so it reaches rendered advice. Bounded — one snippet, no new render machinery.
- **No rotting static lists:** docs reference the list command, never hardcode the current preset names.

### Investigation targets

**Required** (read before coding):
- src/agent/main.ts:670-723 — `runPresetsResolve` + the `presets` subcommand dispatch (where `list` slots in)
- cli/agent.ts — the `presets resolve` usage string + subcommand routing
- plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/dispatch/SKILL.md — `--preset` flag tables + exit rows
- plugins/plan/skills/panel/references/panel.md:26-49, plugins/plan/agents/panel-runner.md:74,87 — the fallback section to delete + exit-2 conditions

**Optional** (reference as needed):
- test/agent-presets.test.ts — subcommand test pattern for a `presets list` smoke test

### Risks

- Depends on task 1's loader API + the new paths; cannot land first (also both edit src/agent/main.ts).
- Keep the `presets resolve` `{kind:...}` JSON contract intact; `list` is additive, not a rewrite of `resolve`.

### Test notes

- A smoke test: `presets list` over a tmpdir catalog lists names + harnesses; `--json` shape; missing-catalog → migration-hint error, exit 2.

## Acceptance

- [ ] `keeper agent presets list` lists configured catalog presets (name + harness/model/effort) and panel names; `--json` for machine use; a missing catalog yields the discovery/migration error (exit 2), not a crash.
- [ ] pair / dispatch / panel skill docs + their `--help`/`--agent-help` strings name `~/.config/keeper/presets.yaml`, state `--preset` needs a real catalog name, and point at `keeper agent presets list`; panel.md's zero-config-fallback section is deleted.
- [ ] No static preset-name lists in docs — they reference the list command.
- [ ] `bun run test:full` green.

## Done summary

## Evidence
