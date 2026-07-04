#!/usr/bin/env bun
// Drift gate for the selector policy config (../model-selector.yaml), mirroring
// the vendor-corpus report-or-exit shape.
//
//   bun plugins/plan/scripts/model-guidance-check.ts --check   (default) verify
//
// Two invariants, both self-contained (no network, pure disk reads):
//   (a) coverage, both directions — every subagents.yaml axis value (efforts AND
//       models, read from DISK via the loader's disk mode) has exactly one
//       guidance block in model-selector.yaml, and no block exists for a
//       non-axis value.
//   (b) hash parity — every configured model has a research entry whose recorded
//       sha256 matches the current references/ cache file, and every research
//       entry names a configured model.
//
// The check core (`checkModelGuidance`) is a pure function over already-loaded
// data so the fast suite drives its failure modes in-process; `--check` wires it
// to disk. The model-guidance skill OWNS the config content — this only verifies.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadSubagentsMatrixFromDisk } from "../src/subagents_config.ts";
import { loadYamlInput } from "../src/yaml_input.ts";

/** Plan plugin root — model-selector.yaml and subagents.yaml sit here. */
export const PLAN_ROOT = resolve(import.meta.dir, "..");

/** One research-provenance entry: a references/ cache file + its content hash. */
export interface ResearchEntry {
  readonly reference: string;
  readonly sha256: string;
}

/** The parsed selector policy config. */
export interface ModelSelectorConfig {
  readonly selector: { harness: string; model: string };
  readonly usage: string;
  readonly efforts: Record<string, string>;
  readonly models: Record<string, string>;
  readonly research: Record<string, ResearchEntry>;
}

/** report-or-exit result, matching vendor.ts VerifyResult. */
export interface GuidanceCheckResult {
  readonly ok: boolean;
  readonly errors: string[];
}

/** Loud, typed failure for a structurally malformed config. */
export class ModelSelectorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSelectorConfigError";
  }
}

function asMapping(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelSelectorConfigError(`${label} must be a mapping`);
  }
  return raw as Record<string, unknown>;
}

function asString(raw: unknown, label: string): string {
  if (typeof raw !== "string") {
    throw new ModelSelectorConfigError(`${label} must be a string`);
  }
  return raw;
}

/** Coerce a mapping of string→string (the efforts / models guidance blocks). */
function asStringRecord(raw: unknown, label: string): Record<string, string> {
  const doc = asMapping(raw, label);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(doc)) {
    out[key] = asString(value, `${label}.${key}`);
  }
  return out;
}

/** Validate a parsed document into a ModelSelectorConfig. Throws on any
 * structural violation so a broken config fails loud rather than silently
 * passing the coverage/hash checks with missing sections. */
export function coerceModelSelectorConfig(
  parsed: unknown,
): ModelSelectorConfig {
  const doc = asMapping(parsed, "model-selector config");
  const selector = asMapping(doc.selector, "selector");
  const research: Record<string, ResearchEntry> = {};
  for (const [model, entry] of Object.entries(
    asMapping(doc.research, "research"),
  )) {
    const e = asMapping(entry, `research.${model}`);
    research[model] = {
      reference: asString(e.reference, `research.${model}.reference`),
      sha256: asString(e.sha256, `research.${model}.sha256`),
    };
  }
  return {
    selector: {
      harness: asString(selector.harness, "selector.harness"),
      model: asString(selector.model, "selector.model"),
    },
    usage: asString(doc.usage, "usage"),
    efforts: asStringRecord(doc.efforts, "efforts"),
    models: asStringRecord(doc.models, "models"),
    research,
  };
}

/** Read + parse the config off disk through the shared YAML 1.1 loader. */
export function loadModelSelectorConfig(path: string): ModelSelectorConfig {
  return coerceModelSelectorConfig(loadYamlInput(path));
}

/** Both-directions coverage between an axis and its guidance-block keys. */
function coverageErrors(
  label: string,
  axis: readonly string[],
  blocks: readonly string[],
): string[] {
  const errors: string[] = [];
  const axisSet = new Set(axis);
  const blockSet = new Set(blocks);
  for (const value of axis) {
    if (!blockSet.has(value)) {
      errors.push(
        `${label}: no guidance block for configured axis value "${value}"`,
      );
    }
  }
  for (const value of blocks) {
    if (!axisSet.has(value)) {
      errors.push(
        `${label}: guidance block "${value}" is not a configured axis value`,
      );
    }
  }
  return errors;
}

/** Inputs to the pure check — axes + config + a hash resolver, no disk access. */
export interface GuidanceCheckInput {
  readonly efforts: readonly string[];
  readonly models: readonly string[];
  readonly config: ModelSelectorConfig;
  /** Actual sha256 of a reference path (relative to plan root), null if absent. */
  readonly referenceHash: (reference: string) => string | null;
}

/** The pure check core: coverage (both directions, both axes) + research hash
 * parity. Returns accumulated errors so callers report all drift at once. */
export function checkModelGuidance(input: GuidanceCheckInput): GuidanceCheckResult {
  const errors: string[] = [];
  errors.push(
    ...coverageErrors("efforts", input.efforts, Object.keys(input.config.efforts)),
  );
  errors.push(
    ...coverageErrors("models", input.models, Object.keys(input.config.models)),
  );

  const modelSet = new Set(input.models);
  for (const model of input.models) {
    if (!(model in input.config.research)) {
      errors.push(`research: no research entry for configured model "${model}"`);
    }
  }
  for (const [model, entry] of Object.entries(input.config.research)) {
    if (!modelSet.has(model)) {
      errors.push(`research: entry "${model}" is not a configured model`);
      continue;
    }
    const actual = input.referenceHash(entry.reference);
    if (actual === null) {
      errors.push(
        `research: ${model} reference "${entry.reference}" is missing on disk`,
      );
    } else if (actual !== entry.sha256) {
      errors.push(
        `research: ${model} recorded sha256 ${entry.sha256} does not match file ${actual} (${entry.reference})`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/** A disk-backed hash resolver rooted at `planRoot`. */
export function referenceHashFromDisk(
  planRoot: string,
): (reference: string) => string | null {
  return (reference) => {
    const p = join(planRoot, reference);
    if (!existsSync(p)) {
      return null;
    }
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  };
}

/** Run the full check against the on-disk config + subagents axes. */
export function checkModelGuidanceFromDisk(
  planRoot: string = PLAN_ROOT,
): GuidanceCheckResult {
  const matrix = loadSubagentsMatrixFromDisk(join(planRoot, "subagents.yaml"));
  const config = loadModelSelectorConfig(join(planRoot, "model-selector.yaml"));
  return checkModelGuidance({
    efforts: matrix.efforts,
    models: matrix.models,
    config,
    referenceHash: referenceHashFromDisk(planRoot),
  });
}

function reportOrExit(result: GuidanceCheckResult): void {
  if (result.ok) {
    process.stdout.write(
      "model-guidance-check: config matches subagents axes; research hashes match references/\n",
    );
    return;
  }
  process.stderr.write("model-guidance-check: selector config drifted:\n");
  for (const e of result.errors) {
    process.stderr.write(`  - ${e}\n`);
  }
  process.exit(1);
}

function main(argv: string[]): void {
  // `--check` is the only (and default) mode; the model-guidance skill authors.
  if (argv.length > 0 && !argv.includes("--check")) {
    process.stderr.write(
      `model-guidance-check: unknown argument(s) ${argv.join(" ")} (only --check)\n`,
    );
    process.exit(2);
  }
  reportOrExit(checkModelGuidanceFromDisk());
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
