/**
 * The host-level provider matrix — the dep-free config-island loader for
 * `~/.config/keeper/matrix.yaml` (ADR 0010). The matrix grows the worker model
 * axis beyond claude: an ordered provider roster (the cost-ascending pecking
 * order), each provider a harness serving a set of capability models with
 * optional native-id aliases, plus the effort axis, the worker template list, the
 * wrapper driver, and additive dispatch defaults. Membership under the `claude`
 * provider makes a model native (it runs in-session); every other model is
 * wrapped (its worker delegates to a run-time-resolved provider).
 *
 * An ABSENT (or empty) file returns null so callers fall back to their embedded
 * claude-only defaults — today's behavior stays byte-identical. A present file
 * with content is fail-loud (ConfigError) on any malformed / ambiguous shape.
 *
 * DEP-FREE ISLAND: imports only the sibling config island (`./config`,
 * `./harness`) + `node:*` — never `src/db.ts` (bun:sqlite). Read producer-side,
 * re-parsed per call (no watcher, so an edit lands without a daemon bounce), and
 * NEVER a fold input.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, keeperConfigDir, parseYaml } from "./config";
import {
  HARNESS_DESCRIPTORS,
  HARNESS_NAMES,
  type HarnessName,
  isHarnessName,
} from "./harness";

/** claude is the native provider; every other roster provider is a wrapper. */
export type Driver = "native" | "wrapped";

/** One roster provider: a harness name plus the capability→native-id map of the
 *  models it serves (native id === capability when the entry carries no alias).
 *  The Map preserves declaration order for stable rendering. */
export interface MatrixProvider {
  name: HarnessName;
  /** capability token → provider-native id, in declaration order. */
  models: Map<string, string>;
}

/** The fixed claude model-and-effort every wrapped cell's wrapper runs at. */
export interface WrapperDriver {
  model: string;
  effort: string;
}

/** Additive dispatch defaults (present-but-defaulted when the block is absent). */
export interface MatrixDefaults {
  stop_timeout_ms: number;
  max_attempts: number;
}

/** The parsed host matrix. `providers` order IS the cost-ascending pecking order
 *  a wrapped cell resolves through at run time. */
export interface Matrix {
  efforts: string[];
  providers: MatrixProvider[];
  subagents: string[];
  wrapper_driver: WrapperDriver;
  defaults: MatrixDefaults;
}

/** The additive-defaults fallbacks (task-spec fixed: 2h stop, 2 attempts). */
export const DEFAULT_STOP_TIMEOUT_MS = 7_200_000;
export const DEFAULT_MAX_ATTEMPTS = 2;

/** The matrix config path under the (KEEPER_CONFIG_DIR-overridable) config dir. */
export function matrixConfigPath(): string {
  return join(keeperConfigDir(), "matrix.yaml");
}

/**
 * The widened matrix name charset: lowercase alnum, hyphen, underscore, dot —
 * with no leading dot. Widened from the preset-name pattern (`[a-z0-9_-]+`) by
 * admitting `.` so a dotted capability id like `gpt-5.5` is a valid token.
 */
export function isValidMatrixToken(token: string): boolean {
  return /^[a-z0-9._-]+$/.test(token) && !token.startsWith(".");
}

/**
 * The alias-TARGET charset: one or more strict matrix tokens joined by `/`, so a
 * provider-qualified native id like `openai/gpt-5.5` is expressible. RELAXED past
 * {@link isValidMatrixToken} for the alias TARGET ONLY — the native id a
 * capability resolves to, which providers-resolve carries verbatim to the launch
 * model flag as pass-through. Every `/`-segment stays strictly validated (no empty
 * segment, no leading dot, no path escape), and alias KEYS + axis tokens stay
 * strict: the split keeps a slashed token out of any preset / cell / file name.
 */
