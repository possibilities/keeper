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
  readonly efforts: readonly string[];
  readonly models: readonly string[];
  readonly subagents: readonly string[];
  readonly wrapper_driver: { readonly model: string; readonly effort: string };
  /** `native` for a claude-served model, `wrapped` for every other. */
  driverFor(model: string): Driver;
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

/** The subset of the host matrix a plan consumer needs, parsed and validated. */
interface HostMatrix {
  efforts: string[];
  /** the model axis: distinct capability tokens in pecking-order first appearance. */
  models: string[];
  wrapper_driver: { model: string; effort: string };
  driverByModel: Map<string, Driver>;
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
  const { models, driverByModel } = coerceProviders(doc.providers, label);
  // Validate `subagents` for fail-loud parity with the launcher island (a matrix
  // it accepts and the plan silently tolerated would be a confusing divergence),
  // but discard it — the renderer's template inventory comes from the plugin's
  // own subagents.yaml, not the host matrix.
  coerceTokenList(doc.subagents, "subagents", label);
  return {
    efforts: coerceTokenList(doc.efforts, "efforts", label),
    models,
    wrapper_driver: coerceWrapperDriver(doc.wrapper_driver, label),
    driverByModel,
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

/** Fold the provider roster into the model axis + per-model driver. claude
 * membership makes a model native; every other provider makes it wrapped. A model
 * served by claude AND another provider is an ambiguous driver — fail-loud (a
 * model is native XOR wrapped). Two non-claude providers sharing a model is the
 * pecking-order overlap the run-time resolver arbitrates, and is allowed. */
function coerceProviders(
  raw: unknown,
  label: string,
): { models: string[]; driverByModel: Map<string, Driver> } {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      "host matrix `providers` must be a non-empty list",
      label,
    );
  }
  const models: string[] = [];
  const seenModel = new Set<string>();
  const claudeModels = new Set<string>();
  const wrappedModels = new Set<string>();
  const seenProvider = new Set<string>();
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
    if (seenProvider.has(rec.name)) {
      throw new SubagentsConfigError(
        `host matrix provider '${rec.name}' is listed more than once`,
        label,
      );
    }
    seenProvider.add(rec.name);
    for (const cap of coerceProviderModels(rec.models, rec.name, label)) {
      if (!seenModel.has(cap)) {
        seenModel.add(cap);
        models.push(cap);
      }
      (rec.name === "claude" ? claudeModels : wrappedModels).add(cap);
    }
  }
  for (const cap of claudeModels) {
    if (wrappedModels.has(cap)) {
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
  return { models, driverByModel };
}

/** The capability tokens one provider serves. Each entry is a bare token or a
 * one-pair `capability: native-id` alias map; only the capability key feeds the
 * model axis (the native id is a dispatch-time concern the launcher island owns,
 * validated here only for fail-loud parity). */
function coerceProviderModels(
  raw: unknown,
  provider: string,
  label: string,
): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new SubagentsConfigError(
      `host matrix provider '${provider}' models must be a non-empty list`,
      label,
    );
  }
  const caps: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    let capability: string;
    if (typeof item === "string") {
      capability = item;
    } else if (
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      const pairs = Object.entries(item as Record<string, unknown>);
      const alias = pairs[0];
      if (pairs.length !== 1 || alias === undefined) {
        throw new SubagentsConfigError(
          `host matrix provider '${provider}' model alias must be a single 'capability: native-id' pair`,
          label,
        );
      }
      capability = alias[0];
      if (!isMatrixAliasTarget(alias[1])) {
        throw new SubagentsConfigError(
          `host matrix provider '${provider}' alias '${capability}' native id must be '/'-joined [a-z0-9._-] segments (no leading dot, no empty segment)`,
          label,
        );
      }
    } else {
      throw new SubagentsConfigError(
        `host matrix provider '${provider}' model entry must be a token or a one-pair alias map`,
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
  }
  return caps;
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
