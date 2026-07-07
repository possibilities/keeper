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
 * `<harness>_default` pointers (`claude_default`/`codex_default`/`pi_default`/
 * `hermes_default`) naming the preset a bare `keeper agent <harness>` launch
 * resolves. The panel selections (`panel.yaml`)
 * name ordered panels over those presets. All are REQUIRED + validated: a preset
 * referenced by name, a dangling `<harness>_default`, and every panel op fail-loud
 * (`ConfigError`) on a missing or invalid file — the autopilot worker is the sole
 * fail-open consumer (it catches the throw and coalesces to its constants).
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  HARNESS_DESCRIPTORS,
  HARNESS_NAME_SET,
  HARNESS_NAMES,
  type HarnessName,
  isCapturableHarness,
} from "./harness";
import { loadMatrix, type Matrix, presetNameFor } from "./matrix";

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
  /**
   * Worker plugin-isolation policy from the `worker_plugin_isolation` key.
   * `true` when set to `strip-scan-dirs`: a keeper-automated (human-less) worker
   * claude launch drops the `plugin_scan_dirs` RESULTS from its argv, loading
   * only the hard-listed `plugin_dirs` (keeper + plan) plus its additive per-cell
   * `--plugin-dir`. NEVER strips the `plugin_dirs` a machine explicitly hard-lists,
   * and NEVER touches interactive launches. Absent / `off` → `false` (the default:
   * every launch inherits the full scan set, byte-identical to an ungated launch).
   * This is launch config, not reconciler state — it lives here, never in
   * `autopilot_state`. The seam (`agent/main.ts`) resolves it against worker-ness;
   * `discoverPlugins` obeys the resolved decision, not this field.
   */
  workerPluginIsolation?: boolean;
}

/**
 * The keeper-only default `plugins.yaml` written by scripts/install.sh (via the
 * `ensure-plugin-config` bridge) when no file exists — keeper's own two plugins
 * and NO arthack scan dirs, so `keeper agent` launches on a machine with no
 * arthack checkout. This module is the SINGLE source of the body; install.sh
 * emits it verbatim rather than embedding a divergent copy.
 */
export const DEFAULT_PLUGINS_YAML = `# Default keeper-owned Claude plugin sources for the \`keeper agent\` launcher.
# scripts/install.sh writes this (from DEFAULT_PLUGINS_YAML in
# src/agent/config.ts) when no ~/.config/keeper/plugins.yaml exists; an existing
# file or symlink is left byte-untouched. No arthack scan dirs — a fresh machine
# needs only keeper's own two plugins.
#
# Each entry IS a plugin (carries .claude-plugin/plugin.json) and is a hard
# dependency: a missing manifest is fail-loud. \`~\` is expanded.
plugin_dirs:
  - ~/code/keeper/plugins/keeper  # keeper: hook + \`keeper:\` NL skills
  - ~/code/keeper/plugins/plan    # plan: \`/plan:*\` NL skills
`;

/**
 * True when an entry already exists at `path` — a regular file, a directory, OR
 * a symlink, INCLUDING a dangling one (lstat, never stat, so a pointer at a
 * since-removed target still reads as present). The installer's never-clobber
 * gate: an existing machine keeps whatever it has.
 */
export function pluginConfigEntryExists(
  path: string = pluginConfigPath(),
): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write keeper's default `plugins.yaml` when — and ONLY when — no entry exists
 * at `path` (see {@link pluginConfigEntryExists}: a symlink, even dangling,
 * counts as present). Returns `"written"` on a fresh write, `"exists"` when it
 * left an existing file/symlink byte-untouched. Creates the parent dir as
 * needed. Idempotent: safe to re-run from install.sh / CI on every build.
 */
