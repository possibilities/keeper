/**
 * The launcher-island loader for the cross-provider worker-cell equivalence map
 * (`plugins/plan/provider-equivalence.yaml`, ADR 0047) — the dep-free root-island
 * counterpart to the plan island's `plugins/plan/src/provider_equivalence.ts`,
 * mirroring the dual `matrix.yaml` parser precedent (`src/agent/matrix.ts` vs
 * `plugins/plan/src/host_matrix.ts`). The daemon's dispatch path must never
 * reach into the plan package's `yaml` dep, so it re-parses the committed map
 * here through the launcher's own Bun.YAML seam. `test/provider-equivalence.test.ts`
 * pins both parsers to the same reduction (cross-island parity).
 *
 * The parser is DELIBERATELY strict (rejects an unknown key at every level, a
 * non-canonical effort, a malformed cell shape) so a typo in the committed map
 * fails loud rather than silently mistranslating a dispatch. Each direction is a
 * LIST of `{source, target}` entries, not a nested map, so a duplicate source
 * cell stays a structural fact rather than a last-wins YAML swallow.
 *
 * DEP-FREE ISLAND: imports only `node:*` + the sibling launcher config/harness
 * islands — never `src/db.ts` (bun:sqlite), never `reconcile-core` as a value
 * (only its runtime translation types, type-only). The pure runtime translation
 * `applyProviderConstraint` lives in `reconcile-core` (the re-fold-safe verdict
 * core the depgraph pin forbids from value-importing this fs-touching loader);
 * this module owns parsing + the reduced runtime `ProviderEquivalenceMap` ONLY,
 * built PRODUCER-SIDE once per cycle and threaded onto the reconcile snapshot.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, parseYaml } from "./agent/config";
import { KEEPER_EFFORTS } from "./agent/harness";

const CANONICAL_EFFORT_SET: ReadonlySet<string> = new Set(KEEPER_EFFORTS);

/** One `{model, effort}` worker cell — a source, a target, or an assigned/
 *  effective dispatch cell. The atom the translation reads + returns. */
export interface EquivalenceCell {
  readonly model: string;
  readonly effort: string;
}

/** The pinned provider FAMILY (`autopilot_state.worker_provider`), NON-null: the
 *  translation runs only when a pin is set, so this carries the two active
 *  members while the unconstrained default (NULL) is modeled as `WorkerProvider |
 *  null` at the read sites. */
export type WorkerProvider = "claude" | "gpt";

/**
 * The TRI-STATE of a `worker_provider` pin read, which NEVER collapses UNKNOWN to
 * ABSENT: `absent` is a genuine "no pin configured" (pass through, dispatch the
 * assigned cell), `value` is the observed pin, and `unknown` is an UNOBSERVABLE
 * authority — a present-but-invalid non-null cell, or (mapped at the read site) a
 * read that THREW. A cell-bearing work launch that cannot observe the durable pin
 * REFUSES rather than silently dispatching the unpinned assigned cell.
 */
export type ProviderPinRead =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly provider: WorkerProvider }
  | { readonly kind: "unknown"; readonly detail: string };

/** Tri-state a SUCCESSFULLY-read `autopilot_state.worker_provider` cell: a null /
 *  undefined cell is `absent`, `"claude"` / `"gpt"` is the pinned `value`, and ANY
 *  other present non-null value is `unknown` (present-but-invalid — never silently
 *  the unpinned default). A read that THROWS is `unknown` too, mapped by the caller
 *  wrapping its own read. The SINGLE classifier the manual dispatch path and the
 *  daemon block-owner redispatch share so their pin authority never drifts. Pure. */
export function classifyProviderPin(raw: unknown): ProviderPinRead {
  if (raw === null || raw === undefined) return { kind: "absent" };
  if (raw === "claude" || raw === "gpt")
    return { kind: "value", provider: raw };
  return {
    kind: "unknown",
    detail: `present but invalid worker_provider value ${JSON.stringify(raw)}`,
  };
}

