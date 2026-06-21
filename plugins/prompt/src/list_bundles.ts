// `keeper prompt list-bundles [--namespace bundle/|sketch/]` — walk the bundle
// storage roots and emit summary rows. Port of promptctl run_list_bundles.py.
//
// Walks one or both runtime namespace roots (bundle/ → the corpus bundles dir,
// sketch/ → `<project>/.promptctl/sketches/`), emitting a
// {ref, summary, snippet_count, created_at} row per valid bundle. A malformed
// bundle warns to stderr and is omitted (the human can `show-bundle <ref>` to
// see the full error). Rows are sorted by `ref` ASC for deterministic output.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { OutputFormat } from "../../plan/src/format.ts";
import { tryLoadBundleFile } from "./bundle_io.ts";
import { bundleRoot, sketchRoot } from "./storage.ts";

const NAMESPACE_VALUES = ["bundle/", "sketch/"];

/** Raised when listing cannot proceed (bad --namespace flag). */
export class ListBundlesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListBundlesError";
  }
}

/** A bundle summary row. */
export interface BundleRow {
  ref: string;
  summary: string | null;
  snippet_count: number;
  created_at: string;
}

/** Walk a namespace directory, returning rows for every valid YAML. `prefix` is
 * the ref namespace (`bundle/` or `sketch/`). */
function walkNamespace(
  dir: string,
  prefix: string,
  warn: (msg: string) => void,
): BundleRow[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files = readdirSync(dir)
    .filter((n) => n.endsWith(".yaml"))
    .sort();
  const out: BundleRow[] = [];
  for (const name of files) {
    const stem = name.replace(/\.yaml$/, "");
    const ref = `${prefix}${stem}`;
    const bundle = tryLoadBundleFile(join(dir, name), `'${ref}'`, warn);
    if (bundle === null) {
      continue;
    }
    out.push({
      ref,
      summary: bundle.summary,
      snippet_count: bundle.snippet_ids.length,
      created_at: bundle.created_at,
    });
  }
  return out;
}

/** Walk one or both namespace roots and return summary rows sorted by ref ASC.
 * `namespace` filters to `"bundle/"` / `"sketch/"`; null walks both. Mirrors
 * list_bundles. */
export function listBundles(
  projectRoot: string,
  namespace: string | null,
  warn: (msg: string) => void = (m) => process.stderr.write(`${m}\n`),
): BundleRow[] {
  if (namespace !== null && !NAMESPACE_VALUES.includes(namespace)) {
    throw new ListBundlesError(
      `--namespace must be one of ['bundle/', 'sketch/'], got '${namespace}'`,
    );
  }
  const rows: BundleRow[] = [];
  if (namespace === null || namespace === "bundle/") {
    rows.push(...walkNamespace(bundleRoot(projectRoot), "bundle/", warn));
  }
  if (namespace === null || namespace === "sketch/") {
    rows.push(...walkNamespace(sketchRoot(projectRoot), "sketch/", warn));
  }
  rows.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return rows;
}

/** Runner: emit the rows via `emit`. Returns the exit code (1 with
 * `Error: <msg>` on stderr on a ListBundlesError). */
export function runListBundles(
  projectRoot: string,
  namespace: string | null,
  format: OutputFormat | null,
  emit: (rows: BundleRow[], format: OutputFormat | null) => void,
): number {
  let rows: BundleRow[];
  try {
    rows = listBundles(projectRoot, namespace);
  } catch (exc) {
    if (exc instanceof ListBundlesError) {
      process.stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  emit(rows, format);
  return 0;
}
