/**
 * Shared transitive import-closure walker for the structural boundary tests.
 * Both consumers — the reconcile-core pure-import pin and the daemon load-surface
 * boundary check — walk a module's relative-import closure from comment-stripped
 * source reads only (fast tier: no subprocess, no git, no module load).
 *
 * Per-statement import-type aware: `import type` / `export type` are erased at
 * runtime and dropped before every check; an inline `import { type Foo, bar }`
 * still pulls `bar` at runtime, so it stays a value statement. Only value imports
 * are reported or followed.
 *
 * The walker models every real runtime edge class, not just static imports:
 *   - static / re-export / bare / dynamic relative imports (source → followed);
 *   - `new Worker(new URL("./x.ts", import.meta.url))` spawn edges — each target
 *     seeded as an additional closure root (src/bus-worker.ts is reachable ONLY
 *     this way); and
 *   - attribute imports (`import x from "./y.yaml" with { type: "text" }`) whose
 *     target is a non-source data asset — a real load edge, recorded but not
 *     walked (it holds no code).
 * A missed edge class silently narrows an enforced boundary, so the count of
 * worker edges is surfaced for the caller to assert positive.
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, posix, relative, resolve, sep } from "node:path";

export const repoRoot = realpathSync(resolve(import.meta.dirname, "../.."));

/** Source extensions the walker follows / scans. A relative import resolving to
 *  anything else (a `.yaml` / `.json` data asset) is a leaf: no imports, no
 *  runtime code — recorded as an asset edge, never followed. */
export const SOURCE_EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/**
 * Strip block + line comments, literal-aware, in ONE pass. A module's own prose
 * names the very specifiers a scan bans, and comment-like byte sequences hide
 * inside strings, templates, and regex literals (and vice versa: a `//` inside a
 * regex, a `/*` inside a `//` line comment). A naive two-regex strip mis-eats
 * those — e.g. a `//` line comment mentioning `.keeper/**` opens a phantom block
 * comment that swallows real code below it, silently dropping worker-spawn edges.
 * This scanner tracks literal state so comment delimiters inside a literal are
 * inert and code delimiters inside a comment never leak. Newlines are preserved
 * so line structure survives for downstream scans.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl" | "regex";
  let state: State = "code";
  // Previous significant (non-whitespace) char, to disambiguate a `/` as the
  // start of a regex literal vs a division operator.
  let prevSig = "";
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (state === "code") {
      if (c === "/" && c2 === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === '"') {
        state = "dq";
        out += c;
        prevSig = c;
        i++;
        continue;
      }
      if (c === "'") {
        state = "sq";
        out += c;
        prevSig = c;
        i++;
        continue;
      }
      if (c === "`") {
        state = "tpl";
        out += c;
        prevSig = c;
        i++;
        continue;
      }
      if (c === "/") {
        // A `/` starts a regex only where an expression may begin — after an
        // operator, an opener, or start-of-input; never after a value-ending
        // char (identifier, `)`, `]`, literal). Ambiguity resolves toward
        // division (leaving the chars as inert code), the safe direction.
        const canRegex =
          prevSig === "" || "(,=:[!&|?{};+-*%^~<>".includes(prevSig);
        if (canRegex) {
          state = "regex";
          out += c;
          prevSig = c;
          i++;
          continue;
        }
      }
      out += c;
      if (!/\s/.test(c)) prevSig = c;
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && c2 === "/") {
        state = "code";
        i += 2;
        continue;
      }
      if (c === "\n") out += c;
      i++;
      continue;
    }
    // string / template / regex literal: copy verbatim, honoring `\` escapes.
    out += c;
    if (c === "\\") {
      if (c2) out += c2;
      i += 2;
      continue;
    }
    const close =
      state === "sq" ? "'" : state === "dq" ? '"' : state === "tpl" ? "`" : "/";
    if (c === close) {
      state = "code";
      prevSig = c;
    }
    i++;
  }
  return out;
}

export interface ParsedImport {
  spec: string;
  /** `import type` / `export type` — erased at runtime, dropped before checks. */
  typeOnly: boolean;
}