export function isValidMatrixAliasTarget(token: string): boolean {
  return token.length > 0 && token.split("/").every(isValidMatrixToken);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const ALLOWED_MATRIX_KEYS: ReadonlySet<string> = new Set([
  "efforts",
  "providers",
  "subagents",
  "wrapper_driver",
  "defaults",
]);

/**
 * Read the host matrix from `matrix.yaml`. An ABSENT or empty/whitespace file
 * returns null (the caller falls back to embedded claude-only defaults); a file
 * with content is fail-loud (ConfigError) on malformed YAML, an unknown top-level
 * key, a provider name not in the harness registry, a model served by claude AND
 * another provider (ambiguous driver), or any token violating the name charset.
 */
export function loadMatrix(
  configPath: string = matrixConfigPath(),
): Matrix | null {
  if (!fileExists(configPath)) {
    return null;
  }
  const raw = parseYaml(readFileSync(configPath, "utf8"));
  if (raw === null) {
    // Empty/whitespace is as good as absent → null (fall back), never a
    // half-built matrix missing its required axes.
    return null;
  }
  if (!isRecord(raw)) {
    throw new ConfigError(`Expected a mapping in ${configPath}`);
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_MATRIX_KEYS.has(key)) {
      throw new ConfigError(
        `Unknown top-level key '${key}' in ${configPath} (allowed: ${[...ALLOWED_MATRIX_KEYS].join(", ")})`,
      );
    }
  }
  const providers = parseProviders(raw.providers, configPath);
  assertNoClaudeOverlap(providers, configPath);
  return {
    efforts: parseTokenList(raw.efforts, "efforts", configPath),
    providers,
    subagents: parseTokenList(raw.subagents, "subagents", configPath),
    wrapper_driver: parseWrapperDriver(raw.wrapper_driver, configPath),
    defaults: parseDefaults(raw.defaults, configPath),
  };
}

function parseTokenList(
  value: unknown,
  key: string,
  configPath: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(`${key} must be a non-empty list in ${configPath}`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isValidMatrixToken(item)) {
      throw new ConfigError(
        `${key} entries must be tokens matching [a-z0-9._-] with no leading dot in ${configPath} (got ${JSON.stringify(item)})`,
      );
    }
    out.push(item);
  }
  return out;
}

function parseProviders(value: unknown, configPath: string): MatrixProvider[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(
      `providers must be a non-empty list in ${configPath}`,
    );
  }
  const seen = new Set<string>();
  const providers: MatrixProvider[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new ConfigError(
        `each providers entry must be a {name, models} mapping in ${configPath}`,
      );
    }
    for (const k of Object.keys(entry)) {
      if (k !== "name" && k !== "models") {
        throw new ConfigError(
          `unknown provider key '${k}' in ${configPath} (allowed: name, models)`,
        );
      }
    }
    const name = entry.name;
    if (typeof name !== "string" || !isHarnessName(name)) {
      throw new ConfigError(
        `provider name must be one of ${HARNESS_NAMES.join("|")} in ${configPath} (got ${JSON.stringify(name)})`,
      );
    }
    if (seen.has(name)) {
      throw new ConfigError(
        `provider '${name}' is listed more than once in ${configPath}`,
      );
    }
    seen.add(name);
    providers.push({
      name,
      models: parseProviderModels(entry.models, name, configPath),
    });
  }
  return providers;
}

function parseProviderModels(
  value: unknown,
  provider: string,
  configPath: string,
): Map<string, string> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigError(
      `provider '${provider}' models must be a non-empty list in ${configPath}`,
    );
  }
  const models = new Map<string, string>();
  for (const item of value) {
    let capability: string;
    let nativeId: string;
    if (typeof item === "string") {
      capability = item;
      nativeId = item;
    } else if (isRecord(item)) {
      const pairs = Object.entries(item);
      if (pairs.length !== 1) {
        throw new ConfigError(
          `provider '${provider}' model alias must be a single 'capability: native-id' pair in ${configPath}`,
        );
      }
      const [cap, nid] = pairs[0] as [string, unknown];
      capability = cap;
      if (typeof nid !== "string") {
        throw new ConfigError(
          `provider '${provider}' alias '${cap}' native id must be a string in ${configPath}`,
        );
      }
      nativeId = nid;
    } else {
      throw new ConfigError(
        `provider '${provider}' model entry must be a token or a one-pair alias map in ${configPath}`,
      );
    }
    if (!isValidMatrixToken(capability)) {
      throw new ConfigError(
        `provider '${provider}' model token '${capability}' must match [a-z0-9._-] with no leading dot in ${configPath}`,
      );
    }
    if (!isValidMatrixAliasTarget(nativeId)) {
      throw new ConfigError(
        `provider '${provider}' native id '${nativeId}' must be '/'-joined [a-z0-9._-] segments (no leading dot, no empty segment) in ${configPath}`,
      );
    }
    if (models.has(capability)) {
      throw new ConfigError(
        `provider '${provider}' lists model '${capability}' more than once in ${configPath}`,
      );
    }
    models.set(capability, nativeId);
  }
  return models;
}