export function ensureDefaultPluginConfig(
  path: string = pluginConfigPath(),
  content: string = DEFAULT_PLUGINS_YAML,
): "written" | "exists" {
  if (pluginConfigEntryExists(path)) {
    return "exists";
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return "written";
}

/**
 * Return `(pluginDirs, pluginScanDirs)` from plugins.yaml. Build-forward, no
 * fallback: a missing FILE is fail-loud (ConfigError) — scripts/install.sh
 * writes keeper's {@link DEFAULT_PLUGINS_YAML} on a fresh machine. Entries are
 * `~`-expanded and resolved absolute. The asymmetry between the two keys is
 * enforced downstream (the manifest check in the plugin-discovery module), not
 * here — both are read identically.
 */
export function loadPluginSources(
  configPath: string = pluginConfigPath(),
): PluginSources {
  if (!isFile(configPath)) {
    throw new ConfigError(
      `Launcher plugin config missing at ${configPath}. ` +
        "Run keeper's scripts/install.sh to write the default, or create " +
        `${configPath} with a plugin_dirs list before launching.`,
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
    workerPluginIsolation: parseWorkerPluginIsolation(raw, configPath),
  };
}

/**
 * Parse the `worker_plugin_isolation` knob (a string, not a boolean — the config
 * corpus is boolean-free). Absent / null / `off` → `false`; `strip-scan-dirs` →
 * `true`; any other value is fail-loud (a typo must be visible, never a silent
 * off). The mode name states the boundary: only `plugin_scan_dirs` RESULTS are
 * stripped, never the explicitly hard-listed `plugin_dirs`.
 */
function parseWorkerPluginIsolation(
  raw: Record<string, unknown>,
  configPath: string,
): boolean {
  const value = raw.worker_plugin_isolation;
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value !== "string") {
    throw new ConfigError(
      `worker_plugin_isolation must be a string (off | strip-scan-dirs) in ${configPath}`,
    );
  }
  const mode = value.trim();
  if (mode === "strip-scan-dirs") {
    return true;
  }
  if (mode === "off" || mode === "") {
    return false;
  }
  throw new ConfigError(
    `worker_plugin_isolation '${mode}' is not a valid mode in ${configPath} (allowed: off, strip-scan-dirs)`,
  );
}

/** A harness the launcher can drive — derived from the harness registry
 *  (`src/agent/harness.ts`) so the name set lives in exactly one place. */
export type PresetHarness = HarnessName;

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
  /** Preset a bare `keeper agent hermes` resolves; null/absent when unset. */
  hermes_default?: string | null;
}

/**
 * The panel selections, parsed from `panel.yaml`: named panels (each an ordered
 * list of catalog preset names) plus an optional `default` naming the panel a
 * bare `keeper agent panel start` (no `--panel`) assembles. Resolved against a
 * {@link PresetCatalog} — every panel member must name a catalog preset whose
 * harness is panel-eligible (its descriptor is `capturable`; claude/codex/pi all
 * qualify, a future non-capturable harness is rejected at load).
 */
export interface PanelSelections {
  panels: Record<string, string[]>;
  default: string | null;
}

const PRESET_HARNESSES: ReadonlySet<string> = HARNESS_NAME_SET;

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
  "hermes",
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

