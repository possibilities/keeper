// Shared loader for the worker {model × effort} matrix (../subagents.yaml).
//
// One config, two access modes — both routed through parseYamlInput so the
// build-time (disk) and runtime (embedded) copies parse under identical YAML 1.1
// rules:
//   - runtime: `subagentsMatrix()` parses a COMPILE-TIME EMBEDDED snapshot of the
//     config (imported below as text, baked in by `bun build --compile`). The
//     compiled keeper-plan binary runs from an arbitrary cwd with no
//     plugin-relative path, so the embed is load-bearing. Memoized at first call.
//   - build: `loadSubagentsMatrixFromDisk(path)` reads the real file off disk for
//     the template renderer.
//
// Unlike config.loadRoots this has NO safe default: a malformed/absent matrix is
// unrecoverable, so both modes throw a typed SubagentsConfigError. The embedded
// text is imported (not parsed) at module eval, so importing this module never
// parses and never crashes the verb importers — the parse (and any throw) happens
// lazily at the call site inside a verb.
//
// This module is reached from the reconcile-core relative-import closure (via
// src/worker-cell.ts), so it must stay free of direct node:fs / node:os edges
// (test/reconcile-core-depgraph.test.ts pins the boundary; yaml_input.ts holds
// the one grandfathered disk read). The host matrix overlay — which needs both —
// lives in host_matrix.ts, outside the closure.

import embeddedConfig from "../subagents.yaml" with { type: "text" };

import { loadYamlInput, parseYamlInput } from "./yaml_input.ts";

/** Label woven into a runtime parse/validation error. */
const EMBED_LABEL = "subagents.yaml (embedded)";

/** The parsed matrix axes. `subagents` is the template source list the renderer
 * fans out; `efforts` / `models` are the two axes. */
export interface SubagentsMatrix {
  readonly efforts: readonly string[];
  readonly models: readonly string[];
  readonly subagents: readonly string[];
}

/** Loud, typed failure for a malformed/absent matrix config — mirrors the
 * shape-guard intent of scaffold's `tier_invalid`/`bad_yaml` but at the config
 * boundary. Carries the source `label` so a call site can locate the bad file. */
export class SubagentsConfigError extends Error {
  readonly label: string;

  constructor(message: string, label: string) {
    super(message);
    this.name = "SubagentsConfigError";
    this.label = label;
  }
}

/** Validate a parsed document into a SubagentsMatrix. Each axis must be a
 * non-empty list of non-empty strings — this also catches YAML 1.1 scalar
 * coercions (a bare `no`/date is not a string, so it fails loud here). */
function coerceMatrix(parsed: unknown, label: string): SubagentsMatrix {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SubagentsConfigError(
      `subagents config must be a mapping with efforts/models/subagents keys`,
      label,
    );
  }
  const doc = parsed as Record<string, unknown>;
  return {
    efforts: coerceAxis(doc.efforts, "efforts", label),
    models: coerceAxis(doc.models, "models", label),
    subagents: coerceAxis(doc.subagents, "subagents", label),
  };
}

/** A single axis: a non-empty list of non-empty, non-whitespace strings. */
function coerceAxis(raw: unknown, key: string, label: string): string[] {
  if (!Array.isArray(raw)) {
    throw new SubagentsConfigError(
      `subagents config \`${key}\` must be a list`,
      label,
    );
  }
  if (raw.length === 0) {
    throw new SubagentsConfigError(
      `subagents config \`${key}\` must be non-empty`,
      label,
    );
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new SubagentsConfigError(
        `subagents config \`${key}\` entries must be non-empty strings`,
        label,
      );
    }
    out.push(entry);
  }
  return out;
}

/** Parse raw config bytes into a validated matrix. Shared by both access modes
 * so the runtime and disk copies parse identically. */
export function parseSubagentsMatrix(
  raw: Buffer,
  label: string,
): SubagentsMatrix {
  return coerceMatrix(parseYamlInput(raw, label), label);
}

let embeddedMemo: SubagentsMatrix | null = null;

/** The runtime matrix, parsed from the compile-time embedded snapshot. Memoized:
 * the parse runs once, on first call, at a verb call site — never at module eval.
 * Throws SubagentsConfigError / YamlInputError on a malformed embed. */
export function subagentsMatrix(): SubagentsMatrix {
  if (embeddedMemo === null) {
    embeddedMemo = parseSubagentsMatrix(
      Buffer.from(embeddedConfig),
      EMBED_LABEL,
    );
  }
  return embeddedMemo;
}

/** The build-time matrix, read from the real file on disk. For the template
 * renderer, which must fan out over the live config, not a baked snapshot. */
export function loadSubagentsMatrixFromDisk(path: string): SubagentsMatrix {
  return coerceMatrix(loadYamlInput(path), path);
}

/** The workers-base directory (relative to the plan plugin root) under which the
 * renderer fans out one self-contained `work` plugin per {model × effort} cell.
 * A SINGLE shared constant so the template's `render_to:` frontmatter and the
 * launcher's `--plugin-dir` cell selection resolve the same path and can't drift. */
export const WORKERS_BASE = "workers";

/** The per-cell plugin dir (relative to the plan plugin root) for a
 * {model, effort} pair: `workers/<model>-<effort>`. The renderer stamps each cell
 * here via the template's `render_to:`; the launcher selects one here via
 * `--plugin-dir`. Order (model then effort) mirrors the `render_to:` convention. */
export function workerCellDir(model: string, effort: string): string {
  return `${WORKERS_BASE}/${model}-${effort}`;
}

/** Pure {model, effort} → worker-agent-name composition over an explicit model
 * axis + a per-model effort resolver. Returns null on EITHER null axis (the
 * /plan:work null-stop signal); throws the corrupt-on-disk guard for a non-null
 * value outside its axis. The tier is validated against the MODEL's effective
 * effort list (`effortsFor`), so a ragged host roster rejects a tier the model
 * cannot render; an unknown model resolves the top-level fallback, leaving the
 * separate model-membership throw to name it. The axis SOURCE — the embedded
 * snapshot vs the host-effective matrix — is the caller's choice, so this composer
 * stays fs-free and safe for the pure reconcile-core closure. */
export function composeWorkerAgent(
  effortsFor: (model: string) => readonly string[],
  models: readonly string[],
  tier: string | null,
  model: string | null,
): string | null {
  if (tier === null || model === null) {
    return null;
  }
  const efforts = effortsFor(model);
  if (!efforts.includes(tier)) {
    throw new Error(
      `unknown tier ${JSON.stringify(tier)}; expected one of ${efforts.join(", ")} or null`,
    );
  }
  if (!models.includes(model)) {
    throw new Error(
      `unknown model ${JSON.stringify(model)}; expected one of ${models.join(", ")} or null`,
    );
  }
  return `plan:worker-${model}-${tier}`;
}

/** Worker-agent composition against the EMBEDDED snapshot only — the fs-free,
 * closure-safe variant the reconcile verdict path uses to validate a task's
 * {model, effort} cell. The host-effective variant (`workerAgentFor` in models.ts)
 * reads the host matrix and lives OUTSIDE this pure closure; keeping the reconcile
 * path on the embedded axes is what leaves a wrapped host-roster cell to the
 * producer's graceful no-route reject rather than a verdict-path host read. */
export function embeddedWorkerAgentFor(
  tier: string | null,
  model: string | null,
): string | null {
  const matrix = subagentsMatrix();
  // The embedded snapshot is the flat claude base — no per-model overrides — so
  // every model resolves the same global effort axis (the cube stays rectangular).
  return composeWorkerAgent(() => matrix.efforts, matrix.models, tier, model);
}