function parseWrapperDriver(value: unknown, configPath: string): WrapperDriver {
  if (!isRecord(value)) {
    throw new ConfigError(
      `wrapper_driver must be a {model, effort} mapping in ${configPath}`,
    );
  }
  for (const k of Object.keys(value)) {
    if (k !== "model" && k !== "effort") {
      throw new ConfigError(
        `unknown wrapper_driver key '${k}' in ${configPath} (allowed: model, effort)`,
      );
    }
  }
  const model = value.model;
  const effort = value.effort;
  if (typeof model !== "string" || !isValidMatrixToken(model)) {
    throw new ConfigError(
      `wrapper_driver.model must be a valid token in ${configPath}`,
    );
  }
  if (typeof effort !== "string" || !isValidMatrixToken(effort)) {
    throw new ConfigError(
      `wrapper_driver.effort must be a valid token in ${configPath}`,
    );
  }
  return { model, effort };
}

function parseDefaults(value: unknown, configPath: string): MatrixDefaults {
  if (value === null || value === undefined) {
    return {
      stop_timeout_ms: DEFAULT_STOP_TIMEOUT_MS,
      max_attempts: DEFAULT_MAX_ATTEMPTS,
    };
  }
  if (!isRecord(value)) {
    throw new ConfigError(`defaults must be a mapping in ${configPath}`);
  }
  for (const k of Object.keys(value)) {
    if (k !== "stop_timeout_ms" && k !== "max_attempts") {
      throw new ConfigError(
        `unknown defaults key '${k}' in ${configPath} (allowed: stop_timeout_ms, max_attempts)`,
      );
    }
  }
  return {
    stop_timeout_ms: parsePositiveInt(
      value.stop_timeout_ms,
      "stop_timeout_ms",
      DEFAULT_STOP_TIMEOUT_MS,
      configPath,
    ),
    max_attempts: parsePositiveInt(
      value.max_attempts,
      "max_attempts",
      DEFAULT_MAX_ATTEMPTS,
      configPath,
    ),
  };
}

function parsePositiveInt(
  value: unknown,
  key: string,
  fallback: number,
  configPath: string,
): number {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `defaults.${key} must be a positive integer in ${configPath}`,
    );
  }
  return value;
}

/**
 * A model served by claude AND another provider is an ambiguous driver (native
 * vs wrapped) — fail-loud. Two NON-claude providers sharing a model is allowed
 * and intended: that overlap is exactly what the pecking order arbitrates.
 */
function assertNoClaudeOverlap(
  providers: MatrixProvider[],
  configPath: string,
): void {
  const claude = providers.find((p) => p.name === "claude");
  if (claude === undefined) {
    return;
  }
  for (const p of providers) {
    if (p.name === "claude") {
      continue;
    }
    for (const model of p.models.keys()) {
      if (claude.models.has(model)) {
        throw new ConfigError(
          `model '${model}' is served by both claude and ${p.name} in ${configPath} — ambiguous driver (a model is native XOR wrapped)`,
        );
      }
    }
  }
}

// ── pure derivations ─────────────────────────────────────────────────────────

/** claude membership → native; every other model (INCLUDING one absent from the
 *  roster) → wrapped. */
export function driverFor(matrix: Matrix, model: string): Driver {
  const claude = matrix.providers.find((p) => p.name === "claude");
  return claude?.models.has(model) === true ? "native" : "wrapped";
}

/** The cost-ascending provider order serving a WRAPPED model — roster order
 *  filtered to providers that list it, claude excluded. Empty when no configured
 *  provider serves it (the no_route condition). */
