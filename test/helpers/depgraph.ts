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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

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
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  m = dynRe.exec(code);
  while (m !== null) {
    out.push({ spec: m[1], typeOnly: false });
    m = dynRe.exec(code);
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
