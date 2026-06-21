// `keeper prompt build-snippets` — rebuild `_partials/snippets/_index.yaml` from
// the classified snippet corpus. Port of promptctl run_build_snippets.py.
//
// Snippet files live at
// `claude/arthack/template/_partials/snippets/**/*.md.tmpl`, each opening with a
// Jinja comment block carrying YAML frontmatter (`name`, `summary`, `domain`,
// `audience`, `severity`, plus optional classification fields). This verb walks
// every snippet, parses the frontmatter, finds cross-template usages, and writes
// the index.
//
// The one intentional divergence from the Python oracle: `token-estimate` no
// longer comes from tiktoken's cl100k_base encoder (a heavyweight, network-
// fetched dependency we drop). A cheap char-based heuristic replaces it; the
// resulting `token-estimate` values shift, which is accepted churn — no consumer
// asserts the exact count, and the field stays informational.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import yaml from "js-yaml";
import { atomicWriteRaw } from "../../plan/src/store.ts";
import { ensureParent } from "./storage.ts";

const REQUIRED_FIELDS = ["name", "summary", "domain", "audience", "severity"];

/** Leading `{#- ... -#}` frontmatter comment block; DOTALL on the meta group.
 * Mirrors run_build_snippets.py _FRONTMATTER_RE (`\A` anchored). */
const FRONTMATTER_RE = /^\{#-?\s*\n([\s\S]*?)\n-?#\}\n?/;

/** Raised when the snippet corpus is malformed (bad frontmatter, field/name
 * mismatch, missing required keys). The runner maps it to `Error: <msg>` + 1. */
export class BuildSnippetsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildSnippetsError";
  }
}

/** Parse one snippet file into [metadata, body]. Mirrors _parse_snippet. */
function parseSnippet(path: string): [Record<string, unknown>, string] {
  const text = readFileSync(path, "utf-8");
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) {
    throw new BuildSnippetsError(
      `Snippet ${path} has no leading {# ... #} frontmatter block`,
    );
  }
  const body = text.slice(match[0].length);
  let meta: unknown;
  try {
    meta = yaml.load(match[1] as string) ?? {};
  } catch (e) {
    throw new BuildSnippetsError(
      `Snippet ${path} has invalid YAML frontmatter: ${e}`,
    );
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
    throw new BuildSnippetsError(
      `Snippet ${path} frontmatter is not a YAML mapping`,
    );
  }
  return [meta as Record<string, unknown>, body];
}

/** Recursively collect files under `dir` matching `predicate`, returned absolute
 * and sorted by full path (mirrors Python `sorted(root.rglob(...))`). */
