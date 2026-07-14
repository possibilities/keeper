import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import yaml from "js-yaml";

import {
  type AgentPin,
  type HostMatrixV2,
  hostMatrixV2ProviderRoute,
  loadHostMatrixV2,
} from "../../plan/src/host_matrix.ts";
import {
  checkProviderEquivalence,
  type EquivalenceCell,
  loadProviderEquivalenceConfig,
  lookupProviderEquivalence,
  type ProviderEquivalenceConfig,
} from "../../plan/src/provider_equivalence.ts";
import {
  loadPromptArtifactCatalog,
  type PromptArtifactCatalog,
  type PromptArtifactRole,
} from "./artifact_catalog.ts";
import { renderTemplate } from "./render_engine.ts";

export const PI_PROMPT_MANIFEST = ".keeper-plan-agents.json";
const SIDECAR_SUFFIX = ".managed-file-dont-edit";
const COMPILER_REVISION = "keeper-prompt-pi-static-v1";

export interface PromptCompileRequest {
  readonly target: "pi";
  readonly bundle?: string;
  readonly role?: string;
}

export interface PromptCompileOptions {
  readonly request: PromptCompileRequest;
  readonly check?: boolean;
  readonly repoRoot?: string;
  readonly planRoot?: string;
  readonly catalogPath?: string;
  readonly matrixPath?: string;
  readonly equivalencePath?: string;
  /** Pi definitions directory. Defaults to $PI_CODING_AGENT_DIR/agents. */
  readonly targetDir?: string;
  readonly taskFacadePath?: string;
  /** Deterministic test seam; returns the complete canonical rendered markdown. */
  readonly renderCanonical?: (
    sourcePath: string,
    variables: Readonly<Record<string, string>>,
  ) => string;
}

export interface PromptCompileCell {
  readonly model: string;
  readonly effort: string;
}

export interface PromptCompileLaunchCell extends PromptCompileCell {
  readonly provider: "pi";
}

export interface PromptCompileRoleResult {
  readonly role: string;
  readonly output: string;
  readonly sha256: string;
  readonly assigned_cell: PromptCompileCell;
  readonly effective_cell: PromptCompileCell;
  readonly launch_cell: PromptCompileLaunchCell;
  readonly changed: boolean;
}

export interface PromptCompileResult {
  readonly schema_version: 1;
  readonly target: "pi";
  readonly request: { readonly kind: "bundle" | "role"; readonly name: string };
  readonly outcome: "hit" | "compiled" | "repaired";
  readonly fingerprint: string;
  readonly outputs: readonly PromptCompileRoleResult[];
  readonly removed: readonly string[];
  readonly check: boolean;
  readonly ok: boolean;
}

interface CompiledRole {
  role: PromptArtifactRole;
  output: string;
  content: string;
  hash: string;
  sidecar: string;
  sidecarContent: string;
  sidecarHash: string;
  assigned: PromptCompileCell;
  effective: PromptCompileCell;
  launch: PromptCompileLaunchCell;
}

interface ManagedManifestV2 {
  schema_version: 2;
  target: "pi";
  fingerprint: string;
  files: Record<string, string>;
  sidecars: Record<string, string>;
}

interface PreviousManifest {
  exists: boolean;
  fingerprint: string | null;
  files: Map<string, string>;
  sidecars: Map<string, string>;
}

interface RenderedClaudeAgent {
  frontmatter: Record<string, unknown>;
  body: string;
}

