/**
 * Launcher config adapters — the dep-free island that reads the
 * `~/.config/keeper/{presets.yaml,panel.yaml,plugins.yaml}` agent launch-config.
 * YAML parsing is isolated behind one adapter (`parseYaml`) so a js-yaml swap
 * stays a one-line change. Bun.YAML targets YAML 1.2 (no `yes/no/on/off`
 * booleans); the config corpus is boolean-free.
 *
 * `plugins.yaml` supplies the Claude plugin sources (fail-loud on a missing
 * file). The launch-config catalog (`presets.yaml`) holds ONLY launch triples
 * (ADR 0033): the four `<harness>_default` keys (`claude_default`/`codex_default`/
 * `pi_default`/`hermes_default`) naming the `<harness>::<model>::<effort>` triple a
 * bare `keeper agent <harness>` launch resolves, the `worker`/`escalation`
 * machine-launch triples, and the nested `dispatch:` per-verb table (ADR 0040,
 * ADDITIVE alongside `worker`/`escalation` today). The freeform named-preset
 * catalog is retired — a leftover `presets:` block fails loud with a migration
 * hint. The panel selections (`panel.yaml`) name ordered panels; the panel-member
 * resolution path (task .5) still reads a {@link Preset} shape. All files are
 * REQUIRED + validated: a missing file, a malformed triple, or a
 * `<harness>_default` whose harness disagrees with its key fail-loud
 * (`ConfigError`) — the worker/escalation/dispatch resolvers are the sole
 * fail-open consumers (they catch the throw and coalesce to their constants).
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
import { type HarnessName, harnessDescriptor } from "./harness";
import { parseTriple, type Triple } from "./triple";

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
 * A resolved launch posture the panel-member path (task .5) still reads.
 * `model`/`effort`/`thinking` are partial: an omitted field sends no override for
 * it. `effort` is claude/codex-only, `thinking` is pi-only (never both). `role` is
 * an optional pair-only label carried verbatim. The launch path derives one of
 * these from a parsed {@link Triple} via `presetFromTriple` (`src/agent/main.ts`);
 * the freeform named-preset catalog that once populated {@link
 * PresetCatalog.presets} is retired.
 */
export interface Preset {
  harness: PresetHarness;
  model: string | null;
  effort: string | null;
  thinking: string | null;
  role: string | null;
}

/**
 * The launch-config catalog parsed from `presets.yaml` (ADR 0033) — ONLY launch
 * triples: the four `<harness>_default` keys naming the triple a bare `keeper agent
 * <harness>` launch resolves, plus the `worker`/`escalation` machine-launch
 * triples. Each is an optional `<harness>::<model>::<effort>` value, parsed to a
 * {@link Triple}; a `<harness>_default` whose harness disagrees with its key
 * prefix fails loud, while `worker`/`escalation` accept any harness (the
 * autopilot/escalation resolvers warn-and-ignore a non-claude one). Read ONLY by
 * this dep-free config island — the launcher import graph never reaches
 * `src/db.ts`. `presets` is retained (always empty) for the panel-member
 * resolution path (task .5) that still resolves a {@link Preset}; the freeform
 * `presets:` block is retired and fails loud at load.
 */
export interface PresetCatalog {
  /** Retired freeform named-preset map — always empty from {@link
   *  loadPresetCatalog}; retained for the panel-member path (task .5). */
  presets: Record<string, Preset>;
  /** Triple a bare `keeper agent claude` resolves; null/absent when unset. */
  claude_default?: Triple | null;
  /** Triple a bare `keeper agent codex` resolves; null/absent when unset. */
  codex_default?: Triple | null;
  /** Triple a bare `keeper agent pi` resolves; null/absent when unset. */
  pi_default?: Triple | null;
  /** Triple a bare `keeper agent hermes` resolves; null/absent when unset. */
  hermes_default?: Triple | null;
  /** Machine worker-launch triple (`work`/`close` dispatch); any harness, the
   *  autopilot resolver warns-and-ignores a non-claude one. Null/absent = unset. */
  worker?: Triple | null;
  /** Machine escalation-launch triple; independent of `worker`, same non-claude
   *  warn-and-ignore posture. Null/absent = unset. */
  escalation?: Triple | null;
  /** The `dispatch:` per-verb launch table (ADR 0040); every {@link DispatchVerb}
   *  key present, null when unset. ADDITIVE alongside `worker`/`escalation` —
   *  this task keeps both parsing unchanged pending the task-2 cutover.
   *  Optional in the type (mirroring `worker`/`escalation`) though {@link
   *  loadPresetCatalog} always populates it. */
  dispatch?: DispatchTable;
}

