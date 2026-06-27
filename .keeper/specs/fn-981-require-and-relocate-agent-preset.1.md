## Description

**Size:** M
**Files:** src/agent/config.ts, src/agent/main.ts, src/pair/panel.ts, cli/pair.ts, cli/dispatch.ts, src/autopilot-worker.ts, README.md, test/agent-config.test.ts, test/agent-presets.test.ts, test/pair-panel.test.ts, test/autopilot-worker.test.ts, test/pair-cli.test.ts, test/dispatch-cli.test.ts

### Approach

Relocate the agent launch-config registry into `~/.config/keeper/`, split the single
`loadPresetRegistry()` into two scoped loaders, reverse the fail-open posture to
required+validated, and rewire all consumers — landed atomically because splitting the
shared `PresetRegistry` type ripples every DI seam and won't compile half-done.

- **`src/agent/config.ts`:** add an island-local `keeperConfigDir()` (reads `KEEPER_CONFIG_DIR`, default `join(homedir(), ".config", "keeper")`) — a PARALLEL to `src/db.ts:229` `resolveConfigPath()`, NOT an import (db.ts is the SQLite island; importing it breaks the guard). Replace `presetsConfigPath()` (config.ts:71-80, the agentwrap hardcode + `KEEPER_PRESETS_CONFIG`) with `presetsCatalogPath()` → `<dir>/presets.yaml` and add `panelConfigPath()` → `<dir>/panel.yaml`. Leave `launcherConfigPath`/`codexConfigPath`/`piLauncherConfigPath`/`pluginConfigPath` (config.ts:55-69) UNTOUCHED in agentwrap — out of scope.
- **Split the type + loaders:** `PresetRegistry` (config.ts:254) → a catalog type `{presets}` and a panel-selections type `{panels, default?}`. `loadPresetCatalog()` parses `presets.yaml` (reuse `parsePreset`/`validatePresetName`/`presetStringField`/`RESERVED_PRESET_NAMES`/`PRESET_NAME_PATTERN` verbatim) and **throws `ConfigError` on a missing file** (the reversal — no more `{presets:{}}` empty return at config.ts:371-373); an empty `presets:` mapping is still valid (worker tolerance). `loadPanelSelections(catalog)` parses `panel.yaml` — move the panel-array block (config.ts:386-414), validate each member resolves against the passed catalog and is pair-launchable (claude|codex, reject pi AT LOAD time), parse a top-level `default:` key (a panel name that must exist) treated as a STRUCTURAL key exempt from `validatePresetName` though `default` is reserved; **throws `ConfigError` on missing**. Strict-reject unknown top-level keys in both files.
- **Migration hint:** a small island-local helper — when a required file is absent, if `~/.config/agentwrap/presets.yaml` exists, append a hint to the `ConfigError` naming the old path and the new two-file layout.
- **Rewire consumers** (all read through the new loaders / `MainDeps` seam):
  - `src/agent/main.ts`: `MainDeps.loadPresetRegistryFn` (131/190) → `loadPresetCatalogFn` (+ a panel-selections loader where panel resolution happens). `runPresetsResolve` (670-720) resolves a name against the catalog, a panel name against `panel.yaml`, preserving the `{kind:"preset"|"panel"}` JSON contract jq parses. Dispatch/preset resolution (769-783, 875-895) asserts the catalog.
  - `src/pair/panel.ts`: `resolvePanelMembers` (165) takes catalog + panel-selections; **REMOVE the opus+codex fallback (212-219)**; `--panel` absent → `panel.yaml` `default`. `buildPanelDeps.loadRegistry` (667) loads catalog + panel selections (both required for panel ops).
  - `cli/pair.ts` (250-270): `--preset X` → resolve against the catalog, exit 2 on `ConfigError`. NO pair config. Bare pair (no `--preset`) unchanged.
  - `cli/dispatch.ts` (409-430): `--preset X` → catalog resolve + assert; plan-key base keeps the fail-open worker resolution.
  - `src/autopilot-worker.ts` `resolveWorkerLaunchConfig` (320-344): point at `loadPresetCatalog()`; KEEP the `catch (instanceof ConfigError)` → `WORKER_MODEL`/`WORKER_EFFORT` swallow (now also catches the missing-file throw). Catalog-only; never pair/panel.
