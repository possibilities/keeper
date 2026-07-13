#!/usr/bin/env bun
// Structural drift gate for the committed panel roster (../panel-selector.yaml).
//
//   bun plugins/plan/scripts/panel-guidance-check.ts --check   (default) verify
//
// Host-blind — no host/matrix read. Cube membership (verifying the roster's
// launch triples actually resolve against the live provider matrix) is checked
// separately by `keeper agent providers check`, deliberately not in CI. This
// gate enforces only the roster's own closed-enum shape: top-level keys exactly
// {panels, default}; exactly 10 panels; per-panel keys exactly {strength,
// members, description}; strength drawn from the closed weak|light|standard|
// strong|max enum with at least one weak and one max panel; 2-3 members each,
// every member shaped <harness>::<model>::<effort> with three non-empty
// segments (harness in {claude, codex, pi}, effort in {high, xhigh, max} — the
// full triple grammar and cube membership stay with the loader and providers
// check); no duplicate member within a panel; description length within
// 150-900 characters (a near-uniformity guard against selection length-bias);
// `default` present and naming a defined panel.
//
// The pure core (`checkPanelSelector`) is a function over already-parsed YAML
// so the fast suite drives every failure mode in-process with hand-built
// inputs, mirroring model-guidance-check's report-or-exit shape.

import { join, resolve } from "node:path";

import { loadYamlInput } from "../src/yaml_input.ts";

/** Plan plugin root — panel-selector.yaml sits here. */
export const PLAN_ROOT = resolve(import.meta.dir, "..");

/** report-or-exit result, matching model-guidance-check's GuidanceCheckResult. */
export interface PanelCheckResult {
  readonly ok: boolean;
  readonly errors: string[];
}

const STRENGTHS = ["weak", "light", "standard", "strong", "max"] as const;
type Strength = (typeof STRENGTHS)[number];

const HARNESSES = ["claude", "codex", "pi"] as const;
const EFFORTS = ["high", "xhigh", "max"] as const;

const PANEL_COUNT = 10;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 3;
const MIN_DESCRIPTION = 150;
const MAX_DESCRIPTION = 900;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Validate one member string's shape: exactly three non-empty
 * `<harness>::<model>::<effort>` segments, harness/effort drawn from the closed
 * roster enums. The model segment is free-form (may itself carry `/`) — the
 * full triple grammar and cube membership stay with the loader / providers
 * check, never duplicated here. */
function memberErrors(panel: string, index: number, raw: unknown): string[] {
  const label = `panels.${panel}.members[${index}]`;
  if (typeof raw !== "string") {
    return [`${label} must be a string`];
  }
  const segments = raw.split("::");
  if (segments.length !== 3 || segments.some((s) => s.length === 0)) {
    return [
      `${label} "${raw}" must have exactly three non-empty <harness>::<model>::<effort> segments`,
    ];
  }
  const [harness, , effort] = segments;
  const errors: string[] = [];
  if (!(HARNESSES as readonly string[]).includes(harness)) {
    errors.push(
      `${label} "${raw}" harness "${harness}" must be one of ${HARNESSES.join(", ")}`,
    );
  }
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    errors.push(
      `${label} "${raw}" effort "${effort}" must be one of ${EFFORTS.join(", ")}`,
    );
  }
  return errors;
}

/** Validate one panel entry: exact key set, strength enum, 2-3 duplicate-free
 * shaped members, description length band. Returns the accumulated errors plus
 * the panel's parsed strength (null when it failed to parse) so the caller can
 * roll up the weak/max coverage check across the whole roster. */