/**
 * The reduced runtime lookup the pure `applyProviderConstraint` reads — built
 * PRODUCER-SIDE once per cycle from the parsed config and threaded onto the
 * reconcile snapshot (the {@link ProviderEquivalenceSnapshot} field), mirroring
 * the `HostMatrixAxes` reduction. Per-direction NESTED `model → effort → target`
 * maps (no flat string key to drift against the consumer) plus each direction's
 * source-model set — the host-blind family membership the translation keys
 * "already in the pinned family" on.
 */
export interface ProviderEquivalenceMap {
  /** claude-family source `model → effort → gpt-family target`. */
  readonly claudeToGpt: ReadonlyMap<
    string,
    ReadonlyMap<string, EquivalenceCell>
  >;
  /** gpt-family source `model → effort → claude-family target`. */
  readonly gptToClaude: ReadonlyMap<
    string,
    ReadonlyMap<string, EquivalenceCell>
  >;
  /** The claude-family models — source models of `claude_to_gpt`. */
  readonly claudeFamilyModels: ReadonlySet<string>;
  /** The gpt-family models — source models of `gpt_to_claude`. */
  readonly gptFamilyModels: ReadonlySet<string>;
}

/**
 * The discriminated map field the reconcile cycle carries: the reduced runtime
 * map on a clean parse, or a typed failure the pure translation turns into a
 * per-cell `map-malformed` reject. Built PRODUCER-SIDE in `loadReconcileSnapshot`
 * (only when a pin is active), NEVER a fold input — mirroring `HostMatrixSnapshot`.
 */
export type ProviderEquivalenceSnapshot =
  | { readonly ok: true; readonly map: ProviderEquivalenceMap }
  | { readonly ok: false; readonly detail: string };

/**
 * The three fail-closed reject reasons a translation can refuse a dispatch with —
 * distinct so an operator sees WHICH of the map's totality invariants broke at
 * runtime (the drift gate is offline, so a stale map fails per-cell here):
 *  - `no-map-entry`      — the cross-family assigned cell has no mapping entry;
 *  - `target-not-on-host`— the mapped target cell is not dispatchable on the live host matrix;
 *  - `map-malformed`     — the committed map failed to parse/load.
 * No reject ever falls back to the assigned provider.
 */
export type ProviderConstraintRejectReason =
  | "no-map-entry"
  | "target-not-on-host"
  | "map-malformed";

/**
 * The pure translation verdict (`applyProviderConstraint`): the assigned cell is
 * already in the pinned family (`unchanged`, a byte-identical no-op), translates
 * to its mapped equivalent (`translated`), or refuses (`reject`) carrying enough
 * machine fields for a caller to name the cells + direction in operator prose.
 */
export type ProviderConstraintResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "translated"; readonly cell: EquivalenceCell }
  | {
      readonly kind: "reject";
      readonly reason: ProviderConstraintRejectReason;
      readonly provider: WorkerProvider;
      readonly direction: EquivalenceDirection;
      readonly assigned: EquivalenceCell;
      /** The mapped target — present for `target-not-on-host`, else null. */
      readonly target: EquivalenceCell | null;
      /** The parse failure detail — present for `map-malformed`, else absent. */
      readonly detail?: string;
    };

/** The model-token charset (mirrors host_matrix.ts's MATRIX_TOKEN_RE): lowercase
 *  alnum, hyphen, underscore, dot, no leading dot — a dotted capability id like
 *  `gpt-5.5` passes while a path-escape or coerced scalar fails loud. */
const MODEL_TOKEN_RE = /^[a-z0-9._-]+$/;
function isModelToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    MODEL_TOKEN_RE.test(value) &&
    !value.startsWith(".")
  );
}

/** The two authored equivalence directions — independently authored, never
 *  inverses of one another. */
