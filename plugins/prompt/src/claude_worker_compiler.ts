import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import yaml from "js-yaml";
import { FileLock } from "../../../src/file-lock.ts";
import {
  type Driver,
  type HostMatrixV2,
  hostMatrixV2EffortsFor,
  hostMatrixV2ProviderRoute,
  parseHostMatrixV2Bytes,
} from "../../plan/src/host_matrix.ts";
import {
  type PromptArtifactCatalog,
  type PromptArtifactRole,
  parsePromptArtifactCatalogBytes,
} from "./artifact_catalog.ts";
import {
  type CapturedTemplateGraph,
  captureTemplateGraph,
  renderCapturedTemplate,
} from "./render_engine.ts";

export const CLAUDE_WORKER_MANIFEST = ".keeper-prompt-claude.json";
export const CLAUDE_WORKER_PUBLISHER = "keeper-prompt-compiler";
const CLAUDE_WORKER_FORMAT = "claude-worker-cell-v1";
const CLAUDE_WORKER_COMPILER_REVISION = "keeper-prompt-claude-worker-v1";
const SIDECAR_SUFFIX = ".managed-file-dont-edit";
const REGENERATE_CMD =
  "keeper prompt compile --role work:worker --target claude";
const VARIANTS_STRIP_RE = /^variants:.*\n/gm;
const MANIFEST_DESCRIPTION_STRIP_RE = /^manifest_description:.*\n/gm;

export interface ClaudeWorkerCompileRequest {
  readonly target: "claude";
  readonly bundle?: string;
  readonly role?: string;
}

export interface ClaudeWorkerCompileOptions {
  readonly request: ClaudeWorkerCompileRequest;
  readonly check?: boolean;
  /** Keeper root or the plan plugin root. */
  readonly repoRoot?: string;
  readonly planRoot?: string;
  readonly catalogPath?: string;
  readonly matrixPath?: string;
  /** Defaults to <plan-root>/workers. */
  readonly targetDir?: string;
}

export interface ClaudeWorkerCell {
  readonly model: string;
  readonly effort: string;
}

export interface ClaudeWorkerLaunchCell extends ClaudeWorkerCell {
  readonly provider: "claude";
}

export interface ClaudeWorkerPluginMetadata {
  readonly name: "work";
  readonly description: string;
  readonly version: "1.0.0";
  readonly author: { readonly name: "ArtHack" };
}

export interface ClaudeWorkerPluginResult {
  readonly output: string;
  readonly sha256: string;
  readonly sidecar: string;
  readonly sidecar_sha256: string;
  readonly changed: boolean;
  readonly sidecar_changed: boolean;
  readonly metadata: ClaudeWorkerPluginMetadata;
}

export interface ClaudeWorkerCompileCellResult {
  readonly role: string;
  readonly cell: ClaudeWorkerCell;
  readonly output: string;
  readonly sha256: string;
  readonly sidecar: string;
  readonly sidecar_sha256: string;
  readonly assigned_cell: ClaudeWorkerCell;
  readonly effective_cell: ClaudeWorkerCell;
  readonly strategy: Driver;
  readonly launch_cell: ClaudeWorkerLaunchCell;
  readonly max_turns: 160 | 300;
  readonly changed: boolean;
  readonly sidecar_changed: boolean;
  readonly plugin_manifest: ClaudeWorkerPluginResult;
}

export interface ClaudeWorkerCompileResult {
  readonly schema_version: 1;
  readonly target: "claude";
  readonly request: { readonly kind: "bundle" | "role"; readonly name: string };
  readonly outcome: "hit" | "compiled" | "repaired";
  readonly fingerprint: string;
  readonly outputs: readonly ClaudeWorkerCompileCellResult[];
  readonly removed: readonly string[];
  readonly drifted: readonly string[];
  readonly check: boolean;
  readonly ok: boolean;
}

export type ClaudeWorkerVerificationFailureKind =
  | "input-invalid"
  | "manifest-missing"
  | "manifest-invalid"
  | "fingerprint-mismatch"
  | "inventory-mismatch"
  | "hash-mismatch"
  | "sidecar-invalid"
  | "path-escape";

export interface ClaudeWorkerVerificationFailure {
  readonly kind: ClaudeWorkerVerificationFailureKind;
  readonly path?: string;
  readonly message: string;
}

export type ClaudeWorkerVerificationResult =
  | {
      readonly ok: true;
      readonly target: "claude";
      readonly fingerprint: string;
      readonly outputs: readonly ClaudeWorkerCompileCellResult[];
    }
  | {
      readonly ok: false;
      readonly target: "claude";
      readonly failure: ClaudeWorkerVerificationFailure;
    };

interface CompilerRoots {
  repoRoot: string;
  planRoot: string;
}

interface ClaudeSnapshot {
  catalogBytes: Buffer;
  matrixBytes: Buffer;
  catalog: PromptArtifactCatalog;
  matrix: HostMatrixV2;
  roles: PromptArtifactRole[];
  graphs: Map<string, CapturedTemplateGraph>;
}

interface Artifact {
  path: string;
  content: string;
  hash: string;
  sidecar: string;
  sidecarContent: string;
  sidecarHash: string;
  role: PromptArtifactRole;
}

interface PlannedCell {
  role: PromptArtifactRole;
  cell: ClaudeWorkerCell;
  assigned: ClaudeWorkerCell;
  effective: ClaudeWorkerCell;
  strategy: Driver;
  launch: ClaudeWorkerLaunchCell;
  maxTurns: 160 | 300;
  agent: Artifact;
  plugin: Artifact;
  pluginMetadata: ClaudeWorkerPluginMetadata;
}

interface PreparedCompilation {
  roots: CompilerRoots;
  targetDir: string;
  request: ClaudeWorkerCompileResult["request"];
  fingerprint: string;
  snapshot: ClaudeSnapshot;
  cells: PlannedCell[];
  artifacts: Artifact[];
  manifest: ManagedClaudeManifest;
  manifestContent: string;
}

interface ManifestCell {
  role: string;
  cell: ClaudeWorkerCell;
  assigned_cell: ClaudeWorkerCell;
  effective_cell: ClaudeWorkerCell;
  strategy: Driver;
  launch_cell: ClaudeWorkerLaunchCell;
  max_turns: 160 | 300;
  agent: {
    path: string;
    sha256: string;
    sidecar: string;
    sidecar_sha256: string;
  };
  plugin_manifest: {
    path: string;
    sha256: string;
    sidecar: string;
    sidecar_sha256: string;
    metadata: ClaudeWorkerPluginMetadata;
  };
}

