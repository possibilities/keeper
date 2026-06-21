// `keeper prompt save-snippet` — atomic snippet authoring with default stamping
// and an incremental `_index.yaml` update. Port of promptctl run_save_snippet.py.
//
// Writes a snippet file at
// `claude/arthack/template/_partials/snippets/<domain>/<name>.md.tmpl` (the
// `{#- frontmatter -#}` block + body) and incrementally inserts the new entry
// into `_index.yaml`, sorted by path ASC, so `build-snippets --check` keeps
// passing without a full rebuild. Default stamping: `audience: agent`,
// `severity: default` so the build's REQUIRED_FIELDS gate is satisfied.
//
// The Python `filelock.FileLock` around the index read-modify-write is DROPPED:
// keeper invokes verbs single-process per call, so there is no concurrent writer
// to serialize against. The `.md.tmpl` + `_index.yaml` writes stay atomic via
// store.ts atomicWriteRaw.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import yaml from "js-yaml";
import type { OutputFormat } from "../../plan/src/format.ts";
import { atomicWriteRaw } from "../../plan/src/store.ts";
import {
  estimateTokens,
  findUsages,
  serializeIndex,
} from "./build_snippets.ts";
import { loadSnippetIndex } from "./refs.ts";

const FRONTMATTER_KEY_ORDER = [
  "name",
  "summary",
  "domain",
  "audience",
  "severity",
  "tags",
  "scope",
  "phase",
  "topics",
  "related",
  "replaces",
];

const DEFAULT_AUDIENCE = "agent";
const DEFAULT_SEVERITY = "default";

/** Raised when a snippet cannot be written (collision, bad input, etc). */
export class SaveSnippetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveSnippetError";
  }
}

/** CLI/API inputs for a save. List fields accept a CSV string or string[]. */
export interface SaveSnippetArgs {
  name: string;
  domain: string;
  summary: string;
  body?: string | null;
  tags?: string[] | string | null;
  scope?: string[] | string | null;
  phase?: string[] | string | null;
  related?: string[] | string | null;
  audience?: string | null;
  severity?: string | null;
  force?: boolean;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Coerce a CLI/API list field into a clean string[] (no empties). */
function normalizeList(value: string[] | string | null | undefined): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return splitCsv(value);
  }
  return value.map((p) => String(p).trim()).filter((p) => p.length > 0);
}

/** Resolve `--body`: `@file` reads a file, `-` reads stdin, else literal. */
function resolveBody(body: string | null | undefined): string {
  if (body === null || body === undefined) {
    return "";
  }
  if (body === "-") {
    return readFileSync(0, "utf-8");
  }
  if (body.startsWith("@")) {
    return readFileSync(body.slice(1), "utf-8");
  }
  return body;
}

function validateName(name: string): void {
  if (!name) {
    throw new SaveSnippetError("--name is required");
  }
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\x00") ||
    name === "." ||
    name === ".."
  ) {
    throw new SaveSnippetError(`invalid --name '${name}'`);
  }
}

function validateDomain(domain: string): void {
  if (!domain) {
    throw new SaveSnippetError("--domain is required");
  }
  if (
    domain.includes("/") ||
    domain.includes("\\") ||
    domain.includes("\x00") ||
    domain === "." ||
    domain === ".."
  ) {
    throw new SaveSnippetError(`invalid --domain '${domain}'`);
  }
}

/** Reject a body holding a literal `{#-` / `-#}` token — it would corrupt the
 * frontmatter round-trip. Mirrors _validate_body_for_frontmatter. */
function validateBodyForFrontmatter(body: string): void {
  if (body.includes("{#-") || body.includes("-#}")) {
    throw new SaveSnippetError(
      "snippet body must not contain Jinja-comment frontmatter " +
        "markers ({#- or -#}); they would break round-trip parsing",
    );
  }
}

/** Serialize the snippet metadata as the canonical `{#- ... -#}` block:
 * block-style top-level mapping, flow-style inline lists. Each value flows
 * through js-yaml so YAML-special characters are quoted correctly. Mirrors
 * _render_frontmatter. */
function renderFrontmatter(meta: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FRONTMATTER_KEY_ORDER) {
    if (!(key in meta)) {
      continue;
    }
    const val = meta[key];
    if (val === null || val === undefined) {
      continue;
    }
    if (Array.isArray(val) && val.length === 0) {
      continue;
    }
    ordered[key] = val;
  }
  for (const [key, val] of Object.entries(meta)) {
    if (key in ordered || FRONTMATTER_KEY_ORDER.includes(key)) {
      continue;
    }
    if (val === null || val === undefined) {
      continue;
    }
    if (Array.isArray(val) && val.length === 0) {
      continue;
    }
    ordered[key] = val;
  }

  const lines: string[] = [];
  for (const [key, val] of Object.entries(ordered)) {
    if (Array.isArray(val)) {
      const listText = yaml
        .dump(val, { flowLevel: 0, lineWidth: 10_000, noCompatMode: true })
        .replace(/\n+$/, "");
      lines.push(`${key}: ${listText}`);
    } else {
      const scalarText = yaml
        .dump({ [key]: val }, { lineWidth: 10_000, noCompatMode: true })
        .replace(/\n+$/, "");
      lines.push(scalarText);
    }
  }
  return `{#-\n${lines.join("\n")}\n-#}\n`;
}

