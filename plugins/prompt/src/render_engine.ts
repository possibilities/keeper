// The `keeper prompt` template renderer — the LiquidJS keystone that reproduces
// the Python promptctl Jinja2 environment (helpers.py render_template) byte-for-
// byte on the live plugin templates.
//
// Why LiquidJS and how it maps to the Jinja surface the corpus actually uses:
//
//   * keep_trailing_newline=True  -> LiquidJS preserves trailing newlines by
//     default; no whitespace trimming is enabled, so the rendered bytes carry
//     every source newline through unchanged.
//   * StrictUndefined             -> strictVariables:true throws on any
//     undefined output (the `current_variant`-unbound branch must RAISE, the
//     asymmetry that keeps a variant template from rendering as non-variant).
//   * autoescape off              -> LiquidJS does not HTML-escape `{{ }}` output.
//   * FileSystemLoader([dirs])    -> the `root` option is the include search path
//     (loaderDirs), so `{% include "_partials/x.md.tmpl" %}` resolves like Jinja.
//   * shell() / file_exists() / snippet()/snippets()/all_snippets_in() globals
//     -> file_exists + the three snippet helpers are LiquidJS globals; the lone
//     Jinja FUNCTION-CALL output `{{ shell("cmd") }}` is rewritten to the filter
//     form `{{ "cmd" | shell }}` (the only output-tag transform) so LiquidJS can
//     parse it, then the `shell` filter runs the command.
//
// The shell filter reproduces Python subprocess.run(cmd, shell=True,
// cwd=template_dir): /bin/sh -c, stdout captured, trailing newlines stripped, and
// the `!`cmd`` fallback on a non-zero exit. `had_errors` is surfaced so the
// render-plugin-templates verb can mirror the bash exit-code semantics.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import yaml from "js-yaml";
import { Liquid, Tokenizer } from "liquidjs";
import { findGitRoot } from "./project_root.ts";

export interface RenderResult {
  /** The rendered template text (Jinja keep_trailing_newline parity). */
  text: string;
  /** True when a shell call failed or emitted an argument-placeholder collision
   * (`$0`..`$9`); the run modules surface this without affecting the exit code. */
  hadErrors: boolean;
}

/** Snippet index entry as loaded from `_partials/snippets/_index.yaml`. */
interface SnippetEntry {
  name: string;
  path: string;
  domain?: string;
  [field: string]: unknown;
}

const LIST_FIELDS = new Set(["tags", "scope", "phase", "topics", "audience"]);
const DISK_HELPERS = new Set([
  "all_snippets_in",
  "file_exists",
  "snippet",
  "snippets",
]);
const PARTIAL_TAGS = new Set(["include", "layout", "render"]);

/** Render the `.md.tmpl` at `templatePath` with the promptctl Jinja environment
 * reproduced in LiquidJS. `extraVars` binds template context (e.g.
 * `current_variant`); an unbound output reference raises (StrictUndefined).
 * Returns the rendered text plus the had-errors signal. Mirrors
 * helpers.py render_template. */
export function renderTemplate(
  templatePath: string,
  extraVars: Record<string, string> | null = null,
): RenderResult {
  return renderTemplateSource(
    templatePath,
    readFileSync(templatePath, "utf-8"),
    extraVars,
  );
}

export interface CapturedTemplateFile {
  /** POSIX path relative to the captured template root. */
  readonly path: string;
  /** Exact UTF-8 source captured for this file. */
  readonly source: string;
}

export interface CapturedTemplateGraph {
  /** Canonical physical template root, used only as capture identity. */
  readonly root: string;
  /** POSIX root-relative entry path. */
  readonly entry: string;
  /** Entry and transitive dependencies in deterministic path order. */
  readonly files: readonly CapturedTemplateFile[];
}