interface ManagedClaudeManifest {
  schema_version: 1;
  target: "claude";
  publisher: typeof CLAUDE_WORKER_PUBLISHER;
  format: typeof CLAUDE_WORKER_FORMAT;
  fingerprint: string;
  files: Record<string, string>;
  sidecars: Record<string, string>;
  cells: ManifestCell[];
}

interface PreviousManifest {
  exists: boolean;
  raw: string | null;
  fingerprint: string | null;
  files: Map<string, string>;
  sidecars: Map<string, string>;
}

interface Inventory {
  files: Set<string>;
  dirs: Set<string>;
}

interface LegacyOwnership {
  staleFiles: Set<string>;
  staleSidecars: Set<string>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isPlanRoot(path: string): boolean {
  return (
    existsSync(join(path, "prompt-artifacts.yaml")) &&
    existsSync(join(path, "template", "agents"))
  );
}

/** Resolve either accepted --project-root shape without reading runtime state. */
export function resolveClaudeCompilerRoots(input: {
  repoRoot?: string;
  planRoot?: string;
}): CompilerRoots {
  if (input.planRoot !== undefined) {
    const planRoot = realpathDirectory(input.planRoot, "plan plugin root");
    const repoRoot = realpathDirectory(
      input.repoRoot ??
        (basename(planRoot) === "plan" &&
        basename(dirname(planRoot)) === "plugins"
          ? resolve(planRoot, "../..")
          : planRoot),
      "keeper root",
    );
    return validateCompilerRoots(repoRoot, planRoot);
  }
  const candidate = realpathDirectory(
    input.repoRoot ?? resolve(import.meta.dir, "../../.."),
    "project root",
  );
  if (isPlanRoot(candidate)) {
    return validateCompilerRoots(
      basename(candidate) === "plan" &&
        basename(dirname(candidate)) === "plugins"
        ? realpathDirectory(resolve(candidate, "../.."), "keeper root")
        : candidate,
      candidate,
    );
  }
  return validateCompilerRoots(
    candidate,
    realpathDirectory(join(candidate, "plugins", "plan"), "plan plugin root"),
  );
}

function validateCompilerRoots(
  repoRoot: string,
  planRoot: string,
): CompilerRoots {
  if (!isWithin(planRoot, repoRoot)) {
    throw new Error(
      `${planRoot}: physical plan plugin root is outside physical keeper root ${repoRoot}`,
    );
  }
  return { repoRoot, planRoot };
}

function realpathDirectory(path: string, label: string): string {
  try {
    const canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new Error(`${path}: ${label} is not a directory`);
  }
}

function defaultMatrixPath(): string {
  const config =
    process.env.KEEPER_CONFIG_DIR ?? join(homedir(), ".config", "keeper");
  return join(config, "matrix.yaml");
}

function validateRequest(
  request: ClaudeWorkerCompileRequest,
  catalog: PromptArtifactCatalog,
): ClaudeWorkerCompileResult["request"] {
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
    if (role === undefined) {
      throw new Error(`unknown prompt artifact role '${request.role}'`);
    }
    if (role.binding !== "cell-bound") {
      throw new Error(
        `${request.role}: target claude publishes cell-bound roles only`,
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
      (name) => catalog.roleByName.get(name)?.binding === "cell-bound",
    )
  ) {
    throw new Error(
      `${bundle.bundle}: target claude has no cell-bound role to publish`,
    );
  }
  return { kind: "bundle", name: bundle.bundle };
}

function snapshotInputs(input: {
  roots: CompilerRoots;
  catalogPath: string;
  matrixPath: string;
}): ClaudeSnapshot {
  const catalogBytes = readFileSync(input.catalogPath);
  const matrixBytes = readFileSync(input.matrixPath);
  const catalog = parsePromptArtifactCatalogBytes(
    catalogBytes,
    input.catalogPath,
    input.roots.planRoot,
  );
  const matrix = parseHostMatrixV2Bytes(matrixBytes, input.matrixPath);
  const roles = catalog.roles
    .filter((role) => role.binding === "cell-bound")
    .sort((a, b) => a.role.localeCompare(b.role));
  if (roles.length === 0) {
    throw new Error("prompt artifact catalog has no cell-bound roles");
  }
  if (
    roles.some(
      (role) =>
        role.role.split(":", 1)[0] !== "work" || role.unserved !== "wrapped",
    )
  ) {
    throw new Error(
      "target claude cell-bound cohort must consist of wrapped work roles",
    );
  }

  const catalogSources = roles.map((role) => role.source).sort();
  const matrixSources = [...matrix.subagentTemplates].sort();
  if (new Set(catalogSources).size !== catalogSources.length) {
    throw new Error("cell-bound catalog contains duplicate source templates");
  }
  if (new Set(matrixSources).size !== matrixSources.length) {
    throw new Error("matrix subagent_templates contains duplicate entries");
  }
  const omitted = catalogSources.filter(
    (source) => !matrixSources.includes(source),
  );
  const extras = matrixSources.filter(
    (source) => !catalogSources.includes(source),
  );
  if (omitted.length > 0 || extras.length > 0) {
    throw new Error(
      `cell-bound catalog and matrix subagent_templates disagree` +
        `${omitted.length > 0 ? `; omitted: ${omitted.join(", ")}` : ""}` +
        `${extras.length > 0 ? `; extras: ${extras.join(", ")}` : ""}`,
    );
  }

  const templateRoot = join(input.roots.planRoot, "template");
  const graphs = new Map<string, CapturedTemplateGraph>();
  for (const role of roles) {
    graphs.set(role.role, captureTemplateGraph(role.sourcePath, templateRoot));
  }
  return {
    catalogBytes: Buffer.from(catalogBytes),
    matrixBytes: Buffer.from(matrixBytes),
    catalog,
    matrix,
    roles,
    graphs,
  };
}

function fingerprintSnapshot(snapshot: ClaudeSnapshot): string {
  const hash = createHash("sha256");
  const add = (label: string, bytes: string | Buffer): void => {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    hash.update(`${label.length}:${label}:${value.length}:`);
    hash.update(value);
  };
  add("compiler", CLAUDE_WORKER_COMPILER_REVISION);
  add("target", "claude");
  add("format", CLAUDE_WORKER_FORMAT);
  add("catalog", snapshot.catalogBytes);
  add("matrix", snapshot.matrixBytes);
  const graphFiles = new Map<string, string>();
  for (const role of snapshot.roles) {
    const graph = snapshot.graphs.get(role.role);
    if (graph === undefined)
      throw new Error(`${role.role}: capture is missing`);
    for (const file of graph.files) {
      const previous = graphFiles.get(file.path);
      if (previous !== undefined && previous !== file.source) {
        throw new Error(
          `captured template graph path '${file.path}' has conflicting bytes`,
        );
      }
      graphFiles.set(file.path, file.source);
    }
  }
  for (const [path, source] of [...graphFiles].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    add(`template:${path}`, source);
  }
  return hash.digest("hex");
}

function parseFrontmatter(
  text: string,
  sourcePath: string,
): Record<string, unknown> {
  if (!text.startsWith("---\n")) {
    throw new Error(
      `${sourcePath}: rendered worker is missing YAML frontmatter`,
    );
  }
  const close = text.indexOf("\n---\n", 4);
  if (close < 0) {
    throw new Error(
      `${sourcePath}: rendered worker has unterminated frontmatter`,
    );
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(text.slice(4, close));
  } catch (error) {
    throw new Error(
      `${sourcePath}: rendered worker frontmatter is invalid: ${errorMessage(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${sourcePath}: rendered worker frontmatter must be a mapping`,
    );
  }
  return parsed as Record<string, unknown>;
}

function validateRenderedLaunchFrontmatter(input: {
  frontmatter: Readonly<Record<string, unknown>>;
  sourcePath: string;
  cellRoot: string;
  launch: ClaudeWorkerLaunchCell;
  maxTurns: 160 | 300;
}): void {
  const expected: Readonly<Record<"model" | "effort" | "maxTurns", unknown>> = {
    model: input.launch.model,
    effort: input.launch.effort,
    maxTurns: input.maxTurns,
  };
  for (const field of ["model", "effort", "maxTurns"] as const) {
    if (input.frontmatter[field] !== expected[field]) {
      throw new Error(
        `${input.sourcePath}: rendered ${input.cellRoot} frontmatter ${field} ` +
          `must be ${JSON.stringify(expected[field])}, got ${JSON.stringify(input.frontmatter[field])}`,
      );
    }
  }
}

function stripWorkerCompilerFields(rendered: string): string {
  return rendered
    .replace(VARIANTS_STRIP_RE, "")
    .replace(MANIFEST_DESCRIPTION_STRIP_RE, "");
}

function pluginMetadata(description: string): ClaudeWorkerPluginMetadata {
  return {
    name: "work",
    description,
    version: "1.0.0",
    author: { name: "ArtHack" },
  };
}

function pluginContent(metadata: ClaudeWorkerPluginMetadata): string {
  return `${JSON.stringify(metadata, null, 2)}\n`;
}

function sortedJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2);
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sidecarContent(input: {
  sourceTemplate: string;
  hash: string;
  fingerprint: string;
  role: string;
}): string {
  return `${sortedJson({
    _warning:
      "GENERATED — edit the source template and re-render with the regenerate_cmd command",
    fingerprint: input.fingerprint,
    publisher: CLAUDE_WORKER_PUBLISHER,
    regenerate_cmd: REGENERATE_CMD,
    role: input.role,
    sha256: input.hash,
    source_template: input.sourceTemplate,
    target: "claude",
  })}\n`;
}

