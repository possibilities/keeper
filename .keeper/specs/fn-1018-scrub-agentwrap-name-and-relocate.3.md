## Description

**Size:** M
**Files:** src/agent/config.ts, src/agent/plugins.ts, test/agent-config.test.ts, scripts/frozen-allowlist.txt (append fallback anchors)

### Approach

Relocate the launcher's per-harness config from `~/.config/agentwrap/` to `~/.config/keeper/` with a transitional read-old fallback. Route the 4 per-harness path fns (`launcherConfigPath`/`codexConfigPath`/`piLauncherConfigPath`/`pluginConfigPath`, config.ts:60-73) through `keeperConfigDir()` (which owns the `KEEPER_CONFIG_DIR` seam) so they resolve under `~/.config/keeper/`. Add a per-file resolver that returns the new path if it `isFile()`-exists, else the old `~/.config/agentwrap/X.yaml` if it exists, else the new path — handed to the EXISTING readers unchanged, so each keeps its posture: `loadLauncherDefaults`/`loadPiLauncherDefaults` stay fail-open, `loadPluginSources` stays fail-LOUD (throws only when BOTH paths are absent, since the resolver returns the new path when neither exists and the reader's own `isFile` check then throws). Emit ONE stderr line when the fallback actually reads the old path (names the stale old path; self-silences post-restow). Mirror the existing `legacyAgentwrapPresetsPath` structure (optional `legacyPath` default-arg), but a warn-on-use fallback, NOT the fail-loud `migrationHint`. Update the config.ts:3 + plugins.ts:6 path comments to `~/.config/keeper/` (forward-facing). Keep `legacyAgentwrapPresetsPath` verbatim. Append `anchor|` records to scripts/frozen-allowlist.txt for the newly-introduced `~/.config/agentwrap/` fallback literals so a future sweep can't delete them. Add NEW tests in test/agent-config.test.ts asserting the `KEEPER_CONFIG_DIR` env-seam + new-then-old fallback for all 4 readers, preserving the fail-open/fail-loud asymmetry (rename the `agentwrap-config-` mkdtemp prefix to `keeper-agent-config-`).

### Investigation targets

**Required** (read before coding):
- src/agent/config.ts:60-104 (path fns + `keeperConfigDir` + legacy detector), 134-254 (the 4 readers' postures), 407-447 (`migrationHint`/`loadPresetCatalog` template), 565-575 (`isFile`/`resolvePath`)
- src/agent/plugins.ts:6,62-90 — path comment + fail-loud message text
- test/agent-config.test.ts:30,407-423 — the mkdtemp prefix + the existing `KEEPER_CONFIG_DIR` seam test to mirror
- test/agent-presets.test.ts:364-394 — the dep-free import-graph guard that must stay green (config.ts must never import `bun:sqlite`)
- scripts/frozen-allowlist.txt (from .1) — append the fallback anchors here

**Optional** (reference as needed):
- src/db.ts `resolveConfigPath` — the parallel `KEEPER_CONFIG_DIR` pattern (do NOT import db.ts)

### Risks

- Silent-degradation: a fail-open reader pointed at an empty/absent new path must fall back, not silently drop model/effort defaults. `isFile()`-exists = present (matches existing semantics); the move (.4) populates the new path.
- Fail-loud erosion: if `loadPluginSources`' fallback returned defaults on new-absent, it would convert fail-loud→fail-open. Resolve-to-path + unchanged reader avoids this; throw only when both absent; do not swallow non-ENOENT errors.
- Dep-free violation: config.ts must not import src/db.ts — keep the import-graph guard green.
- Do not touch any file owned by .2 (this task is config.ts / plugins.ts / agent-config.test.ts / frozen-allowlist.txt only).

### Test notes

New tests cover: new-path-present wins; new-absent/old-present falls back (fail-open + fail-loud both); both-absent (fail-open null, fail-loud throws); `KEEPER_CONFIG_DIR` seam drives all 4. `bun test` + dep-free guard + frozen-anchor lint all green.

## Acceptance

- [ ] The 4 per-harness path fns route through `keeperConfigDir()` → `~/.config/keeper/`, respecting `KEEPER_CONFIG_DIR`
- [ ] Per-file new-then-old fallback; fail-open readers stay fail-open, `loadPluginSources` throws only when both paths are absent
- [ ] One stderr warning when the old path is actually read
- [ ] config.ts:3 + plugins.ts:6 path comments updated to `~/.config/keeper/`; `legacyAgentwrapPresetsPath` unchanged
- [ ] Fallback literals appended to frozen-allowlist.txt; lint green
- [ ] New agent-config.test.ts tests cover env-seam + fallback for all 4 readers; dep-free import-graph guard green; `bun test` green

## Done summary

## Evidence