export function providerOrderFor(matrix: Matrix, model: string): HarnessName[] {
  const order: HarnessName[] = [];
  for (const p of matrix.providers) {
    if (p.name !== "claude" && p.models.has(model)) {
      order.push(p.name);
    }
  }
  return order;
}

/** The provider-native id for a capability model — the alias target, or the
 *  capability token itself when the provider lists it with no alias. Null when
 *  the provider does not serve the model. */
export function nativeIdFor(
  matrix: Matrix,
  provider: HarnessName,
  model: string,
): string | null {
  return (
    matrix.providers.find((p) => p.name === provider)?.models.get(model) ?? null
  );
}

/** One model-axis cell: a distinct capability model tagged with its driver. */
export interface MatrixCell {
  model: string;
  driver: Driver;
}

/** The distinct capability models the matrix defines (the model axis), each
 *  tagged native/wrapped, in pecking-order first appearance. A model served by
 *  several wrapped providers appears exactly once. */
export function cellSet(matrix: Matrix): MatrixCell[] {
  const seen = new Set<string>();
  const cells: MatrixCell[] = [];
  for (const p of matrix.providers) {
    for (const model of p.models.keys()) {
      if (seen.has(model)) {
        continue;
      }
      seen.add(model);
      cells.push({ model, driver: driverFor(matrix, model) });
    }
  }
  return cells;
}

/** The auto-generated preset name for a roster pair: `<provider>-<model>`. */
export function presetNameFor(provider: HarnessName, model: string): string {
  return `${provider}-${model}`;
}

/** One serving candidate: the provider harness, its native model id, and the
 *  auto-generated preset name. */
export interface Candidate {
  harness: HarnessName;
  model_id: string;
  preset_name: string;
}

/** A model resolution: its driver and cost-ordered serving candidates. */
export interface ResolveResult {
  driver: Driver;
  candidates: Candidate[];
}

/**
 * Resolve a model to its driver + cost-ordered serving candidates. A native
 * (claude) model yields the single claude candidate; a wrapped model yields the
 * pecking-ordered foreign candidates (empty when no provider serves it — the
 * caller treats an empty wrapped result as no_route).
 */
export function resolveModel(matrix: Matrix, model: string): ResolveResult {
  const driver = driverFor(matrix, model);
  if (driver === "native") {
    return {
      driver,
      candidates: [
        {
          harness: "claude",
          model_id: nativeIdFor(matrix, "claude", model) ?? model,
          preset_name: presetNameFor("claude", model),
        },
      ],
    };
  }
  return {
    driver,
    candidates: providerOrderFor(matrix, model).map((harness) => ({
      harness,
      model_id: nativeIdFor(matrix, harness, model) ?? model,
      preset_name: presetNameFor(harness, model),
    })),
  };
}

// ── doctor (providers check) ─────────────────────────────────────────────────

/** One `providers check` drift finding. */
export type ProviderCheckFinding =
  | { kind: "binary-unreachable"; provider: HarnessName; binary: string }
  | {
      kind: "preset-collision";
      preset: string;
      provider: HarnessName;
      model: string;
    };

/**
 * Build the `providers check` drift findings — pure over the matrix, the set of
 * hand-authored preset names, and an injected reachability probe (the fs/PATH
 * coupling lives at the call site). One finding per: a provider whose harness
 * binary is not reachable, and each auto-generated `<provider>-<model>` preset
 * name that collides with a hand-authored preset (the collision the catalog
 * auto-generation would fail-loud on at load).
 */
export function providerCheckFindings(
  matrix: Matrix,
  handAuthoredPresets: ReadonlySet<string>,
  isReachable: (harness: HarnessName) => boolean,
): ProviderCheckFinding[] {
  const findings: ProviderCheckFinding[] = [];
  for (const p of matrix.providers) {
    if (!isReachable(p.name)) {
      findings.push({
        kind: "binary-unreachable",
        provider: p.name,
        binary: HARNESS_DESCRIPTORS[p.name].binaryName,
      });
    }
  }
  for (const p of matrix.providers) {
    for (const model of p.models.keys()) {
      const preset = presetNameFor(p.name, model);
      if (handAuthoredPresets.has(preset)) {
        findings.push({
          kind: "preset-collision",
          preset,
          provider: p.name,
          model,
        });
      }
    }
  }
  return findings;
}