function normalizeNestedPath(path: string, label: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label}: unsafe nested path '${path}'`);
  }
  return path;
}

function containedSourceTemplate(
  roots: CompilerRoots,
  sourcePath: string,
): string {
  let canonical: string;
  try {
    canonical = realpathSync(sourcePath);
    if (!statSync(canonical).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${sourcePath}: source template is not a physical file`);
  }
  if (!isWithin(canonical, roots.repoRoot)) {
    throw new Error(
      `${canonical}: source template is outside physical keeper root ${roots.repoRoot}`,
    );
  }
  return normalizeNestedPath(
    relative(roots.repoRoot, canonical).split(sep).join("/"),
    "source template",
  );
}

function artifact(input: {
  path: string;
  content: string;
  sourceTemplate: string;
  fingerprint: string;
  role: PromptArtifactRole;
}): Artifact {
  const path = normalizeNestedPath(input.path, "planned artifact");
  const hash = sha256(input.content);
  const sidecar = `${path}${SIDECAR_SUFFIX}`;
  const marker = sidecarContent({
    sourceTemplate: input.sourceTemplate,
    hash,
    fingerprint: input.fingerprint,
    role: input.role.role,
  });
  return {
    path,
    content: input.content,
    hash,
    sidecar,
    sidecarContent: marker,
    sidecarHash: sha256(marker),
    role: input.role,
  };
}

function claudeLaunchCell(
  matrix: HostMatrixV2,
  capability: string,
  effort: string,
  label: string,
): ClaudeWorkerLaunchCell {
  const route = hostMatrixV2ProviderRoute(matrix, "claude", capability);
  if (route === undefined) {
    throw new Error(
      `${label}: Claude provider has no route for capability '${capability}'`,
    );
  }
  if (!route.efforts.includes(effort)) {
    throw new Error(
      `${label}: Claude route '${route.launchId}' does not allow effort '${effort}'`,
    );
  }
  return {
    provider: "claude",
    model: route.launchId,
    effort,
  };
}