export type EquivalenceDirection = "claude_to_gpt" | "gpt_to_claude";
export const EQUIVALENCE_DIRECTIONS: readonly EquivalenceDirection[] = [
  "claude_to_gpt",
  "gpt_to_claude",
];

/** One authored mapping entry: a source cell and its most-equivalent target. */
export interface EquivalenceEntry {
  readonly source: EquivalenceCell;
  readonly target: EquivalenceCell;
}

/** The parsed provider-equivalence config — the SAME reduction shape the plan
 *  island's parser produces (the cross-island parity contract). */
export interface ProviderEquivalenceConfig {
  readonly schema_version: 1;
  readonly mappings: Record<EquivalenceDirection, readonly EquivalenceEntry[]>;
}

/** Loud, typed failure for a structurally malformed config. */
export class ProviderEquivalenceConfigError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderEquivalenceConfigError";
  }
}

function asMapping(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProviderEquivalenceConfigError(`${label} must be a mapping`);
  }
  return raw as Record<string, unknown>;
}

function rejectUnknownKeys(
  doc: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(doc)) {
    if (!allowed.includes(key)) {
      throw new ProviderEquivalenceConfigError(
        `${label} has unknown key '${key}' (allowed: ${allowed.join(", ")})`,
      );
    }
  }
}

/** Coerce a `{model, effort}` cell — no unknown keys, a valid model token, an
 *  effort in the canonical five-rung vocabulary. */
function coerceCell(raw: unknown, label: string): EquivalenceCell {
  const doc = asMapping(raw, label);
  rejectUnknownKeys(doc, ["model", "effort"], label);
  if (!isModelToken(doc.model)) {
    throw new ProviderEquivalenceConfigError(
      `${label}.model must be a valid token (got ${JSON.stringify(doc.model)})`,
    );
  }
  if (typeof doc.effort !== "string" || !CANONICAL_EFFORT_SET.has(doc.effort)) {
    throw new ProviderEquivalenceConfigError(
      `${label}.effort '${doc.effort}' is not in the canonical effort vocabulary [${KEEPER_EFFORTS.join(", ")}]`,
    );
  }
  return { model: doc.model, effort: doc.effort };
}

/** Coerce one `{source, target}` mapping entry — no unknown keys, both cells
 *  required and well-formed. */
function coerceEntry(raw: unknown, label: string): EquivalenceEntry {
  const doc = asMapping(raw, label);
  rejectUnknownKeys(doc, ["source", "target"], label);
  if (doc.source === undefined) {
    throw new ProviderEquivalenceConfigError(`${label}.source is required`);
  }
  if (doc.target === undefined) {
    throw new ProviderEquivalenceConfigError(`${label}.target is required`);
  }
  return {
    source: coerceCell(doc.source, `${label}.source`),
    target: coerceCell(doc.target, `${label}.target`),
  };
}

/** Coerce one direction's entry LIST (not a nested map — so a duplicate source
 *  cell stays structurally detectable). */
function coerceDirection(raw: unknown, label: string): EquivalenceEntry[] {
  if (!Array.isArray(raw)) {
    throw new ProviderEquivalenceConfigError(
      `${label} must be a list of {source, target} entries`,
    );
  }
  return raw.map((entry, i) => coerceEntry(entry, `${label}[${i}]`));
}

/** Validate a parsed document into a ProviderEquivalenceConfig. Throws on any
 *  structural violation — an unknown key, a non-canonical effort, a malformed
 *  cell shape — so a broken map fails loud. */
