// Cross-provider worker-cell equivalence map (ADR 0047) — a strict plan-island
// parser + pure check/state cores for `../provider-equivalence.yaml`, mirroring
// model-guidance-check.ts's coerce/check/state split. `keeper autopilot config
// worker_provider` reads the committed map at dispatch to translate an
// assigned cell into the pinned provider family; this module owns parsing and
// drift detection ONLY — the runtime translation seam is a separate consumer.
//
// The parser is DELIBERATELY strict (not the permissive coercer pattern used
// elsewhere): it rejects an unknown key at every level, a non-canonical
// effort, and a malformed target shape, so a typo in the committed map fails
// loud rather than silently mistranslating a dispatch. Each direction is a
// LIST of `{source, target}` entries rather than a nested map — YAML's
// duplicate-key handling (`parseYamlInput`'s `uniqueKeys: false`) silently
// last-wins a nested map, which would make a duplicate source cell
// undetectable; a list lets `checkProviderEquivalence` catch it structurally.
//
// `checkProviderEquivalence` is HOST-BLIND (no host matrix read): it validates
// the map's own internal shape — no same-family target, every target model a
// source model of the OPPOSITE direction (the opposite-family proxy), every
// source model covering all five canonical efforts, no duplicate source cell.
// `classifyProviderEquivalence` reads the live host matrix's dispatchable
// cells (`loadHostMatrixV2`) and classifies totality in both directions plus
// target validity against the live roster — the axis-coverage counterpart to
// `classifyModelGuidance`.

import { join, resolve } from "node:path";

import {
  CANONICAL_EFFORTS,
  type EffectiveMatrix,
  effectiveMatrix,
} from "./host_matrix.ts";
import { loadYamlInput } from "./yaml_input.ts";

/** Plan plugin root — provider-equivalence.yaml sits here. */
export const PLAN_ROOT = resolve(import.meta.dir, "..");

const CANONICAL_EFFORT_SET: ReadonlySet<string> = new Set(CANONICAL_EFFORTS);

/** The model-token charset (mirrors host_matrix.ts's MATRIX_TOKEN_RE): lowercase
 * alnum, hyphen, underscore, dot, no leading dot — so a dotted capability id
 * like `gpt-5.5` is valid while a path-escape or scalar-coerced value fails
 * loud. Not exported from host_matrix.ts, so re-declared here (the plan
 * island's own small parser, same discipline as host_matrix.ts's own header). */
const MODEL_TOKEN_RE = /^[a-z0-9._-]+$/;
function isModelToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    MODEL_TOKEN_RE.test(value) &&
    !value.startsWith(".")
  );
}

/** The two authored equivalence directions. Independently authored — never
 * inverses of one another. */
export type EquivalenceDirection = "claude_to_gpt" | "gpt_to_claude";
export const EQUIVALENCE_DIRECTIONS: readonly EquivalenceDirection[] = [
  "claude_to_gpt",
  "gpt_to_claude",
];

/** One `{model, effort}` cell — a source or a target. */
export interface EquivalenceCell {
  readonly model: string;
  readonly effort: string;
}

/** One authored mapping entry: a source cell and its most-equivalent target. */
export interface EquivalenceEntry {
  readonly source: EquivalenceCell;
  readonly target: EquivalenceCell;
}

/** The parsed provider-equivalence config. */
export interface ProviderEquivalenceConfig {
  readonly schema_version: 1;
  readonly mappings: Record<EquivalenceDirection, readonly EquivalenceEntry[]>;
}

/** Loud, typed failure for a structurally malformed config. */
export class ProviderEquivalenceConfigError extends Error {
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

/** Coerce a `{model, effort}` cell — no unknown keys, a valid model token, and
 * an effort in the canonical five-rung vocabulary. */
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
      `${label}.effort '${doc.effort}' is not in the canonical effort vocabulary [${CANONICAL_EFFORTS.join(", ")}]`,
    );
  }
  return { model: doc.model, effort: doc.effort };
}

