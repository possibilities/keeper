// Host provider matrix overlay (ADR 0010).
//
// The embedded/disk subagents.yaml (subagents_config.ts) is the claude-only
// DEFAULT matrix. A host-level `~/.config/keeper/matrix.yaml`, when present,
// OVERRIDES the axes at run time: an ordered provider roster grows the model
// axis with capability models served by non-claude harnesses.
// `effectiveMatrix()` composes the two — host when present, embedded defaults
// otherwise — so both consumers (the plan verbs at runtime, the prompt renderer
// at build time) see one effective matrix.
//
// This module owns the overlay's node:fs / node:os edges and lives OUTSIDE the
// reconcile-core relative-import closure: subagents_config.ts is reached from
// that closure (via src/worker-cell.ts), so it must stay free of direct node IO
// (test/reconcile-core-depgraph.test.ts pins the boundary). Nothing in that
// closure may import this module.
//
// The plan island cannot import src/agent (the launcher island), so this is its
// OWN small parser of the same matrix.yaml shape, extracting only what a plan
// consumer needs: the effort axis, the model axis with each model's driver, the
// worker template list, and the wrapper driver. A present-but-malformed matrix is
// fail-loud (SubagentsConfigError / YamlInputError); an absent or empty file
// returns null so the caller falls back to the embedded defaults byte-identically.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  loadSubagentsMatrixFromDisk,
  SubagentsConfigError,
  type SubagentsMatrix,
  subagentsMatrix,
} from "./subagents_config.ts";
import { parseYamlInput } from "./yaml_input.ts";

/** claude membership → native; every other capability model → wrapped. */
export type Driver = "native" | "wrapped";

/** The composed {model × effort} matrix a consumer renders or validates against.
 * `models` is the model axis, `driverFor` tags each native/wrapped, and
 * `wrapper_driver` is the fixed claude model-and-effort a wrapped cell's wrapper
 * runs at. */
export interface EffectiveMatrix {
  /** The top-level effort axis — the global effort vocabulary and the default a
   * model inherits when no per-model override narrows it. */
  readonly efforts: readonly string[];
  readonly models: readonly string[];
  readonly subagents: readonly string[];
  readonly wrapper_driver: { readonly model: string; readonly effort: string };
  /** `native` for a claude-served model, `wrapped` for every other. */
  driverFor(model: string): Driver;
  /** The effective effort list for a model — the host per-model override when the
   * matrix narrows it, else the top-level axis. With no host matrix every model
   * returns the base axis, so the {model × effort} cube stays rectangular; a host
   * roster's per-model overrides make it ragged. The renderer, the selection-brief
   * candidate enumeration, and the cell-write axis gate all fan out over this. */
  effortsFor(model: string): readonly string[];
}

/** The wrapper driver the embedded defaults imply when no host matrix overrides
 * it (sonnet/high). With no matrix every model is claude-native, so nothing runs
 * wrapped, but the binding is present so the composed template renders uniformly. */
export const DEFAULT_WRAPPER_MODEL = "sonnet";
export const DEFAULT_WRAPPER_EFFORT = "high";

/** The host config dir (`KEEPER_CONFIG_DIR` override, else `~/.config/keeper`).
 * Mirrors the launcher island's `keeperConfigDir()` WITHOUT importing it — the
 * plan island's dep graph must not reach src/agent. The env override is the
 * test-isolation seam (os.homedir ignores $HOME on macOS) and a production lever. */
function keeperConfigDir(): string {
  const override = process.env.KEEPER_CONFIG_DIR;
  if (override !== undefined && override !== "") {
    return override;
  }
  return join(homedir(), ".config", "keeper");
}

/** The host provider matrix path (`<config-dir>/matrix.yaml`). */
export function hostMatrixPath(): string {
  return join(keeperConfigDir(), "matrix.yaml");
}

/** The name charset a matrix token must match: lowercase alnum, hyphen,
 * underscore, dot — no leading dot, so a dotted capability id like `gpt-5.5` is
 * valid while a path-escape or scalar-coerced value fails loud. */
const MATRIX_TOKEN_RE = /^[a-z0-9._-]+$/;

function isMatrixToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    MATRIX_TOKEN_RE.test(value) &&
    !value.startsWith(".")
  );
}

/** The alias-TARGET charset: one or more strict matrix tokens joined by `/` (a
 * provider-qualified native id like `openai/gpt-5.5`). RELAXED past isMatrixToken
 * for the native id a capability aliases to — validated-then-discarded here for
 * fail-loud parity with the launcher island (`src/agent/matrix.ts`
 * `isValidMatrixAliasTarget`), which owns the value. Every `/`-segment stays
 * strict (no empty segment, no leading dot, no path escape); alias keys + axis
 * tokens stay strict. */
function isMatrixAliasTarget(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value
      .split("/")
      .every((seg) => MATRIX_TOKEN_RE.test(seg) && !seg.startsWith("."))
  );
}

/** keeper's canonical five-rung effort vocabulary, ascending — MIRRORS the
 * launcher island's `src/agent/harness.ts` KEEPER_EFFORTS. The plan island cannot
 * import src/agent, so the list is duplicated here; the cross-island parity test
 * pins both parsers to identical subset + normalization behavior against it. */
const CANONICAL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const CANONICAL_EFFORT_SET: ReadonlySet<string> = new Set(CANONICAL_EFFORTS);

/** The subset of the host matrix a plan consumer needs, parsed and validated. */
export interface HostMatrix {
  efforts: string[];
  /** the model axis (capability cell set): distinct ROUTED capability tokens in
   * pecking-order first appearance. A launch-only (route:false) provider's models
   * are excluded here (they enumerate for launch only, never as a cell). */
  models: string[];
  wrapper_driver: { model: string; effort: string };
  driverByModel: Map<string, Driver>;
  /** Per-model effective effort lists (normalized), keyed by capability token, for
   * EVERY model any provider serves (routed + launch-only), resolved by the
   * model → provider → top-level clobber chain. A model absent here inherits the
   * top-level axis via {@link effortsFor}. */
  effortsByModel: Map<string, string[]>;
}

/** Read + parse the host provider matrix, or null when absent/not-a-file or when
 * a present file is empty/whitespace-only (the caller falls back to the
 * embedded defaults). A present file that fails to read (e.g. permission
 * denied) or whose content fails to parse or violates the shape throws —
 * matrix.yaml is fail-loud, never a silent half-built default; this matches
 * the launcher island (`src/agent/matrix.ts` `loadMatrix`), whose
 * `readFileSync` is unguarded. */
export function loadHostMatrix(
  path: string = hostMatrixPath(),
): HostMatrix | null {
  try {
    if (!statSync(path).isFile()) {
      return null;
    }
  } catch {
    return null; // absent / not a file → fall back to embedded defaults
  }
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new SubagentsConfigError(
      `host matrix at ${path} could not be read: ${(err as Error).message}`,
      path,
    );
  }
  const parsed = parseYamlInput(raw, path);
  if (parsed === null || parsed === undefined) {
    return null; // empty / whitespace-only → fall back
  }
  return parseHostMatrix(parsed, path);
}

/** Validate a parsed matrix document into a HostMatrix. Fail-loud (typed) on any
 * malformed shape — the plan island's own small parser of the matrix.yaml the
 * launcher island owns. */
function parseHostMatrix(parsed: unknown, label: string): HostMatrix {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SubagentsConfigError(
      "host matrix must be a mapping with efforts/providers/subagents/wrapper_driver keys",
      label,
    );
  }
  const doc = parsed as Record<string, unknown>;
  const efforts = coerceEffortList(doc.efforts, "efforts", label);
  const { models, driverByModel, effortsByModel } = coerceProviders(
    doc.providers,
    efforts,
    label,
  );
  // Validate `subagents` for fail-loud parity with the launcher island (a matrix
  // it accepts and the plan silently tolerated would be a confusing divergence),
  // but discard it — the renderer's template inventory comes from the plugin's
  // own subagents.yaml, not the host matrix.
  coerceTokenList(doc.subagents, "subagents", label);
  return {
    efforts,
    models,
    wrapper_driver: coerceWrapperDriver(doc.wrapper_driver, label),
    driverByModel,
    effortsByModel,
  };
}

