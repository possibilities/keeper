#!/usr/bin/env bun
/** Source-wide hygiene guard: raw NUL bytes + comment-only provenance tokens + bun import graph. */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import * as ts from "typescript";
import { CONTENT_PATTERNS } from "./lint-claude-md";

const RAW_NUL = "\0";
const MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_ALLOWLIST = "scripts/lint-source-allowlist.json";

const SOURCE_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".css",
  ".cts",
  ".fish",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".mts",
  ".py",
  ".scss",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".toml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const HASH_COMMENT_EXTENSIONS = new Set([
  ".bash",
  ".fish",
  ".py",
  ".sh",
  ".toml",
  ".yaml",
  ".yml",
  ".zsh",
]);

const SLASH_COMMENT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".js",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".mts",
  ".scss",
  ".ts",
  ".tsx",
]);

const MODULE_SOURCE_EXTENSION_ORDER = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;
const MODULE_SOURCE_EXTENSIONS = new Set<string>(MODULE_SOURCE_EXTENSION_ORDER);

export type SourceLintKind =
  | "RAW_NUL_LITERAL"
  | "COMMENT_RENARRATION"
  | "ALLOWLIST"
  | "BUN_BUILTIN_IMPORT";

export interface SourceFinding {
  kind: SourceLintKind;
  file: string;
  line: number;
  message: string;
}

export interface SourceLintResult {
  findings: SourceFinding[];
  scanned: number;
}

export interface SourceLintFiles {
  read(relpath: string): string | null;
  paths(): readonly string[];
}

export interface SourceAllowlist {
  version: 1;
  commentViolations: Record<string, number>;
}

interface CommentChunk {
  line: number;
  text: string;
}

function normalized(relpath: string): string {
  return relpath.replaceAll("\\", "/");
}

function isSkippedPath(relpath: string): boolean {
  const rel = normalized(relpath);
  const name = rel.split("/").at(-1) ?? rel;
  if (rel === "CLAUDE.md" || rel === "AGENTS.md") return true;
  if (rel === "plugins/plan/CLAUDE.md") return true;
  if (rel === "scripts/lint-source.ts") return true;
  if (rel === "test/lint-source.test.ts") return true;
  if (rel.startsWith("test/fixtures/lint-source/")) return true;
  if (rel.startsWith(".keeper/") || rel.startsWith("docs/adr/")) return true;
  if (
    rel.startsWith(".git/") ||
    rel.startsWith("node_modules/") ||
    rel.startsWith("dist/") ||
    rel.startsWith("build/") ||
    rel.startsWith("coverage/") ||
    rel.startsWith(".bun/") ||
    rel.startsWith(".next/")
  ) {
    return true;
  }
  if (name === "bun.lock" || name === "package-lock.json") return true;
  return false;
}

function isSourcePath(relpath: string): boolean {
  const name = relpath.split("/").at(-1) ?? relpath;
  if (name === "keeper") return true;
  return SOURCE_EXTENSIONS.has(extname(name));
}

function isModuleSourcePath(relpath: string): boolean {
  const name = relpath.split("/").at(-1) ?? relpath;
  return MODULE_SOURCE_EXTENSIONS.has(extname(name));
}

function allowsRawNul(relpath: string): boolean {
  const rel = normalized(relpath);
  return (
    rel === "src/composite-key.ts" ||
    rel.startsWith("test/fixtures/lint-source/")
  );
}

