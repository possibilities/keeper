import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  parseStrictYamlInput,
  readYamlBytes,
} from "../../plan/src/yaml_input.ts";

export type PromptArtifactBinding = "static" | "cell-bound";
export type PromptArtifactAdaptation = "equivalent" | "wrapped";

export interface PromptArtifactDefaultPin {
  readonly model: string;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export interface PromptArtifactRole {
  readonly role: string;
  readonly source: string;
  readonly sourcePath: string;
  readonly binding: PromptArtifactBinding;
  readonly unserved: PromptArtifactAdaptation;
  readonly defaultPin?: PromptArtifactDefaultPin;
}

export interface PromptArtifactBundle {
  readonly bundle: string;
  readonly roles: readonly string[];
}

export interface PromptArtifactCatalog {
  readonly schema_version: 1;
  readonly roles: readonly PromptArtifactRole[];
  readonly bundles: readonly PromptArtifactBundle[];
  readonly roleByName: ReadonlyMap<string, PromptArtifactRole>;
  readonly bundleByName: ReadonlyMap<string, PromptArtifactBundle>;
}

export class PromptArtifactCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptArtifactCatalogError";
  }
}

const QUALIFIED_NAME_RE = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;
const PIN_MODEL_RE = /^[a-z0-9][a-z0-9._-]*$/;
const PIN_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function mapping(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PromptArtifactCatalogError(`${label} must be a mapping`);
  }
  return raw as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new PromptArtifactCatalogError(
        `${label} has unknown key '${key}' (allowed: ${allowed.join(", ")})`,
      );
    }
  }
}