/** A non-empty list of matrix tokens. */
function coerceTokenList(raw: unknown, key: string, label: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      `host matrix \`${key}\` must be a non-empty list`,
      label,
    );
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (!isMatrixToken(entry)) {
      throw new SubagentsConfigError(
        `host matrix \`${key}\` entries must be tokens matching [a-z0-9._-] with no leading dot`,
        label,
      );
    }
    out.push(entry);
  }
  return out;
}

/** Parse + validate an effort list — the top-level axis OR a per-provider /
 * per-model override. A non-empty list of strings, each in the canonical effort
 * vocabulary, no duplicates, normalized to canonical ascending order. A present-
 * but-empty list, an out-of-vocabulary token, or a non-string scalar (a YAML 1.1
 * coercion like `off`) is fail-loud. Mirrors the launcher island's
 * `parseEffortList` under the parity test. */
function coerceEffortList(raw: unknown, key: string, label: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      `host matrix \`${key}\` must be a non-empty list`,
      label,
    );
  }
  const present = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new SubagentsConfigError(
        `host matrix \`${key}\` entries must be strings`,
        label,
      );
    }
    if (!CANONICAL_EFFORT_SET.has(entry)) {
      throw new SubagentsConfigError(
        `host matrix \`${key}\` entry '${entry}' is not in the canonical effort vocabulary [${CANONICAL_EFFORTS.join(", ")}]`,
        label,
      );
    }
    if (present.has(entry)) {
      throw new SubagentsConfigError(
        `host matrix \`${key}\` lists '${entry}' more than once`,
        label,
      );
    }
    present.add(entry);
  }
  return CANONICAL_EFFORTS.filter((e) => present.has(e));
}

/** The `{model, effort}` claude driver a wrapped cell's wrapper runs at. */
function coerceWrapperDriver(
  raw: unknown,
  label: string,
): { model: string; effort: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SubagentsConfigError(
      "host matrix `wrapper_driver` must be a {model, effort} mapping",
      label,
    );
  }
  const rec = raw as Record<string, unknown>;
  if (!isMatrixToken(rec.model)) {
    throw new SubagentsConfigError(
      "host matrix `wrapper_driver.model` must be a valid token",
      label,
    );
  }
  if (!isMatrixToken(rec.effort)) {
    throw new SubagentsConfigError(
      "host matrix `wrapper_driver.effort` must be a valid token",
      label,
    );
  }
  return { model: rec.model, effort: rec.effort };
}

/** Fold the provider roster into the capability cell set + per-model driver +
 * per-model effort lists. claude membership makes a model native; every other
 * routed provider makes it wrapped. A model served by claude AND another ROUTED
 * provider is an ambiguous driver — fail-loud (a model is native XOR wrapped). Two
 * non-claude providers sharing a model is the pecking-order overlap the run-time
 * resolver arbitrates, and is allowed. A launch-only (route:false) provider's
 * models stay OUT of the cell set (and the overlap check) but still resolve an
 * effort list for enumeration. */
function coerceProviders(
  raw: unknown,
  baseEfforts: string[],
  label: string,
): {
  models: string[];
  driverByModel: Map<string, Driver>;
  effortsByModel: Map<string, string[]>;
} {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      "host matrix `providers` must be a non-empty list",
      label,
    );
  }
  const models: string[] = [];
  const seenCellModel = new Set<string>();
  const claudeModels = new Set<string>();
  const routedWrappedModels = new Set<string>();
  const seenProvider = new Set<string>();
  const effortsByModel = new Map<string, string[]>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SubagentsConfigError(
        "each host matrix provider must be a {name, models} mapping",
        label,
      );
    }
    const rec = entry as Record<string, unknown>;
    if (!isMatrixToken(rec.name)) {
      throw new SubagentsConfigError(
        "host matrix provider `name` must be a valid token",
        label,
      );
    }
    const name = rec.name;
    if (seenProvider.has(name)) {
      throw new SubagentsConfigError(
        `host matrix provider '${name}' is listed more than once`,
        label,
      );
    }
    seenProvider.add(name);
    const route = coerceRoute(rec.route, name, label);
    const providerEfforts =
      rec.efforts === undefined
        ? undefined
        : coerceEffortList(rec.efforts, `provider '${name}' efforts`, label);
    const { caps, modelEfforts } = coerceProviderModels(
      rec.models,
      name,
      label,
    );
    for (const cap of caps) {
      // Effort resolution is route-agnostic and keyed on pecking-order FIRST
      // appearance (model override → provider override → top-level axis).
      if (!effortsByModel.has(cap)) {
        effortsByModel.set(
          cap,
          modelEfforts.get(cap) ?? providerEfforts ?? baseEfforts,
        );
      }
      if (route) {
        if (!seenCellModel.has(cap)) {
          seenCellModel.add(cap);
          models.push(cap);
        }
        (name === "claude" ? claudeModels : routedWrappedModels).add(cap);
      }
    }
  }
  for (const cap of claudeModels) {
    if (routedWrappedModels.has(cap)) {
      throw new SubagentsConfigError(
        `host matrix model '${cap}' is served by both claude and another provider — ambiguous driver (a model is native XOR wrapped)`,
        label,
      );
    }
  }
  const driverByModel = new Map<string, Driver>();
  for (const cap of models) {
    driverByModel.set(cap, claudeModels.has(cap) ? "native" : "wrapped");
  }
  return { models, driverByModel, effortsByModel };
}

