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
import { loadYamlInput, parseYamlInput } from "../src/yaml_input.ts";

/** Plan plugin root — model-selector.yaml and subagents.yaml sit here. */
export const PLAN_ROOT = resolve(import.meta.dir, "..");

/** One research-provenance entry: a references/ cache file + its content hash. */
export interface ResearchEntry {
  readonly reference: string;
  readonly sha256: string;
}

/** Provenance for the efforts guidance blocks as a whole — the effort axis has
 * no per-value research cache, so one review stamp covers the set. Only the
 * exact string `researched` reads as reviewed guidance in `--state`. */
export interface EffortsProvenance {
  readonly status: string;
  /** Last-reviewed date as a string (a YAML date is tolerated), null if absent. */
  readonly last_reviewed: string | null;
}

/** The parsed selector policy config. */
export interface ModelSelectorConfig {
  readonly selector: { harness: string; model: string };
  readonly usage: string;
  /** Human-owned binding routing policy carried verbatim in every selector
   * brief. Retained through coercion so a silent drop can never pass the gate. */
  readonly hand_tuned: string;
  readonly efforts: Record<string, string>;
  readonly models: Record<string, string>;
  readonly research: Record<string, ResearchEntry>;
  /** Optional efforts-axis provenance, fail-closed to a stub stamp when the key
   * is absent. Read ONLY by the state classifier — never the `--check` core. */
  readonly efforts_provenance?: EffortsProvenance;
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

/** Coerce a YAML date-ish field to a string. A YAML 1.1 timestamp parses to a JS
 * Date, so tolerate a Date (emit its ISO date) and a plain string; anything
 * absent or coerced reads as null. */
function dateFieldToString(raw: unknown): string | null {
  if (raw instanceof Date) {
    return raw.toISOString().slice(0, 10);
  }
  return typeof raw === "string" ? raw : null;
}

/** Coerce the optional `efforts_provenance` block fail-closed — never throws, so
 * the state classifier stays total. A non-mapping, an absent status, or a
 * coerced (non-string) status all read as a `stub` stamp. */
function coerceEffortsProvenance(raw: unknown): EffortsProvenance {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: "stub", last_reviewed: null };
  }
  const doc = raw as Record<string, unknown>;
  return {
    status: typeof doc.status === "string" ? doc.status : "stub",
    last_reviewed: dateFieldToString(doc.last_reviewed),
  };
}

/** Validate a parsed document into a ModelSelectorConfig. Throws on any
 * structural violation so a broken config fails loud rather than silently
 * passing the coverage/hash checks with missing sections. The optional
 * `efforts_provenance` block is the one exception — it coerces fail-closed
 * (never throws) so the state classifier reading it stays total. */
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
    hand_tuned: asString(doc.hand_tuned, "hand_tuned"),
    efforts: asStringRecord(doc.efforts, "efforts"),
    models: asStringRecord(doc.models, "models"),
    research,
    efforts_provenance: coerceEffortsProvenance(doc.efforts_provenance),
  };
}

/** Read + parse the config off disk through the shared YAML 1.1 loader. */
export function loadModelSelectorConfig(path: string): ModelSelectorConfig {
  return coerceModelSelectorConfig(loadYamlInput(path));
}

/** Coverage between an axis and its guidance-block keys. The forward direction
 * (every axis value has a block) always holds. The reverse direction (no block
 * beyond the axis) holds only when `allowExtraBlocks` is false: the models axis
 * tolerates extra blocks because the committed config pre-provisions guidance for
 * host-roster capability models absent from the embedded axis, and the runtime
 * selection-brief seam — not this host-blind gate — enforces effective-matrix
 * coverage. The efforts axis keeps exact both-directions parity. */