function buildCells(input: {
  roots: CompilerRoots;
  snapshot: ClaudeSnapshot;
  fingerprint: string;
}): { cells: PlannedCell[]; artifacts: Artifact[] } {
  const cells: PlannedCell[] = [];
  const artifacts = new Map<string, Artifact>();
  const wrapper = input.snapshot.matrix.wrapper_driver;
  const wrapperLaunch = claudeLaunchCell(
    input.snapshot.matrix,
    wrapper.model,
    wrapper.effort,
    "wrapper_driver",
  );
  for (const model of [...input.snapshot.matrix.models].sort()) {
    const strategy =
      input.snapshot.matrix.driverByModel.get(model) ?? "wrapped";
    for (const effort of hostMatrixV2EffortsFor(
      input.snapshot.matrix,
      model,
    ).sort()) {
      const assigned = { model, effort };
      const cellRoot = `${model}-${effort}`;
      const launch =
        strategy === "native"
          ? claudeLaunchCell(
              input.snapshot.matrix,
              model,
              effort,
              `native cell ${cellRoot}`,
            )
          : wrapperLaunch;
      const maxTurns = strategy === "native" ? 300 : 160;
      let cellPlugin: Artifact | undefined;
      let metadata: ClaudeWorkerPluginMetadata | undefined;
      for (const role of input.snapshot.roles) {
        const graph = input.snapshot.graphs.get(role.role);
        if (graph === undefined)
          throw new Error(`${role.role}: capture is missing`);
        const rendered = `${
          renderCapturedTemplate(graph, {
            current_model: strategy === "native" ? launch.model : model,
            current_effort: effort,
            current_driver: strategy,
            wrapper_model: wrapperLaunch.model,
            wrapper_effort: wrapperLaunch.effort,
          }).text
        }\n`;
        const frontmatter = parseFrontmatter(rendered, role.sourcePath);
        validateRenderedLaunchFrontmatter({
          frontmatter,
          sourcePath: role.sourcePath,
          cellRoot,
          launch,
          maxTurns,
        });
        const description = frontmatter.manifest_description;
        if (typeof description !== "string" || description.trim() === "") {
          throw new Error(
            `${role.sourcePath}: rendered worker is missing manifest_description`,
          );
        }
        const roleMetadata = pluginMetadata(description.trim());
        if (
          metadata !== undefined &&
          JSON.stringify(metadata) !== JSON.stringify(roleMetadata)
        ) {
          throw new Error(
            `${cellRoot}: cell-bound roles disagree on plugin manifest metadata`,
          );
        }
        metadata = roleMetadata;
        const sourceTemplate = containedSourceTemplate(
          input.roots,
          role.sourcePath,
        );
        const local = role.role.slice(role.role.indexOf(":") + 1);
        const agent = artifact({
          path: `${cellRoot}/agents/${local}.md`,
          content: stripWorkerCompilerFields(rendered),
          sourceTemplate,
          fingerprint: input.fingerprint,
          role,
        });
        const priorAgent = artifacts.get(agent.path);
        if (priorAgent !== undefined) {
          throw new Error(`duplicate planned worker artifact '${agent.path}'`);
        }
        artifacts.set(agent.path, agent);
        if (cellPlugin === undefined) {
          cellPlugin = artifact({
            path: `${cellRoot}/.claude-plugin/plugin.json`,
            content: pluginContent(roleMetadata),
            sourceTemplate,
            fingerprint: input.fingerprint,
            role,
          });
          const priorPlugin = artifacts.get(cellPlugin.path);
          if (priorPlugin !== undefined) {
            throw new Error(
              `duplicate planned worker artifact '${cellPlugin.path}'`,
            );
          }
          artifacts.set(cellPlugin.path, cellPlugin);
        }
        cells.push({
          role,
          cell: assigned,
          assigned,
          effective: assigned,
          strategy,
          launch,
          maxTurns,
          agent,
          plugin: cellPlugin,
          pluginMetadata: roleMetadata,
        });
      }
      if (cellPlugin === undefined || metadata === undefined) {
        throw new Error(`${cellRoot}: no cell-bound worker was rendered`);
      }
    }
  }
  return {
    cells,
    artifacts: [...artifacts.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    ),
  };
}

function manifestFrom(
  fingerprint: string,
  cells: readonly PlannedCell[],
  artifacts: readonly Artifact[],
): ManagedClaudeManifest {
  const files: Record<string, string> = {};
  const sidecars: Record<string, string> = {};
  for (const item of artifacts) {
    files[item.path] = item.hash;
    sidecars[item.sidecar] = item.sidecarHash;
  }
  return {
    schema_version: 1,
    target: "claude",
    publisher: CLAUDE_WORKER_PUBLISHER,
    format: CLAUDE_WORKER_FORMAT,
    fingerprint,
    files,
    sidecars,
    cells: cells.map((item) => ({
      role: item.role.role,
      cell: item.cell,
      assigned_cell: item.assigned,
      effective_cell: item.effective,
      strategy: item.strategy,
      launch_cell: item.launch,
      max_turns: item.maxTurns,
      agent: {
        path: item.agent.path,
        sha256: item.agent.hash,
        sidecar: item.agent.sidecar,
        sidecar_sha256: item.agent.sidecarHash,
      },
      plugin_manifest: {
        path: item.plugin.path,
        sha256: item.plugin.hash,
        sidecar: item.plugin.sidecar,
        sidecar_sha256: item.plugin.sidecarHash,
        metadata: item.pluginMetadata,
      },
    })),
  };
}

function prepareCompilation(
  options: ClaudeWorkerCompileOptions,
): PreparedCompilation {
  const roots = resolveClaudeCompilerRoots(options);
  const catalogPath = resolve(
    options.catalogPath ?? join(roots.planRoot, "prompt-artifacts.yaml"),
  );
  const matrixPath = resolve(options.matrixPath ?? defaultMatrixPath());
  const targetDir = canonicalizeClaudeWorkersRoot(
    resolve(options.targetDir ?? join(roots.planRoot, "workers")),
  );
  const snapshot = snapshotInputs({ roots, catalogPath, matrixPath });
  const request = validateRequest(options.request, snapshot.catalog);
  const fingerprint = fingerprintSnapshot(snapshot);
  const built = buildCells({ roots, snapshot, fingerprint });
  const manifest = manifestFrom(fingerprint, built.cells, built.artifacts);
  return {
    roots,
    targetDir,
    request,
    fingerprint,
    snapshot,
    ...built,
    manifest,
    manifestContent: `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function hashMap(raw: unknown, label: string): Map<string, string> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be a mapping`);
  }
  const out = new Map<string, string>();
  for (const [path, hash] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizeNestedPath(path, label);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`${label} has invalid hash for '${path}'`);
    }
    out.set(normalized, hash);
  }
  return out;
}