function rglob(dir: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        walk(full);
      } else if (predicate(name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  out.sort();
  return out;
}

/** Repo-relative POSIX path (forward slashes), matching Python's
 * `Path.relative_to` string form on the platforms the corpus lives on. */
function relPosix(from: string, to: string): string {
  const rel = relative(from, to);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** Cheap, dependency-free token estimate. Replaces the dropped tiktoken
 * cl100k_base count with a ~4-chars-per-token heuristic; the value is
 * informational and intentionally diverges from the oracle (accepted churn). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Escape a literal for embedding in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return repo-relative paths referencing a snippet by name. A reference is
 * either an explicit `snippet('...name')` / `snippets(...)` call or a literal
 * `{% include '...name.md.tmpl' %}`. Mirrors _find_usages (claude/ tree only). */
export function findUsages(projectRoot: string, snippetName: string): string[] {
  const escaped = escapeRegExp(snippetName);
  const pattern = new RegExp(
    `(?:snippet\\(\\s*['"][^'"]*${escaped}['"]` +
      `|include\\s+['"][^'"]*${escaped}\\.md\\.tmpl['"])`,
  );
  const usages = new Set<string>();
  const claudeRoot = join(projectRoot, "claude");
  if (!existsSync(claudeRoot)) {
    return [];
  }
  for (const f of rglob(claudeRoot, (n) => n.endsWith(".md.tmpl"))) {
    let text: string;
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    if (pattern.test(text)) {
      usages.add(relPosix(projectRoot, f));
    }
  }
  for (const f of rglob(claudeRoot, (n) => n === "SKILL.md.tmpl")) {
    const rel = relPosix(projectRoot, f);
    if (usages.has(rel)) {
      continue;
    }
    let text: string;
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    if (pattern.test(text)) {
      usages.add(rel);
    }
  }
  return [...usages].sort();
}

/** Walk the snippet tree and return the sorted list of index entries. Mirrors
 * build_index — field/name/domain consistency is enforced (hard errors). */
export function buildIndex(projectRoot: string): Record<string, unknown>[] {
  const templatesRoot = join(projectRoot, "claude", "arthack", "template");
  const snippetsRoot = join(templatesRoot, "_partials", "snippets");
  const entries: Record<string, unknown>[] = [];
  if (!existsSync(snippetsRoot)) {
    return entries;
  }

  for (const path of rglob(snippetsRoot, (n) => n.endsWith(".md.tmpl"))) {
    const relToTemplates = relPosix(templatesRoot, path);
    const [meta, body] = parseSnippet(path);

    const missing = REQUIRED_FIELDS.filter((f) => !(f in meta)).sort();
    if (missing.length > 0) {
      throw new BuildSnippetsError(
        `Snippet ${relToTemplates} missing required fields: ${pyList(missing)}`,
      );
    }
    const base = path.slice(path.lastIndexOf(sep) + 1);
    const expectedName = base.replace(/\.md\.tmpl$/, "").replace(/\.md$/, "");
    if (meta.name !== expectedName) {
      throw new BuildSnippetsError(
        `Snippet ${relToTemplates} name=${pyRepr(meta.name)} ` +
          `does not match filename stem=${pyRepr(expectedName)}`,
      );
    }
    const parentName = path.slice(0, path.lastIndexOf(sep)).split(sep).pop();
    if (meta.domain !== parentName) {
      throw new BuildSnippetsError(
        `Snippet ${relToTemplates} domain=${pyRepr(meta.domain)} ` +
          `does not match parent dir=${pyRepr(parentName)}`,
      );
    }

    const entry: Record<string, unknown> = { ...meta };
    entry.path = relToTemplates;
    entry["token-estimate"] = estimateTokens(body);
    entry["used-in"] = findUsages(projectRoot, meta.name as string);
    entries.push(entry);
  }

  return entries;
}

/** Serialize the index as deterministic YAML. Mirrors serialize_index:
 * `sort_keys=False, width=10_000, allow_unicode=True`. */
export function serializeIndex(entries: Record<string, unknown>[]): string {
  return yaml.dump(
    { snippets: entries },
    { sortKeys: false, lineWidth: 10_000, noCompatMode: true },
  );
}

/** Bare names + `<domain>/<name>` qualified forms a bundle may reference.
 * Mirrors resolvable_snippet_ids. */
export function resolvableSnippetIds(
  entries: Record<string, unknown>[],
): Set<string> {
  const ids = new Set<string>();
  for (const e of entries) {
    ids.add(e.name as string);
    ids.add(`${(e.domain as string) ?? ""}/${e.name as string}`);
  }
  return ids;
}

/** Resolve every bundle `snippet_ids` entry against the live snippet ids.
 * Raises BuildSnippetsError on the first violation. Mirrors validate_bundles. */
export function validateBundles(
  projectRoot: string,
  knownIds: Set<string>,
): void {
  const templatesRoot = join(projectRoot, "claude", "arthack", "template");
  const bundlesRoot = join(templatesRoot, "_partials", "bundles");
  if (!existsSync(bundlesRoot)) {
    return;
  }
  const files = readdirSync(bundlesRoot)
    .filter((n) => n.endsWith(".yaml"))
    .map((n) => join(bundlesRoot, n))
    .sort();
  for (const path of files) {
    const relpath = relPosix(projectRoot, path);
    let data: unknown;
    try {
      data = yaml.load(readFileSync(path, "utf-8"));
    } catch (e) {
      throw new BuildSnippetsError(`bundle ${relpath} has invalid YAML: ${e}`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new BuildSnippetsError(`bundle ${relpath} is not a YAML mapping`);
    }
    const snippetIds = (data as Record<string, unknown>).snippet_ids;
    if (!Array.isArray(snippetIds)) {
      throw new BuildSnippetsError(
        `bundle ${relpath} is missing a list-valued snippet_ids key`,
      );
    }
    for (const sid of snippetIds) {
      if (!knownIds.has(sid as string)) {
        throw new BuildSnippetsError(
          `bundle ${relpath} references unknown snippet ${sid}`,
        );
      }
    }
  }
}

/** Options for the build-snippets runner (mirrors the click args namespace). */
export interface BuildSnippetsArgs {
  check: boolean;
  projectRoot: string;
}

/** In-process entry point. Returns 0 / 1 (no process.exit) so
 * render-plugin-templates can call it directly. Mirrors run_build_snippets.run.
 * The caller resolves `projectRoot` (this never falls back to cwd). */
export function runBuildSnippets(args: BuildSnippetsArgs): number {
  const projectRoot = args.projectRoot;
  if (!isDir(projectRoot)) {
    process.stderr.write(`Error: project root not found: ${projectRoot}\n`);
    return 1;
  }

  const snippetsRoot = join(
    projectRoot,
    "claude",
    "arthack",
    "template",
    "_partials",
    "snippets",
  );
  const indexPath = join(snippetsRoot, "_index.yaml");

  let entries: Record<string, unknown>[];
  try {
    entries = buildIndex(projectRoot);
  } catch (e) {
    if (e instanceof BuildSnippetsError) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  const newText = serializeIndex(entries);

  if (args.check) {
    const current = existsSync(indexPath)
      ? readFileSync(indexPath, "utf-8")
      : "";
    if (current !== newText) {
      process.stderr.write(
        `Error: ${relPosix(projectRoot, indexPath)} is out of date. ` +
          "Run `keeper prompt build-snippets` to regenerate.\n",
      );
      return 1;
    }
    try {
      validateBundles(projectRoot, resolvableSnippetIds(entries));
    } catch (e) {
      if (e instanceof BuildSnippetsError) {
        process.stderr.write(`Error: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
    return 0;
  }

  if (entries.length > 0 || existsSync(indexPath)) {
    ensureParent(indexPath);
    atomicWriteRaw(indexPath, newText);
  }
  return 0;
}

/** Python `repr()` of a string/None for parity in error messages. */
function pyRepr(value: unknown): string {
  if (value === undefined || value === null) {
    return "None";
  }
  if (typeof value === "string") {
    return `'${value}'`;
  }
  return String(value);
}

/** Python `str(sorted_list)` form: `['a', 'b']`. */
function pyList(items: string[]): string {
  return `[${items.map((i) => `'${i}'`).join(", ")}]`;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