export interface RenderTemplateSourceOptions {
  /** Optional pure shell replacement. Supplying it guarantees this render does
   * not spawn commands; the caller owns every returned byte. */
  readonly shell?: (command: string) => string;
  /** Disable every disk-backed Liquid feature for immutable-source callers.
   * Templates requesting one fail before rendering. */
  readonly allowFileSystemDependencies?: boolean;
}

/** Find disk-backed Liquid constructs in executable tags/outputs. The Liquid
 * tokenizer keeps prose and raw blocks out of the scan; comment blocks and
 * quoted examples are ignored explicitly. */
export function findUnsnapshottedRenderDependencies(source: string): string[] {
  const engine = new Liquid();
  const tokens = new Tokenizer(source).readTopLevelTokens(engine.options);
  const found = new Set<string>();
  let commentDepth = 0;

  for (const token of tokens) {
    if ("name" in token) {
      if (token.name === "comment") {
        commentDepth += 1;
        continue;
      }
      if (token.name === "endcomment") {
        commentDepth = Math.max(0, commentDepth - 1);
        continue;
      }
      if (commentDepth > 0 || token.name === "#") continue;
      if (PARTIAL_TAGS.has(token.name)) found.add(token.name);
      if (token.name === "liquid") {
        findLiquidTagDependencies(token.args, found);
      } else {
        findHelperCalls(token.args, found);
      }
      continue;
    }
    if (commentDepth === 0 && token.getText().startsWith("{{")) {
      findHelperCalls(token.getText(), found);
    }
  }

  return [...found].sort();
}

function findLiquidTagDependencies(source: string, found: Set<string>): void {
  let inComment = false;
  for (const line of source.split("\n")) {
    const name = /^\s*([^\s]+)/.exec(line)?.[1];
    if (name === undefined || name === "#") continue;
    if (name === "comment") {
      inComment = true;
      continue;
    }
    if (name === "endcomment") {
      inComment = false;
      continue;
    }
    if (inComment) continue;
    if (PARTIAL_TAGS.has(name)) found.add(name);
    findHelperCalls(line, found);
  }
}

function findHelperCalls(source: string, found: Set<string>): void {
  findNamedCalls(source, found, DISK_HELPERS);
}

function findNamedCalls(
  source: string,
  found: Set<string>,
  names: ReadonlySet<string>,
): void {
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
        } else if (source[i] === quote) {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (!/[A-Za-z_]/.test(ch)) {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < source.length && /[A-Za-z0-9_-]/.test(source[end] ?? "")) {
      end += 1;
    }
    const name = source.slice(i, end);
    let call = end;
    while (/\s/.test(source[call] ?? "")) call += 1;
    if (source[call] === "(" && names.has(name)) found.add(name);
    i = end;
  }
}

function canonicalDirectory(path: string, label: string): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`${path}: ${label} is not a directory`);
  }
  return canonical;
}

function pathWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function captureRelativePath(
  path: string,
  root: string,
  label: string,
): string {
  let canonical: string;
  try {
    canonical = realpathSync(resolve(path));
    if (!statSync(canonical).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`${path}: ${label} is not a file`);
  }
  if (!pathWithin(canonical, root)) {
    throw new Error(`${path}: ${label} resolves outside template root ${root}`);
  }
  return relative(root, canonical).split(sep).join("/");
}

function normalizeCapturedReference(
  reference: string,
  sourcePath: string,
): string {
  if (
    reference.length === 0 ||
    reference.includes("\0") ||
    reference.includes("\\") ||
    isAbsolute(reference) ||
    reference.startsWith("/")
  ) {
    throw new Error(
      `${sourcePath}: captured template dependency has unsafe path ${JSON.stringify(reference)}`,
    );
  }
  const parts = reference.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(
      `${sourcePath}: captured template dependency escapes its template root: ${JSON.stringify(reference)}`,
    );
  }
  return parts.join("/");
}