/** Coerce one `{source, target}` mapping entry — no unknown keys, both cells
 * required and well-formed. */
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

/** Coerce one direction's entry list. A direction is a LIST (not a nested map)
 * precisely so a duplicate source cell stays structurally detectable —
 * `parseYamlInput` disables duplicate-key rejection, so a nested map would
 * silently last-win a repeated key before this parser ever saw it. */
function coerceDirection(raw: unknown, label: string): EquivalenceEntry[] {
  if (!Array.isArray(raw)) {
    throw new ProviderEquivalenceConfigError(
      `${label} must be a list of {source, target} entries`,
    );
  }
  return raw.map((entry, i) => coerceEntry(entry, `${label}[${i}]`));
}

/** Validate a parsed document into a ProviderEquivalenceConfig. Throws on any
 * structural violation — an unknown key at any level, a non-canonical effort,
 * or a malformed target shape — so a broken map fails loud rather than
 * silently reaching the totality/proxy checks incomplete. */
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

/** Read + parse the config off disk through the shared YAML 1.1 loader. */
export function loadProviderEquivalenceConfig(
  path: string,
): ProviderEquivalenceConfig {
  return coerceProviderEquivalenceConfig(loadYamlInput(path));
}

/** report-or-exit result, matching model-guidance-check's GuidanceCheckResult. */
export interface EquivalenceCheckResult {
  readonly ok: boolean;
  readonly errors: string[];
}

function cellKey(cell: EquivalenceCell): string {
  return `${cell.model}::${cell.effort}`;
}

function otherDirection(direction: EquivalenceDirection): EquivalenceDirection {
  return direction === "claude_to_gpt" ? "gpt_to_claude" : "claude_to_gpt";
}

/** The pure, host-blind check core: no same-family target, every target model
 * a source model of the OPPOSITE direction (the opposite-family proxy), every
 * source model covering all five canonical efforts (host-blind totality), and
 * no duplicate source cell within a direction. Returns accumulated errors so
 * callers report all drift at once. */
