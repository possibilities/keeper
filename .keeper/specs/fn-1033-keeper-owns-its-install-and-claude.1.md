## Description

**Size:** M
**Files:** src/agent/config.ts, src/agent/state-sharing.ts, src/agent/main.ts, system/claude/.claude/settings.json, system/claude/.claude/CLAUDE.md, system/claude/.claude/AGENTS.md, test/agent-config.test.ts, test/agent-state-sharing.test.ts, test/agent-profile-bootstrap.test.ts

### Approach

Move arthack's CURRENT LIVE `system/claude/.claude/` content into keeper at
`system/claude/.claude/` — copy `settings.json` + `CLAUDE.md` + recreate the
`AGENTS.md -> CLAUDE.md` symlink verbatim; do NOT author fresh content (byte
identity is what stops the guard from seeing a divergent clobber at first
launch). Do NOT copy `.stow-local-ignore` — it is stow-only metadata, unused
under the guard-driven model.

Retire the `claude_stow_dir` config key. Add a dep-free `defaultClaudeStowDir()`
helper (a state-sharing module-top leaf, sibling in spirit to
`defaultKeeperAgentPath`) that resolves the source via
`fileURLToPath(import.meta.url)` → `resolve(here, "..", "..", "system", "claude", ".claude")`
→ realpath. Delete `loadClaudeStowDir` from `config.ts`. Keep the injectable
`stowDir` param on `ensureClaudeStateSharing` / `ensureCanonicalStowLinks` (tests
inject it), but wire its PRODUCTION default in `realDeps()` to the new resolver —
the guard now always resolves a real path; the `null`-disable branch becomes
test-only. Preserve the `!existsSync(target)` fail-open (state-sharing.ts:702) and
the `KEEPER_AGENT_SKIP_LINK_GUARD` env rip-cord so a partial checkout warns+skips
rather than bricking a launch.

Sweep the signature change atomically: `MainDeps` (main.ts:153/166-170),
`realDeps()` (241/245-251), the call site (1587-1603), and the positional test
calls. Update stale doc-comment attributions — `state-sharing.ts:769-771`
("(from claude.yaml)" → derived from the module path), `:784-791` ("the claude
stow package owns" → keeper's `system/claude/`) — present-tense, no provenance
(CLAUDE.md rule #0). Do NOT touch `loadPluginSources` / `config.ts:222` ("ships
via the `arthack` stow package"): that is a DIFFERENT, still-arthack-owned
config — conflating them is the trap both scouts flagged.

### Investigation targets

**Required** (read before coding):
- src/keeper-agent-path.ts:32-43 — the `fileURLToPath(import.meta.url)` self-path pattern to mirror
- src/agent/state-sharing.ts:682-745 — `ensureCanonicalStowLinks`; :702-707 fail-open skip; :453-459 profile-farm hard-error; :772-794 `ensureClaudeStateSharing` null-gate; :769-791 stale doc comments
- src/agent/config.ts:183-200 — `loadClaudeStowDir` to delete; :216-249 `loadPluginSources` — DO NOT touch/conflate
- src/agent/main.ts:153, 166-170 (`MainDeps`), 241, 245-251 (`realDeps`), 1587-1603 (call site)
- test/agent-config.test.ts:104-133 — `loadClaudeStowDir` block to delete (:115 hardcodes the OLD arthack path); test/agent-state-sharing.test.ts:138-146 — fixture already uses `repo/system/claude/.claude`; test/agent-profile-bootstrap.test.ts:344, 464 — positional `ensureClaudeStateSharing` calls to sweep

**Optional** (reference as needed):
- ~/code/arthack/system/claude/.claude/ — the source content to copy (settings.json, CLAUDE.md, AGENTS.md symlink)

### Risks

- The signature sweep must land atomically or the build half-migrates.
- `import.meta.url` must resolve to the repo THROUGH the `~/.bun/bin/keeper` symlink — confirm with a one-line `console.log(import.meta.url)` run via the linked binary before relying on it (fallback in the epic's Early proof point).
- The resolver must return the realpath'd ABSOLUTE dir so the guard's `relative(...)` link is stable across launches (no per-launch "wrong target" churn).

### Test notes

- Delete/replace the `loadClaudeStowDir` describe block; sweep the positional `ensureClaudeStateSharing` calls to the new signature.
- Add a test: `defaultClaudeStowDir()` resolves to `<repo>/system/claude/.claude`, and the guard creates `~/.claude/{settings.json,CLAUDE.md}` → that dir from absent.
- `bun test` in-process; `scripts/lint-retired-name.sh` Check C — the new `system/` tree must be "agentwrap"-clean.

## Acceptance

- [ ] `system/claude/.claude/{settings.json,CLAUDE.md,AGENTS.md}` present in keeper, byte-identical to arthack's current live copies (AGENTS.md is a symlink to CLAUDE.md); `.stow-local-ignore` NOT copied
- [ ] `claude_stow_dir` key + `loadClaudeStowDir` removed; no reference remains under src/ or test/
- [ ] The guard resolves the claude source from the module path via `defaultClaudeStowDir()` (mirroring `defaultKeeperAgentPath`); `ensureClaudeStateSharing` keeps its injectable param with the production default wired in `realDeps()`
- [ ] `!existsSync` fail-open + `KEEPER_AGENT_SKIP_LINK_GUARD` env rip-cord preserved (partial checkout warns+skips, never bricks)
- [ ] `loadPluginSources` / the "arthack stow package" message left untouched
- [ ] Stale doc-comments (state-sharing.ts:769-791; the deleted `loadClaudeStowDir` doc) updated to present-tense module-path wording
- [ ] `bun test` green; `scripts/lint-retired-name.sh` clean

## Done summary
Keeper now owns its claude source: vendored arthack's live system/claude/.claude (settings.json, CLAUDE.md, AGENTS.md symlink) byte-identical, retired claude_stow_dir/loadClaudeStowDir, and the launch guard resolves the source from its own module path via defaultClaudeStowDir() (wired in realDeps), preserving the !existsSync + KEEPER_AGENT_SKIP_LINK_GUARD fail-opens.
## Evidence