- **Docs (this task):** rewrite the README presets section (~1371) and the `config.ts` header comment (1-13) to the new paths + required posture, forward-facing only.

### Investigation targets

**Required** (read before coding):
- src/agent/config.ts:71-80 — `presetsConfigPath` + `KEEPER_PRESETS_CONFIG` (the relocate point)
- src/agent/config.ts:241-438 — `Preset`/`PresetRegistry` types, `RESERVED_PRESET_NAMES`, `parsePreset`, `loadPresetRegistry` (fail-open at 371-373, panel block 386-414), `resolvePreset`
- src/pair/panel.ts:55,165-220,667 — `DEFAULT_PANEL_NAME`, `resolvePanelMembers` + the fallback to remove, `buildPanelDeps.loadRegistry`
- src/autopilot-worker.ts:304-344 — `WORKER_MODEL`/`WORKER_EFFORT`, `resolveWorkerLaunchConfig` swallow (the carve-out that must keep working)
- src/db.ts:228-234 — `resolveConfigPath` (the `~/.config/keeper/` pattern to parallel, NOT import)
- test/agent-presets.test.ts:297-329 + test/agent-self-invoke.test.ts:185-198 — the bundle-grep import-graph guards that must stay green

**Optional** (reference as needed):
- src/agent/main.ts:670-720,769-783,875-895 — `runPresetsResolve` JSON contract + dispatch/preset resolution
- cli/pair.ts:250-280, cli/dispatch.ts:409-435 — explicit-preset resolution sites
- test/pair-panel.test.ts:154-163, test/autopilot-worker.test.ts:2800-2862 — the behavior-change tests to invert

### Risks

- **Import-graph guard:** the new `keeperConfigDir()` + loaders MUST stay `node:*` + `Bun.YAML` only; any transitive reach to `src/db.ts` breaks the bundle-grep guards. Parallel `resolveConfigPath`, never import it.
- **Worker carve-out vs the reversal:** the missing-file throw MUST be a `ConfigError` subtype so the worker's existing catch swallows it to constants — a bare `Error` crashes the daemon. This is the epic's early proof point.
- **Type-split ripple:** every DI seam (`loadPresetRegistryFn`, `loadRegistry`) and every literal-registry test harness (`makeHarness`/`makeDeps`) updates together or the build breaks.
- **`default` reserved-name vs structural key:** the `panel.yaml` top-level `default:` key must bypass `validatePresetName` while its value is validated as a real panel name.

### Test notes

- Invert test/pair-panel.test.ts:154-163 (fallback → fail-loud exit 2) and any panel-runner fallback assertion; keep test/autopilot-worker.test.ts worker fail-open green (now via thrown-and-caught `ConfigError` on missing catalog).
- New agent-config cases: fail-loud on missing catalog/panel, member-against-catalog validation, pi-at-load rejection, strict unknown-key reject, the migration hint, and the `KEEPER_CONFIG_DIR` single-seam derivation (the tmpdir config-arg seam still works; `os.homedir()` ignores `$HOME` on macOS, so set the env var).
- `bun run test:full` green, import-graph guards included.

## Acceptance

- [ ] Catalog at `~/.config/keeper/presets.yaml` + panel selections at `~/.config/keeper/panel.yaml`, resolved only by the dep-free island; `KEEPER_CONFIG_DIR` overrides the base dir; `KEEPER_PRESETS_CONFIG` removed; bundle-grep import-graph guards stay green.
- [ ] `keeper pair --preset X`, `keeper dispatch --preset X`, `keeper agent --agentwrap-preset X`, and every panel op hard-fail exit 2 with a message naming the file + bad name + sorted available names on a missing/invalid config; the opus+codex panel fallback is gone; bare `keeper pair` (no `--preset`) still needs no config.
- [ ] Autopilot worker coalesces to `sonnet`/`max` when the catalog or `worker` preset is absent; the daemon never crashes on missing/bad config.
- [ ] A missing-config error that detects a leftover `~/.config/agentwrap/presets.yaml` names it and the new two-file layout.
- [ ] README presets section + `config.ts` header reflect the new paths + required posture (forward-facing, no history narration).
- [ ] `bun run test:full` green.

## Done summary

## Evidence
