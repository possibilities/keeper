// `keeper prompt save-bundle <ref>` — atomic bundle authoring with create /
// append semantics. Port of promptctl run_save_bundle.py.
//
// Namespace dispatched by refs.parse:
//   bundle/<name>  -> corpus tree (claude/arthack/template/_partials/bundles/)
//   sketch/<name>  -> <project>/.promptctl/sketches/  (self-ignored on first use)
//
// Create (default): errors if the file exists unless --force; stamps created_at.
// Validates each snippet id against _index.yaml and warns once per phantom id to
// stderr but does NOT block (drift policy is skip-at-render). A zero-snippet
// write warns but still proceeds (empty sketches are legitimate).
//
// Append (--append): auto-creates if absent; else loads the existing bundle,
// unions snippet_ids preserving first-occurrence order, and applies
// summary/tags only when the existing value is empty unless --force. created_at
// is not re-stamped on append. bundle.id must match the filename stem.
//
// The Python per-bundle filelock is DROPPED (single-process keeper); the write
// stays atomic via store.ts atomicWriteRaw.

import type { OutputFormat } from "../../plan/src/format.ts";
import {
  BundleIoError,
  bundleExists,
  loadBundleFile,
  writeBundleAtomic,
} from "./bundle_io.ts";
import type { Bundle } from "./bundle_schema.ts";
import { loadSnippetIndex, type ParsedRef, parse, RefError } from "./refs.ts";
import { ensureSelfIgnored } from "./storage.ts";

/** Raised when a bundle cannot be written (collision, id mismatch, etc). */
export class SaveBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveBundleError";
  }
}

/** CLI/API inputs for a save-bundle. List fields accept CSV or string[]. */
export interface SaveBundleArgs {
  snippets?: string[] | string | null;
  summary?: string | null;
  tags?: string[] | string | null;
  append?: boolean;
  force?: boolean;
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function normalizeList(value: string[] | string | null | undefined): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    return splitCsv(value);
  }
  return value.map((p) => String(p).trim()).filter((p) => p.length > 0);
}

/** Stem of the ref's last path segment, the canonical bundle.id. */
function bundleIdFromPath(path: string): string {
  const base =
    path
      .slice(path.lastIndexOf("/") + 1)
      .split(/[\\/]/)
      .pop() ?? "";
  return base.replace(/\.yaml$/, "");
}