/** Parse every import/export specifier out of already-comment-stripped code,
 *  classifying each STATEMENT (not the whole module) as type-only or value.
 *  Attribute imports (`... from "x" with { type: "..." }`) match the `from`
 *  form — the trailing `with { … }` clause does not interfere. */
export function parseImports(code: string): ParsedImport[] {
  const out = parseStaticImports(code);
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m = dynRe.exec(code);
  while (m !== null) {
    out.push({ spec: m[1], typeOnly: false });
    m = dynRe.exec(code);
  }
  return out;
}

/** Static import/re-export subset of parseImports. Runtime cycle analysis rejects
 * local dynamic imports rather than quietly treating a partial dynamic-import
 * grammar as complete. */
export function parseStaticImports(code: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  const fromRe = /\b(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m = fromRe.exec(code);
  while (m !== null) {
    out.push({ spec: m[2], typeOnly: /^\s*type\b/.test(m[1]) });
    m = fromRe.exec(code);
  }
  const bareRe = /\bimport\s+['"]([^'"]+)['"]/g;
  m = bareRe.exec(code);
  while (m !== null) {
    out.push({ spec: m[1], typeOnly: false });
    m = bareRe.exec(code);
  }
  return out;
}

/** Parse `new Worker(new URL("./x.ts", import.meta.url))` spawn-edge targets out
 *  of comment-stripped code. Whitespace-tolerant so the inline and multi-line
 *  spawn forms both match. */
export function parseWorkerSpecs(code: string): string[] {
  const out: string[] = [];
  const wRe = /new\s+Worker\s*\(\s*new\s+URL\(\s*['"]([^'"]+)['"]/g;
  let m = wRe.exec(code);
  while (m !== null) {
    out.push(m[1]);
    m = wRe.exec(code);
  }
  return out;
}

/** Resolve a RELATIVE specifier to a SOURCE file in the closure, or `null` for a
 *  bare/`node:` specifier (not walked) or a non-source asset (see resolveAsset). */
export function resolveSource(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    ...SOURCE_EXTS.map((e) => base + e),
    ...SOURCE_EXTS.map((e) => resolve(base, `index${e}`)),
  ];
  for (const c of candidates) {
    if (SOURCE_EXTS.some((e) => c.endsWith(e)) && existsSync(c)) return c;
  }
  return null;
}

/** Resolve a RELATIVE specifier to an in-repo NON-source data asset (a `.yaml` /
 *  `.json` attribute-import target), or `null`. These are real load edges but
 *  hold no code, so they are recorded and boundary-checked, never walked. */
export function resolveAsset(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  if (existsSync(base) && !SOURCE_EXTS.some((e) => base.endsWith(e)))
    return base;
  return null;
}

export interface ClosureFile {
  abs: string;
  rel: string;
  /** Comment-stripped source. */
  code: string;
  /** Value-import specifiers (type-only dropped), for ban checks. */
  valueSpecs: string[];
}

export interface WalkResult {
  /** Every visited SOURCE module, comment-stripped, with its value specifiers. */
  files: ClosureFile[];
  /** Repo-relative worker-spawn targets discovered (one per edge; a target
   *  spawned from two files counts twice). */
  workerEdges: string[];
  /** Repo-relative in-repo data assets reached via attribute/asset imports. */
  assetImports: string[];
}

/** Walk the transitive runtime closure from `rootAbs`: relative imports, worker
 *  spawn edges (seeded as additional roots), and asset imports. */
export function walkClosure(rootAbs: string): WalkResult {
  const visited = new Set<string>();
  const queue = [rootAbs];
  const files: ClosureFile[] = [];
  const workerEdges: string[] = [];
  const assetSet = new Set<string>();
  while (queue.length > 0) {
    const abs = queue.shift() as string;
    if (visited.has(abs)) continue;
    visited.add(abs);
    const code = stripComments(readFileSync(abs, "utf8"));
    const valueSpecs: string[] = [];
    for (const imp of parseImports(code)) {
      if (imp.typeOnly) continue;
      valueSpecs.push(imp.spec);
      const src = resolveSource(abs, imp.spec);
      if (src !== null) {
        queue.push(src);
        continue;
      }
      const asset = resolveAsset(abs, imp.spec);
      if (asset !== null) assetSet.add(relative(repoRoot, asset));
    }
    for (const spec of parseWorkerSpecs(code)) {
      const src = resolveSource(abs, spec);
      if (src !== null) {
        workerEdges.push(relative(repoRoot, src));
        queue.push(src);
      }
    }
    files.push({ abs, rel: relative(repoRoot, abs), code, valueSpecs });
  }
  return { files, workerEdges, assetImports: [...assetSet].sort() };
}

export interface RuntimeEdge {
  from: string;
  to: string;
}

export interface RuntimeGraph {
  files: string[];
  edges: RuntimeEdge[];
}

export class DependencyGraphError extends Error {
  constructor(message: string) {
    super(`runtime dependency graph: ${message}`);
    this.name = "DependencyGraphError";
  }
}

/** Canonical slash-separated repository path, independent of host separators. */
function canonicalPath(path: string): string {
  return path.split(sep).join("/");
}

function codeOffsets(code: string): Set<number> {
  const offsets = new Set<number>();
  type State = "code" | "sq" | "dq" | "tpl" | "regex";
  let state: State = "code";
  let prevSig = "";
  let templateExpressionDepth: number | null = null;
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (state === "code") {
      offsets.add(i);
      if (char === "'" || char === '"' || char === "`") {
        state = char === "'" ? "sq" : char === '"' ? "dq" : "tpl";
      } else if (char === "/") {
        const canRegex =
          prevSig === "" || "(,=:[!&|?{};+-*%^~<>".includes(prevSig);
        if (canRegex) state = "regex";
      } else if (templateExpressionDepth !== null && char === "{") {
        templateExpressionDepth++;
      } else if (templateExpressionDepth !== null && char === "}") {
        templateExpressionDepth--;
        if (templateExpressionDepth === 0) {
          templateExpressionDepth = null;
          state = "tpl";
        }
      }
      if (!/\s/.test(char)) prevSig = char;
      continue;
    }
    if (char === "\\") {
      i++;
      continue;
    }
    if (state === "tpl" && char === "$" && code[i + 1] === "{") {
      offsets.add(i + 1);
      templateExpressionDepth = 1;
      state = "code";
      i++;
      prevSig = "{";
      continue;
    }
    const close =
      state === "sq" ? "'" : state === "dq" ? '"' : state === "tpl" ? "`" : "/";
    if (char === close) {
      state = "code";
      prevSig = char;
    }
  }
  return offsets;
}

function unsupportedLocalForms(rel: string, code: string): string[] {
  const hits: string[] = [];
  const offsets = codeOffsets(code);
  const forms: Array<[string, RegExp]> = [
    ["dynamic import", /\bimport\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g],
    ["CommonJS require", /\brequire\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/g],
  ];
  for (const [name, pattern] of forms) {
    let match = pattern.exec(code);
    while (match !== null) {
      if (offsets.has(match.index)) {
        hits.push(`${rel}: unsupported local ${name} "${match[2]}"`);
      }
      match = pattern.exec(code);
    }
  }
  return hits;
}

function sourceFilesBelow(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = resolve(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
      ) {
        files.push(abs);
      }
    }
  };
  visit(root);
  return files.sort((a, b) => canonicalPath(a).localeCompare(canonicalPath(b)));
}

