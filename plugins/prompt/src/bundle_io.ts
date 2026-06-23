// Shared bundle load + serialize helpers for the `keeper prompt` bundle verbs
// (save-bundle / list-bundles / show-bundle). Pulls the YAML read-validate and
// canonical-write shape into one seam so the four runners agree on the on-disk
// form. Port of the bundle I/O scattered across promptctl's run_save_bundle.py /
// run_show_bundle.py / run_list_bundles.py.

import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import { atomicWriteRaw } from "../../plan/src/store.ts";
import { type Bundle, parseBundle, zodErrorMessage } from "./bundle_schema.ts";
import { ensureParent } from "./storage.ts";
import { yamlDump } from "./yaml_dump.ts";

/** Raised when a bundle YAML cannot be loaded or fails schema validation. */
export class BundleIoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleIoError";
  }
}

/** Load + validate the bundle at `path`. `label` names the ref for error text.
 * Raises BundleIoError on bad YAML or a schema violation. */
export function loadBundleFile(path: string, label: string): Bundle {
  let data: unknown;
  try {
    data = yaml.load(readFileSync(path, "utf-8")) ?? {};
  } catch (exc) {
    throw new BundleIoError(`bundle ${label} at ${path}: invalid YAML: ${exc}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new BundleIoError(
      `bundle ${label} at ${path}: YAML is not a mapping`,
    );
  }
  try {
    return parseBundle(data);
  } catch (exc) {
    if (exc instanceof z.ZodError) {
      throw new BundleIoError(
        `bundle ${label} at ${path}: schema validation failed: ${zodErrorMessage(exc)}`,
      );
    }
    throw exc;
  }
}

/** Best-effort load: returns the bundle or null (caller warns + skips) — used by
 * list-bundles so one malformed file never aborts the whole walk. */
export function tryLoadBundleFile(
  path: string,
  label: string,
  warn: (msg: string) => void,
): Bundle | null {
  try {
    return loadBundleFile(path, label);
  } catch (exc) {
    warn(`Warning: ${exc instanceof Error ? exc.message : String(exc)}`);
    return null;
  }
}

/** Canonical on-disk YAML for a bundle: block-style mapping, fields in schema
 * order (id, snippet_ids, summary, tags, created_at). */
export function serializeBundle(bundle: Bundle): string {
  return yamlDump({
    id: bundle.id,
    snippet_ids: bundle.snippet_ids,
    summary: bundle.summary,
    tags: bundle.tags,
    created_at: bundle.created_at,
  });
}

/** Atomically write a bundle to `path` (parent dir created on demand). */
export function writeBundleAtomic(path: string, bundle: Bundle): void {
  ensureParent(path);
  atomicWriteRaw(path, serializeBundle(bundle));
}

/** True when `path` exists (re-exported for the runners' create/append gate). */
export function bundleExists(path: string): boolean {
  return existsSync(path);
}