function commentModes(relpath: string): { slash: boolean; hash: boolean } {
  const ext = extname(relpath.split("/").at(-1) ?? relpath);
  return {
    slash: SLASH_COMMENT_EXTENSIONS.has(ext),
    hash: HASH_COMMENT_EXTENSIONS.has(ext),
  };
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function extractComments(text: string, relpath: string): CommentChunk[] {
  const modes = commentModes(relpath);
  if (!modes.slash && !modes.hash) return [];

  const chunks: CommentChunk[] = [];
  let i = 0;
  let line = 1;
  let atLineStart = true;

  const bump = (ch: string): void => {
    if (ch === "\n") {
      line++;
      atLineStart = true;
    } else if (ch !== " " && ch !== "\t" && ch !== "\r") {
      atLineStart = false;
    }
  };

  const skipString = (quote: string): void => {
    bump(text[i]);
    i++;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        bump(ch);
        i++;
        if (i < text.length) {
          bump(text[i]);
          i++;
        }
        continue;
      }
      bump(ch);
      i++;
      if (ch === quote) return;
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (modes.slash && ch === "/" && next === "/") {
      const startLine = line;
      i += 2;
      let body = "";
      while (i < text.length && text[i] !== "\n") {
        body += text[i];
        i++;
      }
      chunks.push({ line: startLine, text: body });
      continue;
    }

    if (modes.slash && ch === "/" && next === "*") {
      const startLine = line;
      i += 2;
      let body = "";
      while (i < text.length) {
        if (text[i] === "*" && text[i + 1] === "/") {
          i += 2;
          break;
        }
        const c = text[i];
        body += c;
        if (c === "\n") line++;
        i++;
      }
      for (const [offset, commentLine] of body.split("\n").entries()) {
        chunks.push({ line: startLine + offset, text: commentLine });
      }
      atLineStart = false;
      continue;
    }

    if (
      modes.hash &&
      ch === "#" &&
      (atLineStart || text[i - 1] === " " || text[i - 1] === "\t")
    ) {
      const startLine = line;
      i++;
      let body = "";
      while (i < text.length && text[i] !== "\n") {
        body += text[i];
        i++;
      }
      chunks.push({ line: startLine, text: body });
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      skipString(ch);
      continue;
    }

    bump(ch);
    i++;
  }
  return chunks;
}

interface ModuleEdge {
  spec: string;
  line: number;
}

const SCRIPT_KIND_BY_EXT: Record<string, ts.ScriptKind> = {
  ".cjs": ts.ScriptKind.JS,
  ".cts": ts.ScriptKind.TS,
  ".js": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.TSX,
  ".mjs": ts.ScriptKind.JS,
  ".mts": ts.ScriptKind.TS,
  ".ts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
};

function scriptKindForPath(relpath: string): ts.ScriptKind {
  const ext = extname(relpath.split("/").at(-1) ?? relpath);
  return SCRIPT_KIND_BY_EXT[ext] ?? ts.ScriptKind.TS;
}

function lineAt(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings) || clause.name !== undefined) {
    return false;
  }
  return (
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return false;
  return (
    clause.elements.length > 0 &&
    clause.elements.every((element) => element.isTypeOnly)
  );
}

