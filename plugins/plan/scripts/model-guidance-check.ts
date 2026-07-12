#!/usr/bin/env bun
// Drift gate for the selector policy config (../model-selector.yaml), mirroring
// the vendor-corpus report-or-exit shape.
//
//   bun plugins/plan/scripts/model-guidance-check.ts --check   (default) verify
//
// `--check` is a HOST-BLIND integrity gate — no axis read, so it is green on a
// matrix-less host (the axes now live in the required v2 host matrix, absent in CI):
//   (a) structural validation — the config coerces (a malformed section fails loud).
//   (b) research-hash parity — EVERY research entry names a references/ cache file
//       that exists and whose recorded sha256 matches it on disk, AND every
//       DECLARED vendor card (references/cards/) hashes the same way. Presence +
//       hash only: the gate NEVER parses a card's provenance header — fetched
//       vendor content stays out of the gate parser.
// The axis-coverage directions are dropped from the gate; the model-guidance-v2
// follow-up epic owns the coverage UX against the host matrix. The pure coverage
// core (`checkModelGuidance`) is retained for the in-process failure-mode tests.
//
// `--state` classifies every configured axis value against the model-selector.yaml
// guidance, reading its axes from the required v2 host matrix (`matrix.yaml`). A
// model classifies `fresh` only with researched notes AND a present, hash-matching
// card; the envelope carries card_present / card_hash_parity / reasons per model.
//
// The pure cores (`checkModelGuidance` / `classifyModelGuidance`) are functions over
// already-loaded data so the fast suite drives their failure modes in-process. The
// model-guidance skill OWNS the config content — this only verifies.
//
// This script ALSO gates the cross-provider equivalence map
// (../provider-equivalence.yaml, ADR 0047): `--check` runs its host-blind
// structural + totality + opposite-family-proxy check alongside the selector
// checks above (one combined report-or-exit); `--state` adds an `equivalence`
// key to the envelope, reading its own totality/target-validity classification
// from `src/provider_equivalence.ts` (the parallel pure coerce/check/state core
// for that map).

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadHostMatrixV2 } from "../src/host_matrix.ts";
import {
  checkProviderEquivalenceFromDisk,
  classifyProviderEquivalenceFromDisk,
  type EquivalenceCheckResult,
} from "../src/provider_equivalence.ts";
import { loadYamlInput, parseYamlInput } from "../src/yaml_input.ts";

/** Plan plugin root — model-selector.yaml sits here. */
export const PLAN_ROOT = resolve(import.meta.dir, "..");

/** A vendor system-card cache pin: the converted-markdown card under
 * references/cards/ + its content hash. The gate hashes the committed markdown,
 * never upstream bytes, and NEVER parses the card's provenance header. */
export interface CardEntry {
  readonly reference: string;
  readonly sha256: string;
}

/** One research-provenance entry: a references/ cache file + its content hash,
 * plus an OPTIONAL vendor system-card cache. An absent `card` key means no card
 * (inert until backfilled); a card is REQUIRED for a model to classify `fresh`. */
