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
