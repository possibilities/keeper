## Description

**Size:** M
**Files:** src/agent/config.ts, src/agent/args.ts, src/agent/dispatch.ts, src/agent/main.ts, src/agent/passthrough.ts, cli/agent.ts, test/agent-config.test.ts, test/agent-args.test.ts, test/helpers/agent-main-harness.ts, README.md

### Approach

Add the preset registry to the dep-free `src/agent/config.ts` family and the
`--agentwrap-preset` flag + `presets resolve` verb to the launcher. Keep the
whole resolution path out of `src/db.ts` (cold-start invariant).

- **Registry reader** (`config.ts`): add `presetsConfigPath()` (mirrors `launcherConfigPath` :55) and `loadPresetRegistry(path?)`. Registry shape: `{ presets: Record<name, {harness: "claude"|"codex"|"pi", model?: string, effort?: string, thinking?: string, role?: string}>, panels: Record<name, string[]> }`. Reuse `parseYaml`/`expandUser`/`readMapping`/`isFile`/`ConfigError` (export the privates or inline the same shape — do NOT re-implement YAML parsing). Fail-OPEN on a missing file (empty registry), fail-LOUD `ConfigError` on malformed YAML or invalid entries.
- **Load-time validation** (fail-loud): `harness` in `{claude,codex,pi}`; `effort` only on claude/codex, `thinking` only on pi, never both; preset name matches `[a-z0-9_-]+` and is not in the reserved set (`claude|codex|pi|wait-for-stop|show-last-message|default|help` + YAML-1.1 booleans `yes|no|on|off|true|false|null|~`); every `panels.<name>` member references an existing preset.
- **`resolvePreset(registry, name)`**: returns the preset or throws a specific not-found error listing the file path + requested name + available names.
- **Per-field precedence wiring** (`main.ts`): add `loadPresetRegistryFn` to `MainDeps` (:96-154, beside `loadLauncherDefaultsFn` :117) + `realDeps` (:157-202). Resolve the preset, then coalesce per field BEFORE the resolver default slot: `defaultModel = preset?.model ?? yaml.model`, `defaultEffort = preset?.effort ?? yaml.effort` (claude :1125-1148), the codex effort path :968-988 via the codex resolvers (they live in `main.ts`, NOT passthrough), pi `thinking` :1154-1175. The existing `resolveStartup*Override` already encode explicit>env>default, so the result is `explicit > env > preset > yaml > native` per field with no new precedence machinery.
- **Arg parsing** (`args.ts`): add `--agentwrap-preset` to `ParsedArgs` (:29-53) + `parseArgsForAgent` (:71-152), mirroring the `--agentwrap-profile` split/joined state machine (:85-111); default `null` (no "auto").
- **Dispatch** (`dispatch.ts`): add a `run-preset` kind to `splitSubcommand` (:133-154) for the harnessless form (`--agentwrap-preset` given, no head token → harness comes from the preset); add a `presets resolve <name>` subcommand kind; update `USAGE` (:39) + `AGENTWRAP_HELP` (:66). If a head token IS present and disagrees with the preset's harness → fail loud.
- **`presets resolve <name>`**: emits JSON. A single preset name → `{name, harness, model, effort|thinking, role}`. A panel name → an ordered array of `{name, harness}` members, validating each is pair-launchable (`claude|codex`) and failing loud if a member pins `pi`. This JSON is the contract task 4's panel SKILL parses with `jq` — pin it here.
- **Docs**: document `--agentwrap-preset` + `presets resolve` in the `cli/agent.ts` top comment + `AGENTWRAP_HELP`, and add the `~/.config/agentwrap/presets.yaml` location to the README config section.

### Investigation targets

**Required** (read before coding):
- src/agent/config.ts:20-121 — `ConfigError`, `parseYaml`, `expandUser`, `readMapping`, `isFile`, the `LauncherDefaults` loaders + fail-open/fail-loud split to mirror.
- src/agent/args.ts:29-152 — `ParsedArgs` + the `--agentwrap-profile` state machine to clone for `--agentwrap-preset`.
- src/agent/dispatch.ts:19-154 — `SubcommandKind`/`Dispatch` union, `splitSubcommand`, `USAGE`, `AGENTWRAP_HELP`.
- src/agent/main.ts:96-202 (MainDeps + realDeps loader seams), :1125-1148 (claude wiring), :968-988 (codex wiring), :1154-1175 (pi), and the codex resolvers (grep `resolveCodexStartup` — they are in main.ts, not passthrough).
- src/agent/passthrough.ts:279-291, 378-397 — the claude/pi resolvers; the preset feeds their `default` arg.
- cli/agent.ts:16-20 — the cold-start import-graph invariant text.

**Optional**:
- test/agent-config.test.ts — `mkdtempSync`/`writeYaml` fixture pattern; missing→null, malformed→`toThrow(ConfigError)`.
- test/helpers/agent-main-harness.ts:119-150 — every loader seam is stubbed inline; add a `loadPresetRegistryFn` stub.

### Risks

- Cold-start regression: any symbol the preset reader imports that transitively reaches `src/db.ts` silently slows every launcher cold start. Keep resolution in the `config.ts` dep-free island (or a `src/agent/presets.ts` leaf importing only `node:*` + config helpers).
- Codex resolvers are NOT in passthrough.ts — wiring claude/pi through passthrough and forgetting the codex path in main.ts would silently drop preset effort for codex.
- `Bun.YAML.parse` is YAML 1.2 (boolean-free corpus) — keep the reserved-name guard anyway for downstream 1.1 re-parsers.

### Test notes

- Registry: missing file → empty registry (fail-open); malformed → `ConfigError`; invalid harness / cross-harness effort+thinking / reserved or non-matching name / dangling panel member → fail-loud at load.
- Precedence: a model-only preset leaves effort falling through to yaml and vice versa; an explicit `--model`/`--effort` still wins over a preset; `CLAUDE_CODE_EFFORT_LEVEL` beats the preset effort.
- `presets resolve`: JSON shape for single + panel; pi panel member → fail loud.
- **Cold-start guard**: a test asserting the launcher entry / `config.ts` import graph does not include `src/db.ts`.

## Acceptance

- [ ] `loadPresetRegistry` reads `~/.config/agentwrap/presets.yaml` via the existing config helpers, fail-open on missing, fail-loud on malformed/invalid.
- [ ] `keeper agent --agentwrap-preset <name>` resolves harness/model/effort with `explicit > env > preset > yaml > native` precedence, per field.
- [ ] A head token disagreeing with the preset's harness fails loud; the harnessless form drives harness from the preset.
- [ ] `keeper agent presets resolve <name>` emits the pinned JSON contract for both a single preset and a panel array; a pi panel member fails loud.
- [ ] A cold-start guard test proves the launcher import graph never reaches `src/db.ts`.
- [ ] With no `--agentwrap-preset` passed, launcher behavior is byte-identical to today.

## Done summary

## Evidence