/** The per-provider `route` flag: a strict boolean, default `true` when absent.
 * `route: false` declares a launch-only provider; `route: false` on claude is a
 * load error (claude is always the native routing provider). Mirrors the launcher
 * island's `parseRoute`. */
function coerceRoute(value: unknown, name: string, label: string): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new SubagentsConfigError(
      `host matrix provider '${name}' route must be a boolean`,
      label,
    );
  }
  if (name === "claude" && value === false) {
    throw new SubagentsConfigError(
      `host matrix provider 'claude' cannot set route: false — claude is always the native routing provider`,
      label,
    );
  }
  return value;
}

/** The capability tokens one provider serves plus their per-model effort
 * overrides. Each entry is a bare token or the model long form
 * `{name, native?, efforts?}`, discriminated by a required `name` key; an object
 * WITHOUT `name` is the RETIRED one-pair `capability: native-id` alias map — fail
 * loud, naming the long form. Only the capability key feeds the model axis (the
 * native id is a dispatch-time concern the launcher island owns, validated here
 * only for fail-loud parity); the per-model `efforts` override feeds
 * {@link effortsFor}. */
function coerceProviderModels(
  raw: unknown,
  provider: string,
  label: string,
): { caps: string[]; modelEfforts: Map<string, string[]> } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      `host matrix provider '${provider}' models must be a non-empty list`,
      label,
    );
  }
  const caps: string[] = [];
  const seen = new Set<string>();
  const modelEfforts = new Map<string, string[]>();
  for (const item of raw) {
    let capability: string;
    let perModelEfforts: string[] | undefined;
    if (typeof item === "string") {
      capability = item;
    } else if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      const rec = item as Record<string, unknown>;
      if (!("name" in rec)) {
        throw new SubagentsConfigError(
          `host matrix provider '${provider}' model entry must be a bare token or the long form {name, native?, efforts?} (the 'capability: native-id' alias map is retired — use {name: <capability>, native: <native-id>})`,
          label,
        );
      }
      for (const k of Object.keys(rec)) {
        if (k !== "name" && k !== "native" && k !== "efforts") {
          throw new SubagentsConfigError(
            `host matrix provider '${provider}' model long form has unknown key '${k}' (allowed: name, native, efforts)`,
            label,
          );
        }
      }
      if (typeof rec.name !== "string") {
        throw new SubagentsConfigError(
          `host matrix provider '${provider}' model 'name' must be a string`,
          label,
        );
      }
      capability = rec.name;
      // The native id is a launcher-island dispatch concern — validated here for
      // fail-loud parity, then discarded (the plan island keeps only the axis).
      if (rec.native !== undefined && !isMatrixAliasTarget(rec.native)) {
        throw new SubagentsConfigError(
          `host matrix provider '${provider}' model '${capability}' native id must be '/'-joined [a-z0-9._-] segments (no leading dot, no empty segment)`,
          label,
        );
      }
      if (rec.efforts !== undefined) {
        perModelEfforts = coerceEffortList(
          rec.efforts,
          `provider '${provider}' model '${capability}' efforts`,
          label,
        );
      }
    } else {
      throw new SubagentsConfigError(
        `host matrix provider '${provider}' model entry must be a bare token or the long form {name, native?, efforts?}`,
        label,
      );
    }
    if (!isMatrixToken(capability)) {
      throw new SubagentsConfigError(
        `host matrix provider '${provider}' model token '${capability}' must match [a-z0-9._-] with no leading dot`,
        label,
      );
    }
    if (seen.has(capability)) {
      throw new SubagentsConfigError(
        `host matrix provider '${provider}' lists model '${capability}' more than once`,
        label,
      );
    }
    seen.add(capability);
    caps.push(capability);
    if (perModelEfforts !== undefined) {
      modelEfforts.set(capability, perModelEfforts);
    }
  }
  return { caps, modelEfforts };
}