function resolveCapturedDependency(
  root: string,
  relativePath: string,
  entryPath: string,
): string {
  const lexical = resolve(root, ...relativePath.split("/"));
  if (!pathWithin(lexical, root)) {
    throw new Error(
      `${entryPath}: dependency escapes template root: ${relativePath}`,
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync(lexical);
    if (!statSync(canonical).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `${entryPath}: captured template dependency is missing: ${relativePath}`,
    );
  }
  if (!pathWithin(canonical, root)) {
    throw new Error(
      `${entryPath}: captured template dependency resolves outside template root: ${relativePath}`,
    );
  }
  return canonical;
}

function readUtf8Exact(path: string): string {
  const bytes = readFileSync(path);
  const source = bytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(bytes)) {
    throw new Error(`${path}: captured template is not valid UTF-8`);
  }
  return source;
}

function literalPartialDependencies(
  source: string,
  sourcePath: string,
): string[] {
  const engine = new Liquid();
  const tokens = new Tokenizer(source).readTopLevelTokens(engine.options);
  const dependencies: string[] = [];
  let commentDepth = 0;
  const accept = (name: string, args: string): void => {
    if (!PARTIAL_TAGS.has(name)) return;
    const match = /^\s*(["'])([^"']*)\1(?=\s|,|$)/s.exec(args);
    if (match === null) {
      throw new Error(
        `${sourcePath}: dynamic Liquid ${name} references are forbidden in captured templates`,
      );
    }
    dependencies.push(match[2] as string);
  };

  for (const token of tokens) {
    if (!("name" in token)) continue;
    if (token.name === "comment") {
      commentDepth += 1;
      continue;
    }
    if (token.name === "endcomment") {
      commentDepth = Math.max(0, commentDepth - 1);
      continue;
    }
    if (commentDepth > 0 || token.name === "#") continue;
    if (token.name === "liquid") {
      let inComment = false;
      for (const line of token.args.split("\n")) {
        const parsed = /^\s*([^\s]+)(?:\s+(.*))?$/.exec(line);
        if (parsed === null || parsed[1] === "#") continue;
        const name = parsed[1] as string;
        if (name === "comment") {
          inComment = true;
          continue;
        }
        if (name === "endcomment") {
          inComment = false;
          continue;
        }
        if (!inComment) accept(name, parsed[2] ?? "");
      }
    } else {
      accept(token.name, token.args);
    }
  }
  return [...new Set(dependencies)].sort();
}

function withoutQuotedText(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const ch = source[index] as string;
    if (ch !== '"' && ch !== "'") {
      out += ch;
      index += 1;
      continue;
    }
    const quote = ch;
    out += " ";
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") {
        index += 2;
      } else if (source[index] === quote) {
        index += 1;
        break;
      } else {
        index += 1;
      }
    }
  }
  return out;
}

function findCapturedForbiddenDependencies(source: string): string[] {
  const found = new Set(
    findUnsnapshottedRenderDependencies(source).filter(
      (name) => !PARTIAL_TAGS.has(name),
    ),
  );
  const shellNames = new Set(["shell"]);
  const engine = new Liquid();
  const tokens = new Tokenizer(source).readTopLevelTokens(engine.options);
  let commentDepth = 0;
  for (const token of tokens) {
    if (!("name" in token)) {
      if (commentDepth === 0 && token.getText().startsWith("{{")) {
        const text = token.getText();
        findNamedCalls(text, found, shellNames);
        if (/\|\s*shell\b/.test(withoutQuotedText(text))) found.add("shell");
      }
      continue;
    }
    if (token.name === "comment") {
      commentDepth += 1;
      continue;
    }
    if (token.name === "endcomment") {
      commentDepth = Math.max(0, commentDepth - 1);
      continue;
    }
    if (commentDepth > 0 || token.name === "#") continue;
    findNamedCalls(token.args, found, shellNames);
    if (/\|\s*shell\b/.test(withoutQuotedText(token.args))) found.add("shell");
  }
  return [...found].sort();
}

