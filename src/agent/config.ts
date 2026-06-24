/**
 * Launcher config adapters — the
 * `~/.config/agentwrap/{claude,codex,pi,plugins}.yaml`
 * readers. YAML parsing is isolated behind one adapter (`parseYaml`) so a
 * js-yaml swap stays a one-line change. Bun.YAML targets YAML 1.2 (no
 * `yes/no/on/off` booleans); the config corpus is boolean-free.
 *
 * `claude.yaml` and `codex.yaml` supply `model`/`effort` startup defaults;
 * `pi.yaml` supplies Pi's `model`/`thinking` startup defaults (fail-open: a
 * missing key or file sends no override). `plugins.yaml` supplies the Claude
 * plugin sources (fail-loud on a missing file). Each reader documents its own
 * absence semantics below.
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

export function launcherConfigPath(): string {
  return join(homedir(), ".config", "agentwrap", "claude.yaml");
}

export function codexConfigPath(): string {
  return join(homedir(), ".config", "agentwrap", "codex.yaml");
}

export function piLauncherConfigPath(): string {
  return join(homedir(), ".config", "agentwrap", "pi.yaml");
}

export function pluginConfigPath(): string {
  return join(homedir(), ".config", "agentwrap", "plugins.yaml");
}

export function presetsConfigPath(): string {
  return join(homedir(), ".config", "agentwrap", "presets.yaml");
}

export interface LauncherDefaults {
  model: string | null;
  effort: string | null;
}

export interface PiLauncherDefaults {
  model: string | null;
  thinking: string | null;
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

/**
 * Return `(model, effort)` for the startup CLI overrides. Fail-open on absence:
 * a missing config file or unset key yields null for that field (Claude then
 * uses its own settings). A key that IS present must be a non-empty string; a
 * malformed value is fail-loud (ConfigError).
 */
export function loadLauncherDefaults(
  configPath: string = launcherConfigPath(),
): LauncherDefaults {
  if (!isFile(configPath)) {
    return { model: null, effort: null };
  }
  const raw = readMapping(configPath);

  const value = (key: string): string | null => {
    const v = raw[key];
    if (v === null || v === undefined) {
      return null;
    }
    if (typeof v !== "string" || !v.trim()) {
      throw new ConfigError(
        `Expected ${key} to be a non-empty string in ${configPath}`,
      );
    }
    return v.trim();
  };

  return { model: value("model"), effort: value("effort") };
}

/**
 * Return `(model, thinking)` for Pi startup CLI overrides. Fail-open on absence:
 * a missing config file or unset key yields null for that field (Pi then uses
 * its own settings). A key that IS present must be a non-empty string; a
 * malformed value is fail-loud (ConfigError).
 */
export function loadPiLauncherDefaults(
  configPath: string = piLauncherConfigPath(),
): PiLauncherDefaults {
  if (!isFile(configPath)) {
    return { model: null, thinking: null };
  }
  const raw = readMapping(configPath);

  const value = (key: string): string | null => {
    const v = raw[key];
    if (v === null || v === undefined) {
      return null;
    }
    if (typeof v !== "string" || !v.trim()) {
      throw new ConfigError(
        `Expected ${key} to be a non-empty string in ${configPath}`,
      );
    }
    return v.trim();
  };

  return { model: value("model"), thinking: value("thinking") };
}

export function loadClaudeStowDir(
  configPath: string = launcherConfigPath(),
): string | null {
  if (!isFile(configPath)) {
    return null;
  }
  const raw = readMapping(configPath);
  const v = raw.claude_stow_dir;
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v !== "string" || !v.trim()) {
    throw new ConfigError(
      `Expected claude_stow_dir to be a non-empty string in ${configPath}`,
    );
  }
  return resolvePath(expandUser(v.trim()));
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
 * preset that omits a field layers OVER the per-harness yaml rather than
 * replacing it. `effort` is claude/codex-only, `thinking` is pi-only (never
 * both). `role` is an optional pair-only label carried verbatim.
 */
export interface Preset {
  harness: PresetHarness;
  model: string | null;
  effort: string | null;
  thinking: string | null;
  role: string | null;
}

/**
 * The single launch-config registry parsed from `presets.yaml`: named presets
 * plus named panels (each an ordered list of preset names). Read ONLY by this
 * dep-free config island — the launcher import graph never reaches `src/db.ts`.
 */
export interface PresetRegistry {
  presets: Record<string, Preset>;
  panels: Record<string, string[]>;
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

/**
 * Read the named-preset registry from `presets.yaml`. Fail-OPEN on a missing
 * file (an empty registry — presets are recommended, never mandatory), and
 * fail-LOUD (ConfigError) on malformed YAML or any invalid entry: a bad
 * harness, cross-harness effort+thinking, a reserved / non-matching name, or a
 * panel member that references no defined preset.
 */
export function loadPresetRegistry(
  configPath: string = presetsConfigPath(),
): PresetRegistry {
  if (!isFile(configPath)) {
    return { presets: {}, panels: {} };
  }
  const raw = readMapping(configPath);

  const presets: Record<string, Preset> = {};
  const presetsRaw = raw.presets ?? {};
  if (!isRecord(presetsRaw)) {
    throw new ConfigError(`Expected presets to be a mapping in ${configPath}`);
  }
  for (const [name, value] of Object.entries(presetsRaw)) {
    validatePresetName(name, configPath);
    presets[name] = parsePreset(name, value, configPath);
  }

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
      if (!(memberName in presets)) {
        throw new ConfigError(
          `Panel '${name}' references undefined preset '${memberName}' in ${configPath}`,
        );
      }
      out.push(memberName);
    }
    panels[name] = out;
  }

  return { presets, panels };
}

/**
 * Resolve a single preset by name. Fail-loud with a specific message naming the
 * file, the requested name, and the available names — never a silent fallback to
 * a default (a typo must be visible).
 */
export function resolvePreset(
  registry: PresetRegistry,
  name: string,
  configPath: string = presetsConfigPath(),
): Preset {
  const preset = registry.presets[name];
  if (preset === undefined) {
    const available = Object.keys(registry.presets);
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
