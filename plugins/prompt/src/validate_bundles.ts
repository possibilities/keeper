// `keeper prompt validate-bundles` — proactive bundle-reference validator. Port
// of promptctl run_validate_bundles.py.
//
// At render time a bundle referencing a snippet id with no index entry is
// soft-skipped (warn + continue, exit 0 — the deletion-drift policy). This verb
// is the opt-in counterpart: it walks every bundle YAML under
// `_partials/bundles/`, resolves each `snippet_ids` entry against the live
// snippet index, COLLECTS every miss across every bundle (vs build-snippets
// --check which raises on the first), prints one `bundle id + snippet id` line
// per miss to stderr, and exits non-zero if any miss was found.
//
// Resolution mirrors the renderer exactly: the known-id set comes from
// resolvableSnippetIds(buildIndex(...)) — bare `name` plus `<domain>/<name>`.
// A bundle whose YAML is unparseable / not a mapping / lacks a list-valued
// snippet_ids key raises ValidateBundlesError naming the file (a structural
// failure, distinct from snippet-id drift), also exit 1.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import yaml from "js-yaml";
import {
  BuildSnippetsError,
  buildIndex,
  resolvableSnippetIds,
} from "./build_snippets.ts";

/** Raised on a structural bundle failure (unparseable / non-mapping / missing
 * snippet_ids). Distinct from a snippet-id miss, which is collected not thrown. */
export class ValidateBundlesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidateBundlesError";
  }
}

/** Repo-relative POSIX path (forward slashes). */
function relPosix(from: string, to: string): string {
  const rel = relative(from, to);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/** Walk every bundle YAML and return all unresolvable (bundle_id, snippet_id)
 * pairs. Misses collected across all bundles; structural failures throw.
 * Mirrors find_misses. */
export function findMisses(projectRoot: string): [string, string][] {
  const knownIds = resolvableSnippetIds(buildIndex(projectRoot));

  const bundlesRoot = join(
    projectRoot,
    "claude",
    "arthack",
    "template",
    "_partials",
    "bundles",
  );
  const misses: [string, string][] = [];
  if (!existsSync(bundlesRoot)) {
    return misses;
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
      throw new ValidateBundlesError(
        `bundle ${relpath} has invalid YAML: ${e}`,
      );
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ValidateBundlesError(`bundle ${relpath} is not a YAML mapping`);
    }
    const snippetIds = (data as Record<string, unknown>).snippet_ids;
    if (!Array.isArray(snippetIds)) {
      throw new ValidateBundlesError(
        `bundle ${relpath} is missing a list-valued snippet_ids key`,
      );
    }
    const bundleId = String((data as Record<string, unknown>).id ?? relpath);
    for (const sid of snippetIds) {
      if (!knownIds.has(String(sid))) {
        misses.push([bundleId, String(sid)]);
      }
    }
  }
  return misses;
}

/** Runner: exit 0 with a one-line stdout summary when every id resolves; exit 1
 * with one miss per stderr line otherwise. Structural failures exit 1 with the
 * raised message on stderr. Mirrors run_validate_bundles.run. */
export function runValidateBundles(projectRoot: string): number {
  let misses: [string, string][];
  try {
    misses = findMisses(projectRoot);
  } catch (e) {
    if (e instanceof ValidateBundlesError || e instanceof BuildSnippetsError) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 1;
    }
    throw e;
  }

  if (misses.length > 0) {
    for (const [bundleId, snippetId] of misses) {
      process.stderr.write(
        `bundle ${bundleId} references unknown snippet ${snippetId}\n`,
      );
    }
    const noun = misses.length === 1 ? "reference" : "references";
    process.stderr.write(
      `Error: ${misses.length} unresolvable snippet ${noun} found\n`,
    );
    return 1;
  }

  process.stdout.write("All bundle snippet_ids resolve.\n");
  return 0;
}