const PI_TOOL_NAMES: Readonly<Record<string, readonly string[]>> = {
  Bash: ["bash"],
  Edit: ["edit"],
  Glob: ["find"],
  Monitor: ["Monitor"],
  Read: ["read"],
  Task: ["Task", "Agent"],
  Write: ["write"],
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function csv(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim());
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function translatedDeniedTools(value: unknown): string[] {
  const translated: string[] = [];
  for (const tool of csv(value)) {
    for (const mapped of PI_TOOL_NAMES[tool] ?? [tool]) {
      if (!translated.includes(mapped)) translated.push(mapped);
    }
  }
  return translated;
}

function piThinking(effort: string): "low" | "medium" | "high" | "xhigh" {
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  if (effort === "max") return "xhigh";
  throw new Error(`unsupported Pi thinking effort ${JSON.stringify(effort)}`);
}

function maxTurns(thinking: "low" | "medium" | "high" | "xhigh"): number {
  return { low: 25, medium: 40, high: 60, xhigh: 75 }[thinking];
}

function splitRenderedClaudeAgent(
  rendered: string,
  sourcePath: string,
): RenderedClaudeAgent {
  if (!rendered.startsWith("---\n")) {
    throw new Error(
      `${sourcePath}: rendered template is missing YAML frontmatter`,
    );
  }
  const close = rendered.indexOf("\n---\n", 4);
  if (close < 0) {
    throw new Error(
      `${sourcePath}: rendered template has unterminated YAML frontmatter`,
    );
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(rendered.slice(4, close));
  } catch (error) {
    throw new Error(
      `${sourcePath}: rendered frontmatter is invalid YAML: ${errorMessage(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${sourcePath}: rendered frontmatter must be a mapping`);
  }
  return {
    frontmatter: parsed as Record<string, unknown>,
    body: rendered.slice(close + "\n---\n".length),
  };
}

/** Translate one canonical Claude render to Pi metadata while retaining its
 * post-frontmatter body byte-for-byte. */
export function translateClaudeAgentToPi(input: {
  readonly role: string;
  readonly sourcePath: string;
  readonly rendered: string;
  readonly launchModel: string;
  readonly launchEffort: string;
  readonly taskFacadePath: string;
}): { readonly content: string; readonly body: string } {
  const source = splitRenderedClaudeAgent(input.rendered, input.sourcePath);
  const description = source.frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`${input.sourcePath}: description is required`);
  }
  const thinking = piThinking(input.launchEffort);
  const denied = translatedDeniedTools(source.frontmatter.disallowedTools);
  const lines = [
    "---",
    `description: ${JSON.stringify(description)}`,
    `model: ${input.launchModel}`,
    `thinking: ${thinking}`,
    `max_turns: ${maxTurns(thinking)}`,
    "prompt_mode: replace",
  ];
  if (input.role === "plan:panel-runner") {
    if (!existsSync(input.taskFacadePath)) {
      throw new Error(
        `${input.sourcePath}: Pi Task extension not found at ${input.taskFacadePath}`,
      );
    }
    lines.push(
      `extensions: ${JSON.stringify(`pi-subagents, ${input.taskFacadePath}`)}`,
      `tools: ${JSON.stringify("all, ext:task-facade/Task")}`,
    );
  }
  if (denied.length > 0) {
    lines.push(`disallowed_tools: ${JSON.stringify(denied.join(", "))}`);
  }
  lines.push("---", "");
  return {
    content: `${lines.join("\n")}${source.body}`,
    body: source.body,
  };
}

function localName(role: string): string {
  return role.slice(role.indexOf(":") + 1);
}

function resolveCell(
  role: PromptArtifactRole,
  pin: AgentPin,
  matrix: HostMatrixV2,
  equivalence: ProviderEquivalenceConfig,
): {
  assigned: PromptCompileCell;
  effective: PromptCompileCell;
  launch: PromptCompileLaunchCell;
} {
  const assigned = { model: pin.model, effort: pin.effort };
  let effective: EquivalenceCell = assigned;
  let route = hostMatrixV2ProviderRoute(matrix, "pi", assigned.model);
  if (route === undefined || !route.efforts.includes(assigned.effort)) {
    if (role.unserved !== "equivalent") {
      throw new Error(
        `${role.role}: provider pi does not serve assigned cell ${assigned.model}/${assigned.effort}`,
      );
    }
    const mapped = lookupProviderEquivalence(equivalence, assigned, "gpt");
    if (mapped === undefined) {
      throw new Error(
        `${role.role}: provider equivalence has no gpt target for assigned cell ${assigned.model}/${assigned.effort}`,
      );
    }
    effective = mapped;
    route = hostMatrixV2ProviderRoute(matrix, "pi", mapped.model);
  }
  if (route === undefined) {
    throw new Error(
      `${role.role}: provider pi has no route for effective capability '${effective.model}'`,
    );
  }
  if (!route.efforts.includes(effective.effort)) {
    throw new Error(
      `${role.role}: provider pi route '${route.launchId}' does not allow effort '${effective.effort}'`,
    );
  }
  return {
    assigned,
    effective: { ...effective },
    launch: {
      provider: "pi",
      model: route.launchId,
      effort: effective.effort,
    },
  };
}