/** The effective effort list for a capability model — the most-specific override
 * wins (model-level → provider-level → the top-level axis), resolved at the
 * pecking-order FIRST provider that serves the model, returned in canonical
 * ascending order. A model no provider serves inherits the top-level axis. Mirrors
 * the launcher island's `effortsFor` (src/agent/matrix.ts) under the parity test. */
export function effortsFor(host: HostMatrix, model: string): string[] {
  return [...(host.effortsByModel.get(model) ?? host.efforts)];
}

/** Compose the effective matrix over a `base` (embedded or disk) default: the
 * host provider matrix when `matrix.yaml` is present, else the base treated as
 * claude-native with the default wrapper driver. Re-reads matrix.yaml per call
 * (no memo) so an operator edit — including a provider reorder — lands on the next
 * render/dispatch with no rebuild. */
function composeEffective(base: SubagentsMatrix): EffectiveMatrix {
  const host = loadHostMatrix();
  if (host !== null) {
    const { driverByModel } = host;
    return {
      efforts: host.efforts,
      models: host.models,
      // The template inventory (which agent templates fan out) is a property of
      // the plugin, not the host — so it always comes from the plugin's own
      // subagents.yaml, never the host matrix (whose `subagents` names the work
      // plugin/agent, a launch concern the launcher island owns).
      subagents: base.subagents,
      wrapper_driver: host.wrapper_driver,
      driverFor: (model) => driverByModel.get(model) ?? "wrapped",
      effortsFor: (model) => effortsFor(host, model),
    };
  }
  return {
    efforts: base.efforts,
    models: base.models,
    subagents: base.subagents,
    wrapper_driver: {
      model: DEFAULT_WRAPPER_MODEL,
      effort: DEFAULT_WRAPPER_EFFORT,
    },
    driverFor: () => "native",
    effortsFor: () => base.efforts,
  };
}

/** The runtime effective matrix: the compile-time embedded snapshot as the
 * claude-native base, overlaid by the host matrix when present. For the plan
 * verbs (which run from the compiled binary at an arbitrary cwd). */
export function effectiveMatrix(): EffectiveMatrix {
  return composeEffective(subagentsMatrix());
}

/** The build-time effective matrix: the on-disk subagents.yaml at `path` as the
 * claude-native base, overlaid by the host matrix when present. For the template
 * renderer, which fans out over the live config. */
export function effectiveMatrixFromDisk(path: string): EffectiveMatrix {
  return composeEffective(loadSubagentsMatrixFromDisk(path));
}

// ── v2 loader (ADR 0036) ─────────────────────────────────────────────────────
//
// The plan island's OWN small parser of the v2 matrix.yaml the launcher island
// owns — extracting only what a plan consumer needs (the effort axis, the cell
// axis with each cell's driver, the template inventory, the wrapper driver, the
// per-cell effort lists, the dedup shadow log), pinned byte-for-byte against the
// launcher island's twin (`src/agent/matrix.ts` `loadMatrixV2`) by the cross-island
// parity test. A provider model entry is the launch id verbatim; the capability is
// its basename. Absence/malformedness is a typed four-state loud error.
//
// ADDITIVE this task: the v1 `loadHostMatrix` + `composeEffective` base path stay
// unchanged so the plan verbs and renderer keep working until their cutover tasks.