function qualifiedName(value: unknown, label: string): string {
  if (typeof value !== "string" || !QUALIFIED_NAME_RE.test(value)) {
    throw new PromptArtifactCatalogError(
      `${label} must be a fully-qualified namespace:name token`,
    );
  }
  return value;
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function sourcePath(
  raw: unknown,
  planRoot: string,
  label: string,
): {
  source: string;
  sourcePath: string;
} {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.includes("\0") ||
    isAbsolute(raw) ||
    raw.includes("\\") ||
    raw
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    !raw.startsWith("template/agents/") ||
    !raw.endsWith(".md.tmpl")
  ) {
    throw new PromptArtifactCatalogError(
      `${label} must be a relative template/agents/*.md.tmpl path with no escape`,
    );
  }
  const root = realpathSync(planRoot);
  const agentTemplates = realpathSync(resolve(root, "template", "agents"));
  if (!isWithin(agentTemplates, root)) {
    throw new PromptArtifactCatalogError(
      `${label} template/agents root resolves outside the plan package`,
    );
  }
  const lexical = resolve(root, raw);
  if (!isWithin(lexical, root)) {
    throw new PromptArtifactCatalogError(`${label} escapes the plan package`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(lexical);
    if (!statSync(canonical).isFile()) throw new Error("not a file");
  } catch {
    throw new PromptArtifactCatalogError(
      `${label} does not name a file: ${raw}`,
    );
  }
  if (!isWithin(canonical, agentTemplates)) {
    throw new PromptArtifactCatalogError(
      `${label} resolves outside the canonical agent template directory: ${raw}`,
    );
  }
  return { source: raw, sourcePath: canonical };
}

/** Strict parser for the package-level role catalog. This schema is compiler
 * control data and intentionally independent of the public snippet bundles. */
export function parsePromptArtifactCatalog(
  parsed: unknown,
  planRoot: string,
): PromptArtifactCatalog {
  const doc = mapping(parsed, "prompt artifact catalog");
  onlyKeys(
    doc,
    ["schema_version", "roles", "bundles"],
    "prompt artifact catalog",
  );
  if (doc.schema_version !== 1) {
    throw new PromptArtifactCatalogError(
      `prompt artifact catalog schema_version must be exactly 1`,
    );
  }
  if (!Array.isArray(doc.roles) || doc.roles.length === 0) {
    throw new PromptArtifactCatalogError(
      "prompt artifact catalog roles must be a non-empty list",
    );
  }
  if (!Array.isArray(doc.bundles) || doc.bundles.length === 0) {
    throw new PromptArtifactCatalogError(
      "prompt artifact catalog bundles must be a non-empty list",
    );
  }

  const roles: PromptArtifactRole[] = [];
  const roleByName = new Map<string, PromptArtifactRole>();
  for (let index = 0; index < doc.roles.length; index += 1) {
    const label = `roles[${index}]`;
    const rec = mapping(doc.roles[index], label);
    onlyKeys(
      rec,
      ["role", "source", "binding", "unserved", "default_pin"],
      label,
    );
    const role = qualifiedName(rec.role, `${label}.role`);
    if (roleByName.has(role)) {
      throw new PromptArtifactCatalogError(`duplicate role '${role}'`);
    }
    if (rec.binding !== "static" && rec.binding !== "cell-bound") {
      throw new PromptArtifactCatalogError(
        `${label}.binding must be 'static' or 'cell-bound'`,
      );
    }
    if (rec.unserved !== "equivalent" && rec.unserved !== "wrapped") {
      throw new PromptArtifactCatalogError(
        `${label}.unserved must be 'equivalent' or 'wrapped'`,
      );
    }
    if (
      (rec.binding === "static" && rec.unserved !== "equivalent") ||
      (rec.binding === "cell-bound" && rec.unserved !== "wrapped")
    ) {
      throw new PromptArtifactCatalogError(
        `${label} has invalid binding/unserved combination '${rec.binding}/${rec.unserved}'`,
      );
    }
    let defaultPin: PromptArtifactDefaultPin | undefined;
    if (rec.default_pin !== undefined) {
      if (rec.binding !== "static") {
        throw new PromptArtifactCatalogError(
          `${label}.default_pin is allowed only for a static role`,
        );
      }
      const pin = mapping(rec.default_pin, `${label}.default_pin`);
      onlyKeys(pin, ["model", "effort"], `${label}.default_pin`);
      if (typeof pin.model !== "string" || !PIN_MODEL_RE.test(pin.model)) {
        throw new PromptArtifactCatalogError(
          `${label}.default_pin.model must be a valid model token`,
        );
      }
      if (typeof pin.effort !== "string" || !PIN_EFFORTS.has(pin.effort)) {
        throw new PromptArtifactCatalogError(
          `${label}.default_pin.effort must be low, medium, high, xhigh, or max`,
        );
      }
      defaultPin = {
        model: pin.model,
        effort: pin.effort as PromptArtifactDefaultPin["effort"],
      };
    }
    const source = sourcePath(rec.source, planRoot, `${label}.source`);
    const entry: PromptArtifactRole = {
      role,
      ...source,
      binding: rec.binding,
      unserved: rec.unserved,
      ...(defaultPin === undefined ? {} : { defaultPin }),
    };
    roles.push(entry);
    roleByName.set(role, entry);
  }

  const catalogSources = new Set(roles.map((role) => role.source));
  for (const name of readdirSync(
    resolve(planRoot, "template", "agents"),
  ).sort()) {
    if (!name.endsWith(".md.tmpl")) continue;
    const source = `template/agents/${name}`;
    if (!catalogSources.has(source)) {
      throw new PromptArtifactCatalogError(
        `agent template '${source}' has no catalog role`,
      );
    }
  }

  const bundles: PromptArtifactBundle[] = [];
  const bundleByName = new Map<string, PromptArtifactBundle>();
  const bundledRoles = new Set<string>();
  for (let index = 0; index < doc.bundles.length; index += 1) {
    const label = `bundles[${index}]`;
    const rec = mapping(doc.bundles[index], label);
    onlyKeys(rec, ["bundle", "roles"], label);
    const bundle = qualifiedName(rec.bundle, `${label}.bundle`);
    if (bundleByName.has(bundle)) {
      throw new PromptArtifactCatalogError(`duplicate bundle '${bundle}'`);
    }
    if (!Array.isArray(rec.roles) || rec.roles.length === 0) {
      throw new PromptArtifactCatalogError(
        `${label}.roles must be a non-empty list`,
      );
    }
    const members: string[] = [];
    const seen = new Set<string>();
    for (
      let memberIndex = 0;
      memberIndex < rec.roles.length;
      memberIndex += 1
    ) {
      const role = qualifiedName(
        rec.roles[memberIndex],
        `${label}.roles[${memberIndex}]`,
      );
      if (seen.has(role)) {
        throw new PromptArtifactCatalogError(
          `${label}.roles lists '${role}' more than once`,
        );
      }
      if (!roleByName.has(role)) {
        throw new PromptArtifactCatalogError(
          `${label}.roles references missing role '${role}'`,
        );
      }
      seen.add(role);
      bundledRoles.add(role);
      members.push(role);
    }
    const entry = { bundle, roles: members };
    bundles.push(entry);
    bundleByName.set(bundle, entry);
  }

  for (const role of roleByName.keys()) {
    if (!bundledRoles.has(role)) {
      throw new PromptArtifactCatalogError(
        `role '${role}' is not a member of any bundle`,
      );
    }
  }

  return {
    schema_version: 1,
    roles,
    bundles,
    roleByName,
    bundleByName,
  };
}

/** Parse one already-read catalog snapshot. Duplicate mapping keys are rejected
 * here without changing the shared plan-input loader's last-key-wins contract. */
export function parsePromptArtifactCatalogBytes(
  raw: Buffer,
  catalogPath: string,
  planRoot: string,
): PromptArtifactCatalog {
  return parsePromptArtifactCatalog(
    parseStrictYamlInput(raw, catalogPath),
    planRoot,
  );
}

export function loadPromptArtifactCatalog(
  catalogPath: string,
  planRoot: string,
): PromptArtifactCatalog {
  return parsePromptArtifactCatalogBytes(
    readYamlBytes(catalogPath),
    catalogPath,
    planRoot,
  );
}