function validateRequest(
  request: PromptCompileRequest,
  catalog: PromptArtifactCatalog,
): { kind: "bundle" | "role"; name: string } {
  if (request.target !== "pi") {
    throw new Error(`unsupported prompt compiler target '${request.target}'`);
  }
  const names = [request.bundle, request.role].filter(
    (value): value is string => value !== undefined,
  );
  if (names.length !== 1) {
    throw new Error(
      "prompt compile request must identify exactly one bundle or role",
    );
  }
  if (request.role !== undefined) {
    const role = catalog.roleByName.get(request.role);
    if (role === undefined)
      throw new Error(`unknown prompt artifact role '${request.role}'`);
    if (role.binding !== "static") {
      throw new Error(
        `${request.role}: target pi currently publishes static roles only`,
      );
    }
    return { kind: "role", name: request.role };
  }
  const bundle = catalog.bundleByName.get(request.bundle as string);
  if (bundle === undefined) {
    throw new Error(`unknown prompt artifact bundle '${request.bundle}'`);
  }
  if (
    !bundle.roles.some(
      (name) => catalog.roleByName.get(name)?.binding === "static",
    )
  ) {
    throw new Error(
      `${bundle.bundle}: target pi has no static role to publish in this slice`,
    );
  }
  return { kind: "bundle", name: bundle.bundle };
}

function fingerprintInputs(input: {
  catalogPath: string;
  matrixPath: string;
  equivalencePath: string;
  roles: readonly PromptArtifactRole[];
  taskFacadePath: string;
}): string {
  const hash = createHash("sha256");
  const add = (label: string, bytes: string | Buffer): void => {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    hash.update(`${label.length}:${label}:${value.length}:`);
    hash.update(value);
  };
  add("compiler", COMPILER_REVISION);
  add("target", "pi");
  add("task-facade-path", input.taskFacadePath);
  for (const [label, path] of [
    ["catalog", input.catalogPath],
    ["matrix", input.matrixPath],
    ["equivalence", input.equivalencePath],
  ] as const) {
    add(label, readFileSync(path));
  }
  for (const role of [...input.roles].sort((a, b) =>
    a.role.localeCompare(b.role),
  )) {
    add(`source:${role.role}:${role.source}`, readFileSync(role.sourcePath));
  }
  return hash.digest("hex");
}

function sidecarContent(
  role: PromptArtifactRole,
  planRoot: string,
  fingerprint: string,
): string {
  return [
    "Generated by keeper prompt compile. Do not edit this file directly.",
    `Role: ${role.role}`,
    `Source: ${relative(planRoot, role.sourcePath)}`,
    `Fingerprint: ${fingerprint}`,
    "Regenerate with: keeper prompt compile --bundle plan:static --target pi",
    "",
  ].join("\n");
}

function readManifest(path: string): PreviousManifest {
  if (!existsSync(path)) {
    return {
      exists: false,
      fingerprint: null,
      files: new Map(),
      sidecars: new Map(),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path}: invalid managed manifest: ${errorMessage(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: invalid managed manifest`);
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.schema_version !== 1 && rec.schema_version !== 2) {
    throw new Error(`${path}: unsupported managed manifest schema`);
  }
  const files = hashMap(rec.files, `${path}.files`);
  if (rec.schema_version === 1) {
    return { exists: true, fingerprint: null, files, sidecars: new Map() };
  }
  if (rec.target !== "pi" || typeof rec.fingerprint !== "string") {
    throw new Error(`${path}: malformed v2 managed manifest`);
  }
  return {
    exists: true,
    fingerprint: rec.fingerprint,
    files,
    sidecars: hashMap(rec.sidecars, `${path}.sidecars`),
  };
}

function hashMap(raw: unknown, label: string): Map<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be a mapping`);
  }
  const out = new Map<string, string>();
  for (const [name, hash] of Object.entries(raw as Record<string, unknown>)) {
    if (
      basename(name) !== name ||
      name.includes("\0") ||
      typeof hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(hash)
    ) {
      throw new Error(`${label} has invalid entry '${name}'`);
    }
    out.set(name, hash);
  }
  return out;
}

function fileMatches(path: string, hash: string): boolean {
  return existsSync(path) && sha256(readFileSync(path)) === hash;
}

function hasManagedSidecar(path: string): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  return (
    content.startsWith("Generated by keeper prompt compile.") ||
    content.startsWith("Generated by Keeper for Pi.")
  );
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temp, content, { mode: 0o644 });
  chmodSync(temp, 0o644);
  renameSync(temp, path);
}