/** The four discriminated matrix-load failure states — mirrors the launcher
 *  island's `MatrixConfigState`. */
export type MatrixConfigState =
  | "absent"
  | "unparseable"
  | "schema-invalid"
  | "valid-but-empty";

/** The remediation every four-state error carries. */
export const MATRIX_EXAMPLE_PATH = "docs/examples/matrix.example.yaml";

/** A typed, four-state matrix-load failure. Extends {@link SubagentsConfigError}
 *  (the plan island's existing typed error) so an `instanceof` catch still
 *  catches it; `state` discriminates the four cases, `label` names the path. */
export class HostMatrixConfigError extends SubagentsConfigError {
  readonly state: MatrixConfigState;
  constructor(state: MatrixConfigState, path: string, detail: string) {
    super(
      `${detail} (looked at ${path}). ` +
        `Copy ${MATRIX_EXAMPLE_PATH} to ${path} and edit it.`,
      path,
    );
    this.name = "HostMatrixConfigError";
    this.state = state;
  }
}

/** One cross-provider dedup shadow (mirrors the launcher island's `MatrixShadow`). */
export interface HostMatrixShadow {
  provider: string;
  capability: string;
  launchId: string;
  winner: string;
}

/** The v2 subset a plan consumer needs. `models` IS `subagent_models` (the cell
 *  axis); `effortsByModel` covers EVERY capability any provider serves. */
export interface HostMatrixV2 {
  efforts: string[];
  subagentTemplates: string[];
  models: string[];
  wrapper_driver: { model: string; effort: string };
  driverByModel: Map<string, Driver>;
  effortsByModel: Map<string, string[]>;
  shadowed: HostMatrixShadow[];
}

const ALLOWED_V2_KEYS: ReadonlySet<string> = new Set([
  "efforts",
  "subagent_templates",
  "subagent_models",
  "providers",
  "wrapper_driver",
  "defaults",
]);

/** The capability token of a launch id: the segment after the LAST `/`, else the
 *  whole id. Safe by construction (the launch id validates as a slash-joined
 *  strict-token target, so its last segment is a strict token). */
export function capabilityOf(launchId: string): string {
  const slash = launchId.lastIndexOf("/");
  return slash === -1 ? launchId : launchId.slice(slash + 1);
}

/** A `subagent_templates` entry: a non-empty RELATIVE path, no `..` segment, no
 *  NUL — the traversal guard replacing the retired `render_to:` check. */
export function isValidTemplatePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value.includes("\0") || value.startsWith("/")) {
    return false;
  }
  return !value.split("/").includes("..");
}

/** Load + validate the v2 host matrix, or throw a typed four-state
 * {@link HostMatrixConfigError}. Never returns null — v2 has no silent fallback.
 * Mirrors the launcher island's `loadMatrixV2` under the parity test. */
export function loadHostMatrixV2(
  path: string = hostMatrixPath(),
): HostMatrixV2 {
  try {
    if (!statSync(path).isFile()) {
      throw new HostMatrixConfigError("absent", path, "no matrix.yaml found");
    }
  } catch (err) {
    if (err instanceof HostMatrixConfigError) {
      throw err;
    }
    throw new HostMatrixConfigError("absent", path, "no matrix.yaml found");
  }
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new HostMatrixConfigError(
      "unparseable",
      path,
      `matrix.yaml could not be read: ${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = parseYamlInput(raw, path);
  } catch (err) {
    throw new HostMatrixConfigError(
      "unparseable",
      path,
      `matrix.yaml is not valid YAML: ${(err as Error).message}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    throw new HostMatrixConfigError(
      "valid-but-empty",
      path,
      "matrix.yaml is empty",
    );
  }
  try {
    return parseHostMatrixV2(parsed, path);
  } catch (err) {
    if (err instanceof HostMatrixConfigError) {
      throw err;
    }
    if (err instanceof SubagentsConfigError) {
      throw new HostMatrixConfigError("schema-invalid", path, err.message);
    }
    throw err;
  }
}