/** Dedup a list preserving first-occurrence order (Python dict.fromkeys). */
function dedup(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/** Append-mode union: existing order preserved, new ids appended at the end. */
function unionPreservingOrder(
  existing: string[],
  incoming: string[],
): string[] {
  const seen = new Set<string>(existing);
  const merged = [...existing];
  for (const sid of incoming) {
    if (!seen.has(sid)) {
      merged.push(sid);
      seen.add(sid);
    }
  }
  return merged;
}

/** Return the subset of `snippetIds` absent from `_index.yaml`. Phantoms warn
 * but never block. Mirrors _check_phantom_snippet_ids. */
function checkPhantomSnippetIds(
  snippetIds: string[],
  projectRoot: string,
): string[] {
  const entries = loadSnippetIndex(projectRoot);
  const known = new Set<string>();
  for (const e of entries) {
    known.add(e.name);
    if (e.domain) {
      known.add(`${e.domain}/${e.name}`);
    }
  }
  return snippetIds.filter((sid) => !known.has(sid));
}

/** ISO 8601 UTC now with microsecond-style precision trimmed to ms (the schema
 * normalizes either form). */
function nowIso(): string {
  return new Date().toISOString();
}

/** Write or merge a bundle at `ref`. Returns the bundle row written. `warn`
 * receives phantom-id / zero-snippet warnings. Mirrors save_bundle. */
export function saveBundle(
  ref: string,
  projectRoot: string,
  args: SaveBundleArgs,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): Bundle {
  const snippetIds = normalizeList(args.snippets);
  const tagList = normalizeList(args.tags);
  const append = args.append ?? false;
  const force = args.force ?? false;

  let parsed: ParsedRef;
  try {
    parsed = parse(ref, projectRoot);
  } catch (exc) {
    if (exc instanceof RefError) {
      throw new SaveBundleError(exc.message);
    }
    throw exc;
  }

  if (parsed.kind !== "bundle" && parsed.kind !== "sketch") {
    throw new SaveBundleError(
      `save-bundle requires a bundle/sketch ref, got snippet ref '${ref}'`,
    );
  }

  const bundleId = bundleIdFromPath(parsed.path);
  const bundlePath = parsed.path;
  if (parsed.kind === "sketch") {
    ensureSelfIgnored(projectRoot);
  }

  const phantoms = checkPhantomSnippetIds(snippetIds, projectRoot);
  for (const sid of phantoms) {
    warn(
      `Warning: bundle '${ref}' references unknown snippet id '${sid}' ` +
        "(write proceeds; drift policy is skip-at-render)",
    );
  }

  const exists = bundleExists(bundlePath);

  if (!append) {
    if (exists && !force) {
      throw new SaveBundleError(
        `bundle '${ref}' already exists at ${bundlePath} ` +
          "(pass --force to overwrite, or --append to merge)",
      );
    }
    const deduped = dedup(snippetIds);
    if (deduped.length === 0) {
      warnZeroSnippet(warn, ref, "create");
    }
    const bundle: Bundle = {
      id: bundleId,
      snippet_ids: deduped,
      summary: args.summary ?? null,
      tags: tagList,
      created_at: nowIso(),
    };
    writeBundleAtomic(bundlePath, bundle);
    return bundle;
  }

  // Append mode.
  if (!exists) {
    const deduped = dedup(snippetIds);
    if (deduped.length === 0) {
      warnZeroSnippet(warn, ref, "append-auto-create");
    }
    const bundle: Bundle = {
      id: bundleId,
      snippet_ids: deduped,
      summary: args.summary ?? null,
      tags: tagList,
      created_at: nowIso(),
    };
    writeBundleAtomic(bundlePath, bundle);
    return bundle;
  }

  let existing: Bundle;
  try {
    existing = loadBundleFile(bundlePath, `'${ref}'`);
  } catch (exc) {
    if (exc instanceof BundleIoError) {
      throw new SaveBundleError(exc.message);
    }
    throw exc;
  }
  if (existing.id !== bundleId) {
    throw new SaveBundleError(
      `bundle '${ref}': on-disk bundle.id '${existing.id}' does not ` +
        `match filename stem '${bundleId}'`,
    );
  }

  const mergedIds = unionPreservingOrder(existing.snippet_ids, snippetIds);

  let newSummary = existing.summary;
  if (args.summary != null && (!existing.summary || force)) {
    newSummary = args.summary;
  }
  let newTags = [...existing.tags];
  if (tagList.length > 0 && (existing.tags.length === 0 || force)) {
    newTags = tagList;
  }

  const merged: Bundle = {
    id: existing.id,
    snippet_ids: mergedIds,
    summary: newSummary,
    tags: newTags,
    created_at: existing.created_at, // do not re-stamp on append
  };
  writeBundleAtomic(bundlePath, merged);
  return merged;
}

function warnZeroSnippet(
  warn: (msg: string) => void,
  ref: string,
  mode: string,
): void {
  warn(
    `Warning: bundle '${ref}' written (${mode}) with zero snippet ids ` +
      "(write proceeds; bundle-health diagnostic will surface this as an " +
      "empty-shell persistence)",
  );
}

/** Runner: write/merge + emit the bundle row via `emit`. Returns the exit code
 * (1 with `Error: <msg>` on stderr on a SaveBundleError). */
export function runSaveBundle(
  ref: string | undefined,
  projectRoot: string,
  args: SaveBundleArgs,
  format: OutputFormat | null,
  emit: (row: Bundle, format: OutputFormat | null) => void,
): number {
  if (!ref) {
    process.stderr.write("Error: missing argument 'REF'\n");
    return 2;
  }
  let row: Bundle;
  try {
    row = saveBundle(ref, projectRoot, args);
  } catch (exc) {
    if (exc instanceof SaveBundleError) {
      process.stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  emit(row, format);
  return 0;
}