function manifestBody(
  fingerprint: string,
  compiled: readonly CompiledRole[],
): string {
  const files: Record<string, string> = {};
  const sidecars: Record<string, string> = {};
  for (const item of compiled) {
    files[item.output] = item.hash;
    sidecars[item.sidecar] = item.sidecarHash;
  }
  const manifest: ManagedManifestV2 = {
    schema_version: 2,
    target: "pi",
    fingerprint,
    files,
    sidecars,
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Compile and publish the complete static plan-role set. A role/bundle request
 * is validated as the invocation scope, while publication deliberately ensures
 * the whole static set so one manifest has unambiguous orphan ownership. */
export function compilePromptArtifacts(
  options: PromptCompileOptions,
): PromptCompileResult {
  const repoRoot = resolve(
    options.repoRoot ?? resolve(import.meta.dir, "../../.."),
  );
  const planRoot = resolve(
    options.planRoot ?? join(repoRoot, "plugins", "plan"),
  );
  const catalogPath = resolve(
    options.catalogPath ?? join(planRoot, "prompt-artifacts.yaml"),
  );
  const matrixPath = resolve(options.matrixPath ?? joinDefaultMatrixPath());
  const equivalencePath = resolve(
    options.equivalencePath ?? join(planRoot, "provider-equivalence.yaml"),
  );
  const targetDir = resolve(options.targetDir ?? defaultPiAgentsDir());
  const taskFacadePath = resolve(
    options.taskFacadePath ??
      join(repoRoot, "plugins", "keeper", "pi-extension", "task-facade.ts"),
  );
  const check = options.check ?? false;

  const catalog = loadPromptArtifactCatalog(catalogPath, planRoot);
  const request = validateRequest(options.request, catalog);
  const matrix = loadHostMatrixV2(matrixPath);
  const equivalence = loadProviderEquivalenceConfig(equivalencePath);
  const equivalenceCheck = checkProviderEquivalence(equivalence);
  if (!equivalenceCheck.ok) {
    throw new Error(
      `provider equivalence map is invalid: ${equivalenceCheck.errors.join("; ")}`,
    );
  }
  const staticRoles = catalog.roles
    .filter((role) => role.binding === "static")
    .sort((a, b) => a.role.localeCompare(b.role));
  if (staticRoles.length === 0) {
    throw new Error("prompt artifact catalog has no static roles");
  }
  const fingerprint = fingerprintInputs({
    catalogPath,
    matrixPath,
    equivalencePath,
    roles: staticRoles,
    taskFacadePath,
  });

  const compiled: CompiledRole[] = staticRoles.map((role) => {
    const pin = matrix.agentPins.get(localName(role.role));
    if (pin === undefined) {
      throw new Error(
        `${role.role}: no agent_pins entry for '${localName(role.role)}'`,
      );
    }
    const cells = resolveCell(role, pin, matrix, equivalence);
    const variables = {
      agent_model: pin.model,
      agent_effort: pin.effort,
    };
    const canonical =
      options.renderCanonical?.(role.sourcePath, variables) ??
      `${renderTemplate(role.sourcePath, variables).text}\n`;
    const translated = translateClaudeAgentToPi({
      role: role.role,
      sourcePath: role.sourcePath,
      rendered: canonical,
      launchModel: cells.launch.model,
      launchEffort: cells.launch.effort,
      taskFacadePath,
    });
    const output = `${role.role}.md`;
    const sidecar = `${output}${SIDECAR_SUFFIX}`;
    const marker = sidecarContent(role, planRoot, fingerprint);
    return {
      role,
      output,
      content: translated.content,
      hash: sha256(translated.content),
      sidecar,
      sidecarContent: marker,
      sidecarHash: sha256(marker),
      ...cells,
    };
  });

  const manifestPath = join(targetDir, PI_PROMPT_MANIFEST);
  const previous = readManifest(manifestPath);
  for (const item of compiled) {
    const path = join(targetDir, item.output);
    const owned =
      previous.files.has(item.output) ||
      hasManagedSidecar(join(targetDir, item.sidecar));
    if (existsSync(path) && !owned) {
      throw new Error(`${path}: refusing to overwrite an unmanaged plan agent`);
    }
  }

  const expectedFiles = new Set(compiled.map((item) => item.output));
  const expectedSidecars = new Set(compiled.map((item) => item.sidecar));
  const stale = [...previous.files.keys()]
    .filter((name) => !expectedFiles.has(name))
    .sort();
  const staleSidecars = new Set(
    [...previous.sidecars.keys()].filter((name) => !expectedSidecars.has(name)),
  );
  for (const name of stale) staleSidecars.add(`${name}${SIDECAR_SUFFIX}`);

  const outputChanged = new Map<string, boolean>();
  let artifactDrift = stale.length > 0 || staleSidecars.size > 0;
  for (const item of compiled) {
    const changed = !fileMatches(join(targetDir, item.output), item.hash);
    const sidecarChanged = !fileMatches(
      join(targetDir, item.sidecar),
      item.sidecarHash,
    );
    outputChanged.set(item.output, changed);
    artifactDrift ||= changed || sidecarChanged;
  }
  const nextManifest = manifestBody(fingerprint, compiled);
  const manifestMatches =
    existsSync(manifestPath) &&
    readFileSync(manifestPath, "utf8") === nextManifest;
  const drift = artifactDrift || !manifestMatches;
  const inputsMatch = previous.fingerprint === fingerprint;
  const outcome: PromptCompileResult["outcome"] = !drift
    ? "hit"
    : previous.exists && inputsMatch
      ? "repaired"
      : "compiled";

  if (!check && drift) {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    for (const item of compiled) {
      const outputPath = join(targetDir, item.output);
      const sidecarPath = join(targetDir, item.sidecar);
      // The marker lands first so a crash before the manifest-last rename leaves
      // a recoverable ownership proof rather than an apparently unmanaged file.
      if (!fileMatches(sidecarPath, item.sidecarHash)) {
        atomicWrite(sidecarPath, item.sidecarContent);
      }
      if (!fileMatches(outputPath, item.hash)) {
        atomicWrite(outputPath, item.content);
      }
    }
    for (const name of stale) rmSync(join(targetDir, name), { force: true });
    for (const name of [...staleSidecars].sort()) {
      rmSync(join(targetDir, name), { force: true });
    }
    // Publication authority lands last: readers never observe a new manifest
    // that claims output bytes which have not yet been renamed into place.
    if (!manifestMatches) atomicWrite(manifestPath, nextManifest);
  }

  return {
    schema_version: 1,
    target: "pi",
    request,
    outcome,
    fingerprint,
    outputs: compiled.map((item) => ({
      role: item.role.role,
      output: item.output,
      sha256: item.hash,
      assigned_cell: item.assigned,
      effective_cell: item.effective,
      launch_cell: item.launch,
      changed: outputChanged.get(item.output) ?? false,
    })),
    removed: [...stale, ...[...staleSidecars].sort()],
    check,
    ok: !(check && drift),
  };
}

function defaultPiAgentsDir(): string {
  const root =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(root, "agents");
}

function joinDefaultMatrixPath(): string {
  const config =
    process.env.KEEPER_CONFIG_DIR ?? join(homedir(), ".config", "keeper");
  return join(config, "matrix.yaml");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