/** Build the complete static runtime graph for production TypeScript under src/.
 * Every local specifier is resolved even when its target is outside src; only
 * src-to-src edges enter the graph. Data assets are validated leaves. */
export function buildProductionRuntimeGraph(
  srcRoot = resolve(repoRoot, "src"),
): RuntimeGraph {
  const sourceFiles = sourceFilesBelow(srcRoot);
  const sourceSet = new Set(sourceFiles);
  const files = sourceFiles.map((abs) =>
    canonicalPath(relative(repoRoot, abs)),
  );
  const errors: string[] = [];
  const edgeKeys = new Set<string>();

  for (const abs of sourceFiles) {
    const from = canonicalPath(relative(repoRoot, abs));
    const code = stripComments(readFileSync(abs, "utf8"));
    errors.push(...unsupportedLocalForms(from, code));
    for (const imp of parseStaticImports(code)) {
      if (imp.typeOnly || !imp.spec.startsWith(".")) continue;
      const target = resolveSource(abs, imp.spec);
      if (target !== null) {
        if (sourceSet.has(target)) {
          const to = canonicalPath(relative(repoRoot, target));
          edgeKeys.add(`${from}\0${to}`);
        }
        continue;
      }
      if (resolveAsset(abs, imp.spec) !== null) continue;
      errors.push(`${from}: unresolved local import "${imp.spec}"`);
    }
  }

  if (errors.length > 0) {
    throw new DependencyGraphError(errors.sort().join("\n"));
  }
  const edges = [...edgeKeys].sort().map((key) => {
    const [from, to] = key.split("\0");
    return { from, to };
  });
  return { files, edges };
}