function parseModuleEdges(relpath: string, text: string): ModuleEdge[] {
  const sourceFile = ts.createSourceFile(
    relpath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(relpath),
  );
  const edges: ModuleEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (!importDeclarationIsTypeOnly(node)) {
        edges.push({
          spec: node.moduleSpecifier.text,
          line: lineAt(sourceFile, node.moduleSpecifier),
        });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      if (!exportDeclarationIsTypeOnly(node)) {
        edges.push({
          spec: node.moduleSpecifier.text,
          line: lineAt(sourceFile, node.moduleSpecifier),
        });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      edges.push({
        spec: node.moduleReference.expression.text,
        line: lineAt(sourceFile, node.moduleReference.expression),
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      edges.push({
        spec: node.arguments[0].text,
        line: lineAt(sourceFile, node.arguments[0]),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

function resolveModuleSource(
  fromRelpath: string,
  spec: string,
  knownFiles: Set<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const base = normalized(join(dirname(fromRelpath), spec));
  const candidates = [
    base,
    ...MODULE_SOURCE_EXTENSION_ORDER.map((ext) => `${base}${ext}`),
    ...MODULE_SOURCE_EXTENSION_ORDER.map((ext) =>
      normalized(join(base, `index${ext}`)),
    ),
  ];
  for (const candidate of candidates) {
    if (!isModuleSourcePath(candidate)) continue;
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

function isPiExtensionSourceRoot(relpath: string): boolean {
  return (
    /^integrations\/pi-[^/]+\/src\//.test(normalized(relpath)) &&
    isModuleSourcePath(relpath)
  );
}

function findPiExtensionBunBuiltinFindings(
  files: SourceLintFiles,
): SourceFinding[] {
  const paths = [...files.paths()];
  const knownFiles = new Set(paths.map(normalized));
  const findings: SourceFinding[] = [];
  const visited = new Set<string>();
  const parsed = new Map<string, ModuleEdge[]>();
  const visit = (relpath: string): void => {
    const rel = normalized(relpath);
    if (visited.has(rel)) return;
    visited.add(rel);
    const text = files.read(rel);
    if (text === null) return;
    const edges = parsed.get(rel) ?? parseModuleEdges(rel, text);
    parsed.set(rel, edges);
    for (const edge of edges) {
      if (edge.spec === "bun" || edge.spec.startsWith("bun:")) {
        findings.push({
          kind: "BUN_BUILTIN_IMPORT",
          file: rel,
          line: edge.line,
          message: `pi-extension import graph reaches bun builtin "${edge.spec}"`,
        });
        continue;
      }
      const resolved = resolveModuleSource(rel, edge.spec, knownFiles);
      if (resolved !== null) visit(resolved);
    }
  };
  for (const relpath of paths.filter(isPiExtensionSourceRoot)) {
    visit(relpath);
  }
  return findings;
}

export function scanSourceText(relpath: string, text: string): SourceFinding[] {
  const findings: SourceFinding[] = [];
  const rel = normalized(relpath);

  if (!allowsRawNul(rel) && text.includes(RAW_NUL)) {
    findings.push({
      kind: "RAW_NUL_LITERAL",
      file: rel,
      line: lineOf(text, text.indexOf(RAW_NUL)),
      message: "raw NUL byte literal is only allowed in src/composite-key.ts",
    });
  }

  for (const comment of extractComments(text, rel)) {
    for (const { name, re } of CONTENT_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(comment.text)) {
        findings.push({
          kind: "COMMENT_RENARRATION",
          file: rel,
          line: comment.line,
          message: `comment re-narration fingerprint [${name}]: ${comment.text.trim()}`,
        });
      }
    }
  }
  return findings;
}

function emptyAllowlist(): SourceAllowlist {
  return { version: 1, commentViolations: {} };
}

export function parseAllowlist(text: string): SourceAllowlist {
  const parsed = JSON.parse(text) as Partial<SourceAllowlist>;
  if (
    parsed.version !== 1 ||
    typeof parsed.commentViolations !== "object" ||
    parsed.commentViolations === null
  ) {
    throw new Error(
      "lint-source allowlist must be {version:1, commentViolations:{...}}",
    );
  }
  const commentViolations: Record<string, number> = {};
  for (const [path, count] of Object.entries(parsed.commentViolations)) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(
        `lint-source allowlist count for ${path} must be a non-negative integer`,
      );
    }
    commentViolations[normalized(path)] = count;
  }
  return { version: 1, commentViolations };
}

export function stringifyAllowlist(allowlist: SourceAllowlist): string {
  const sorted: Record<string, number> = {};
  for (const path of Object.keys(allowlist.commentViolations).sort()) {
    const count = allowlist.commentViolations[path];
    if (count > 0) sorted[path] = count;
  }
  return `${JSON.stringify({ version: 1, commentViolations: sorted }, null, 2)}\n`;
}

export function treeFiles(root: string): SourceLintFiles {
  const contents = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir) as string[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const path = join(dir, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      const rel = normalized(relative(root, path));
      if (st.isDirectory()) {
        if (!isSkippedPath(`${rel}/placeholder`)) walk(path);
      } else if (st.isFile()) {
        if (
          isSkippedPath(rel) ||
          !isSourcePath(rel) ||
          st.size > MAX_FILE_BYTES
        )
          continue;
        try {
          contents.set(rel, readFileSync(path, "utf8"));
        } catch {
          // Binary and unreadable files are skipped by extension/size first; this is defensive.
        }
      }
    }
  };
  walk(root);
  return {
    read: (relpath) => contents.get(normalized(relpath)) ?? null,
    paths: () => [...contents.keys()].sort(),
  };
}

export function buildAllowlist(files: SourceLintFiles): SourceAllowlist {
  const commentViolations: Record<string, number> = {};
  for (const relpath of files.paths()) {
    if (isSkippedPath(relpath) || !isSourcePath(relpath)) continue;
    const text = files.read(relpath);
    if (text === null) continue;
    const count = scanSourceText(relpath, text).filter(
      (f) => f.kind === "COMMENT_RENARRATION",
    ).length;
    if (count > 0) commentViolations[normalized(relpath)] = count;
  }
  return { version: 1, commentViolations };
}

export function lintSourceFiles(
  files: SourceLintFiles,
  allowlist: SourceAllowlist,
): SourceLintResult {
  const findings: SourceFinding[] = [];
  const actualCommentCounts = new Map<string, number>();
  let scanned = 0;

  for (const relpath of files.paths()) {
    const rel = normalized(relpath);
    if (isSkippedPath(rel) || !isSourcePath(rel)) continue;
    const text = files.read(rel);
    if (text === null) continue;
    scanned++;
    const fileFindings = scanSourceText(rel, text);
    const commentCount = fileFindings.filter(
      (f) => f.kind === "COMMENT_RENARRATION",
    ).length;
    actualCommentCounts.set(rel, commentCount);
    findings.push(...fileFindings.filter((f) => f.kind === "RAW_NUL_LITERAL"));
    const allowed = allowlist.commentViolations[rel] ?? 0;
    if (commentCount > allowed) {
      findings.push({
        kind: "COMMENT_RENARRATION",
        file: rel,
        line: 0,
        message: `net-new comment re-narration fingerprints: found ${commentCount}, allowlist permits ${allowed}`,
      });
    }
  }

  for (const [relpath, allowed] of Object.entries(
    allowlist.commentViolations,
  )) {
    const actual = actualCommentCounts.get(normalized(relpath)) ?? 0;
    if (allowed > 0 && actual === 0) {
      findings.push({
        kind: "ALLOWLIST",
        file: relpath,
        line: 0,
        message:
          "allowlist entry is inflated for a clean file; remove it or keep the count at zero",
      });
    }
  }

  findings.push(...findPiExtensionBunBuiltinFindings(files));

  return { findings, scanned };
}

export function lintSource(
  root: string,
  allowlistPath = join(root, DEFAULT_ALLOWLIST),
): SourceLintResult {
  const files = treeFiles(root);
  const allowlist = existsSync(allowlistPath)
    ? parseAllowlist(readFileSync(allowlistPath, "utf8"))
    : emptyAllowlist();
  return lintSourceFiles(files, allowlist);
}

function main(): void {
  const root =
    process.env.KEEPER_SOURCE_LINT_REPO_ROOT ?? dirname(import.meta.dir);
  if (!existsSync(root)) {
    console.error(`ERROR: source lint repo root not found at ${root}`);
    process.exitCode = 1;
    return;
  }
  const allowlistPath = join(root, DEFAULT_ALLOWLIST);
  const files = treeFiles(root);

  if (process.argv.includes("--write-allowlist")) {
    const allowlist = buildAllowlist(files);
    mkdirSync(dirname(allowlistPath), { recursive: true });
    writeFileSync(allowlistPath, stringifyAllowlist(allowlist));
    console.log(
      `[lint-source] wrote ${Object.keys(allowlist.commentViolations).length} allowlist entr${Object.keys(allowlist.commentViolations).length === 1 ? "y" : "ies"} to ${DEFAULT_ALLOWLIST}`,
    );
    return;
  }

  let allowlist: SourceAllowlist;
  try {
    allowlist = existsSync(allowlistPath)
      ? parseAllowlist(readFileSync(allowlistPath, "utf8"))
      : emptyAllowlist();
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const { findings, scanned } = lintSourceFiles(files, allowlist);
  if (findings.length === 0) {
    console.log(`[lint-source] ok — scanned ${scanned} source files`);
    return;
  }

  console.error(
    `ERROR: source hygiene guard found ${findings.length} violation(s):`,
  );
  for (const finding of findings) {
    const where = finding.line > 0 ? `:${finding.line}` : "";
    console.error(
      `  - ${finding.file}${where} [${finding.kind}] ${finding.message}`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