function panelErrors(
  name: string,
  raw: unknown,
): { errors: string[]; strength: Strength | null } {
  if (!isPlainObject(raw)) {
    return { errors: [`panels.${name} must be a mapping`], strength: null };
  }
  const errors: string[] = [];
  const keys = Object.keys(raw).sort();
  const expected = ["description", "members", "strength"];
  if (keys.join(",") !== expected.join(",")) {
    errors.push(
      `panels.${name} keys must be exactly {strength, members, description}, got {${keys.join(", ")}}`,
    );
  }

  let strength: Strength | null = null;
  if (typeof raw.strength !== "string") {
    errors.push(`panels.${name}.strength must be a string`);
  } else if (!(STRENGTHS as readonly string[]).includes(raw.strength)) {
    errors.push(
      `panels.${name}.strength "${raw.strength}" must be one of ${STRENGTHS.join(", ")}`,
    );
  } else {
    strength = raw.strength as Strength;
  }

  if (!Array.isArray(raw.members)) {
    errors.push(`panels.${name}.members must be a list`);
  } else {
    if (raw.members.length < MIN_MEMBERS || raw.members.length > MAX_MEMBERS) {
      errors.push(
        `panels.${name}.members must have ${MIN_MEMBERS}-${MAX_MEMBERS} entries, got ${raw.members.length}`,
      );
    }
    const seen = new Set<string>();
    raw.members.forEach((m, i) => {
      errors.push(...memberErrors(name, i, m));
      if (typeof m === "string") {
        if (seen.has(m)) {
          errors.push(`panels.${name}.members has a duplicate member "${m}"`);
        }
        seen.add(m);
      }
    });
  }

  if (typeof raw.description !== "string") {
    errors.push(`panels.${name}.description must be a string`);
  } else if (
    raw.description.length < MIN_DESCRIPTION ||
    raw.description.length > MAX_DESCRIPTION
  ) {
    errors.push(
      `panels.${name}.description length ${raw.description.length} must be within ${MIN_DESCRIPTION}-${MAX_DESCRIPTION} characters`,
    );
  }

  return { errors, strength };
}

/** The pure structural check core: no disk access, operates on already-parsed
 * YAML. Accumulates every violation rather than throwing on the first, so a
 * hand-built fixture can drive several failure classes through one call. */
export function checkPanelSelector(parsed: unknown): PanelCheckResult {
  if (!isPlainObject(parsed)) {
    return { ok: false, errors: ["panel-selector config must be a mapping"] };
  }
  const errors: string[] = [];

  const topKeys = Object.keys(parsed).sort();
  const expectedTop = ["default", "panels"];
  if (topKeys.join(",") !== expectedTop.join(",")) {
    errors.push(
      `top-level keys must be exactly {panels, default}, got {${topKeys.join(", ")}}`,
    );
  }

  const panelsRaw = parsed.panels;
  const strengthsSeen = new Set<Strength>();
  let panelNames: string[] = [];
  if (!isPlainObject(panelsRaw)) {
    errors.push("panels must be a mapping");
  } else {
    panelNames = Object.keys(panelsRaw);
    if (panelNames.length !== PANEL_COUNT) {
      errors.push(
        `panels must have exactly ${PANEL_COUNT} entries, got ${panelNames.length}`,
      );
    }
    for (const name of panelNames) {
      const { errors: panelErrs, strength } = panelErrors(
        name,
        panelsRaw[name],
      );
      errors.push(...panelErrs);
      if (strength !== null) {
        strengthsSeen.add(strength);
      }
    }
    if (!strengthsSeen.has("weak")) {
      errors.push('panels: at least one panel must carry strength "weak"');
    }
    if (!strengthsSeen.has("max")) {
      errors.push('panels: at least one panel must carry strength "max"');
    }
  }

  const defaultRaw = parsed.default;
  if (typeof defaultRaw !== "string" || defaultRaw.length === 0) {
    errors.push("default must be a non-empty string");
  } else if (!panelNames.includes(defaultRaw)) {
    errors.push(`default "${defaultRaw}" must name a defined panel`);
  }

  return { ok: errors.length === 0, errors };
}

/** Run the host-blind structural gate against the on-disk committed roster. */
export function checkPanelSelectorFromDisk(
  planRoot: string = PLAN_ROOT,
): PanelCheckResult {
  const parsed = loadYamlInput(join(planRoot, "panel-selector.yaml"));
  return checkPanelSelector(parsed);
}

function reportOrExit(result: PanelCheckResult): void {
  if (result.ok) {
    process.stdout.write(
      "panel-guidance-check: panel-selector.yaml is structurally sound\n",
    );
    return;
  }
  process.stderr.write("panel-guidance-check: panel roster drifted:\n");
  for (const e of result.errors) {
    process.stderr.write(`  - ${e}\n`);
  }
  process.exit(1);
}

function main(argv: string[]): void {
  if (argv.length > 0 && !argv.includes("--check")) {
    process.stderr.write(
      `panel-guidance-check: unknown argument(s) ${argv.join(" ")} (only --check)\n`,
    );
    process.exit(2);
  }
  reportOrExit(checkPanelSelectorFromDisk());
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