/** Pure source-map graph builder used to prove parser failures without touching
 * process state. Paths and resolution use repository-style POSIX spelling. */
export function buildRuntimeGraphFromSources(
  sources: Readonly<Record<string, string>>,
): RuntimeGraph {
  const files = Object.keys(sources).sort();
  const fileSet = new Set(files);
  const errors: string[] = [];
  const edgeKeys = new Set<string>();
  for (const from of files) {
    if (!isCanonicalSourcePath(from)) {
      errors.push(`non-canonical source path "${from}"`);
      continue;
    }
    const code = stripComments(sources[from]);
    errors.push(...unsupportedLocalForms(from, code));
    for (const imp of parseStaticImports(code)) {
      if (imp.typeOnly || !imp.spec.startsWith(".")) continue;
      const base = posix.normalize(posix.join(posix.dirname(from), imp.spec));
      const candidates = [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        `${base}.js`,
        `${base}.mjs`,
        `${base}.cjs`,
        `${base}/index.ts`,
        `${base}/index.tsx`,
        `${base}/index.js`,
        `${base}/index.mjs`,
        `${base}/index.cjs`,
      ];
      const to = candidates.find((candidate) => fileSet.has(candidate));
      if (to === undefined) {
        errors.push(`${from}: unresolved local import "${imp.spec}"`);
      } else {
        edgeKeys.add(`${from}\0${to}`);
      }
    }
  }
  if (errors.length > 0) {
    throw new DependencyGraphError(errors.sort().join("\n"));
  }
  const edges = [...edgeKeys].sort().map((key) => {
    const [from, to] = key.split("\0");
    return { from, to };
  });
  return { files, edges };
}

function isCanonicalSourcePath(path: string): boolean {
  return (
    path.startsWith("src/") &&
    posix.normalize(path) === path &&
    !path.includes("\\") &&
    /\.(?:ts|tsx|js|mjs|cjs)$/.test(path)
  );
}

interface CycleException {
  edges: RuntimeEdge[];
}