function readPreviousManifest(path: string): PreviousManifest {
  if (!existsSync(path)) {
    return {
      exists: false,
      raw: null,
      fingerprint: null,
      files: new Map(),
      sidecars: new Map(),
    };
  }
  let raw: string;
  let parsed: unknown;
  try {
    raw = readFileSync(path, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${path}: invalid Claude worker manifest: ${errorMessage(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: invalid Claude worker manifest`);
  }
  const rec = parsed as Record<string, unknown>;
  if (
    rec.schema_version !== 1 ||
    rec.target !== "claude" ||
    rec.publisher !== CLAUDE_WORKER_PUBLISHER ||
    rec.format !== CLAUDE_WORKER_FORMAT ||
    typeof rec.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(rec.fingerprint) ||
    !Array.isArray(rec.cells)
  ) {
    throw new Error(`${path}: malformed Claude worker manifest`);
  }
  const files = hashMap(rec.files, `${path}.files`);
  const sidecars = hashMap(rec.sidecars, `${path}.sidecars`);
  for (const file of files.keys()) {
    if (
      file === CLAUDE_WORKER_MANIFEST ||
      file.endsWith(SIDECAR_SUFFIX) ||
      sidecars.has(file)
    ) {
      throw new Error(`${path}: invalid managed primary path '${file}'`);
    }
  }
  for (const sidecar of sidecars.keys()) {
    if (
      sidecar === CLAUDE_WORKER_MANIFEST ||
      !sidecar.endsWith(SIDECAR_SUFFIX) ||
      files.has(sidecar)
    ) {
      throw new Error(`${path}: invalid managed sidecar path '${sidecar}'`);
    }
  }
  validateManifestCellPaths(rec.cells, `${path}.cells`, files, sidecars);
  return {
    exists: true,
    raw,
    fingerprint: rec.fingerprint,
    files,
    sidecars,
  };
}

function validateManifestCellPaths(
  raw: unknown[],
  label: string,
  files: ReadonlyMap<string, string>,
  sidecars: ReadonlyMap<string, string>,
): void {
  for (let index = 0; index < raw.length; index += 1) {
    const cell = raw[index];
    if (cell === null || typeof cell !== "object" || Array.isArray(cell)) {
      throw new Error(`${label}[${index}] must be a mapping`);
    }
    const rec = cell as Record<string, unknown>;
    for (const field of ["agent", "plugin_manifest"] as const) {
      const artifact = rec[field];
      if (
        artifact === null ||
        typeof artifact !== "object" ||
        Array.isArray(artifact)
      ) {
        throw new Error(`${label}[${index}].${field} must be a mapping`);
      }
      const artifactRec = artifact as Record<string, unknown>;
      if (typeof artifactRec.path !== "string") {
        throw new Error(`${label}[${index}].${field}.path must be a string`);
      }
      if (typeof artifactRec.sidecar !== "string") {
        throw new Error(`${label}[${index}].${field}.sidecar must be a string`);
      }
      const path = normalizeNestedPath(
        artifactRec.path,
        `${label}[${index}].${field}.path`,
      );
      const sidecar = normalizeNestedPath(
        artifactRec.sidecar,
        `${label}[${index}].${field}.sidecar`,
      );
      if (
        sidecar !== `${path}${SIDECAR_SUFFIX}` ||
        typeof artifactRec.sha256 !== "string" ||
        typeof artifactRec.sidecar_sha256 !== "string" ||
        files.get(path) !== artifactRec.sha256 ||
        sidecars.get(sidecar) !== artifactRec.sidecar_sha256
      ) {
        throw new Error(
          `${label}[${index}].${field} disagrees with managed hashes`,
        );
      }
    }
  }
}

function inspectInventory(targetDir: string): Inventory {
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (!existsSync(targetDir)) return { files, dirs };
  const walk = (absolute: string, prefix: string): void => {
    for (const name of readdirSync(absolute).sort()) {
      const path = join(absolute, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `${path}: symlinks are forbidden in the workers publication root`,
        );
      }
      if (stat.isDirectory()) {
        dirs.add(rel);
        walk(path, rel);
      } else if (stat.isFile()) {
        files.add(rel);
      } else {
        throw new Error(
          `${path}: unsupported filesystem entry in workers root`,
        );
      }
    }
  };
  walk(targetDir, "");
  return { files, dirs };
}

function expectedDirectories(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      out.add(parts.slice(0, index).join("/"));
    }
  }
  return out;
}

function fileMatches(path: string, hash: string): boolean {
  try {
    return statSync(path).isFile() && sha256(readFileSync(path)) === hash;
  } catch {
    return false;
  }
}

function assertNoNestedSymlink(targetDir: string, relativePath: string): void {
  const normalized = normalizeNestedPath(relativePath, "worker artifact");
  let current = targetDir;
  for (const part of normalized.split("/")) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`${current}: symlink escape in workers publication path`);
    }
  }
  const lexical = resolve(targetDir, ...normalized.split("/"));
  if (!isWithin(lexical, targetDir)) {
    throw new Error(
      `${relativePath}: worker artifact escapes publication root`,
    );
  }
}

function parseSidecar(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${path}: malformed worker sidecar: ${errorMessage(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: malformed worker sidecar`);
  }
  return parsed as Record<string, unknown>;
}

function sidecarSourceIsCanonical(
  source: unknown,
  roots: CompilerRoots,
  sourcePath: string,
): boolean {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.includes("\0") ||
    source.includes("\\") ||
    isAbsolute(source) ||
    source.split("/").includes("..")
  ) {
    return false;
  }
  for (const root of [roots.repoRoot, roots.planRoot]) {
    try {
      if (realpathSync(resolve(root, source)) === realpathSync(sourcePath)) {
        return true;
      }
    } catch {
      // Try the other accepted project-root shape.
    }
  }
  return false;
}

function validateNewSidecar(
  path: string,
  role: PromptArtifactRole,
  roots: CompilerRoots,
): Record<string, unknown> {
  const data = parseSidecar(path);
  const invalid = [
    data.publisher !== CLAUDE_WORKER_PUBLISHER ? "publisher" : null,
    data.target !== "claude" ? "target" : null,
    data.role !== role.role ? "role" : null,
    data.regenerate_cmd !== REGENERATE_CMD ? "regenerate_cmd" : null,
    typeof data.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.fingerprint)
      ? "fingerprint"
      : null,
    typeof data.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.sha256)
      ? "sha256"
      : null,
    data.source_template !== containedSourceTemplate(roots, role.sourcePath)
      ? "source_template"
      : null,
  ].filter((name): name is string => name !== null);
  if (invalid.length > 0) {
    throw new Error(
      `${path}: malformed or unrecognized Claude worker sidecar (${invalid.join(", ")})`,
    );
  }
  return data;
}

function validateLegacyPair(input: {
  primary: string;
  sidecar: string;
  role: PromptArtifactRole;
  roots: CompilerRoots;
}): void {
  if (!existsSync(input.primary) || !existsSync(input.sidecar)) {
    throw new Error(`${input.sidecar}: incomplete legacy worker artifact pair`);
  }
  const data = parseSidecar(input.sidecar);
  if (
    typeof data.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.sha256) ||
    !sidecarSourceIsCanonical(
      data.source_template,
      input.roots,
      input.role.sourcePath,
    ) ||
    !fileMatches(input.primary, data.sha256)
  ) {
    throw new Error(
      `${input.sidecar}: tampered or unrecognized legacy worker artifact`,
    );
  }
}

