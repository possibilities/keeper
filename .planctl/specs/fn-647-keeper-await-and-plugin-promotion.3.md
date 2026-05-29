## Description

**Size:** M
**Files:** .claude-plugin/plugin.json (new, root), hooks/hooks.json (new,
root), plugin/.claude-plugin/plugin.json (retire), plugin/hooks/hooks.json
(retire/migrate), README.md, CLAUDE.md (AGENTS.md is a symlink — never
rm+recreate).

### Approach

Promote the keeper repo root to a Claude plugin so the events-writer hook
and the new `skills/` dir (task .4) ship as one plugin loaded via
`--plugin-dir ~/code/keeper`.

- Add root `.claude-plugin/plugin.json` reusing `name: "keeper"` (the skill
  namespace prefix → `keeper:keeper-await`) and the existing description;
  OMIT an explicit `version` during dev so the git SHA is the cache key.
  Only `plugin.json` goes in `.claude-plugin/`.
- Add root `hooks/hooks.json` (Claude plugin convention) whose command
  points at `${CLAUDE_PLUGIN_ROOT}/plugin/hooks/events-writer.ts`. **The
  hook source file STAYS at `plugin/hooks/events-writer.ts`** so its
  path-sensitive `../../src/db` / `../../src/dead-letter` imports are
  untouched. `bin/git` likewise stays under `plugin/bin/`; any reference
  becomes `${CLAUDE_PLUGIN_ROOT}/plugin/bin`.
- Retire the inner `plugin/.claude-plugin/plugin.json` and the inner
  `plugin/hooks/hooks.json` so there is exactly ONE manifest (root) and one
  hooks.json (root) — two discoverable manifests under one `--plugin-dir`
  would be ambiguous.
- Retire the `~/.claude/plugins/keeper` symlink install: rewrite README
  Install step 4 (the `ln -s "$PWD/plugin" …` block) to describe loading
  via the launcher `--plugin-dir`; remove the `rm ~/.claude/plugins/keeper`
  Uninstall line. Add a migration note: existing machines MUST
  `rm ~/.claude/plugins/keeper` or the hook double-registers (launcher load
  + symlink) and writes two `events` rows per invocation — there is no
  runtime dedup guard (keeper's "no in-process self-heal" stance).
- Update README "Example clients" (add `keeper await`, fix the "Four
  scripts" count) and add a one-sentence dispatcher mention to Architecture.
  Add a short plugin-layout pointer to CLAUDE.md (root manifest canonical;
  `plugin/` holds hook source + bin; `skills/` holds NL skills).

Preserve all hook invariants: no third-party deps in events-writer.ts,
always exit 0, opens DB with `{ migrate: false }`.

### Investigation targets

**Required** (read before coding):
- plugin/.claude-plugin/plugin.json — current manifest (`name: "keeper"`, description) to lift to root.
- plugin/hooks/hooks.json — current `${CLAUDE_PLUGIN_ROOT}` command paths to re-point.
- plugin/hooks/events-writer.ts:1-23 — the invariants + the `../../src/db` / `../../src/dead-letter` relative imports that MUST keep resolving (file stays put).
- README.md — Install step 4 (the `ln -s "$PWD/plugin" ~/.claude/plugins/keeper` block, ~:254-258), Uninstall (`rm ~/.claude/plugins/keeper`, ~:564), "Example clients", Architecture.
- CLAUDE.md — the AGENTS.md-symlink note + a spot for the plugin-layout pointer.

**Optional** (reference as needed):
- plugin/bin/git — confirm how it's referenced for PATH injection.

### Risks

- **Silent event loss is the headline risk**: a wrong hook command path
  makes events-writer.ts fail to resolve → it exits 0 → events silently
  stop. Verify the hook still fires and writes exactly one row after the
  layout change (load via `claude --plugin-dir ~/code/keeper`, run a hook,
  check the `events` table count delta is 1).
- **Double-fold**: the retired symlink coexisting with the launcher load
  doubles every event. Keep the rm a hard, documented prerequisite.
- Do not disturb the `AGENTS.md → CLAUDE.md` symlink.

### Test notes

No unit test for plugin discovery; verify manually: load the root plugin
via `--plugin-dir`, trigger a hook, confirm a single `events` row lands
(`bun` one-liner or `sqlite3` count delta). Confirm `test/events-writer.test.ts`
and `test/git-wrapper.test.ts` still pass (imports unchanged). Confirm
`/keeper:` namespace resolves once task .4 lands.

## Acceptance

- [ ] Root `.claude-plugin/plugin.json` exists (`name: "keeper"`, no dev `version`); inner `plugin/.claude-plugin/plugin.json` removed.
- [ ] Root `hooks/hooks.json` points at `${CLAUDE_PLUGIN_ROOT}/plugin/hooks/events-writer.ts`; the hook file stays put and its relative imports still resolve.
- [ ] Loading `claude --plugin-dir ~/code/keeper` and triggering a hook writes exactly ONE `events` row (no double-fold); `test/events-writer.test.ts` + `test/git-wrapper.test.ts` pass.
- [ ] README Install/Uninstall rewritten (symlink retired, launcher load documented, double-install migration note added); "Example clients" + Architecture updated; CLAUDE.md plugin-layout pointer added; AGENTS.md symlink intact.
- [ ] Hook invariants preserved (no third-party deps, exit 0, `{migrate:false}`).

## Done summary

## Evidence