function parseHostMatrixV2(parsed: unknown, label: string): HostMatrixV2 {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SubagentsConfigError("matrix.yaml must be a mapping", label);
  }
  const doc = parsed as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (key === "subagents") {
      throw new SubagentsConfigError(
        "the 'subagents:' key is retired — use 'subagent_templates:' (the cell-template inventory) and 'subagent_models:' (worker-cell eligibility)",
        label,
      );
    }
    if (!ALLOWED_V2_KEYS.has(key)) {
      throw new SubagentsConfigError(
        `unknown top-level key '${key}' (allowed: ${[...ALLOWED_V2_KEYS].join(", ")})`,
        label,
      );
    }
  }
  const efforts = coerceEffortList(doc.efforts, "efforts", label);
  const subagentTemplates = coerceTemplateList(doc.subagent_templates, label);
  const { effortsByModel, servedBy, claudeServes, shadowed } =
    coerceV2Providers(doc.providers, efforts, label);
  const models = coerceSubagentModels(doc.subagent_models, servedBy, label);
  const driverByModel = new Map<string, Driver>();
  for (const cap of models) {
    driverByModel.set(cap, claudeServes.has(cap) ? "native" : "wrapped");
  }
  return {
    efforts,
    subagentTemplates,
    models,
    wrapper_driver: coerceWrapperDriver(doc.wrapper_driver, label),
    driverByModel,
    effortsByModel,
    shadowed,
  };
}

function coerceTemplateList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      "host matrix `subagent_templates` must be a non-empty list",
      label,
    );
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (!isValidTemplatePath(entry)) {
      throw new SubagentsConfigError(
        `host matrix \`subagent_templates\` entry ${JSON.stringify(entry)} must be a non-empty relative path with no '..' segment and no NUL`,
        label,
      );
    }
    out.push(entry);
  }
  return out;
}

function coerceV2Providers(
  raw: unknown,
  baseEfforts: string[],
  label: string,
): {
  effortsByModel: Map<string, string[]>;
  servedBy: Map<string, string>;
  claudeServes: Set<string>;
  shadowed: HostMatrixShadow[];
} {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      "host matrix `providers` must be a non-empty list",
      label,
    );
  }
  const effortsByModel = new Map<string, string[]>();
  const servedBy = new Map<string, string>();
  // claudeServes tracks capabilities the claude provider serves → native.
  const claudeServes = new Set<string>();
  const shadowed: HostMatrixShadow[] = [];
  const seenProvider = new Set<string>();
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SubagentsConfigError(
        "each host matrix provider must be a {name, models} mapping",
        label,
      );
    }
    const rec = entry as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (k === "route") {
        throw new SubagentsConfigError(
          "the 'route:' flag is retired — launch-only enumeration falls out of a capability's absence from 'subagent_models', not a per-provider flag",
          label,
        );
      }
      if (k !== "name" && k !== "models" && k !== "efforts") {
        throw new SubagentsConfigError(
          `host matrix provider has unknown key '${k}' (allowed: name, models, efforts)`,
          label,
        );
      }
    }
    if (!isMatrixToken(rec.name)) {
      throw new SubagentsConfigError(
        "host matrix provider `name` must be a valid token",
        label,
      );
    }
    const name = rec.name;
    if (seenProvider.has(name)) {
      throw new SubagentsConfigError(
        `host matrix provider '${name}' is listed more than once`,
        label,
      );
    }
    seenProvider.add(name);
    const providerEfforts =
      rec.efforts === undefined
        ? undefined
        : coerceEffortList(rec.efforts, `provider '${name}' efforts`, label);
    const caps = coerceV2ProviderModels(rec.models, name, label);
    for (const cap of caps.keys()) {
      if (name === "claude") {
        claudeServes.add(cap);
      }
      if (!servedBy.has(cap)) {
        servedBy.set(cap, name);
        effortsByModel.set(
          cap,
          caps.get(cap) ?? providerEfforts ?? baseEfforts,
        );
      } else {
        shadowed.push({
          provider: name,
          capability: cap,
          launchId: caps.launchId(cap),
          winner: servedBy.get(cap) as string,
        });
      }
    }
  }
  return { effortsByModel, servedBy, claudeServes, shadowed };
}