function coverageErrors(
  label: string,
  axis: readonly string[],
  blocks: readonly string[],
  allowExtraBlocks = false,
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
  if (!allowExtraBlocks) {
    for (const value of blocks) {
      if (!axisSet.has(value)) {
        errors.push(
          `${label}: guidance block "${value}" is not a configured axis value`,
        );
      }
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
    ...coverageErrors(
      "models",
      input.models,
      Object.keys(input.config.models),
      true,
    ),
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

// ---------------------------------------------------------------------------
// Guidance STATE mode — a pure, total classifier parallel to the frozen check
// core. Every configured axis value maps to exactly one state, no throw path.
// ---------------------------------------------------------------------------

/** A model guidance value's state on the fail-closed lattice. `fresh` needs
 * positive evidence (an exact `researched` status AND hash parity); a researched
 * stamp whose reference hash drifted is `stale`; any other, absent, unparseable,
 * or coerced provenance is `stub`; a missing guidance block, research entry, or
 * reference file is `missing`. */
export type ModelGuidanceState = "missing" | "stub" | "stale" | "fresh";

/** An effort guidance value's state: a present block, or none. */
export type EffortGuidanceState = "missing" | "present";

/** Provenance facts parsed from a reference file's first comment block, emitted
 * alongside a model's state so the skill sees what drove it. */
export interface ModelProvenance {
  readonly status: string | null;
  readonly researched: string | null;
  readonly resolves_to: string | null;
}

/** One model value's classification plus the facts that drove it. */
export interface ModelStateEntry extends ModelProvenance {
  readonly state: ModelGuidanceState;
  /** Recorded-vs-actual reference hash; null when the reference is absent. */
  readonly hash_parity: boolean | null;
}

/** One effort value's classification. */
export interface EffortStateEntry {
  readonly state: EffortGuidanceState;
}

/** The full state envelope: every configured axis value classified, plus the
 * efforts-axis provenance stamp. */
export interface GuidanceStateResult {
  readonly efforts: Record<string, EffortStateEntry>;
  readonly efforts_provenance: EffortsProvenance;
  readonly models: Record<string, ModelStateEntry>;
}

/** Inputs to the pure state classifier — axes + config + reference resolvers, no
 * disk access (the parallel of GuidanceCheckInput). */
export interface GuidanceStateInput {
  readonly efforts: readonly string[];
  readonly models: readonly string[];
  readonly config: ModelSelectorConfig;
  /** Raw reference file text for a reference path (relative to plan root), null
   * when absent on disk. */
  readonly referenceText: (reference: string) => string | null;
  /** Actual sha256 of a reference path, null when absent (shared with --check). */
  readonly referenceHash: (reference: string) => string | null;
}

/** All-null provenance facts — the shape for a missing or unparseable header. */
const ABSENT_PROVENANCE: ModelProvenance = {
  status: null,
  researched: null,
  resolves_to: null,
};

/** Slice the inner text of the FIRST `<!-- ... -->` comment block, or null when
 * there is no complete block. The reference files open with an H1, so this is
 * deliberately NOT byte-0-anchored; only the first block is trusted, so
 * YAML-looking prose in the body can never be read as provenance. */
function firstCommentBlock(text: string): string | null {
  const open = text.indexOf("<!--");
  if (open === -1) {
    return null;
  }
  const close = text.indexOf("-->", open + 4);
  if (close === -1) {
    return null;
  }
  return text.slice(open + 4, close);
}

/** Parse provenance facts from a reference file, string-strict and total. An
 * absent, incomplete, or unparseable first comment block — or a first block that
 * carries no `provenance:` mapping — yields all-null facts (which the lattice
 * reads as stub). A non-string `status` (a YAML 1.1 coercion) reads as null. */
function parseProvenance(text: string): ModelProvenance {
  const inner = firstCommentBlock(text);
  if (inner === null) {
    return ABSENT_PROVENANCE;
  }
  let parsed: unknown;
  try {
    parsed = parseYamlInput(Buffer.from(inner, "utf-8"), "provenance-header");
  } catch {
    return ABSENT_PROVENANCE;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return ABSENT_PROVENANCE;
  }
  const provenance = (parsed as Record<string, unknown>).provenance;
  if (
    provenance === null ||
    typeof provenance !== "object" ||
    Array.isArray(provenance)
  ) {
    return ABSENT_PROVENANCE;
  }
  const p = provenance as Record<string, unknown>;
  return {
    status: typeof p.status === "string" ? p.status : null,
    researched: dateFieldToString(p.researched),
    resolves_to: typeof p.resolves_to === "string" ? p.resolves_to : null,
  };
}

/** Classify one configured model value against the fail-closed lattice. */
function classifyModel(
  model: string,
  input: GuidanceStateInput,
): ModelStateEntry {
  const block = input.config.models[model];
  const research = input.config.research[model];
  // missing: no guidance block, no research entry, or no reference on disk.
  if (block === undefined || block.length === 0 || research === undefined) {
    return { state: "missing", hash_parity: null, ...ABSENT_PROVENANCE };
  }
  const text = input.referenceText(research.reference);
  if (text === null) {
    return { state: "missing", hash_parity: null, ...ABSENT_PROVENANCE };
  }
  const facts = parseProvenance(text);
  const actual = input.referenceHash(research.reference);
  const hashParity = actual === null ? null : actual === research.sha256;
  // fresh needs positive evidence on BOTH axes; a researched stamp without parity
  // is stale; anything else is stub.
  let state: ModelGuidanceState;
  if (facts.status === "researched") {
    state = hashParity === true ? "fresh" : "stale";
  } else {
    state = "stub";
  }
  return { state, hash_parity: hashParity, ...facts };
}

/** The pure state core: classify every configured axis value with no throw. */
export function classifyModelGuidance(
  input: GuidanceStateInput,
): GuidanceStateResult {
  const efforts: Record<string, EffortStateEntry> = {};
  for (const effort of input.efforts) {
    const block = input.config.efforts[effort];
    efforts[effort] = {
      state: block !== undefined && block.length > 0 ? "present" : "missing",
    };
  }
  const models: Record<string, ModelStateEntry> = {};
  for (const model of input.models) {
    models[model] = classifyModel(model, input);
  }
  return {
    efforts,
    efforts_provenance: input.config.efforts_provenance ?? {
      status: "stub",
      last_reviewed: null,
    },
    models,
  };
}

/** A disk-backed reference-text resolver rooted at `planRoot`. */
export function referenceTextFromDisk(
  planRoot: string,
): (reference: string) => string | null {
  return (reference) => {
    const p = join(planRoot, reference);
    if (!existsSync(p)) {
      return null;
    }
    return readFileSync(p, "utf-8");
  };
}

/** Run the full state classification against the on-disk config + subagents
 * axes (the state-mode parallel of checkModelGuidanceFromDisk). */
export function classifyModelGuidanceFromDisk(
  planRoot: string = PLAN_ROOT,
): GuidanceStateResult {
  const matrix = loadSubagentsMatrixFromDisk(join(planRoot, "subagents.yaml"));
  const config = loadModelSelectorConfig(join(planRoot, "model-selector.yaml"));
  return classifyModelGuidance({
    efforts: matrix.efforts,
    models: matrix.models,
    config,
    referenceText: referenceTextFromDisk(planRoot),
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
  // `--state` emits the per-value guidance-state envelope; `--check` (the
  // default) runs the frozen drift gate. The model-guidance skill authors both.
  if (argv.includes("--state")) {
    process.stdout.write(
      `${JSON.stringify(classifyModelGuidanceFromDisk(), null, 2)}\n`,
    );
    return;
  }
  if (argv.length > 0 && !argv.includes("--check")) {
    process.stderr.write(
      `model-guidance-check: unknown argument(s) ${argv.join(" ")} (only --check, --state)\n`,
    );
    process.exit(2);
  }
  reportOrExit(checkModelGuidanceFromDisk());
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
