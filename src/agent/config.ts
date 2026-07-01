/**
 * Launcher config adapters — the dep-free island that reads the
 * `~/.config/keeper/{presets.yaml,panel.yaml,plugins.yaml}` agent launch-config.
 * YAML parsing is isolated behind one adapter (`parseYaml`) so a js-yaml swap
 * stays a one-line change. Bun.YAML targets YAML 1.2 (no `yes/no/on/off`
 * booleans); the config corpus is boolean-free.
 *
 * `plugins.yaml` supplies the Claude plugin sources (fail-loud on a missing
 * file). The preset catalog (`presets.yaml`) is the SINGLE source of a launch's
 * model/effort/thinking: it holds the named presets plus the top-level
 * `claude_default`/`codex_default`/`pi_default` pointers naming the preset a bare
 * `keeper agent <harness>` launch resolves. The panel selections (`panel.yaml`)
 * name ordered panels over those presets. All are REQUIRED + validated: a preset
 * referenced by name, a dangling `<harness>_default`, and every panel op fail-loud
 * (`ConfigError`) on a missing or invalid file — the autopilot worker is the sole
 * fail-open consumer (it catches the throw and coalesces to its constants).
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Raised for fail-loud config errors; main() prints `Error: <msg>` + exit 1. */
export class ConfigError extends Error {}

/**
 * Parse a YAML document. Returns the parsed value, or `null` for an
 * empty/whitespace document (mirroring Python's `yaml.safe_load(...) or {}`
 * coalesced by callers). Throws ConfigError on a malformed document so a
 * corrupt config is fail-loud, matching `yaml.safe_load`'s raise.
 */