function validateUnclaimedPlannedArtifacts(
  prepared: PreparedCompilation,
  previous: PreviousManifest,
): void {
  for (const item of prepared.artifacts) {
    const primaryPath = join(prepared.targetDir, item.path);
    const sidecarPath = join(prepared.targetDir, item.sidecar);
    const primaryClaimed = previous.files.has(item.path);
    const sidecarClaimed = previous.sidecars.has(item.sidecar);
    if (primaryClaimed && sidecarClaimed) continue;
    const primaryExists = existsSync(primaryPath);
    const sidecarExists = existsSync(sidecarPath);
    if (!primaryExists && !sidecarExists) continue;
    if (!sidecarExists) {
      throw new Error(
        `${primaryPath}: refusing to overwrite an unmanaged worker artifact`,
      );
    }
    const data = parseSidecar(sidecarPath);
    if (data.publisher === CLAUDE_WORKER_PUBLISHER) {
      const marker = validateNewSidecar(sidecarPath, item.role, prepared.roots);
      const markerHash = marker.sha256 as string;
      const intactPriorPublication =
        primaryExists && fileMatches(primaryPath, markerHash);
      const currentMarkerFirstPublication =
        markerHash === item.hash && marker.fingerprint === prepared.fingerprint;
      if (!intactPriorPublication && !currentMarkerFirstPublication) {
        throw new Error(
          `${sidecarPath}: refusing new-format sidecar adoption without an intact primary or current marker-first proof`,
        );
      }
      continue;
    }
    validateLegacyPair({
      primary: primaryPath,
      sidecar: sidecarPath,
      role: item.role,
      roots: prepared.roots,
    });
  }
}

function validateLegacyInventory(
  prepared: PreparedCompilation,
  inventory: Inventory,
): LegacyOwnership {
  const expectedFiles = new Set<string>();
  for (const item of prepared.artifacts) {
    expectedFiles.add(item.path);
    expectedFiles.add(item.sidecar);
  }
  const staleFiles = new Set<string>();
  const staleSidecars = new Set<string>();
  const role = prepared.snapshot.roles.find(
    (item) => item.role === "work:worker",
  );
  if (role === undefined) {
    throw new Error("legacy worker adoption requires canonical work:worker");
  }
  const cells = new Set<string>();
  for (const file of inventory.files) {
    if (file === CLAUDE_WORKER_MANIFEST) continue;
    const first = file.split("/", 1)[0] as string;
    cells.add(first);
  }
  for (const cell of [...cells].sort()) {
    const accepted = [
      `${cell}/agents/worker.md`,
      `${cell}/agents/worker.md${SIDECAR_SUFFIX}`,
      `${cell}/.claude-plugin/plugin.json`,
      `${cell}/.claude-plugin/plugin.json${SIDECAR_SUFFIX}`,
    ];
    const actual = [...inventory.files]
      .filter((file) => file.startsWith(`${cell}/`))
      .sort();
    if (actual.some((file) => !accepted.includes(file))) {
      throw new Error(
        `${join(prepared.targetDir, cell)}: unmanaged extra in worker cell`,
      );
    }
    const planned = actual.some((file) => expectedFiles.has(file));
    if (planned) continue;
    if (
      actual.length !== accepted.length ||
      accepted.some((file) => !actual.includes(file))
    ) {
      throw new Error(
        `${join(prepared.targetDir, cell)}: incomplete unrecognized legacy cell`,
      );
    }
    for (const primary of [accepted[0] as string, accepted[2] as string]) {
      validateLegacyPair({
        primary: join(prepared.targetDir, primary),
        sidecar: join(prepared.targetDir, `${primary}${SIDECAR_SUFFIX}`),
        role,
        roots: prepared.roots,
      });
      staleFiles.add(primary);
      staleSidecars.add(`${primary}${SIDECAR_SUFFIX}`);
    }
  }
  return { staleFiles, staleSidecars };
}

function validateOwnership(input: {
  prepared: PreparedCompilation;
  previous: PreviousManifest;
  inventory: Inventory;
}): LegacyOwnership {
  const { prepared, previous, inventory } = input;
  for (const path of [
    ...previous.files.keys(),
    ...previous.sidecars.keys(),
    ...prepared.artifacts.flatMap((item) => [item.path, item.sidecar]),
  ]) {
    assertNoNestedSymlink(prepared.targetDir, path);
  }
  validateUnclaimedPlannedArtifacts(prepared, previous);

  if (!previous.exists) {
    const ownership = validateLegacyInventory(prepared, inventory);
    const accepted = new Set<string>([CLAUDE_WORKER_MANIFEST]);
    for (const item of prepared.artifacts) {
      accepted.add(item.path);
      accepted.add(item.sidecar);
    }
    for (const path of ownership.staleFiles) accepted.add(path);
    for (const path of ownership.staleSidecars) accepted.add(path);
    const extras = [...inventory.files].filter((path) => !accepted.has(path));
    if (extras.length > 0) {
      throw new Error(
        `${join(prepared.targetDir, extras[0] as string)}: unmanaged worker publication file`,
      );
    }
    const acceptedDirs = expectedDirectories(accepted);
    const extraDir = [...inventory.dirs].find(
      (path) => !acceptedDirs.has(path),
    );
    if (extraDir !== undefined) {
      throw new Error(
        `${join(prepared.targetDir, extraDir)}: unmanaged directory in workers publication root`,
      );
    }
    return ownership;
  }

  const desired = new Set<string>();
  for (const item of prepared.artifacts) {
    desired.add(item.path);
    desired.add(item.sidecar);
  }
  const claimed = new Set<string>([
    CLAUDE_WORKER_MANIFEST,
    ...previous.files.keys(),
    ...previous.sidecars.keys(),
    ...desired,
  ]);
  const extras = [...inventory.files].filter((path) => !claimed.has(path));
  if (extras.length > 0) {
    throw new Error(
      `${join(prepared.targetDir, extras[0] as string)}: unmanaged extra in workers publication root`,
    );
  }
  const claimedDirs = expectedDirectories(claimed);
  const extraDir = [...inventory.dirs].find((path) => !claimedDirs.has(path));
  if (extraDir !== undefined) {
    throw new Error(
      `${join(prepared.targetDir, extraDir)}: unmanaged directory in workers publication root`,
    );
  }

  for (const [path, hash] of previous.files) {
    if (desired.has(path) || !existsSync(join(prepared.targetDir, path)))
      continue;
    if (!fileMatches(join(prepared.targetDir, path), hash)) {
      throw new Error(
        `${join(prepared.targetDir, path)}: refusing to prune a modified orphan`,
      );
    }
  }
  for (const [path, hash] of previous.sidecars) {
    if (desired.has(path) || !existsSync(join(prepared.targetDir, path)))
      continue;
    if (!fileMatches(join(prepared.targetDir, path), hash)) {
      throw new Error(
        `${join(prepared.targetDir, path)}: refusing to prune a modified orphan sidecar`,
      );
    }
  }
  return { staleFiles: new Set(), staleSidecars: new Set() };
}