/** Repo-relative POSIX path. */
function relPosix(from: string, to: string): string {
  const rel = relative(from, to);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** Build the `_index.yaml` row for a freshly written snippet. Mirrors
 * _entry_for_index (single-snippet incremental insert). */
function entryForIndex(
  projectRoot: string,
  snippetPath: string,
  meta: Record<string, unknown>,
  body: string,
): Record<string, unknown> {
  const templatesRoot = join(projectRoot, "claude", "arthack", "template");
  const entry: Record<string, unknown> = { ...meta };
  entry.path = relPosix(templatesRoot, snippetPath);
  entry["token-estimate"] = estimateTokens(body);
  entry["used-in"] = findUsages(projectRoot, meta.name as string);
  return entry;
}

/** Insert/replace `newEntry` in `entries`, sorted by path ASC — matching the
 * full-rebuild walk order so `build-snippets --check` stays green. Mirrors
 * _insert_entry_sorted. */
function insertEntrySorted(
  entries: Record<string, unknown>[],
  newEntry: Record<string, unknown>,
): Record<string, unknown>[] {
  const newPath = newEntry.path;
  const kept = entries.filter((e) => e.path !== newPath);
  kept.push(newEntry);
  kept.sort((a, b) => {
    const pa = String(a.path ?? "");
    const pb = String(b.path ?? "");
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  return kept;
}

/** Write the snippet + update the index. Returns the index row written. Mirrors
 * save_snippet. */
export function saveSnippet(
  projectRoot: string,
  args: SaveSnippetArgs,
): Record<string, unknown> {
  validateName(args.name);
  validateDomain(args.domain);
  if (!args.summary) {
    throw new SaveSnippetError("--summary is required");
  }

  let resolvedBody = resolveBody(args.body);
  validateBodyForFrontmatter(resolvedBody);

  const snippetsRoot = join(
    projectRoot,
    "claude",
    "arthack",
    "template",
    "_partials",
    "snippets",
  );
  const domainDir = join(snippetsRoot, args.domain);
  const snippetPath = join(domainDir, `${args.name}.md.tmpl`);

  if (existsSync(snippetPath) && !args.force) {
    throw new SaveSnippetError(
      `snippet ${relPosix(projectRoot, snippetPath)} already exists ` +
        "(pass --force to overwrite)",
    );
  }

  const meta: Record<string, unknown> = {
    name: args.name,
    summary: args.summary,
    domain: args.domain,
    audience: args.audience || DEFAULT_AUDIENCE,
    severity: args.severity || DEFAULT_SEVERITY,
  };
  const tagList = normalizeList(args.tags);
  const scopeList = normalizeList(args.scope);
  const phaseList = normalizeList(args.phase);
  const relatedList = normalizeList(args.related);
  if (tagList.length > 0) {
    meta.tags = tagList;
  }
  if (scopeList.length > 0) {
    meta.scope = scopeList;
  }
  if (phaseList.length > 0) {
    meta.phase = phaseList;
  }
  if (relatedList.length > 0) {
    meta.related = relatedList;
  }

  mkdirSync(domainDir, { recursive: true });

  const frontmatter = renderFrontmatter(meta);
  if (resolvedBody && !resolvedBody.endsWith("\n")) {
    resolvedBody = `${resolvedBody}\n`;
  }
  atomicWriteRaw(snippetPath, frontmatter + resolvedBody);

  const indexPath = join(snippetsRoot, "_index.yaml");
  mkdirSync(snippetsRoot, { recursive: true });
  const entries = loadSnippetIndex(projectRoot) as Record<string, unknown>[];
  const newEntry = entryForIndex(projectRoot, snippetPath, meta, resolvedBody);
  const updated = insertEntrySorted(entries, newEntry);
  atomicWriteRaw(indexPath, serializeIndex(updated));

  return newEntry;
}

/** Runner: write the snippet + emit the index row via `emit`. Returns the exit
 * code (1 with `Error: <msg>` on stderr on a SaveSnippetError). */
export function runSaveSnippet(
  projectRoot: string,
  args: SaveSnippetArgs,
  format: OutputFormat | null,
  emit: (row: Record<string, unknown>, format: OutputFormat | null) => void,
): number {
  let entry: Record<string, unknown>;
  try {
    entry = saveSnippet(projectRoot, args);
  } catch (exc) {
    if (exc instanceof SaveSnippetError) {
      process.stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  emit(entry, format);
  return 0;
}