export function checkProviderEquivalence(
  config: ProviderEquivalenceConfig,
): EquivalenceCheckResult {
  const errors: string[] = [];
  const sourceModelsByDirection: Record<EquivalenceDirection, Set<string>> = {
    claude_to_gpt: new Set(
      config.mappings.claude_to_gpt.map((e) => e.source.model),
    ),
    gpt_to_claude: new Set(
      config.mappings.gpt_to_claude.map((e) => e.source.model),
    ),
  };

  for (const direction of EQUIVALENCE_DIRECTIONS) {
    const entries = config.mappings[direction];
    const ownSourceModels = sourceModelsByDirection[direction];
    const otherSourceModels =
      sourceModelsByDirection[otherDirection(direction)];

    const seenSource = new Set<string>();
    const effortsByModel = new Map<string, Set<string>>();
    for (const entry of entries) {
      const key = cellKey(entry.source);
      if (seenSource.has(key)) {
        errors.push(
          `${direction}: duplicate source cell {model: ${entry.source.model}, effort: ${entry.source.effort}}`,
        );
      }
      seenSource.add(key);

      if (ownSourceModels.has(entry.target.model)) {
        errors.push(
          `${direction}: target model '${entry.target.model}' is same-family (also a source model in ${direction}) for source {model: ${entry.source.model}, effort: ${entry.source.effort}}`,
        );
      }
      if (!otherSourceModels.has(entry.target.model)) {
        errors.push(
          `${direction}: target model '${entry.target.model}' is not a source model in ${otherDirection(direction)} (dangling cross-direction target) for source {model: ${entry.source.model}, effort: ${entry.source.effort}}`,
        );
      }

      const set = effortsByModel.get(entry.source.model) ?? new Set<string>();
      set.add(entry.source.effort);
      effortsByModel.set(entry.source.model, set);
    }

    for (const [model, efforts] of effortsByModel) {
      for (const effort of CANONICAL_EFFORTS) {
        if (!efforts.has(effort)) {
          errors.push(
            `${direction}: model '${model}' has no mapping for effort '${effort}' (missing effort)`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Run the host-blind check against the on-disk map. */
export function checkProviderEquivalenceFromDisk(
  planRoot: string = PLAN_ROOT,
): EquivalenceCheckResult {
  const config = loadProviderEquivalenceConfig(
    join(planRoot, "provider-equivalence.yaml"),
  );
  return checkProviderEquivalence(config);
}

// ---------------------------------------------------------------------------
// State mode — totality + target validity against the live host matrix's
// dispatchable cells, parallel to classifyModelGuidance.
// ---------------------------------------------------------------------------

/** A dispatchable {model, effort} cell with no entry in the direction its
 * family requires — the gap `--state` reports "in the right direction". */
export interface EquivalenceGap {
  readonly direction: EquivalenceDirection;
  readonly model: string;
  readonly effort: string;
}

/** A mapping entry whose target does not resolve on the live host matrix. */
export interface DanglingEquivalenceTarget {
  readonly direction: EquivalenceDirection;
  readonly source: EquivalenceCell;
  readonly target: EquivalenceCell;
  readonly reason: "target-not-on-host" | "target-effort-not-on-host";
}

/** The full equivalence state envelope: total iff no gap and no dangling
 * target. */
export interface EquivalenceStateResult {
  readonly total: boolean;
  readonly gaps: readonly EquivalenceGap[];
  readonly dangling_targets: readonly DanglingEquivalenceTarget[];
}

/** Classify the map's totality (both directions, against the live matrix's
 * dispatchable cells) and target validity. A model's dispatchable cell
 * (`model × effortsFor(model)`) requires an entry in `claude_to_gpt` when the
 * matrix drives it natively, else `gpt_to_claude` — a gap absent from that
 * direction is reported with the direction it belongs in. Every mapping
 * entry's target must resolve to a live matrix model + effort. */
export function classifyProviderEquivalence(
  config: ProviderEquivalenceConfig,
  matrix: EffectiveMatrix,
): EquivalenceStateResult {
  const bySourceKey: Record<EquivalenceDirection, Set<string>> = {
    claude_to_gpt: new Set(
      config.mappings.claude_to_gpt.map((e) => cellKey(e.source)),
    ),
    gpt_to_claude: new Set(
      config.mappings.gpt_to_claude.map((e) => cellKey(e.source)),
    ),
  };

  const gaps: EquivalenceGap[] = [];
  for (const model of matrix.models) {
    const direction: EquivalenceDirection =
      matrix.driverFor(model) === "native" ? "claude_to_gpt" : "gpt_to_claude";
    for (const effort of matrix.effortsFor(model)) {
      if (!bySourceKey[direction].has(`${model}::${effort}`)) {
        gaps.push({ direction, model, effort });
      }
    }
  }

  const modelsOnHost = new Set(matrix.models);
  const dangling: DanglingEquivalenceTarget[] = [];
  for (const direction of EQUIVALENCE_DIRECTIONS) {
    for (const entry of config.mappings[direction]) {
      if (!modelsOnHost.has(entry.target.model)) {
        dangling.push({
          direction,
          source: entry.source,
          target: entry.target,
          reason: "target-not-on-host",
        });
        continue;
      }
      if (
        !matrix.effortsFor(entry.target.model).includes(entry.target.effort)
      ) {
        dangling.push({
          direction,
          source: entry.source,
          target: entry.target,
          reason: "target-effort-not-on-host",
        });
      }
    }
  }

  return {
    total: gaps.length === 0 && dangling.length === 0,
    gaps,
    dangling_targets: dangling,
  };
}

/** Run the state classifier against the on-disk map + the live host matrix
 * (the state-mode parallel of checkProviderEquivalenceFromDisk). */
export function classifyProviderEquivalenceFromDisk(
  planRoot: string = PLAN_ROOT,
): EquivalenceStateResult {
  const config = loadProviderEquivalenceConfig(
    join(planRoot, "provider-equivalence.yaml"),
  );
  return classifyProviderEquivalence(config, effectiveMatrix());
}