export function coerceProviderEquivalenceConfig(
  parsed: unknown,
): ProviderEquivalenceConfig {
  const doc = asMapping(parsed, "provider-equivalence config");
  rejectUnknownKeys(
    doc,
    ["schema_version", "mappings"],
    "provider-equivalence config",
  );
  if (doc.schema_version !== 1) {
    throw new ProviderEquivalenceConfigError(
      `provider-equivalence config \`schema_version\` must be exactly 1 (got ${JSON.stringify(doc.schema_version)})`,
    );
  }
  const mappingsDoc = asMapping(doc.mappings, "mappings");
  rejectUnknownKeys(
    mappingsDoc,
    ["claude_to_gpt", "gpt_to_claude"],
    "mappings",
  );
  return {
    schema_version: 1,
    mappings: {
      claude_to_gpt: coerceDirection(
        mappingsDoc.claude_to_gpt,
        "mappings.claude_to_gpt",
      ),
      gpt_to_claude: coerceDirection(
        mappingsDoc.gpt_to_claude,
        "mappings.gpt_to_claude",
      ),
    },
  };
}

/** The keeper repo root — derived from THIS module's location (`src/…` → `..`),
 *  env-overridable via `KEEPER_ROOT` (tests + a non-default checkout), mirroring
 *  reconcile-core's own derive. Kept local so this dep-free island never
 *  value-imports the reconcile-core module graph. */
function keeperRoot(): string {
  const raw = process.env.KEEPER_ROOT;
  if (raw != null && raw !== "") {
    return raw;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The committed map's on-disk path (`<repo>/plugins/plan/provider-equivalence.yaml`). */
export function defaultProviderEquivalencePath(): string {
  return join(keeperRoot(), "plugins", "plan", "provider-equivalence.yaml");
}

/** Read + parse the committed map off disk through the launcher's Bun.YAML seam.
 *  Throws a typed error on a read failure or a structural violation. */
export function loadProviderEquivalenceConfig(
  path: string = defaultProviderEquivalencePath(),
): ProviderEquivalenceConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ProviderEquivalenceConfigError(
      `cannot read provider-equivalence map at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return coerceProviderEquivalenceConfig(parseYaml(text));
}

/** Reduce a parsed config into the runtime lookup the pure translation reads:
 *  per-direction nested `model → effort → target` maps (no string key to drift
 *  against the consumer) plus each direction's source-model set (the host-blind
 *  family membership `applyProviderConstraint` keys "already in the pinned
 *  family" on). Pure. */
export function buildProviderEquivalenceMap(
  config: ProviderEquivalenceConfig,
): ProviderEquivalenceMap {
  const build = (
    entries: readonly EquivalenceEntry[],
  ): Map<string, Map<string, EquivalenceCell>> => {
    const byModel = new Map<string, Map<string, EquivalenceCell>>();
    for (const entry of entries) {
      let byEffort = byModel.get(entry.source.model);
      if (byEffort === undefined) {
        byEffort = new Map<string, EquivalenceCell>();
        byModel.set(entry.source.model, byEffort);
      }
      byEffort.set(entry.source.effort, entry.target);
    }
    return byModel;
  };
  return {
    claudeToGpt: build(config.mappings.claude_to_gpt),
    gptToClaude: build(config.mappings.gpt_to_claude),
    claudeFamilyModels: new Set(
      config.mappings.claude_to_gpt.map((e) => e.source.model),
    ),
    gptFamilyModels: new Set(
      config.mappings.gpt_to_claude.map((e) => e.source.model),
    ),
  };
}

/** Load the committed map into the discriminated runtime snapshot the reconcile
 *  cycle threads to the pure translation — `{ok:true, map}` on a clean parse,
 *  `{ok:false, detail}` on ANY read/parse/structural failure. FAIL-CLOSED by
 *  contract: a stale or broken map at runtime (the drift gate is offline) becomes
 *  a per-cell launch reject (`map-malformed`), NEVER a thrown cycle crash. */
export function loadProviderEquivalenceSnapshot(
  path: string = defaultProviderEquivalencePath(),
): ProviderEquivalenceSnapshot {
  try {
    return {
      ok: true,
      map: buildProviderEquivalenceMap(loadProviderEquivalenceConfig(path)),
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