function memoryContains(root: string, file: string): boolean {
  return (
    file === root || file.startsWith(root.endsWith("/") ? root : `${root}/`)
  );
}

/** Capture an entry template and every literal transitive Liquid partial.
 * Dependency discovery is syntax-based, so both sides of conditionals are
 * included. Every byte and physical path is validated before the immutable,
 * deterministically ordered graph is returned. */
export function captureTemplateGraph(
  templatePath: string,
  templateRoot: string,
): CapturedTemplateGraph {
  const root = canonicalDirectory(templateRoot, "template root");
  const entry = captureRelativePath(templatePath, root, "entry template");
  const captured = new Map<string, string>();
  const visiting: string[] = [];

  const visit = (path: string): void => {
    const cycleAt = visiting.indexOf(path);
    if (cycleAt >= 0) {
      throw new Error(
        `${templatePath}: captured template dependency cycle: ${[
          ...visiting.slice(cycleAt),
          path,
        ].join(" -> ")}`,
      );
    }
    if (captured.has(path)) return;
    visiting.push(path);
    const absolute = resolveCapturedDependency(root, path, templatePath);
    const source = readUtf8Exact(absolute);
    const forbidden = findCapturedForbiddenDependencies(source);
    if (forbidden.length > 0) {
      throw new Error(
        `${absolute}: captured templates forbid disk helpers and shell execution: ${forbidden.join(
          ", ",
        )}`,
      );
    }
    for (const dependency of literalPartialDependencies(source, absolute)) {
      visit(normalizeCapturedReference(dependency, absolute));
    }
    visiting.pop();
    captured.set(path, source);
  };

  visit(entry);
  const files = [...captured]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, source]) => Object.freeze({ path, source }));
  return Object.freeze({ root, entry, files: Object.freeze(files) });
}

/** Render a captured graph without consulting the filesystem. The custom
 * Liquid filesystem resolves only graph members; capture-time validation has
 * already rejected dynamic references and non-memory-backed helpers. */
export function renderCapturedTemplate(
  graph: CapturedTemplateGraph,
  extraVars: Record<string, string> | null = null,
): RenderResult {
  const files = new Map(
    graph.files.map((file) => [`/${file.path}`, file.source]),
  );
  const entry = files.get(`/${graph.entry}`);
  if (entry === undefined) {
    throw new Error(
      `captured template graph is missing entry '${graph.entry}'`,
    );
  }
  const memoryFs = {
    exists: async (path: string) => files.has(path),
    existsSync: (path: string) => files.has(path),
    readFile: async (path: string) => {
      const source = files.get(path);
      if (source === undefined)
        throw new Error(`uncaptured template '${path}'`);
      return source;
    },
    readFileSync: (path: string) => {
      const source = files.get(path);
      if (source === undefined)
        throw new Error(`uncaptured template '${path}'`);
      return source;
    },
    resolve: (root: string, file: string, ext: string) => {
      const name = posix.extname(file) === "" ? `${file}${ext}` : file;
      return posix.resolve(root, name);
    },
    contains: async (root: string, file: string) => memoryContains(root, file),
    containsSync: (root: string, file: string) => memoryContains(root, file),
    sep: "/",
    dirname: posix.dirname,
  };
  const engine = new Liquid({
    root: ["/"],
    partials: ["/"],
    layouts: ["/"],
    extname: "",
    strictVariables: true,
    fs: memoryFs,
  });
  const text = engine.parseAndRenderSync(entry, {
    ...(extraVars ?? {}),
  }) as string;
  return { text, hadErrors: false };
}

/** Render caller-supplied template bytes. Includes resolve through the
 * canonical loader roots by default, but the primary source is never re-read. */