/**
 * The panel selections, parsed from `panel.yaml`: named panels (each an ordered
 * list of launch-triple members `<harness>::<model>::<effort>`) plus an optional
 * `default` naming the panel a bare `keeper agent panel start` (no `--panel`)
 * assembles. Members are stored as their raw triple strings in declaration order;
 * every member's harness is panel-eligible ({@link isPanelEligibleHarness}) or the
 * load fails loud. Duplicate identical triples are legal — the launch path
 * (`resolvePanelMembers`) disambiguates them by 1-based ordinal.
 */
export interface PanelSelections {
  panels: Record<string, string[]>;
  default: string | null;
}

/**
 * Names a panel may NOT take — they would collide with a launcher
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
// never reads as a hidden file). The dot admits a dotted token like `gpt-5.5`.
// Retained for panel-name validation (`loadPanelSelections`).
const PRESET_NAME_PATTERN = /^[a-z0-9_-][a-z0-9._-]*$/;

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

/** The four `<harness>_default` catalog keys, the two retired-shape machine-launch
 *  keys (`worker`/`escalation`, still parsed unchanged pending the task-2
 *  cutover), and the `dispatch` block — the ONLY top-level keys `presets.yaml`
 *  admits (ADR 0033, ADR 0040). Anything else is a strict-reject; a legacy
 *  `presets:` block is caught with a migration hint. */
const ALLOWED_CATALOG_KEYS: ReadonlySet<string> = new Set([
  "claude_default",
  "codex_default",
  "pi_default",
  "hermes_default",
  "worker",
  "escalation",
  "dispatch",
]);
const ALLOWED_PANEL_KEYS: ReadonlySet<string> = new Set(["panels", "default"]);

/** Reject any unknown key in a config mapping (no silent typos). `label` names
 *  the offending key's kind in the error ("top-level key" for the catalog root,
 *  "dispatch verb" for the nested `dispatch:` block). */
function rejectUnknownKeys(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  configPath: string,
  label = "top-level key",
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ConfigError(
        `Unknown ${label} '${key}' in ${configPath} (allowed: ${[...allowed].join(", ")})`,
      );
    }
  }
}

/**
 * The dispatched verbs a `dispatch:` row may key on (ADR 0040): the daemon's
 * three retry-wire verbs, the three autonomous escalation verbs, and handoff.
 * `approve` resolves through the `work` row rather than carrying its own —
 * there is no eighth key. Declared here (the catalog's own schema) rather than
 * imported from `src/dispatch-command.ts`'s verb unions, keeping this dep-free
 * config island's import graph unchanged.
 */
export type DispatchVerb =
  | "work"
  | "close"
  | "resolve"
  | "unblock"
  | "deconflict"
  | "repair"
  | "handoff";

const DISPATCH_VERBS: readonly DispatchVerb[] = [
  "work",
  "close",
  "resolve",
  "unblock",
  "deconflict",
  "repair",
  "handoff",
];
const DISPATCH_VERB_SET: ReadonlySet<string> = new Set(DISPATCH_VERBS);

/** One resolved `dispatch:` triple per verb; an unset verb reads `null`. Every
 *  verb key is always present (mirrors the always-null-when-unset posture of
 *  `claude_default`/`worker`/`escalation`). */
export type DispatchTable = Record<DispatchVerb, Triple | null>;

