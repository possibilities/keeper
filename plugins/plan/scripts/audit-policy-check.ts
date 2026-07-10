#!/usr/bin/env bun
// Drift gate for the audit policy config (../audit-policy.yaml), mirroring the
// model-guidance-check report-or-exit shape.
//
//   bun plugins/plan/scripts/audit-policy-check.ts --check   (default) verify
//
// Two invariants, both self-contained (no network, pure disk reads) and
// host-blind (tiers validate against the canonical effort vocabulary, no host file):
//   (a) tier coverage, both directions — every canonical effort tier has an
//       explicit true/false in `tier_audit`, and no `tier_audit` key exists for a
//       non-canonical tier.
//   (b) band validity — every `depth_bands` entry names a depth in the fixed
//       lean/standard/deep vocabulary.
//
// A third invariant rides the coercion step rather than `checkAuditPolicy`:
// `coerceDepthBand` requires each entry to carry exactly the keys in
// close_preflight.ts's own DEPTH_BAND_THRESHOLD_KEYS (imported, not
// re-declared), so a key the runtime close-audit consumer stops reading — or
// the file stops providing — fails coercion loud instead of silently
// diverging.
//
// The check core (`checkAuditPolicy`) is a pure function over already-loaded data
// so the fast suite drives its failure modes in-process; `--check` wires it to
// disk. Structural coercion (`coerceAuditPolicy`) is fail-loud so a malformed
// config never reaches the coverage/band checks with missing sections; the
// runtime consumer (assign-cells) reads the same file degrade-SOFT instead.

import { join, resolve } from "node:path";

import { CANONICAL_EFFORTS } from "../src/host_matrix.ts";
import { DEPTH_BAND_THRESHOLD_KEYS } from "../src/verbs/close_preflight.ts";
import { loadYamlInput } from "../src/yaml_input.ts";

/** Plan plugin root — audit-policy.yaml sits here. */
export const PLAN_ROOT = resolve(import.meta.dir, "..");

/** The fixed close-depth vocabulary a `depth_bands` entry may name. Ordered
 * lean→deep by increasing review depth; the gate rejects any other name. */
export const AUDIT_DEPTHS = ["lean", "standard", "deep"] as const;
export type AuditDepth = (typeof AUDIT_DEPTHS)[number];

/** One close-depth band: the depth it selects plus the inclusive-minimum signal
 * thresholds that select it (task count, diff LOC, touched-repo count). */
export interface DepthBand {
  readonly depth: string;
  readonly min_task_count: number;
  readonly min_diff_loc: number;
  readonly min_touched_repos: number;
}

/** The parsed audit policy config. */
export interface AuditPolicy {
  /** Per-tier audit-flag decision, keyed by effort tier. */
  readonly tier_audit: Record<string, boolean>;
  /** Close-depth bands, richest-first (the consumer picks the first band met). */
  readonly depth_bands: DepthBand[];
}

/** report-or-exit result, matching the model-guidance GuidanceCheckResult. */
export interface AuditPolicyCheckResult {
  readonly ok: boolean;
  readonly errors: string[];
}

/** Loud, typed failure for a structurally malformed config. */
export class AuditPolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditPolicyConfigError";
  }
}

function asMapping(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AuditPolicyConfigError(`${label} must be a mapping`);
  }
  return raw as Record<string, unknown>;
}

function asBool(raw: unknown, label: string): boolean {
  if (typeof raw !== "boolean") {
    throw new AuditPolicyConfigError(`${label} must be a boolean`);
  }
  return raw;
}

function asNumber(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new AuditPolicyConfigError(`${label} must be a finite number`);
  }
  return raw;
}

function asString(raw: unknown, label: string): string {
  if (typeof raw !== "string") {
    throw new AuditPolicyConfigError(`${label} must be a string`);
  }
  return raw;
}

/** Coerce one `depth_bands` entry, fail-loud on any missing/mistyped field.
 * Threshold keys come from DEPTH_BAND_THRESHOLD_KEYS — close_preflight.ts's own
 * runtime read-list, imported rather than re-declared — so a key the consumer
 * stops reading, or the file stops providing, fails this coercion loud instead
 * of silently diverging. */