export function renderTemplateSource(
  templatePath: string,
  source: string,
  extraVars: Record<string, string> | null = null,
  options: RenderTemplateSourceOptions = {},
): RenderResult {
  const cwd = dirname(templatePath);
  const allowFileSystemDependencies =
    options.allowFileSystemDependencies ?? true;
  const dependencies = findUnsnapshottedRenderDependencies(source);
  if (!allowFileSystemDependencies && dependencies.length > 0) {
    throw new Error(
      `${templatePath}: unsnapshotted render dependencies: ${dependencies.join(
        ", ",
      )}`,
    );
  }
  const projectRoot = allowFileSystemDependencies ? findGitRoot(cwd) : null;
  let hadErrors = false;

  const shell = (cmd: string): string => {
    if (options.shell !== undefined) return options.shell(cmd);
    const result = spawnSync("/bin/sh", ["-c", cmd], {
      cwd,
      encoding: "utf-8",
    });
    if (result.status !== 0) {
      hadErrors = true;
      process.stderr.write(`Warning: Command failed: ${cmd}\n`);
      const stderr = (result.stderr ?? "").trim();
      if (stderr) {
        process.stderr.write(`  stderr: ${stderr}\n`);
      }
      return `!\`${cmd}\``;
    }
    const output = (result.stdout ?? "").replace(/\n+$/, "");
    // Argument-placeholder collision check ($0..$9) — bash-faithful warning.
    for (const match of output.matchAll(/\$\d/g)) {
      hadErrors = true;
      process.stderr.write(
        `Warning: Shell output contains '${match[0]}' ` +
          `(argument placeholder collision): ${cmd}\n`,
      );
    }
    return output;
  };

  const fileExists = (path: string): boolean => {
    if (projectRoot === null) {
      return false;
    }
    return existsSync(join(projectRoot, path));
  };

  const loaderDirs = allowFileSystemDependencies
    ? resolveLoaderDirs(templatePath, projectRoot)
    : [cwd];
  const globals = allowFileSystemDependencies
    ? {
        file_exists: fileExists,
        ...buildSnippetHelpers(snippetRoot(loaderDirs)),
      }
    : {};

  const engine = new Liquid({
    root: loaderDirs,
    extname: "",
    strictVariables: true,
    globals,
  });
  engine.registerFilter("shell", (cmd: unknown) => shell(String(cmd)));

  const text = engine.parseAndRenderSync(rewriteShellCalls(source), {
    ...(extraVars ?? {}),
  }) as string;

  return { text, hadErrors };
}

/** Rewrite every Jinja FUNCTION-CALL output `{{ shell(<quoted>) }}` to the
 * LiquidJS filter form `{{ <quoted> | shell }}`. The argument is always a single
 * quoted string literal; the scan is quote-aware (respects the quote char and
 * backslash escapes) so a `)` inside the command body never closes the call
 * early. Leading/trailing whitespace inside the tag is preserved so the rewritten
 * bytes match what a hand-authored filter tag would produce. */