function exactInventoryMatches(
  inventory: Inventory,
  artifacts: readonly Artifact[],
): boolean {
  const expectedFiles = new Set<string>([CLAUDE_WORKER_MANIFEST]);
  for (const item of artifacts) {
    expectedFiles.add(item.path);
    expectedFiles.add(item.sidecar);
  }
  if (
    inventory.files.size !== expectedFiles.size ||
    [...expectedFiles].some((path) => !inventory.files.has(path))
  ) {
    return false;
  }
  const expectedDirs = expectedDirectories(expectedFiles);
  return (
    inventory.dirs.size === expectedDirs.size &&
    [...expectedDirs].every((path) => inventory.dirs.has(path))
  );
}

function artifactsMatch(
  targetDir: string,
  artifacts: readonly Artifact[],
): boolean {
  return artifacts.every(
    (item) =>
      fileMatches(join(targetDir, item.path), item.hash) &&
      fileMatches(join(targetDir, item.sidecar), item.sidecarHash),
  );
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, content, { mode: 0o644 });
    chmodSync(temp, 0o644);
    if (!readFileSync(temp).equals(Buffer.from(content))) {
      throw new Error(`${temp}: atomic write verification failed`);
    }
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function pruneEmptyParents(targetDir: string, paths: Iterable<string>): void {
  const dirs = new Set<string>();
  for (const path of paths) {
    let current = dirname(join(targetDir, path));
    while (current !== targetDir && isWithin(current, targetDir)) {
      dirs.add(current);
      current = dirname(current);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    if (!existsSync(dir)) continue;
    if (lstatSync(dir).isSymbolicLink()) {
      throw new Error(`${dir}: refusing to prune through a symlink`);
    }
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  }
}

function resultRows(
  cells: readonly PlannedCell[],
  changed: ReadonlyMap<string, boolean>,
): ClaudeWorkerCompileCellResult[] {
  return cells.map((item) => ({
    role: item.role.role,
    cell: item.cell,
    output: item.agent.path,
    sha256: item.agent.hash,
    sidecar: item.agent.sidecar,
    sidecar_sha256: item.agent.sidecarHash,
    assigned_cell: item.assigned,
    effective_cell: item.effective,
    strategy: item.strategy,
    launch_cell: item.launch,
    max_turns: item.maxTurns,
    changed: changed.get(item.agent.path) ?? false,
    sidecar_changed: changed.get(item.agent.sidecar) ?? false,
    plugin_manifest: {
      output: item.plugin.path,
      sha256: item.plugin.hash,
      sidecar: item.plugin.sidecar,
      sidecar_sha256: item.plugin.sidecarHash,
      changed: changed.get(item.plugin.path) ?? false,
      sidecar_changed: changed.get(item.plugin.sidecar) ?? false,
      metadata: item.pluginMetadata,
    },
  }));
}

function compilePrepared(
  prepared: PreparedCompilation,
  check: boolean,
): ClaudeWorkerCompileResult {
  const manifestPath = join(prepared.targetDir, CLAUDE_WORKER_MANIFEST);
  const previous = readPreviousManifest(manifestPath);
  const inventory = inspectInventory(prepared.targetDir);
  if (
    previous.fingerprint === prepared.fingerprint &&
    previous.raw === prepared.manifestContent &&
    exactInventoryMatches(inventory, prepared.artifacts) &&
    artifactsMatch(prepared.targetDir, prepared.artifacts)
  ) {
    return {
      schema_version: 1,
      target: "claude",
      request: prepared.request,
      outcome: "hit",
      fingerprint: prepared.fingerprint,
      outputs: resultRows(prepared.cells, new Map()),
      removed: [],
      drifted: [],
      check,
      ok: true,
    };
  }

  const legacy = validateOwnership({ prepared, previous, inventory });
  const expectedFiles = new Set(prepared.artifacts.map((item) => item.path));
  const expectedSidecars = new Set(
    prepared.artifacts.map((item) => item.sidecar),
  );
  const staleFiles = new Set(
    [...previous.files.keys()].filter((path) => !expectedFiles.has(path)),
  );
  const staleSidecars = new Set(
    [...previous.sidecars.keys()].filter((path) => !expectedSidecars.has(path)),
  );
  for (const path of legacy.staleFiles) staleFiles.add(path);
  for (const path of legacy.staleSidecars) staleSidecars.add(path);

  const changed = new Map<string, boolean>();
  const drifted = new Set<string>();
  for (const item of prepared.artifacts) {
    const primaryChanged = !fileMatches(
      join(prepared.targetDir, item.path),
      item.hash,
    );
    const markerChanged = !fileMatches(
      join(prepared.targetDir, item.sidecar),
      item.sidecarHash,
    );
    changed.set(item.path, primaryChanged);
    changed.set(item.sidecar, markerChanged);
    if (primaryChanged) drifted.add(item.path);
    if (markerChanged) drifted.add(item.sidecar);
  }
  const removed = [...new Set([...staleFiles, ...staleSidecars])].sort();
  for (const path of removed) drifted.add(path);
  if (previous.raw !== prepared.manifestContent) {
    drifted.add(CLAUDE_WORKER_MANIFEST);
  }
  const drift = drifted.size > 0;
  const outcome: ClaudeWorkerCompileResult["outcome"] =
    previous.exists && previous.fingerprint === prepared.fingerprint
      ? "repaired"
      : "compiled";

  if (!check && drift) {
    mkdirSync(prepared.targetDir, { recursive: true, mode: 0o700 });
    for (const item of prepared.artifacts) {
      assertNoNestedSymlink(prepared.targetDir, item.sidecar);
      if (
        !fileMatches(join(prepared.targetDir, item.sidecar), item.sidecarHash)
      ) {
        atomicWrite(
          join(prepared.targetDir, item.sidecar),
          item.sidecarContent,
        );
      }
    }
    for (const item of prepared.artifacts) {
      assertNoNestedSymlink(prepared.targetDir, item.path);
      if (!fileMatches(join(prepared.targetDir, item.path), item.hash)) {
        atomicWrite(join(prepared.targetDir, item.path), item.content);
      }
    }
    if (!artifactsMatch(prepared.targetDir, prepared.artifacts)) {
      throw new Error(
        "Claude worker artifacts changed before manifest publication",
      );
    }
    for (const path of [...staleFiles].sort()) {
      assertNoNestedSymlink(prepared.targetDir, path);
      rmSync(join(prepared.targetDir, path), { force: true });
    }
    for (const path of [...staleSidecars].sort()) {
      assertNoNestedSymlink(prepared.targetDir, path);
      rmSync(join(prepared.targetDir, path), { force: true });
    }
    pruneEmptyParents(prepared.targetDir, removed);
    if (!artifactsMatch(prepared.targetDir, prepared.artifacts)) {
      throw new Error("Claude worker artifacts changed during orphan pruning");
    }
    const finalInventory = inspectInventory(prepared.targetDir);
    const inventoryWithoutManifest = new Set(finalInventory.files);
    inventoryWithoutManifest.delete(CLAUDE_WORKER_MANIFEST);
    const expectedWithoutManifest = new Set<string>();
    for (const item of prepared.artifacts) {
      expectedWithoutManifest.add(item.path);
      expectedWithoutManifest.add(item.sidecar);
    }
    if (
      inventoryWithoutManifest.size !== expectedWithoutManifest.size ||
      [...expectedWithoutManifest].some(
        (path) => !inventoryWithoutManifest.has(path),
      )
    ) {
      throw new Error(
        "Claude worker inventory changed before manifest publication",
      );
    }
    atomicWrite(manifestPath, prepared.manifestContent);
    if (
      readFileSync(manifestPath, "utf8") !== prepared.manifestContent ||
      !artifactsMatch(prepared.targetDir, prepared.artifacts)
    ) {
      throw new Error("Claude worker publication failed final verification");
    }
  }

  return {
    schema_version: 1,
    target: "claude",
    request: prepared.request,
    outcome,
    fingerprint: prepared.fingerprint,
    outputs: resultRows(prepared.cells, changed),
    removed,
    drifted: [...drifted].sort(),
    check,
    ok: !(check && drift),
  };
}

/** Compile and publish the complete cell-bound cohort under the workers root. */
export function compileClaudeWorkerArtifacts(
  options: ClaudeWorkerCompileOptions,
): ClaudeWorkerCompileResult {
  const prepared = prepareCompilation(options);
  const check = options.check ?? false;
  if (check) return compilePrepared(prepared, true);

  const lockPath = `${prepared.targetDir}.keeper-prompt-claude.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = FileLock.acquire(lockPath);
  try {
    return compilePrepared(prepared, false);
  } finally {
    lock.release();
  }
}

function verificationFailure(
  kind: ClaudeWorkerVerificationFailureKind,
  message: string,
  path?: string,
): ClaudeWorkerVerificationResult {
  return {
    ok: false,
    target: "claude",
    failure: { kind, message, ...(path === undefined ? {} : { path }) },
  };
}

/** Fresh, read-only verification of source identity and the published cohort. */
export function verifyClaudeWorkerCohort(
  options: Omit<ClaudeWorkerCompileOptions, "request" | "check"> & {
    readonly request?: ClaudeWorkerCompileRequest;
  } = {},
): ClaudeWorkerVerificationResult {
  let prepared: PreparedCompilation;
  try {
    prepared = prepareCompilation({
      ...options,
      request: options.request ?? { target: "claude", role: "work:worker" },
    });
  } catch (error) {
    const message = errorMessage(error);
    const kind: ClaudeWorkerVerificationFailureKind = message.includes(
      "symlink",
    )
      ? "path-escape"
      : "input-invalid";
    return verificationFailure(kind, message);
  }
  const manifestPath = join(prepared.targetDir, CLAUDE_WORKER_MANIFEST);
  if (!existsSync(manifestPath)) {
    return verificationFailure(
      "manifest-missing",
      "Claude worker manifest is missing",
      manifestPath,
    );
  }
  let previous: PreviousManifest;
  try {
    previous = readPreviousManifest(manifestPath);
  } catch (error) {
    return verificationFailure(
      "manifest-invalid",
      errorMessage(error),
      manifestPath,
    );
  }
  if (previous.fingerprint !== prepared.fingerprint) {
    return verificationFailure(
      "fingerprint-mismatch",
      "Claude worker manifest fingerprint does not match current inputs",
      manifestPath,
    );
  }
  if (previous.raw !== prepared.manifestContent) {
    return verificationFailure(
      "manifest-invalid",
      "Claude worker manifest is not canonical",
      manifestPath,
    );
  }
  let inventory: Inventory;
  try {
    inventory = inspectInventory(prepared.targetDir);
  } catch (error) {
    return verificationFailure("path-escape", errorMessage(error));
  }
  if (!exactInventoryMatches(inventory, prepared.artifacts)) {
    return verificationFailure(
      "inventory-mismatch",
      "Claude worker publication inventory is not exact",
      prepared.targetDir,
    );
  }
  for (const item of prepared.artifacts) {
    if (!fileMatches(join(prepared.targetDir, item.path), item.hash)) {
      return verificationFailure(
        "hash-mismatch",
        "Claude worker primary hash does not match",
        join(prepared.targetDir, item.path),
      );
    }
    if (
      !fileMatches(join(prepared.targetDir, item.sidecar), item.sidecarHash)
    ) {
      return verificationFailure(
        "sidecar-invalid",
        "Claude worker sidecar bytes do not match",
        join(prepared.targetDir, item.sidecar),
      );
    }
  }
  return {
    ok: true,
    target: "claude",
    fingerprint: prepared.fingerprint,
    outputs: resultRows(prepared.cells, new Map()),
  };
}

/** Canonicalize a possibly missing workers root through its deepest existing
 * physical ancestor, so aliases share one lock and publication identity. */
export function canonicalizeClaudeWorkersRoot(targetDir: string): string {
  let ancestor = resolve(targetDir);
  const missing: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      throw new Error(`${targetDir}: cannot resolve a physical workers root`);
    }
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  const canonical = realpathSync(ancestor);
  if (!statSync(canonical).isDirectory()) {
    throw new Error(`${targetDir}: workers root ancestor is not a directory`);
  }
  return resolve(canonical, ...missing);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