// Lowercase alnum, hyphen, underscore, dot — with no LEADING dot (so a name
// never reads as a hidden file). The dot admits a dotted capability token like
// `gpt-5.5` inside an auto-generated `<provider>-<model>` preset name.
const PRESET_NAME_PATTERN = /^[a-z0-9_-][a-z0-9._-]*$/;

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
      `Preset name '${name}' must match [a-z0-9._-] with no leading dot in ${configPath}`,
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
      `Preset '${name}' harness must be one of ${HARNESS_NAMES.join("|")} in ${configPath}`,
    );
  }
  const effort = presetStringField(value, "effort", name, configPath);
  const thinking = presetStringField(value, "thinking", name, configPath);
  if (effort !== null && thinking !== null) {
    throw new ConfigError(
      `Preset '${name}' cannot set both effort and thinking in ${configPath}`,
    );
  }
  // The second-reasoning-axis gate reads the descriptor's `secondAxis` (never a
  // harness-name literal): a preset may set only the axis its harness exposes. A
  // model-only harness (hermes, `secondAxis: "none"`) accepts neither.
  const descriptor = HARNESS_DESCRIPTORS[harness as PresetHarness];
  if (thinking !== null && descriptor.secondAxis !== "thinking") {
    throw new ConfigError(
      `Preset '${name}' thinking is pi-only, not ${harness} in ${configPath}`,
    );
  }
  if (effort !== null && descriptor.secondAxis !== "effort") {
    throw new ConfigError(
      `Preset '${name}' effort is claude/codex-only, not ${harness} in ${configPath}`,
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
  "hermes_default",
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
 *
 * The parsed catalog is then augmented IN MEMORY with one auto-generated
 * `<provider>-<model>` preset per host-matrix roster pair (ADR 0010) — nothing is
 * ever written back to presets.yaml. `matrix` defaults to the host
 * `matrix.yaml`; an absent matrix (null) leaves the catalog byte-identical to the
 * hand-authored file. Pass `matrix` explicitly (including `null`) to load the raw
 * hand-authored catalog without the roster augmentation.
 */
export function loadPresetCatalog(
  configPath: string = presetsCatalogPath(),
  matrix: Matrix | null = loadMatrix(),
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
  // Merge the host-matrix roster cells BEFORE the `<harness>_default` pointers
  // resolve, so a pointer may name an auto-generated preset.
  augmentCatalogWithMatrix(presets, matrix, configPath);
  return {
    presets,
    claude_default: parseHarnessDefault(raw, "claude", presets, configPath),
    codex_default: parseHarnessDefault(raw, "codex", presets, configPath),
    pi_default: parseHarnessDefault(raw, "pi", presets, configPath),
    hermes_default: parseHarnessDefault(raw, "hermes", presets, configPath),
  };
}

/**
 * Augment the parsed catalog in memory with one `<provider>-<model>` preset per
 * host-matrix roster pair (ADR 0010). Each auto-preset pins the roster provider's
 * harness and the model's provider-native id, carrying NO effort/thinking — the
 * second reasoning axis arrives per-run through the descriptor map, never baked
 * here. Absent matrix (null) → no-op, the catalog stays byte-identical. An
 * auto-generated name colliding with a hand-authored preset OR a reserved name is
 * fail-loud, so the operator renames rather than silently shadowing a roster
 * cell. Auto-names are globally unique (a distinct provider × model pair each), so
 * no auto-vs-auto collision is possible — those two guarded cases are the only
 * ones.
 */
function augmentCatalogWithMatrix(
  presets: Record<string, Preset>,
  matrix: Matrix | null,
  configPath: string,
): void {
  if (matrix === null) {
    return;
  }
  for (const provider of matrix.providers) {
    for (const [capability, nativeId] of provider.models) {
      const name = presetNameFor(provider.name, capability);
      if (RESERVED_PRESET_NAMES.has(name)) {
        throw new ConfigError(
          `Auto-generated preset '${name}' (matrix provider ${provider.name}, model ${capability}) is a reserved name in ${configPath}.`,
        );
      }
      if (name in presets) {
        throw new ConfigError(
          `Auto-generated preset '${name}' (matrix provider ${provider.name}, model ${capability}) collides with a hand-authored preset in ${configPath} — rename the hand-authored preset.`,
        );
      }
      presets[name] = {
        harness: provider.name,
        model: nativeId,
        effort: null,
        thinking: null,
        role: null,
      };
    }
  }
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
 * panel-eligible — its descriptor is `capturable` (claude/codex/pi all qualify; a
 * future non-capturable harness is rejected AT LOAD). The optional top-level
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
      // Panel eligibility is a descriptor CAPABILITY (`capturable`), never a
      // harness-name allowlist: a member's final message must be capturable for a
      // panel leg to read its verdict. pi is capturable, so a pi member is valid;
      // a future non-capturable harness (hermes before M2) is rejected here.
      if (!isCapturableHarness(preset.harness)) {
        throw new ConfigError(
          `Panel '${name}' member '${memberName}' pins harness ${preset.harness}, which is not panel-eligible (its final message is not capturable) in ${configPath}`,
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