export interface ResearchEntry {
  readonly reference: string;
  readonly sha256: string;
  readonly card?: CardEntry;
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

/** Coerce a research entry's OPTIONAL nested `card` mapping. An absent key is
 * handled by the caller (no card); a PRESENT key must be a full `{reference,
 * sha256}` string mapping — a non-mapping or a partial/malformed card fails loud
 * naming the model, exactly like the notes fields (a declared-but-broken pin
 * never passes silently). A card path equal to the notes reference is a
 * copy-paste error and is rejected loud. */
function coerceCardEntry(
  raw: unknown,
  notesReference: string,
  label: string,
): CardEntry {
  const c = asMapping(raw, label);
  const reference = asString(c.reference, `${label}.reference`);
  const sha256 = asString(c.sha256, `${label}.sha256`);
  if (reference === notesReference) {
    throw new ModelSelectorConfigError(
      `${label}.reference must differ from the notes reference "${notesReference}" (copy-paste guard)`,
    );
  }
  return { reference, sha256 };
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
    const reference = asString(e.reference, `research.${model}.reference`);
    research[model] = {
      reference,
      sha256: asString(e.sha256, `research.${model}.sha256`),
      // Absent `card` key means no card; a present key coerces loud.
      ...(e.card !== undefined
        ? { card: coerceCardEntry(e.card, reference, `research.${model}.card`) }
        : {}),
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

/** Union the effort tokens across every configured scope, first-appearance order.
 * A single flat effort axis is one scope, but a host provider matrix expresses
 * efforts as several scopes (a top-level axis plus per-provider and per-model
 * overrides); the guidance gate must cover their union so no scope's effort
 * token can slip past coverage. This host-blind gate reads only the disk
 * config's scopes, so today the union collapses to the single flat axis — the
 * union shape keeps coverage correct wherever the effort axis carries more than
 * one scope. */
export function unionEfforts(scopes: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const scope of scopes) {
    for (const effort of scope) {
      if (!seen.has(effort)) {
        seen.add(effort);
        out.push(effort);
      }
    }
  }
  return out;
}

/** Inputs to the pure check — axes + config + a hash resolver, no disk access. */
export interface GuidanceCheckInput {
  readonly efforts: readonly string[];
  readonly models: readonly string[];
  readonly config: ModelSelectorConfig;
  /** Actual sha256 of a reference path (relative to plan root), null if absent. */
  readonly referenceHash: (reference: string) => string | null;
}

/** Hash-parity errors for one research entry: its notes cache AND its declared
 * card (if any). A declared card is hashed exactly like the notes reference —
 * presence + hash only, NEVER a header parse — so fetched vendor content stays
 * out of the gate parser; an absent card key is skipped (cards are optional).
 * The notes messages are byte-stable so a typo self-reveals as a missing file. */
function researchEntryParityErrors(
  model: string,
  entry: ResearchEntry,
  referenceHash: (reference: string) => string | null,
): string[] {
  const errors: string[] = [];
  const notesActual = referenceHash(entry.reference);
  if (notesActual === null) {
    errors.push(
      `research: ${model} reference "${entry.reference}" is missing on disk`,
    );
  } else if (notesActual !== entry.sha256) {
    errors.push(
      `research: ${model} recorded sha256 ${entry.sha256} does not match file ${notesActual} (${entry.reference})`,
    );
  }
  if (entry.card !== undefined) {
    const cardActual = referenceHash(entry.card.reference);
    if (cardActual === null) {
      errors.push(
        `research: ${model} card "${entry.card.reference}" is missing on disk`,
      );
    } else if (cardActual !== entry.card.sha256) {
      errors.push(
        `research: ${model} card recorded sha256 ${entry.card.sha256} does not match file ${cardActual} (${entry.card.reference})`,
      );
    }
  }
  return errors;
}

/** The pure check core: coverage (both directions, both axes) + research hash
 * parity. Returns accumulated errors so callers report all drift at once. */
export function checkModelGuidance(
  input: GuidanceCheckInput,
): GuidanceCheckResult {
  const errors: string[] = [];
  errors.push(
    ...coverageErrors(
      "efforts",
      input.efforts,
      Object.keys(input.config.efforts),
    ),
  );
  errors.push(
    ...coverageErrors(
      "models",
      input.models,
      Object.keys(input.config.models),
      true,
    ),
  );

  for (const model of input.models) {
    if (!(model in input.config.research)) {
      errors.push(
        `research: no research entry for configured model "${model}"`,
      );
    }
  }
  // A research entry for a non-configured model is TOLERATED (a host-roster extra,
  // mirroring the extra-guidance-block tolerance, keeping the gate host-blind) —
  // but EVERY entry's reference file (notes AND any declared card) must exist and
  // hash-match. There is no skip-continue: a typo'd entry self-reveals as a
  // missing reference file rather than silently passing.
  for (const [model, entry] of Object.entries(input.config.research)) {
    errors.push(...researchEntryParityErrors(model, entry, input.referenceHash));
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

/** Host-blind research-hash parity: EVERY research entry's notes reference AND
 * declared card file exists and its recorded sha256 matches on disk. No axis read
 * (the coverage directions are dropped from the integrity gate), so the gate
 * stays green on a matrix-less host, and it never parses a card header — presence
 * + hash only. A typo'd entry self-reveals as a missing reference file. */
export function checkResearchParity(
  config: ModelSelectorConfig,
  referenceHash: (reference: string) => string | null,
): GuidanceCheckResult {
  const errors: string[] = [];
  for (const [model, entry] of Object.entries(config.research)) {
    errors.push(...researchEntryParityErrors(model, entry, referenceHash));
  }
  return { ok: errors.length === 0, errors };
}

/** Run the host-blind integrity gate against the on-disk config: structural
 * validation (a malformed section fails loud in `loadModelSelectorConfig`) plus
 * research-hash parity. No host matrix read, so the gate passes with no matrix. */
export function checkModelGuidanceFromDisk(
  planRoot: string = PLAN_ROOT,
): GuidanceCheckResult {
  const config = loadModelSelectorConfig(join(planRoot, "model-selector.yaml"));
  return checkResearchParity(config, referenceHashFromDisk(planRoot));
}

// ---------------------------------------------------------------------------
// Guidance STATE mode — a pure, total classifier parallel to the frozen check
// core. Every configured axis value maps to exactly one state, no throw path.
// ---------------------------------------------------------------------------

/** A model guidance value's state on the fail-closed lattice, precedence pinned:
 * structural absence (no guidance block / no research entry / no notes file) →
 * `missing`; notes provenance not `researched` → `stub` (card irrelevant); notes
 * researched but notes-hash drift → `stale`; notes researched + parity but the
 * card is absent (undeclared OR declared-but-file-missing) → `missing` (the
 * backfill class); notes researched + parity + card present but card-hash drift →
 * `stale`; both parities plus card presence → `fresh`. A card is REQUIRED for
 * `fresh`, and the classifier is total (no throw path). */
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

/** One model value's classification plus the facts that drove it. The
 * `card_present`, `card_hash_parity`, and `reasons` field names are the stable
 * jq contract the skill-docs surface quotes byte-aligned. */
export interface ModelStateEntry extends ModelProvenance {
  readonly state: ModelGuidanceState;
  /** Recorded-vs-actual notes reference hash; null when the reference is absent. */
  readonly hash_parity: boolean | null;
  /** A vendor card is declared AND its file resolves on disk. A declared card
   * whose file is missing reads exactly like no card (false). */
  readonly card_present: boolean;
  /** Recorded-vs-actual card hash; null when no card is present on disk. */
  readonly card_hash_parity: boolean | null;
  /** Every contributing cause the model is not `fresh`, drawn exactly from
   * [no-block, no-research-entry, no-notes-file, notes-not-researched,
   * notes-hash-drift, no-card, card-hash-drift] — empty exactly when `fresh`. */
  readonly reasons: readonly string[];
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

/** Classify one configured model value against the fail-closed lattice. Total:
 * every path returns, no throw. `reasons` accumulates every contributing cause at
 * and above the first failing precedence gate; it is empty exactly when `fresh`. */
function classifyModel(
  model: string,
  input: GuidanceStateInput,
): ModelStateEntry {
  const reasons: string[] = [];
  const block = input.config.models[model];
  const research = input.config.research[model];

  const hasBlock = block !== undefined && block.length > 0;
  if (!hasBlock) {
    reasons.push("no-block");
  }

  // Notes: text + provenance + hash parity, evaluable only when the entry and its
  // file both exist.
  let facts: ModelProvenance = ABSENT_PROVENANCE;
  let notesParity: boolean | null = null;
  let notesResearched = false;
  let notesFilePresent = false;
  if (research === undefined) {
    reasons.push("no-research-entry");
  } else {
    const text = input.referenceText(research.reference);
    if (text === null) {
      reasons.push("no-notes-file");
    } else {
      notesFilePresent = true;
      facts = parseProvenance(text);
      const actual = input.referenceHash(research.reference);
      notesParity = actual === null ? null : actual === research.sha256;
      notesResearched = facts.status === "researched";
    }
  }

  // Card facts for the envelope — computed independently of state so the fields
  // are always truthful. A declared card whose file is absent reads as no card.
  let cardPresent = false;
  let cardHashParity: boolean | null = null;
  if (research?.card !== undefined) {
    const cardActual = input.referenceHash(research.card.reference);
    if (cardActual !== null) {
      cardPresent = true;
      cardHashParity = cardActual === research.card.sha256;
    }
  }

  // Precedence lattice — the first failing gate fixes the state; the card gates
  // apply ONLY once the notes are researched-with-parity (below them the card is
  // irrelevant and contributes no reason).
  let state: ModelGuidanceState;
  if (!hasBlock || research === undefined || !notesFilePresent) {
    state = "missing";
  } else if (!notesResearched) {
    reasons.push("notes-not-researched");
    state = "stub";
  } else if (notesParity !== true) {
    reasons.push("notes-hash-drift");
    state = "stale";
  } else if (!cardPresent) {
    reasons.push("no-card");
    state = "missing";
  } else if (cardHashParity !== true) {
    reasons.push("card-hash-drift");
    state = "stale";
  } else {
    state = "fresh";
  }

  return {
    state,
    hash_parity: notesParity,
    card_present: cardPresent,
    card_hash_parity: cardHashParity,
    reasons,
    ...facts,
  };
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

/** Run the full state classification against the on-disk config + the required v2
 * host matrix axes (the state-mode parallel of checkModelGuidanceFromDisk). A
 * minimal source swap: the axes come from `matrix.yaml` (fail-loud when absent);
 * the classification semantics are otherwise unchanged. */
export function classifyModelGuidanceFromDisk(
  planRoot: string = PLAN_ROOT,
): GuidanceStateResult {
  const matrix = loadHostMatrixV2();
  const config = loadModelSelectorConfig(join(planRoot, "model-selector.yaml"));
  return classifyModelGuidance({
    efforts: matrix.efforts,
    models: matrix.models,
    config,
    referenceText: referenceTextFromDisk(planRoot),
    referenceHash: referenceHashFromDisk(planRoot),
  });
}

function reportOrExit(
  result: GuidanceCheckResult,
  equivalence: EquivalenceCheckResult,
): void {
  if (result.ok && equivalence.ok) {
    process.stdout.write(
      "model-guidance-check: config coerces; research hashes match references/; provider-equivalence map is well-formed\n",
    );
    return;
  }
  process.stderr.write("model-guidance-check: drift detected:\n");
  for (const e of result.errors) {
    process.stderr.write(`  - ${e}\n`);
  }
  for (const e of equivalence.errors) {
    process.stderr.write(`  - provider-equivalence: ${e}\n`);
  }
  process.exit(1);
}

function main(argv: string[]): void {
  // `--state` emits the per-value guidance-state envelope; `--check` (the
  // default) runs the frozen drift gate. The model-guidance skill authors both.
  if (argv.includes("--state")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ...classifyModelGuidanceFromDisk(),
          equivalence: classifyProviderEquivalenceFromDisk(),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (argv.length > 0 && !argv.includes("--check")) {
    process.stderr.write(
      `model-guidance-check: unknown argument(s) ${argv.join(" ")} (only --check, --state)\n`,
    );
    process.exit(2);
  }
  reportOrExit(checkModelGuidanceFromDisk(), checkProviderEquivalenceFromDisk());
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
