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
import { FileLock } from "../../../src/file-lock.ts";
import {
  type AgentPin,
  type HostMatrixV2,
  hostMatrixV2ProviderRoute,
  parseHostMatrixV2Bytes,
} from "../../plan/src/host_matrix.ts";
import {
  checkProviderEquivalence,
  type EquivalenceCell,
  lookupProviderEquivalence,
  type ProviderEquivalenceConfig,
  parseProviderEquivalenceConfigBytes,
} from "../../plan/src/provider_equivalence.ts";
import {
  type PromptArtifactCatalog,
  type PromptArtifactRole,
  parsePromptArtifactCatalogBytes,
} from "./artifact_catalog.ts";
import { renderTemplateSource } from "./render_engine.ts";

export const PI_PROMPT_MANIFEST = ".keeper-plan-agents.json";
const SIDECAR_SUFFIX = ".managed-file-dont-edit";
const COMPILER_REVISION = "keeper-prompt-pi-static-v2";

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
  /** Explicit deterministic values for canonical shell expressions. Every value
   * is snapshotted into the input fingerprint; the compiler never runs a shell. */
  readonly renderInputs?: Partial<PromptCompilerRenderInputs>;
  /** Deterministic test seam; receives the snapshotted canonical source bytes. */
  readonly renderCanonical?: (
    sourcePath: string,
    variables: Readonly<Record<string, string>>,
    source: string,
  ) => string;
}

export interface PromptCompilerRenderInputs {
  readonly currentYear: string;
  readonly knowctlAgentTeaser: string;
  readonly knowctlTopicCount: string;
  readonly knowctlTopics: string;
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
  readonly sidecar_changed: boolean;
}

export interface PromptCompileResult {
  readonly schema_version: 1;
  readonly target: "pi";
  readonly request: { readonly kind: "bundle" | "role"; readonly name: string };
  readonly outcome: "hit" | "compiled" | "repaired";
  readonly fingerprint: string;
  readonly outputs: readonly PromptCompileRoleResult[];
  readonly removed: readonly string[];
  readonly drifted: readonly string[];
  readonly check: boolean;
  readonly ok: boolean;
}

interface PlannedRole {
  role: PromptArtifactRole;
  output: string;
  sidecar: string;
  sidecarContent: string;
  sidecarHash: string;
  assigned: PromptCompileCell;
  effective: PromptCompileCell;
  launch: PromptCompileLaunchCell;
}

interface CompiledRole extends PlannedRole {
  content: string;
  hash: string;
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
  /** Compatibility facades can emit the model-free one-file header contract. */
  readonly emitModel?: boolean;
}): { readonly content: string; readonly body: string } {
  const source = splitRenderedClaudeAgent(input.rendered, input.sourcePath);
  const description = source.frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`${input.sourcePath}: description is required`);
  }
  const thinking = piThinking(input.launchEffort);
  const denied = translatedDeniedTools(source.frontmatter.disallowedTools);
  const lines = ["---", `description: ${JSON.stringify(description)}`];
  if (input.emitModel ?? true) {
    lines.push(`model: ${JSON.stringify(input.launchModel)}`);
  }
  lines.push(
    `thinking: ${thinking}`,
    `max_turns: ${maxTurns(thinking)}`,
    "prompt_mode: replace",
  );
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

interface PromptCompilerSnapshot {
  readonly catalog: Buffer;
  readonly matrix: Buffer;
  readonly equivalence: Buffer;
  readonly sources: ReadonlyMap<string, string>;
  readonly renderInputs: PromptCompilerRenderInputs;
}

function renderInputs(
  provided: Partial<PromptCompilerRenderInputs> | undefined,
): PromptCompilerRenderInputs {
  const values = {
    currentYear: String(new Date().getUTCFullYear()),
    knowctlAgentTeaser: "",
    knowctlTopicCount: "",
    knowctlTopics: "",
    ...provided,
  };
  if (!/^\d{4}$/.test(values.currentYear)) {
    throw new Error(
      "prompt compiler renderInputs.currentYear must be four digits",
    );
  }
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(
        `prompt compiler renderInputs.${name} must be a NUL-free string`,
      );
    }
  }
  return values;
}

