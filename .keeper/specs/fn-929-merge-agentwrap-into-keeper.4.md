## Description

**Size:** M
**Files:** package.json, README.md, CLAUDE.md (= AGENTS.md symlink), plugins/keeper/skills/pair/SKILL.md, plugins/keeper/skills/dispatch/SKILL.md, plugins/plan/skills/panel/SKILL.md, cli/pair.ts

### Approach

Only AFTER task `.3` soaks. On the keeper side: land a provenance commit
recording the absorbed agentwrap SHA; `bun unlink agentwrap`. Then the docs
sweep, FORWARD-FACING only (state current behavior, never "formerly
agentwrap"): README.md `## Config` (~406-458: replace `agentwrap_path` /
`KEEPER_AGENTWRAP_PATH` with the `KEEPER_AGENT_PATH` resolver; rewrite the "HARD
runtime dependency validated at boot" paragraph — the dep is now an in-binary
subcommand), Install step 4 (~461-481: `plugin_scan_dirs` loader attribution →
the in-binary mechanism; retain the `~/.claude/plugins/keeper` double-register
warning), `## Architecture` (~2856-2860 + :1074: `keeper agent` in-binary
family + new call sites); CLAUDE.md line 23 (the agentwrap `plugin_scan_dirs`
loader sentence — edit IN PLACE, the symlink rule); pair/SKILL.md (:21 detached
partner, :98 handle attribution, :122 `--timeout` / wait-for-stop default);
dispatch/SKILL.md (:22 "via agentwrap"); panel/SKILL.md (:86 create-race
recovery); cli/pair.ts `--help` (:68 "via agentwrap"). The change-history
belongs in the commit message, not the prose.

### Investigation targets

**Required** (read before coding):
- README.md `## Config` (~406-458), Install step 4 (~461-481), `## Architecture` (~2856-2860, :1074)
- CLAUDE.md:23 (the plugin_scan_dirs line); AGENTS.md is the symlink — edit in place, never rm+recreate
- plugins/keeper/skills/pair/SKILL.md:21,98,122; plugins/keeper/skills/dispatch/SKILL.md:22; plugins/plan/skills/panel/SKILL.md:86
- cli/pair.ts:68 (--help string), package.json (the `bun link` / dep entry)

**Optional** (reference as needed):
- `keeper prompt render future-facing-docs` / `code-comment-style` — the forward-facing rule

### Risks

- Premature retirement: do NOT `bun unlink` until task `.3`'s in-binary path has soaked in a real dispatch.
- Doc drift: keep all prose forward-facing; mixing in change-history is the common mistake here.

### Test notes

No new test surface; `bun run test:full` green (docs + unlink shouldn't break
tests). Sanity: `keeper agent claude --version` works with the external
agentwrap unlinked.

## Acceptance

- [ ] provenance commit records the absorbed agentwrap SHA; `bun unlink agentwrap`; keeper launches still work with the external binary gone
- [ ] README (Config / Install / Architecture), CLAUDE.md:23, pair/dispatch/panel SKILL.md, cli/pair.ts `--help` all reflect the in-binary `keeper agent` surface, forward-facing
- [ ] `bun run test:full` green

## Done summary

## Evidence