/**
 * Parse the nested `dispatch:` block (ADR 0040): an optional mapping keyed by
 * {@link DispatchVerb}, each value an optional machine-launch triple parsed by
 * {@link parseMachineTriple} (harness-unchecked, same posture as `worker`/
 * `escalation`). Strict unknown-key rejection inside the block via the same
 * {@link rejectUnknownKeys} discipline as the catalog root. An absent/null
 * `dispatch` key returns every verb null (ADDITIVE alongside `worker`/
 * `escalation`; the task-2 cutover retires those keys, not this task).
 */
function parseDispatchBlock(
  raw: Record<string, unknown>,
  configPath: string,
): DispatchTable {
  const table = Object.fromEntries(
    DISPATCH_VERBS.map((verb) => [verb, null]),
  ) as DispatchTable;
  const value = raw.dispatch;
  if (value === null || value === undefined) {
    return table;
  }
  if (!isRecord(value)) {
    throw new ConfigError(`dispatch must be a mapping in ${configPath}`);
  }
  rejectUnknownKeys(value, DISPATCH_VERB_SET, configPath, "dispatch verb");
  for (const verb of DISPATCH_VERBS) {
    table[verb] = parseMachineTriple(value, verb, configPath);
  }
  return table;
}

/**
 * Read the launch-config catalog from `presets.yaml` (ADR 0033, ADR 0040). REQUIRED
 * + validated: a missing file is fail-LOUD (ConfigError). The file holds ONLY launch
 * triples — the four `<harness>_default` keys, the `worker`/`escalation`
 * machine-launch keys, and the nested `dispatch:` per-verb table (each an optional
 * `<harness>::<model>::<effort>` string). `dispatch` is ADDITIVE alongside
 * `worker`/`escalation` today — both still parse unchanged; a future cutover
 * retires the pair with a migration hint. A leftover freeform `presets:` block
 * fails loud with a migration hint; any other unknown key (including an unknown
 * `dispatch` verb) is a strict-reject; a malformed triple or a `<harness>_default`
 * whose harness disagrees with its key prefix is fail-loud. An empty/whitespace
 * file is a valid empty catalog (every key null). `presets` is always empty —
 * retained for the panel-member path (task .5).
 */
export function loadPresetCatalog(
  configPath: string = presetsCatalogPath(),
): PresetCatalog {
  if (!isFile(configPath)) {
    throw new ConfigError(`Preset catalog missing at ${configPath}.`);
  }
  const raw = readMapping(configPath);
  if ("presets" in raw) {
    throw new ConfigError(
      `The freeform 'presets:' catalog is retired (ADR 0033) in ${configPath}. ` +
        `presets.yaml now holds only launch triples: the four <harness>_default ` +
        `keys plus worker and escalation, each a '<harness>::<model>::<effort>' ` +
        `string. See 'keeper agent presets list'.`,
    );
  }
  rejectUnknownKeys(raw, ALLOWED_CATALOG_KEYS, configPath);

  return {
    presets: {},
    claude_default: parseDefaultTriple(raw, "claude", configPath),
    codex_default: parseDefaultTriple(raw, "codex", configPath),
    pi_default: parseDefaultTriple(raw, "pi", configPath),
    hermes_default: parseDefaultTriple(raw, "hermes", configPath),
    worker: parseMachineTriple(raw, "worker", configPath),
    escalation: parseMachineTriple(raw, "escalation", configPath),
    dispatch: parseDispatchBlock(raw, configPath),
  };
}

/** Read a raw catalog value as a required non-empty triple STRING, or null when
 *  the key is unset. A present-but-non-string / empty value is fail-loud. */
function tripleStringField(
  raw: Record<string, unknown>,
  key: string,
  configPath: string,
): string | null {
  const v = raw[key];
  if (v === null || v === undefined) {
    return null;
  }
  if (typeof v !== "string" || !v.trim()) {
    throw new ConfigError(
      `${key} must be a non-empty '<harness>::<model>::<effort>' triple string in ${configPath}`,
    );
  }
  return v.trim();
}

