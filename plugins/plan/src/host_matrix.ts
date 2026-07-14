// Host provider matrix loader (ADR 0036).
//
// `~/.config/keeper/matrix.yaml` is the single, REQUIRED worker-matrix config —
// an ordered provider roster supplies the effort axis, the model axis with each
// model's driver (native for claude, wrapped otherwise), the worker template
// list, and the wrapper driver. `effectiveMatrix()` is the one entry point both
// consumers (the plan verbs at runtime, the prompt renderer at build time) read.
//
// This module owns the loader's node:fs / node:os edges and lives OUTSIDE the
// reconcile-core relative-import closure (test/reconcile-core-depgraph.test.ts
// pins the boundary) — nothing in that closure may import this module.
//
// The plan island cannot import src/agent (the launcher island), so this is its
// OWN small parser of the same matrix.yaml shape, extracting only what a plan
// consumer needs: the effort axis, the model axis with each model's driver, the
// template inventory, wrapper driver, and exact named-provider routes. Absence
// or malformedness is a
// typed, four-state loud failure — see {@link HostMatrixConfigError}.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseYamlInput } from "./yaml_input.ts";

/** Loud, typed failure for a malformed/absent matrix config — carries the
 * source `label` so a call site can locate the bad file. */
export class SubagentsConfigError extends Error {
  readonly label: string;

  constructor(message: string, label: string) {
    super(message);
    this.name = "SubagentsConfigError";
    this.label = label;
  }
}

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
 * pins both parsers to identical subset + normalization behavior against it. It is
 * also the tier vocabulary the host-blind audit-policy gate validates tier keys
 * against, so the gate never reads a host file. */
export const CANONICAL_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const CANONICAL_EFFORT_SET: ReadonlySet<string> = new Set(CANONICAL_EFFORTS);

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

/** The runtime effective matrix, resolved from the REQUIRED v2 host matrix
 * (`~/.config/keeper/matrix.yaml`). Throws a typed four-state
 * {@link HostMatrixConfigError} when the matrix is absent or malformed. For the
 * plan verbs (which run from the compiled binary at an arbitrary cwd); re-reads
 * per call so an operator matrix edit lands with no rebuild. */
export function effectiveMatrix(): EffectiveMatrix {
  return hostMatrixV2ToEffective(loadHostMatrixV2());
}

// ── v2 loader (ADR 0036) ─────────────────────────────────────────────────────
//
// The plan island's OWN small parser of the v2 matrix.yaml the launcher island
// owns — extracting only what a plan consumer needs (the effort axis, the cell
// axis with each cell's driver, the template inventory, the wrapper driver, named
// provider routes, per-cell effort lists, and the dedup shadow log), pinned
// byte-for-byte against the
// launcher island's twin (`src/agent/matrix.ts` `loadMatrixV2`) by the cross-island
// parity test. A provider model entry is the launch id verbatim; the capability is
// its basename. Absence/malformedness is a typed four-state loud error.

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

/** A static plan subagent's `{model, effort}` pin (a pair, never a triple —
 *  frontmatter carries no harness axis), baked into the agent's rendered
 *  frontmatter at render time. Mirrors the launcher island's `AgentPin`. */
export interface AgentPin {
  model: string;
  effort: string;
}

/** One provider's exact native route for a capability. Unlike the deduplicated
 * worker-cell projection, this preserves every named provider's launch id and
 * effort allowlist so publication consumers can target a specific host. */
export interface HostProviderRoute {
  readonly provider: string;
  readonly capability: string;
  readonly launchId: string;
  readonly efforts: readonly string[];
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
  /** Exact routes by provider then capability, including cross-provider shadows. */
  providerRoutes: Map<string, Map<string, HostProviderRoute>>;
  /** the `agent_pins:` map (static subagent name → its `{model, effort}` pin),
   *  in declaration order. Empty when the block is absent. */
  agentPins: Map<string, AgentPin>;
}