function coerceDepthBand(raw: unknown, label: string): DepthBand {
  const doc = asMapping(raw, label);
  const depth = asString(doc.depth, `${label}.depth`);
  const thresholds = {} as Record<
    (typeof DEPTH_BAND_THRESHOLD_KEYS)[number],
    number
  >;
  for (const key of DEPTH_BAND_THRESHOLD_KEYS) {
    thresholds[key] = asNumber(doc[key], `${label}.${key}`);
  }
  return { depth, ...thresholds };
}

/** Validate a parsed document into an AuditPolicy. Throws on any structural
 * violation so a broken config fails loud rather than silently passing the
 * coverage/band checks with missing sections. `tier_audit` must be a mapping of
 * boolean values; `depth_bands` a non-empty list of well-formed bands. */
export function coerceAuditPolicy(parsed: unknown): AuditPolicy {
  const doc = asMapping(parsed, "audit-policy config");
  const tierNode = asMapping(doc.tier_audit, "tier_audit");
  const tier_audit: Record<string, boolean> = {};
  for (const [tier, value] of Object.entries(tierNode)) {
    tier_audit[tier] = asBool(value, `tier_audit.${tier}`);
  }
  if (!Array.isArray(doc.depth_bands) || doc.depth_bands.length === 0) {
    throw new AuditPolicyConfigError("depth_bands must be a non-empty list");
  }
  const depth_bands = doc.depth_bands.map((band, idx) =>
    coerceDepthBand(band, `depth_bands #${idx + 1}`),
  );
  return { tier_audit, depth_bands };
}

/** Read + parse the config off disk through the shared YAML 1.1 loader. */
export function loadAuditPolicy(path: string): AuditPolicy {
  return coerceAuditPolicy(loadYamlInput(path));
}

/** Inputs to the pure check — the effort axis + config, no disk access. */
export interface AuditPolicyCheckInput {
  readonly efforts: readonly string[];
  readonly policy: AuditPolicy;
}

/** The pure check core: tier coverage (both directions) + band-depth validity.
 * Returns accumulated errors so callers report all drift at once. */
export function checkAuditPolicy(
  input: AuditPolicyCheckInput,
): AuditPolicyCheckResult {
  const errors: string[] = [];
  const axisSet = new Set(input.efforts);
  const mapped = new Set(Object.keys(input.policy.tier_audit));
  for (const tier of input.efforts) {
    if (!mapped.has(tier)) {
      errors.push(
        `tier_audit: no audit decision for configured tier "${tier}"`,
      );
    }
  }
  for (const tier of mapped) {
    if (!axisSet.has(tier)) {
      errors.push(`tier_audit: "${tier}" is not a configured effort tier`);
    }
  }
  const depths = new Set<string>(AUDIT_DEPTHS);
  input.policy.depth_bands.forEach((band, idx) => {
    if (!depths.has(band.depth)) {
      errors.push(
        `depth_bands #${idx + 1}: "${band.depth}" is not a valid depth (${AUDIT_DEPTHS.join(", ")})`,
      );
    }
  });
  return { ok: errors.length === 0, errors };
}

/** Run the full check against the on-disk config + the canonical effort
 * vocabulary. Host-blind: tier keys are validated against CANONICAL_EFFORTS (the
 * fixed tier vocabulary), never a host file, so the gate is green with no matrix. */
export function checkAuditPolicyFromDisk(
  planRoot: string = PLAN_ROOT,
): AuditPolicyCheckResult {
  const policy = loadAuditPolicy(join(planRoot, "audit-policy.yaml"));
  return checkAuditPolicy({ efforts: CANONICAL_EFFORTS, policy });
}

function reportOrExit(result: AuditPolicyCheckResult): void {
  if (result.ok) {
    process.stdout.write(
      "audit-policy-check: tier_audit covers the efforts axis; every band names a valid depth\n",
    );
    return;
  }
  process.stderr.write("audit-policy-check: audit policy drifted:\n");
  for (const e of result.errors) {
    process.stderr.write(`  - ${e}\n`);
  }
  process.exit(1);
}

function main(argv: string[]): void {
  if (argv.length > 0 && !argv.includes("--check")) {
    process.stderr.write(
      `audit-policy-check: unknown argument(s) ${argv.join(" ")} (only --check)\n`,
    );
    process.exit(2);
  }
  reportOrExit(checkAuditPolicyFromDisk());
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