/**
 * Parse + strict-validate one `<harness>_default` launch triple. An unset key is
 * null; a present one must be a well-formed triple (`parseTriple`) whose harness
 * matches the key prefix, else fail-loud naming the file, key, and the offending
 * segment/harness.
 */
function parseDefaultTriple(
  raw: Record<string, unknown>,
  harness: HarnessName,
  configPath: string,
): Triple | null {
  const key = `${harness}_default`;
  const value = tripleStringField(raw, key, configPath);
  if (value === null) {
    return null;
  }
  const parsed = parseTriple(value);
  if (!parsed.ok) {
    throw new ConfigError(`${key} in ${configPath}: ${parsed.error}`);
  }
  if (parsed.triple.harness !== harness) {
    throw new ConfigError(
      `${key} '${value}' pins harness ${parsed.triple.harness}, expected ${harness} in ${configPath}`,
    );
  }
  return parsed.triple;
}

/**
 * Parse one machine-launch triple (`worker`/`escalation`, or a `dispatch:` verb
 * row). An unset key is null; a present one must be a well-formed triple
 * (fail-loud on malformed — the resolvers swallow the throw to their constants),
 * but its harness is UNCHECKED here: the autopilot / escalation / dispatch
 * resolvers accept any harness and warn-and-ignore a non-claude one.
 */
function parseMachineTriple(
  raw: Record<string, unknown>,
  key: string,
  configPath: string,
): Triple | null {
  const value = tripleStringField(raw, key, configPath);
  if (value === null) {
    return null;
  }
  const parsed = parseTriple(value);
  if (!parsed.ok) {
    throw new ConfigError(`${key} in ${configPath}: ${parsed.error}`);
  }
  return parsed.triple;
}

/**
 * True when a harness may serve as a panel member: its final message is capturable
 * (a panel leg must read a verdict) AND it exposes a second reasoning axis (an
 * axisless harness has no effort/thinking rung to compare, so it is not a panel
 * comparand — panels are claude/codex/pi). The SINGLE eligibility predicate both
 * the load gate ({@link loadPanelSelections}) and the launch gate (panel.ts
 * `resolvePanelMembers`) read, so panel eligibility can never drift between them.
 */
export function isPanelEligibleHarness(name: string): boolean {
  const d = harnessDescriptor(name);
  if (d === undefined) {
    return false;
  }
  return d.capturable && d.secondAxis !== "none";
}

/**
 * Read the panel selections from `panel.yaml`. REQUIRED + validated: a missing file
 * is fail-LOUD (ConfigError). Each panel is an ordered list of launch-triple members
 * (`<harness>::<model>::<effort>`) parsed with the shared grammar — a malformed
 * triple is fail-loud naming the panel and the offending member. Every member's
 * harness must be panel-eligible ({@link isPanelEligibleHarness}: capturable AND
 * carrying a reasoning axis; claude/codex/pi qualify, an axisless harness is rejected
 * AT LOAD, the same predicate the launch path re-checks). Duplicate identical triples
 * are legal (the launch path disambiguates by ordinal). The optional top-level
 * `default` key (a structural key, exempt from `validatePresetName` though `default`
 * is a reserved preset name) must name a defined panel. Fail-loud on malformed YAML,
 * an unknown top-level key, an empty panel list, or any of the above.
 */
export function loadPanelSelections(
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
      const triple = member.trim();
      const parsed = parseTriple(triple);
      if (!parsed.ok) {
        throw new ConfigError(
          `Panel '${name}' member '${triple}' is not a valid launch triple: ${parsed.error} (in ${configPath})`,
        );
      }
      if (!isPanelEligibleHarness(parsed.triple.harness)) {
        throw new ConfigError(
          `Panel '${name}' member '${triple}' pins harness ${parsed.triple.harness}, which is not panel-eligible (panels compare a reasoning axis — claude/codex/pi only) in ${configPath}`,
        );
      }
      out.push(triple);
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