const ALLOWED_V2_KEYS: ReadonlySet<string> = new Set([
  "efforts",
  "subagent_templates",
  "subagent_models",
  "providers",
  "wrapper_driver",
  "defaults",
  "agent_pins",
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
  return parseHostMatrixV2Bytes(raw, path);
}

/** Parse one already-read matrix snapshot. The compiler uses this seam so
 * parsing, route resolution, and fingerprinting all consume identical bytes. */
export function parseHostMatrixV2Bytes(
  raw: Buffer,
  path: string,
): HostMatrixV2 {
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
  const { effortsByModel, servedBy, claudeServes, shadowed, providerRoutes } =
    coerceV2Providers(doc.providers, efforts, label);
  const models = coerceSubagentModels(doc.subagent_models, servedBy, label);
  const driverByModel = new Map<string, Driver>();
  for (const cap of models) {
    driverByModel.set(cap, claudeServes.has(cap) ? "native" : "wrapped");
  }
  const agentPins = coerceAgentPins(doc.agent_pins, efforts, label);
  return {
    efforts,
    subagentTemplates,
    models,
    wrapper_driver: coerceWrapperDriver(doc.wrapper_driver, label),
    driverByModel,
    effortsByModel,
    shadowed,
    providerRoutes,
    agentPins,
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
  providerRoutes: Map<string, Map<string, HostProviderRoute>>;
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
  const providerRoutes = new Map<string, Map<string, HostProviderRoute>>();
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
    const routes = new Map<string, HostProviderRoute>();
    providerRoutes.set(name, routes);
    for (const cap of caps.keys()) {
      const effectiveEfforts = caps.get(cap) ?? providerEfforts ?? baseEfforts;
      routes.set(cap, {
        provider: name,
        capability: cap,
        launchId: caps.launchId(cap),
        efforts: [...effectiveEfforts],
      });
      if (name === "claude") {
        claudeServes.add(cap);
      }
      if (!servedBy.has(cap)) {
        servedBy.set(cap, name);
        effortsByModel.set(cap, effectiveEfforts);
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
  return {
    effortsByModel,
    servedBy,
    claudeServes,
    shadowed,
    providerRoutes,
  };
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

/** Parse + validate the `agent_pins:` map — agent name → `{model, effort}`. An
 * absent block parses as an empty map (a pins-less v2 file stays valid for
 * launch/dispatch surfaces; render-time strictness for a missing/extra pin is
 * the renderer's job — task 5). Effort must be a member of the matrix's
 * top-level efforts axis; model is an opaque non-empty strict-charset token
 * (not cross-checked against `subagent_models` — frontmatter has no harness
 * axis to resolve through). Mirrors the launcher island's `parseAgentPins`. */
function coerceAgentPins(
  raw: unknown,
  efforts: string[],
  label: string,
): Map<string, AgentPin> {
  const pins = new Map<string, AgentPin>();
  if (raw === undefined) {
    return pins;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SubagentsConfigError(
      "host matrix `agent_pins` must be a mapping of agent name to {model, effort}",
      label,
    );
  }
  const effortSet = new Set(efforts);
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SubagentsConfigError(
        `host matrix \`agent_pins['${name}']\` must be a {model, effort} mapping`,
        label,
      );
    }
    const rec = entry as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (k !== "model" && k !== "effort") {
        throw new SubagentsConfigError(
          `host matrix \`agent_pins['${name}']\` has unknown key '${k}' (allowed: model, effort)`,
          label,
        );
      }
    }
    if (!isMatrixToken(rec.model)) {
      throw new SubagentsConfigError(
        `host matrix \`agent_pins['${name}'].model\` must be a valid token`,
        label,
      );
    }
    if (typeof rec.effort !== "string" || !effortSet.has(rec.effort)) {
      throw new SubagentsConfigError(
        `host matrix \`agent_pins['${name}'].effort\` '${rec.effort}' is not in the matrix effort axis [${efforts.join(", ")}]`,
        label,
      );
    }
    pins.set(name, { model: rec.model, effort: rec.effort });
  }
  return pins;
}

/** Resolve whether a named provider serves a capability and, when it does,
 * return the exact launch id plus that provider route's allowed efforts. */
export function hostMatrixV2ProviderRoute(
  host: HostMatrixV2,
  provider: string,
  capability: string,
): HostProviderRoute | undefined {
  const route = host.providerRoutes.get(provider)?.get(capability);
  if (route === undefined) return undefined;
  return { ...route, efforts: [...route.efforts] };
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

/** Adapt a loaded {@link HostMatrixV2} into the {@link EffectiveMatrix} shape the
 * plan verbs consume (model axis = `subagent_models`, `subagents` = the template
 * inventory). The driver map defaults an unlisted model to wrapped. */
export function hostMatrixV2ToEffective(host: HostMatrixV2): EffectiveMatrix {
  return {
    efforts: host.efforts,
    models: host.models,
    subagents: host.subagentTemplates,
    wrapper_driver: host.wrapper_driver,
    driverFor: (model) => host.driverByModel.get(model) ?? "wrapped",
    effortsFor: (model) => hostMatrixV2EffortsFor(host, model),
  };
}