export function parseYaml(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    throw new ConfigError(
      `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsed ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Expand a leading `~` to the home directory (mirrors Path.expanduser). */
export function expandUser(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function pluginConfigPath(): string {
  return join(keeperConfigDir(), "plugins.yaml");
}

/**
 * The `~/.config/keeper/` base dir both agent-launch-config files live under.
 * `KEEPER_CONFIG_DIR` overrides it — the single env seam (the test-isolation
 * lever, since os.homedir() ignores $HOME on macOS, and a production override).
 * Parallels `src/db.ts` `resolveConfigPath()` WITHOUT importing it: db.ts is the
 * SQLite island, so the launcher's dep-free import graph must never reach it.
 */
export function keeperConfigDir(): string {
  const override = process.env.KEEPER_CONFIG_DIR;
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), ".config", "keeper");
}

/** The preset catalog (`<config-dir>/presets.yaml`). */
export function presetsCatalogPath(): string {
  return join(keeperConfigDir(), "presets.yaml");
}

/** The panel selections (`<config-dir>/panel.yaml`). */
export function panelConfigPath(): string {
  return join(keeperConfigDir(), "panel.yaml");
}

function readMapping(configPath: string): Record<string, unknown> {
  const text = readFileSync(configPath, "utf8");
  const raw = parseYaml(text);
  if (raw === null) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new ConfigError(`Expected a mapping in ${configPath}`);
  }
  return raw;
}

export interface PluginSources {
  /** Each entry IS a plugin; a missing manifest is fail-loud. */
  pluginDirs: string[];
  /** Each entry is a parent whose children are scanned; missing → skipped. */
  pluginScanDirs: string[];
}

/**
 * Return `(pluginDirs, pluginScanDirs)` from plugins.yaml. Build-forward, no
 * fallback: the config ships via the `arthack` stow package, so a missing FILE
 * is fail-loud (ConfigError). Entries are `~`-expanded and resolved absolute.
 * The asymmetry between the two keys is enforced downstream (the manifest check
 * in the plugin-discovery module), not here — both are read identically.
 */
export function loadPluginSources(
  configPath: string = pluginConfigPath(),
): PluginSources {
  if (!isFile(configPath)) {
    throw new ConfigError(
      `Launcher plugin config missing at ${configPath}. ` +
        "It ships via the `arthack` stow package — run scripts/install.sh " +
        "(or restore the file) before launching.",
    );
  }
  const raw = readMapping(configPath);

  const paths = (key: string): string[] => {
    const values = raw[key] ?? [];
    if (!Array.isArray(values)) {
      throw new ConfigError(`Expected ${key} to be a list in ${configPath}`);
    }
    const out: string[] = [];
    for (const item of values) {
      if (typeof item !== "string" || !item.trim()) {
        throw new ConfigError(
          `Expected non-empty string entries in ${key} of ${configPath}`,
        );
      }
      out.push(resolvePath(expandUser(item.trim())));
    }
    return out;
  };

  return {
    pluginDirs: paths("plugin_dirs"),
    pluginScanDirs: paths("plugin_scan_dirs"),
  };
}

/** A harness the launcher can drive. */
export type PresetHarness = "claude" | "codex" | "pi";

/**
 * A named launch-config triple. `model`/`effort`/`thinking` are partial: a
 * preset that omits a field sends no override for it (the fresh-launch fail-loud
 * gate then rejects the launch unless a flag supplies it). `effort` is
 * claude/codex-only, `thinking` is pi-only (never both). `role` is an optional
 * pair-only label carried verbatim.
 */
export interface Preset {
  harness: PresetHarness;
  model: string | null;
  effort: string | null;
  thinking: string | null;
  role: string | null;
}

/**
 * The catalog of available presets, parsed from `presets.yaml`: the full set of
 * named `{harness, model?, effort?, thinking?, role?}` triples a launch may pin,
 * plus the top-level `<harness>_default` pointers naming the preset a bare
 * `keeper agent <harness>` launch resolves. Read ONLY by this dep-free config
 * island — the launcher import graph never reaches `src/db.ts`. An empty
 * `presets:` mapping is valid (worker tolerance); each `<harness>_default` is
 * optional but, when set, must name a defined preset whose harness matches.
 */
export interface PresetCatalog {
  presets: Record<string, Preset>;
  /** Preset a bare `keeper agent claude` resolves; null/absent when unset. */
  claude_default?: string | null;
  /** Preset a bare `keeper agent codex` resolves; null/absent when unset. */
  codex_default?: string | null;
  /** Preset a bare `keeper agent pi` resolves; null/absent when unset. */
  pi_default?: string | null;
}

/**
 * The panel selections, parsed from `panel.yaml`: named panels (each an ordered
 * list of catalog preset names) plus an optional `default` naming the panel a
 * bare `keeper agent panel start` (no `--panel`) assembles. Resolved against a
 * {@link PresetCatalog} — every panel member must name a catalog preset whose
 * harness is panel-launchable (claude|codex; pi is rejected at load).
 */
export interface PanelSelections {
  panels: Record<string, string[]>;
  default: string | null;
}

const PRESET_HARNESSES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "pi",
]);

/**
 * Names a preset / panel may NOT take — they would collide with a launcher
 * subcommand or with a downstream YAML-1.1 boolean re-parse. `Bun.YAML.parse`
 * is YAML 1.2 (boolean-free), but a name consumed by a 1.1 re-parser (jq,
 * another yaml lib) could silently coerce, so reserve them here.
 */
const RESERVED_PRESET_NAMES: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "pi",
  "wait-for-stop",
  "show-last-message",
  "default",
  "help",
  // YAML 1.1 booleans / null.
  "yes",
  "no",
  "on",
  "off",
  "true",
  "false",
  "null",
  "~",
]);

const PRESET_NAME_PATTERN = /^[a-z0-9_-]+$/;

function presetStringField(
  raw: Record<string, unknown>,
  key: string,
  name: string,
  configPath: string,
): string | null {
  const v = raw[key];
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v !== "string" || !v.trim()) {
    throw new ConfigError(
      `Preset '${name}' field ${key} must be a non-empty string in ${configPath}`,
    );
  }
  return v.trim();
}

function validatePresetName(name: string, configPath: string): void {
  if (!PRESET_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `Preset name '${name}' must match [a-z0-9_-]+ in ${configPath}`,
    );
  }
  if (RESERVED_PRESET_NAMES.has(name)) {
    throw new ConfigError(
      `Preset name '${name}' is reserved and cannot be used in ${configPath}`,
    );
  }
}

function parsePreset(name: string, value: unknown, configPath: string): Preset {
  if (!isRecord(value)) {
    throw new ConfigError(
      `Preset '${name}' must be a mapping in ${configPath}`,
    );
  }
  const harness = value.harness;
  if (typeof harness !== "string" || !PRESET_HARNESSES.has(harness)) {
    throw new ConfigError(
      `Preset '${name}' harness must be one of claude|codex|pi in ${configPath}`,
    );
  }
  const effort = presetStringField(value, "effort", name, configPath);
  const thinking = presetStringField(value, "thinking", name, configPath);
  if (effort !== null && thinking !== null) {
    throw new ConfigError(
      `Preset '${name}' cannot set both effort and thinking in ${configPath}`,
    );
  }
  if (thinking !== null && harness !== "pi") {
    throw new ConfigError(
      `Preset '${name}' thinking is pi-only, not ${harness} in ${configPath}`,
    );
  }
  if (effort !== null && harness === "pi") {
    throw new ConfigError(
      `Preset '${name}' effort is claude/codex-only, not pi in ${configPath}`,
    );
  }
  return {
    harness: harness as PresetHarness,
    model: presetStringField(value, "model", name, configPath),
    effort,
    thinking,
    role: presetStringField(value, "role", name, configPath),
  };
}

/** Top-level keys each file admits — anything else is a strict-reject. */
const ALLOWED_CATALOG_KEYS: ReadonlySet<string> = new Set([
  "presets",
  "claude_default",
  "codex_default",
  "pi_default",
]);
const ALLOWED_PANEL_KEYS: ReadonlySet<string> = new Set(["panels", "default"]);

/** Reject any unknown top-level key in a config mapping (no silent typos). */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  configPath: string,
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ConfigError(
        `Unknown top-level key '${key}' in ${configPath} (allowed: ${[...allowed].join(", ")})`,
      );
    }
  }
}

/**
 * Read the preset catalog from `presets.yaml`. REQUIRED + validated: a missing
 * file is fail-LOUD (ConfigError) — the reversal of the old fail-open posture. An
 * empty `presets:` mapping is still valid (the worker tolerates a catalog with no
 * presets). Also fail-loud on malformed YAML, an unknown top-level key, any
 * invalid entry (a bad harness, cross-harness effort+thinking, a reserved /
 * non-matching name), or a `<harness>_default` pointer that names no defined
 * preset or one whose harness does not match the key prefix.
 */
export function loadPresetCatalog(
  configPath: string = presetsCatalogPath(),
): PresetCatalog {
  if (!isFile(configPath)) {
    throw new ConfigError(`Preset catalog missing at ${configPath}.`);
  }
  const raw = readMapping(configPath);
  rejectUnknownKeys(raw, ALLOWED_CATALOG_KEYS, configPath);

  const presets: Record<string, Preset> = {};
  const presetsRaw = raw.presets ?? {};
  if (!isRecord(presetsRaw)) {
    throw new ConfigError(`Expected presets to be a mapping in ${configPath}`);
  }
  for (const [name, value] of Object.entries(presetsRaw)) {
    validatePresetName(name, configPath);
    presets[name] = parsePreset(name, value, configPath);
  }
  return {
    presets,
    claude_default: parseHarnessDefault(raw, "claude", presets, configPath),
    codex_default: parseHarnessDefault(raw, "codex", presets, configPath),
    pi_default: parseHarnessDefault(raw, "pi", presets, configPath),
  };
}

/**
 * Parse + strict-validate one `<harness>_default` pointer. A structural key
 * (exempt from `validatePresetName`, mirroring the panel `default` precedent): an
 * unset key is null; a present one must name a defined preset whose harness
 * matches the key prefix, else fail-loud with a message naming the file, key,
 * offending name, and expected harness (mirroring `resolvePreset`).
 */
function parseHarnessDefault(
  raw: Record<string, unknown>,
  harness: PresetHarness,
  presets: Record<string, Preset>,
  configPath: string,
): string | null {
  const key = `${harness}_default`;
  const v = raw[key];
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v !== "string" || !v.trim()) {
    throw new ConfigError(
      `${key} must be a non-empty string naming a preset in ${configPath}`,
    );
  }
  const name = v.trim();
  const preset = presets[name];
  if (preset === undefined) {
    const available = Object.keys(presets).sort();
    const list = available.length > 0 ? available.join(", ") : "(none)";
    throw new ConfigError(
      `${key} '${name}' is not a defined preset in ${configPath}. Available: ${list}`,
    );
  }
  if (preset.harness !== harness) {
    throw new ConfigError(
      `${key} '${name}' pins harness ${preset.harness}, expected ${harness} in ${configPath}`,
    );
  }
  return name;
}

/**
 * Read the panel selections from `panel.yaml`, resolved against an already-parsed
 * {@link PresetCatalog}. REQUIRED + validated: a missing file is fail-LOUD
 * (ConfigError). Each panel member must name a catalog preset whose harness is
 * panel-launchable (claude|codex — pi is rejected AT LOAD). The optional top-level
 * `default` key (a structural key, exempt from `validatePresetName` though
 * `default` is a reserved preset name) must name a defined panel. Fail-loud on
 * malformed YAML, an unknown top-level key, an empty panel list, or any of the
 * above.
 */
export function loadPanelSelections(
  catalog: PresetCatalog,
  configPath: string = panelConfigPath(),
): PanelSelections {
  if (!isFile(configPath)) {
    throw new ConfigError(`Panel selections missing at ${configPath}.`);
  }
  const raw = readMapping(configPath);
  rejectUnknownKeys(raw, ALLOWED_PANEL_KEYS, configPath);

  const panels: Record<string, string[]> = {};
  const panelsRaw = raw.panels ?? {};
  if (!isRecord(panelsRaw)) {
    throw new ConfigError(`Expected panels to be a mapping in ${configPath}`);
  }
  for (const [name, members] of Object.entries(panelsRaw)) {
    validatePresetName(name, configPath);
    if (!Array.isArray(members) || members.length === 0) {
      throw new ConfigError(
        `Panel '${name}' must be a non-empty list in ${configPath}`,
      );
    }
    const out: string[] = [];
    for (const member of members) {
      if (typeof member !== "string" || !member.trim()) {
        throw new ConfigError(
          `Panel '${name}' members must be non-empty strings in ${configPath}`,
        );
      }
      const memberName = member.trim();
      const preset = catalog.presets[memberName];
      if (preset === undefined) {
        throw new ConfigError(
          `Panel '${name}' references undefined preset '${memberName}' in ${configPath}`,
        );
      }
      if (preset.harness !== "claude" && preset.harness !== "codex") {
        throw new ConfigError(
          `Panel '${name}' member '${memberName}' pins harness ${preset.harness}, which is not panel-launchable (claude|codex only) in ${configPath}`,
        );
      }
      out.push(memberName);
    }
    panels[name] = out;
  }

  let defaultPanel: string | null = null;
  const rawDefault = raw.default;
  if (rawDefault !== undefined && rawDefault !== null) {
    if (typeof rawDefault !== "string" || !rawDefault.trim()) {
      throw new ConfigError(
        `default must be a non-empty string naming a panel in ${configPath}`,
      );
    }
    const d = rawDefault.trim();
    if (!(d in panels)) {
      throw new ConfigError(
        `default panel '${d}' is not a defined panel in ${configPath}`,
      );
    }
    defaultPanel = d;
  }

  return { panels, default: defaultPanel };
}

/**
 * Resolve a single preset by name against the catalog. Fail-loud with a specific
 * message naming the file, the requested name, and the sorted available names —
 * never a silent fallback to a default (a typo must be visible).
 */
export function resolvePreset(
  catalog: PresetCatalog,
  name: string,
  configPath: string = presetsCatalogPath(),
): Preset {
  const preset = catalog.presets[name];
  if (preset === undefined) {
    const available = Object.keys(catalog.presets).sort();
    const list = available.length > 0 ? available.join(", ") : "(none)";
    throw new ConfigError(
      `Preset '${name}' not found in ${configPath}. Available: ${list}`,
    );
  }
  return preset;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(p);
}