export interface CycleExceptionManifest {
  version: 1;
  exceptions: CycleException[];
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

/** Strict manifest parser: unknown fields, non-canonical paths, duplicate edges,
 * duplicate exceptions, and edge sets that are not themselves cyclic all fail. */
export function parseCycleExceptionManifest(
  raw: string,
): CycleExceptionManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DependencyGraphError(
      "malformed cycle exception manifest: invalid JSON",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value as Record<string, unknown>, ["version", "exceptions"]) ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { exceptions?: unknown }).exceptions)
  ) {
    throw new DependencyGraphError(
      "malformed cycle exception manifest: expected exactly version 1 and exceptions array",
    );
  }

  const exceptions: CycleException[] = [];
  const seenExceptions = new Set<string>();
  for (const [exceptionIndex, candidate] of (
    value as { exceptions: unknown[] }
  ).exceptions.entries()) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      !exactKeys(candidate as Record<string, unknown>, ["edges"]) ||
      !Array.isArray((candidate as { edges?: unknown }).edges) ||
      (candidate as { edges: unknown[] }).edges.length === 0
    ) {
      throw new DependencyGraphError(
        `malformed cycle exception ${exceptionIndex}: expected exactly a non-empty edges array`,
      );
    }
    const edges: RuntimeEdge[] = [];
    const seenEdges = new Set<string>();
    for (const [edgeIndex, edge] of (
      candidate as { edges: unknown[] }
    ).edges.entries()) {
      if (
        !Array.isArray(edge) ||
        edge.length !== 2 ||
        !edge.every((part) => typeof part === "string") ||
        !edge.every((part) => isCanonicalSourcePath(part as string))
      ) {
        throw new DependencyGraphError(
          `malformed cycle exception ${exceptionIndex} edge ${edgeIndex}: expected two canonical src paths`,
        );
      }
      const [from, to] = edge as [string, string];
      const key = `${from}\0${to}`;
      if (seenEdges.has(key)) {
        throw new DependencyGraphError(
          `duplicate edge in cycle exception ${exceptionIndex}: ${from} -> ${to}`,
        );
      }
      seenEdges.add(key);
      edges.push({ from, to });
    }
    edges.sort((a, b) => edgeLabel(a).localeCompare(edgeLabel(b)));
    const key = edges.map(edgeLabel).join(" | ");
    if (seenExceptions.has(key)) {
      throw new DependencyGraphError(
        `duplicate cycle exception ${exceptionIndex}: ${key}`,
      );
    }
    seenExceptions.add(key);
    const exceptionGraph: RuntimeGraph = {
      files: [...new Set(edges.flatMap((edge) => [edge.from, edge.to]))].sort(),
      edges,
    };
    const exceptionCycles = cyclicEdgeSets(exceptionGraph);
    if (exceptionCycles.length !== 1 || exceptionCycles[0] !== key) {
      throw new DependencyGraphError(
        `malformed cycle exception ${exceptionIndex}: edges must form exactly one cyclic component`,
      );
    }
    exceptions.push({ edges });
  }
  return { version: 1, exceptions };
}

function edgeLabel(edge: RuntimeEdge): string {
  return `${edge.from} -> ${edge.to}`;
}

/** Return one canonical exact internal-edge set per cyclic SCC. */
export function cyclicEdgeSets(graph: RuntimeGraph): string[] {
  const nodes = [...new Set(graph.files)].sort();
  const nodeSet = new Set(nodes);
  const outgoing = new Map(nodes.map((node) => [node, [] as string[]]));
  for (const edge of graph.edges) {
    if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) {
      throw new DependencyGraphError(
        `edge endpoint is absent from files: ${edgeLabel(edge)}`,
      );
    }
    outgoing.get(edge.from)?.push(edge.to);
  }
  for (const targets of outgoing.values()) targets.sort();

  let nextIndex = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, nextIndex);
    low.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);
    for (const target of outgoing.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(
          node,
          Math.min(low.get(node) as number, low.get(target) as number),
        );
      } else if (onStack.has(target)) {
        low.set(
          node,
          Math.min(low.get(node) as number, index.get(target) as number),
        );
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component.sort());
    }
  };
  for (const node of nodes) if (!index.has(node)) visit(node);

  const sets: string[] = [];
  for (const component of components) {
    const members = new Set(component);
    const internal = graph.edges
      .filter((edge) => members.has(edge.from) && members.has(edge.to))
      .map(edgeLabel)
      .sort();
    if (
      component.length > 1 ||
      internal.includes(`${component[0]} -> ${component[0]}`)
    ) {
      sets.push(internal.join(" | "));
    }
  }
  return sets.sort();
}

/** Compare exact cyclic topology. Every exception must match one live SCC and
 * every live SCC must have one exception; neither side is a count-only ratchet. */
export function runtimeCycleDiagnostics(
  graph: RuntimeGraph,
  manifest: CycleExceptionManifest,
): string[] {
  const live = new Set(cyclicEdgeSets(graph));
  const allowed = new Set(
    manifest.exceptions.map((exception) =>
      exception.edges.map(edgeLabel).sort().join(" | "),
    ),
  );
  const diagnostics: string[] = [];
  for (const exception of [...allowed].sort()) {
    if (!live.has(exception)) {
      diagnostics.push(`stale runtime cycle exception: ${exception}`);
    }
  }
  for (const cycle of [...live].sort()) {
    if (!allowed.has(cycle))
      diagnostics.push(`unexpected runtime cycle: ${cycle}`);
  }
  return diagnostics;
}
