// Namespace-prefix parser for `keeper prompt` runtime substrate refs — shared by
// the `render` and `find-snippets` verbs. Port of promptctl refs.py.
//
// Refs fall into one of three shapes, dispatched by leading prefix:
//
//   bundle/<name>      -> <root>/claude/arthack/template/_partials/bundles/<name>.yaml
//   sketch/<name>      -> <root>/.promptctl/sketches/<name>.yaml  (write-time only)
//   <bare-snippet-id>  -> resolved via the snippet _index.yaml lookup
//
// Dispatch is by prefix only — no lookup-order fallback. Bare-id resolution is
// attempted exclusively when the ref does NOT start with one of the two known
// prefixes; an unknown leading `foo/...` prefix is rejected with an explicit
// error.
//
// Path-traversal attempts (`..`, leading `/`, NUL bytes, or any segment holding
// `/` or `\`) are rejected before touching the filesystem; the final resolved
// path is always asserted to be inside its expected root (via storage.ts
// safeJoin).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  bundleRoot,
  StorageError,
  safeJoin,
  sketchRoot,
  validateSegment,
} from "./storage.ts";

export type RefKind = "bundle" | "sketch" | "snippet";

/** Raised when a ref cannot be parsed or resolved. */
export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefError";
  }
}

/** A snippet `_index.yaml` row. `name` + `path` are always present; `domain` and
 * the remaining classification fields are optional. */
export interface SnippetEntry {
  name: string;
  path: string;
  domain?: string;
  [field: string]: unknown;
}

/** A resolved reference. `path` is the resolved filesystem path; for snippet
 * refs `snippetEntry` carries the matched `_index.yaml` row, else null. */
export interface ParsedRef {
  kind: RefKind;
  ref: string;
  path: string;
  snippetEntry: SnippetEntry | null;
}

/** Load `_partials/snippets/_index.yaml` under `projectRoot` (empty when
 * absent). Mirrors helpers.py load_snippet_index. */
export function loadSnippetIndex(projectRoot: string): SnippetEntry[] {
  const indexPath = join(
    projectRoot,
    "claude",
    "arthack",
    "template",
    "_partials",
    "snippets",
    "_index.yaml",
  );
  if (!existsSync(indexPath)) {
    return [];
  }
  const data = yaml.load(readFileSync(indexPath, "utf-8")) as {
    snippets?: SnippetEntry[];
  } | null;
  return data?.snippets ?? [];
}

/** Reject the obvious traversal-bait characters before any segment split.
 * Mirrors refs.py _validate_no_traversal_chars. */
function validateNoTraversalChars(ref: string): void {
  if (!ref) {
    throw new RefError("ref is empty");
  }
  if (ref.includes("\x00")) {
    throw new RefError(`ref contains NUL byte: ${quote(ref)}`);
  }
  if (ref.startsWith("/")) {
    throw new RefError(`ref must not be absolute: ${quote(ref)}`);
  }
}

function parseBundle(ref: string, projectRoot: string): ParsedRef {
  const suffix = ref.slice("bundle/".length);
  if (suffix.includes("/")) {
    throw new RefError(
      `bundle ref must be 'bundle/<name>' with no sub-paths, got ${quote(ref)}`,
    );
  }
  let path: string;
  try {
    validateSegment(suffix, ref);
    path = safeJoin(bundleRoot(projectRoot), [`${suffix}.yaml`], ref);
  } catch (err) {
    throw asRefError(err);
  }
  return { kind: "bundle", ref, path, snippetEntry: null };
}

function parseSketch(ref: string, projectRoot: string): ParsedRef {
  // A `sketch/<name>` ref is consumed at write time and inlined into the
  // record's `snippets` list — this parser exists to support that write-time
  // resolver, NOT a runtime project-relative pointer.
  const suffix = ref.slice("sketch/".length);
  if (suffix.includes("/")) {
    throw new RefError(
      `sketch ref must be 'sketch/<name>' with no sub-paths, got ${quote(ref)}`,
    );
  }
  let path: string;
  try {
    validateSegment(suffix, ref);
    path = safeJoin(sketchRoot(projectRoot), [`${suffix}.yaml`], ref);
  } catch (err) {
    throw asRefError(err);
  }
  return { kind: "sketch", ref, path, snippetEntry: null };
}

function parseSnippet(ref: string, projectRoot: string): ParsedRef {
  // An unknown leading prefix like `foo/bar` would otherwise silently fall into
  // snippet resolution and miss. Require either a bare id (no `/`) or a
  // single-slash domain-qualified id.
  if (countSlashes(ref) > 1) {
    throw new RefError(
      `unknown ref prefix in ${quote(ref)}: expected one of ` +
        `'bundle/<name>', 'sketch/<name>', or a bare snippet id`,
    );
  }

  const entries = loadSnippetIndex(projectRoot);
  const byName = new Map<string, SnippetEntry>();
  for (const e of entries) {
    byName.set(e.name, e);
    byName.set(`${e.domain ?? ""}/${e.name}`, e);
  }

  const entry = byName.get(ref);
  if (entry === undefined) {
    throw new RefError(`unknown snippet id: ${quote(ref)}`);
  }

  const templatesDir = join(projectRoot, "claude", "arthack", "template");
  let path: string;
  try {
    path = safeJoin(templatesDir, entry.path.split("/"), ref);
  } catch (err) {
    throw asRefError(err);
  }
  return { kind: "snippet", ref, path, snippetEntry: entry };
}

/** Parse a substrate ref and return its resolved path + kind. Dispatch order is
 * strictly prefix-based: `bundle/...`, then `sketch/...`, then bare snippet id.
 * Mirrors refs.py parse. */
export function parse(ref: string, projectRoot: string): ParsedRef {
  validateNoTraversalChars(ref);

  if (ref.startsWith("bundle/")) {
    return parseBundle(ref, projectRoot);
  }
  if (ref.startsWith("sketch/")) {
    return parseSketch(ref, projectRoot);
  }
  return parseSnippet(ref, projectRoot);
}

function countSlashes(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === "/") {
      n += 1;
    }
  }
  return n;
}

/** Re-wrap a StorageError as a RefError; rethrow anything else. */
function asRefError(err: unknown): RefError {
  if (err instanceof StorageError) {
    return new RefError(err.message);
  }
  if (err instanceof RefError) {
    return err;
  }
  throw err;
}

function quote(s: string): string {
  return `'${s}'`;
}