function snapshotInputs(input: {
  catalogPath: string;
  matrixPath: string;
  equivalencePath: string;
  planRoot: string;
  renderInputs: PromptCompilerRenderInputs;
}): {
  snapshot: PromptCompilerSnapshot;
  catalog: PromptArtifactCatalog;
  matrix: HostMatrixV2;
  equivalence: ProviderEquivalenceConfig;
  roles: PromptArtifactRole[];
} {
  const catalogBytes = readFileSync(input.catalogPath);
  const matrixBytes = readFileSync(input.matrixPath);
  const equivalenceBytes = readFileSync(input.equivalencePath);
  const catalog = parsePromptArtifactCatalogBytes(
    catalogBytes,
    input.catalogPath,
    input.planRoot,
  );
  const matrix = parseHostMatrixV2Bytes(matrixBytes, input.matrixPath);
  const equivalence = parseProviderEquivalenceConfigBytes(
    equivalenceBytes,
    input.equivalencePath,
  );
  const roles = catalog.roles
    .filter((role) => role.binding === "static")
    .sort((a, b) => a.role.localeCompare(b.role));
  const sources = new Map<string, string>();
  for (const role of roles) {
    sources.set(role.role, readFileSync(role.sourcePath, "utf8"));
  }
  return {
    snapshot: {
      catalog: Buffer.from(catalogBytes),
      matrix: Buffer.from(matrixBytes),
      equivalence: Buffer.from(equivalenceBytes),
      sources,
      renderInputs: input.renderInputs,
    },
    catalog,
    matrix,
    equivalence,
    roles,
  };
}