/** The capabilities one provider serves plus per-model effort overrides and launch
 *  ids. Returned as an augmented Map with `.get(cap)` = per-model efforts (or
 *  undefined) and `.launchId(cap)` = the entry's launch id. Each entry is a bare
 *  launch id or `{id, efforts?}`; the retired `name:`/`native:` keys fail loud. */
function coerceV2ProviderModels(
  raw: unknown,
  provider: string,
  label: string,
): Map<string, string[] | undefined> & { launchId(cap: string): string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      `host matrix provider '${provider}' models must be a non-empty list`,
      label,
    );
  }
  const perModel = new Map<string, string[] | undefined>();
  const launchIds = new Map<string, string>();
  for (const item of raw) {
    let launchId: string;
    let perModelEfforts: string[] | undefined;
    if (typeof item === "string") {
      launchId = item;
    } else if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      const rec = item as Record<string, unknown>;
      for (const k of Object.keys(rec)) {
        if (k === "name") {
          throw new SubagentsConfigError(
            `host matrix provider '${provider}' model long form uses the retired 'name:' key — use 'id:' (the launch id; its capability is derived by basename)`,
            label,
          );
        }
        if (k === "native") {
          throw new SubagentsConfigError(
            `host matrix provider '${provider}' model long form uses the retired 'native:' key — the model entry IS the launch id verbatim; the capability is the basename`,
            label,
          );
        }
        if (k !== "id" && k !== "efforts") {
          throw new SubagentsConfigError(
            `host matrix provider '${provider}' model long form has unknown key '${k}' (allowed: id, efforts)`,
            label,
          );
        }
      }
      if (typeof rec.id !== "string") {
        throw new SubagentsConfigError(
          `host matrix provider '${provider}' model long form 'id' must be a string`,
          label,
        );
      }
      launchId = rec.id;
      if (rec.efforts !== undefined) {
        perModelEfforts = coerceEffortList(
          rec.efforts,
          `provider '${provider}' model '${launchId}' efforts`,
          label,
        );
      }
    } else {
      throw new SubagentsConfigError(
        `host matrix provider '${provider}' model entry must be a bare launch-id string or the long form {id, efforts?}`,
        label,
      );
    }
    if (!isMatrixAliasTarget(launchId)) {
      throw new SubagentsConfigError(
        `host matrix provider '${provider}' launch id '${launchId}' must be '/'-joined [a-z0-9._-] segments (no leading dot, no empty segment)`,
        label,
      );
    }
    const capability = capabilityOf(launchId);
    if (!isMatrixToken(capability)) {
      throw new SubagentsConfigError(
        `host matrix provider '${provider}' launch id '${launchId}' derives an invalid capability token '${capability}'`,
        label,
      );
    }
    if (launchIds.has(capability)) {
      throw new SubagentsConfigError(
        `host matrix provider '${provider}' derives capability '${capability}' from more than one launch id (same-provider duplicate — a typo)`,
        label,
      );
    }
    perModel.set(capability, perModelEfforts);
    launchIds.set(capability, launchId);
  }
  return Object.assign(perModel, {
    launchId: (cap: string): string => launchIds.get(cap) as string,
  });
}

function coerceSubagentModels(
  raw: unknown,
  servedBy: Map<string, string>,
  label: string,
): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      "host matrix `subagent_models` must be a non-empty list",
      label,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isMatrixToken(item)) {
      throw new SubagentsConfigError(
        `host matrix \`subagent_models\` entries must be tokens matching [a-z0-9._-] with no leading dot (got ${JSON.stringify(item)})`,
        label,
      );
    }
    if (seen.has(item)) {
      throw new SubagentsConfigError(
        `host matrix \`subagent_models\` lists '${item}' more than once`,
        label,
      );
    }
    if (!servedBy.has(item)) {
      throw new SubagentsConfigError(
        `host matrix \`subagent_models\` entry '${item}' is served by no provider — add a provider whose launch id derives that capability`,
        label,
      );
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** The effective effort list for a capability under the v2 host matrix — the
 * resolved per-capability list, else the top-level axis. Mirrors the launcher
 * island's `matrixV2EffortsFor`. */
export function hostMatrixV2EffortsFor(
  host: HostMatrixV2,
  model: string,
): string[] {
  return [...(host.effortsByModel.get(model) ?? host.efforts)];
}