export function rewriteShellCalls(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{{", i);
    if (open === -1) {
      out += source.slice(i);
      break;
    }
    const close = source.indexOf("}}", open);
    if (close === -1) {
      out += source.slice(i);
      break;
    }
    const inner = source.slice(open + 2, close);
    const head = /^(\s*)shell\((['"])/.exec(inner);
    if (head === null) {
      out += source.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    const lead = head[1] as string;
    const quote = head[2] as string;
    let j = (head[0] as string).length;
    let literal = quote;
    while (j < inner.length) {
      const ch = inner[j] as string;
      literal += ch;
      if (ch === "\\") {
        literal += inner[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (ch === quote) {
        j += 1;
        break;
      }
      j += 1;
    }
    const tail = /^\)(\s*)$/.exec(inner.slice(j));
    if (tail === null) {
      out += source.slice(i, close + 2);
      i = close + 2;
      continue;
    }
    out += `${source.slice(i, open)}{{${lead}${literal} | shell${tail[1]}}}`;
    i = close + 2;
  }
  return out;
}

/** The include search path. The base is the nearest ancestor of the template
 * that holds a `_partials/` child (the `template/` root) — falling back to the
 * template's own dir. A shared `claude/arthack/template` under the project root is
 * appended as a fallback loader so plugins beyond arthack can include the
 * canonical partials. Mirrors helpers.py loader_dir / loader_dirs. */
function resolveLoaderDirs(
  templatePath: string,
  projectRoot: string | null,
): string[] {
  let loaderDir = dirname(templatePath);
  let walker = dirname(templatePath);
  for (;;) {
    if (existsSync(join(walker, "_partials"))) {
      loaderDir = walker;
      break;
    }
    const parent = dirname(walker);
    if (parent === walker) {
      break;
    }
    walker = parent;
  }

  const dirs = [loaderDir];
  if (projectRoot !== null) {
    const shared = join(projectRoot, "claude", "arthack", "template");
    if (existsSync(shared) && shared !== loaderDir) {
      dirs.push(shared);
    }
  }
  return dirs;
}

/** The first loader dir carrying `_partials/snippets/_index.yaml`, else the
 * first dir. The snippet helpers index that root. */
function snippetRoot(loaderDirs: string[]): string {
  for (const d of loaderDirs) {
    if (existsSync(join(d, "_partials", "snippets", "_index.yaml"))) {
      return d;
    }
  }
  return loaderDirs[0] as string;
}

/** Load `_partials/snippets/_index.yaml` under `loaderDir` (empty when absent). */
function loadSnippetIndex(loaderDir: string): SnippetEntry[] {
  const indexPath = join(loaderDir, "_partials", "snippets", "_index.yaml");
  if (!existsSync(indexPath)) {
    return [];
  }
  const data = yaml.load(readFileSync(indexPath, "utf-8")) as {
    snippets?: SnippetEntry[];
  } | null;
  return data?.snippets ?? [];
}

/** Build the `snippet` / `snippets` / `all_snippets_in` LiquidJS globals. Paths
 * returned are relative to `loaderDir` so they feed `{% include path %}`
 * directly. Mirrors helpers.py _build_snippet_helpers. */
function buildSnippetHelpers(loaderDir: string): {
  snippet: (name: string) => string;
  snippets: (filters?: Record<string, unknown>) => string[];
  all_snippets_in: (domain: string) => string[];
} {
  const entries = loadSnippetIndex(loaderDir);
  const byName = new Map<string, SnippetEntry>();
  for (const e of entries) {
    byName.set(e.name, e);
    byName.set(`${e.domain ?? ""}/${e.name}`, e);
  }

  const snippet = (name: string): string => {
    const entry = byName.get(name);
    if (entry === undefined) {
      throw new Error(`Unknown snippet: '${name}'`);
    }
    return entry.path;
  };

  const snippets = (filters: Record<string, unknown> = {}): string[] => {
    const out: string[] = [];
    for (const entry of entries) {
      if (
        Object.entries(filters).every(([k, v]) => entryMatches(entry, k, v))
      ) {
        out.push(entry.path);
      }
    }
    return out.sort();
  };

  const all_snippets_in = (domain: string): string[] => snippets({ domain });

  return { snippet, snippets, all_snippets_in };
}

/** Whether `entry[field]` matches `want` (scalar or list-contains for the
 * list-valued fields). Mirrors helpers.py entry_matches. */
function entryMatches(
  entry: SnippetEntry,
  field: string,
  want: unknown,
): boolean {
  const have = entry[field];
  if (have === undefined || have === null) {
    return false;
  }
  const wants = Array.isArray(want) ? want : [want];
  if (LIST_FIELDS.has(field) && Array.isArray(have)) {
    return wants.some((w) => have.includes(w));
  }
  return wants.includes(have);
}

/** The repo-relative source path used in the sidecar `source_template` field. */
export function sourceRelpath(
  templatePath: string,
  projectRoot: string,
): string {
  return relative(projectRoot, templatePath);
}