function fingerprintInputs(input: {
  snapshot: PromptCompilerSnapshot;
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
  add("render-inputs", JSON.stringify(input.snapshot.renderInputs));
  add("catalog", input.snapshot.catalog);
  add("matrix", input.snapshot.matrix);
  add("equivalence", input.snapshot.equivalence);
  for (const role of input.roles) {
    const source = input.snapshot.sources.get(role.role);
    if (source === undefined) {
      throw new Error(`${role.role}: canonical template snapshot is missing`);
    }
    add(`source:${role.role}:${role.source}`, source);
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

function hasValidatedManagedSidecar(
  path: string,
  role: PromptArtifactRole,
  planRoot: string,
): boolean {
  if (!existsSync(path)) return false;
  const content = readFileSync(path, "utf8");
  const legacy = [
    "Generated by Keeper for Pi. Do not edit this file directly.",
    `Source: ${localName(role.role)}.md`,
    "Regenerate with: bun scripts/install-pi-plan-agents.ts",
    "",
  ].join("\n");
  if (content === legacy) return true;
  const lines = content.split("\n");
  return (
    lines.length === 6 &&
    lines[0] ===
      "Generated by keeper prompt compile. Do not edit this file directly." &&
    lines[1] === `Role: ${role.role}` &&
    lines[2] === `Source: ${relative(planRoot, role.sourcePath)}` &&
    /^Fingerprint: [a-f0-9]{64}$/.test(lines[3] ?? "") &&
    lines[4] ===
      "Regenerate with: keeper prompt compile --bundle plan:static --target pi" &&
    lines[5] === ""
  );
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, content, { mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function compilerShell(
  inputs: PromptCompilerRenderInputs,
): (command: string) => string {
  return (command) => {
    if (command === "date +%Y") return inputs.currentYear;
    if (command.includes("knowctl --agent-teaser")) {
      return inputs.knowctlAgentTeaser;
    }
    if (command.includes("knowctl list-topics") && command.includes("wc -l")) {
      return inputs.knowctlTopicCount;
    }
    if (
      command.includes("knowctl list-topics") &&
      command.includes("paste -sd")
    ) {
      return inputs.knowctlTopics;
    }
    throw new Error(
      `prompt compiler template uses unsnapshotted shell command ${JSON.stringify(command)}`,
    );
  };
}

function manifestBodyFromHashes(
  fingerprint: string,
  planned: readonly PlannedRole[],
  fileHashes: ReadonlyMap<string, string>,
): string {
  const files: Record<string, string> = {};
  const sidecars: Record<string, string> = {};
  for (const item of planned) {
    const hash = fileHashes.get(item.output);
    if (hash === undefined) {
      throw new Error(`missing compiled hash for ${item.output}`);
    }
    files[item.output] = hash;
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

function planRoles(
  roles: readonly PromptArtifactRole[],
  matrix: HostMatrixV2,
  equivalence: ProviderEquivalenceConfig,
  planRoot: string,
  fingerprint: string,
): PlannedRole[] {
  return roles.map((role) => {
    const pin = matrix.agentPins.get(localName(role.role));
    if (pin === undefined) {
      throw new Error(
        `${role.role}: no agent_pins entry for '${localName(role.role)}'`,
      );
    }
    const cells = resolveCell(role, pin, matrix, equivalence);
    const output = `${role.role}.md`;
    const sidecar = `${output}${SIDECAR_SUFFIX}`;
    const marker = sidecarContent(role, planRoot, fingerprint);
    return {
      role,
      output,
      sidecar,
      sidecarContent: marker,
      sidecarHash: sha256(marker),
      ...cells,
    };
  });
}

function fastPathMatches(
  previous: PreviousManifest,
  fingerprint: string,
  planned: readonly PlannedRole[],
  targetDir: string,
  manifestPath: string,
): boolean {
  if (
    previous.fingerprint !== fingerprint ||
    previous.files.size !== planned.length ||
    previous.sidecars.size !== planned.length
  ) {
    return false;
  }
  for (const item of planned) {
    const outputHash = previous.files.get(item.output);
    if (
      outputHash === undefined ||
      previous.sidecars.get(item.sidecar) !== item.sidecarHash ||
      !fileMatches(join(targetDir, item.output), outputHash) ||
      !fileMatches(join(targetDir, item.sidecar), item.sidecarHash)
    ) {
      return false;
    }
  }
  return (
    readFileSync(manifestPath, "utf8") ===
    manifestBodyFromHashes(fingerprint, planned, previous.files)
  );
}

function roleResults(
  planned: readonly PlannedRole[],
  hashes: ReadonlyMap<string, string>,
  outputChanged: ReadonlyMap<string, boolean>,
  sidecarChanged: ReadonlyMap<string, boolean>,
): PromptCompileRoleResult[] {
  return planned.map((item) => ({
    role: item.role.role,
    output: item.output,
    sha256: hashes.get(item.output) as string,
    assigned_cell: item.assigned,
    effective_cell: item.effective,
    launch_cell: item.launch,
    changed: outputChanged.get(item.output) ?? false,
    sidecar_changed: sidecarChanged.get(item.sidecar) ?? false,
  }));
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

  const snapshotted = snapshotInputs({
    catalogPath,
    matrixPath,
    equivalencePath,
    planRoot,
    renderInputs: renderInputs(options.renderInputs),
  });
  const request = validateRequest(options.request, snapshotted.catalog);
  const equivalenceCheck = checkProviderEquivalence(snapshotted.equivalence);
  if (!equivalenceCheck.ok) {
    throw new Error(
      `provider equivalence map is invalid: ${equivalenceCheck.errors.join("; ")}`,
    );
  }
  if (snapshotted.roles.length === 0) {
    throw new Error("prompt artifact catalog has no static roles");
  }
  const fingerprint = fingerprintInputs({
    snapshot: snapshotted.snapshot,
    roles: snapshotted.roles,
    taskFacadePath,
  });
  const planned = planRoles(
    snapshotted.roles,
    snapshotted.matrix,
    snapshotted.equivalence,
    planRoot,
    fingerprint,
  );
  if (
    planned.some((item) => item.role.role === "plan:panel-runner") &&
    !existsSync(taskFacadePath)
  ) {
    throw new Error(`Pi Task extension not found at ${taskFacadePath}`);
  }

  const lockPath = `${targetDir}.keeper-prompt-compile.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = FileLock.acquire(lockPath);
  try {
    return compileUnderPublicationLock({
      options,
      request,
      check,
      planRoot,
      targetDir,
      taskFacadePath,
      fingerprint,
      snapshot: snapshotted.snapshot,
      planned,
    });
  } finally {
    lock.release();
  }
}

function compileUnderPublicationLock(input: {
  options: PromptCompileOptions;
  request: PromptCompileResult["request"];
  check: boolean;
  planRoot: string;
  targetDir: string;
  taskFacadePath: string;
  fingerprint: string;
  snapshot: PromptCompilerSnapshot;
  planned: readonly PlannedRole[];
}): PromptCompileResult {
  const manifestPath = join(input.targetDir, PI_PROMPT_MANIFEST);
  const previous = readManifest(manifestPath);

  if (
    fastPathMatches(
      previous,
      input.fingerprint,
      input.planned,
      input.targetDir,
      manifestPath,
    )
  ) {
    const unchanged = new Map<string, boolean>();
    return {
      schema_version: 1,
      target: "pi",
      request: input.request,
      outcome: "hit",
      fingerprint: input.fingerprint,
      outputs: roleResults(input.planned, previous.files, unchanged, unchanged),
      removed: [],
      drifted: [],
      check: input.check,
      ok: true,
    };
  }

  for (const item of input.planned) {
    const outputPath = join(input.targetDir, item.output);
    const sidecarPath = join(input.targetDir, item.sidecar);
    const markerOwned = hasValidatedManagedSidecar(
      sidecarPath,
      item.role,
      input.planRoot,
    );
    if (
      existsSync(sidecarPath) &&
      !previous.sidecars.has(item.sidecar) &&
      !markerOwned
    ) {
      throw new Error(
        `${sidecarPath}: refusing to overwrite an unmanaged sidecar`,
      );
    }
    if (
      existsSync(outputPath) &&
      !previous.files.has(item.output) &&
      !markerOwned
    ) {
      throw new Error(
        `${outputPath}: refusing to overwrite an unmanaged plan agent`,
      );
    }
  }

  const compiled: CompiledRole[] = input.planned.map((item) => {
    const source = input.snapshot.sources.get(item.role.role);
    if (source === undefined) {
      throw new Error(
        `${item.role.role}: canonical template snapshot is missing`,
      );
    }
    const variables = {
      agent_model: item.assigned.model,
      agent_effort: item.assigned.effort,
    };
    const canonical =
      input.options.renderCanonical?.(
        item.role.sourcePath,
        variables,
        source,
      ) ??
      `${
        renderTemplateSource(item.role.sourcePath, source, variables, {
          shell: compilerShell(input.snapshot.renderInputs),
        }).text
      }\n`;
    const translated = translateClaudeAgentToPi({
      role: item.role.role,
      sourcePath: item.role.sourcePath,
      rendered: canonical,
      launchModel: item.launch.model,
      launchEffort: item.launch.effort,
      taskFacadePath: input.taskFacadePath,
    });
    return {
      ...item,
      content: translated.content,
      hash: sha256(translated.content),
    };
  });
  const hashes = new Map(compiled.map((item) => [item.output, item.hash]));
  const expectedFiles = new Set(compiled.map((item) => item.output));
  const expectedSidecars = new Set(compiled.map((item) => item.sidecar));
  const stale = [...previous.files.keys()]
    .filter((name) => !expectedFiles.has(name))
    .sort();
  const staleSidecars = new Set(
    [...previous.sidecars.keys()].filter((name) => !expectedSidecars.has(name)),
  );
  for (const name of stale) staleSidecars.add(`${name}${SIDECAR_SUFFIX}`);
  const removed = [...new Set([...stale, ...staleSidecars])].sort();

  const outputChanged = new Map<string, boolean>();
  const sidecarChanged = new Map<string, boolean>();
  const drifted = new Set<string>(removed);
  for (const item of compiled) {
    const changed = !fileMatches(join(input.targetDir, item.output), item.hash);
    const markerChanged = !fileMatches(
      join(input.targetDir, item.sidecar),
      item.sidecarHash,
    );
    outputChanged.set(item.output, changed);
    sidecarChanged.set(item.sidecar, markerChanged);
    if (changed) drifted.add(item.output);
    if (markerChanged) drifted.add(item.sidecar);
  }
  const nextManifest = manifestBodyFromHashes(
    input.fingerprint,
    compiled,
    hashes,
  );
  const manifestMatches =
    existsSync(manifestPath) &&
    readFileSync(manifestPath, "utf8") === nextManifest;
  if (!manifestMatches) drifted.add(PI_PROMPT_MANIFEST);
  const drift = drifted.size > 0;
  const outcome: PromptCompileResult["outcome"] =
    previous.exists && previous.fingerprint === input.fingerprint
      ? "repaired"
      : "compiled";

  if (!input.check && drift) {
    mkdirSync(input.targetDir, { recursive: true, mode: 0o700 });
    for (const item of compiled) {
      const outputPath = join(input.targetDir, item.output);
      const sidecarPath = join(input.targetDir, item.sidecar);
      // Marker first: an interrupted manifest-last publication leaves a
      // validated ownership proof, never an apparently unmanaged primary.
      if (!fileMatches(sidecarPath, item.sidecarHash)) {
        atomicWrite(sidecarPath, item.sidecarContent);
      }
      if (!fileMatches(outputPath, item.hash)) {
        atomicWrite(outputPath, item.content);
      }
    }
    for (const name of stale) {
      rmSync(join(input.targetDir, name), { force: true });
    }
    for (const name of [...staleSidecars].sort()) {
      rmSync(join(input.targetDir, name), { force: true });
    }

    // Reverify every claimed byte under the target-scoped lock immediately
    // before the manifest-last publication authority is renamed into place.
    for (const item of compiled) {
      if (!fileMatches(join(input.targetDir, item.output), item.hash)) {
        throw new Error(
          `${join(input.targetDir, item.output)}: changed before manifest publication`,
        );
      }
      if (!fileMatches(join(input.targetDir, item.sidecar), item.sidecarHash)) {
        throw new Error(
          `${join(input.targetDir, item.sidecar)}: changed before manifest publication`,
        );
      }
    }
    if (!manifestMatches) atomicWrite(manifestPath, nextManifest);
  }

  return {
    schema_version: 1,
    target: "pi",
    request: input.request,
    outcome,
    fingerprint: input.fingerprint,
    outputs: roleResults(compiled, hashes, outputChanged, sidecarChanged),
    removed,
    drifted: [...drifted].sort(),
    check: input.check,
    ok: !(input.check && drift),
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
