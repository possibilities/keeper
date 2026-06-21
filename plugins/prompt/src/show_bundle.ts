// `keeper prompt show-bundle <ref>` — load and emit a single bundle YAML by ref.
// Port of promptctl run_show_bundle.py.
//
// Dispatches `<ref>` via refs.parse to one of the bundle/sketch roots, loads the
// YAML, validates against the zod Bundle schema (`.strict()` → unknown keys fail
// loudly), and emits the normalized row. Errors if the ref is not a
// bundle/sketch ref, the file is missing, or schema validation fails.

import type { OutputFormat } from "../../plan/src/format.ts";
import { BundleIoError, bundleExists, loadBundleFile } from "./bundle_io.ts";
import type { Bundle } from "./bundle_schema.ts";
import { parse, RefError } from "./refs.ts";

/** Raised when a bundle cannot be loaded (bad ref, missing file, schema fail). */
export class ShowBundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShowBundleError";
  }
}

/** Resolve + load the bundle at `ref`, returning its normalized row. Mirrors
 * show_bundle. */
export function showBundle(ref: string, projectRoot: string): Bundle {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(ref, projectRoot);
  } catch (exc) {
    if (exc instanceof RefError) {
      throw new ShowBundleError(exc.message);
    }
    throw exc;
  }
  if (parsed.kind !== "bundle" && parsed.kind !== "sketch") {
    throw new ShowBundleError(
      `show-bundle requires a bundle/sketch ref, got snippet ref '${ref}'`,
    );
  }
  if (!bundleExists(parsed.path)) {
    throw new ShowBundleError(
      `bundle '${ref}' does not exist at ${parsed.path}`,
    );
  }
  try {
    return loadBundleFile(parsed.path, `'${ref}'`);
  } catch (exc) {
    if (exc instanceof BundleIoError) {
      throw new ShowBundleError(exc.message);
    }
    throw exc;
  }
}

/** Runner: emit the bundle row via `emit`. Returns the exit code (1 with
 * `Error: <msg>` on stderr on a ShowBundleError). */
export function runShowBundle(
  ref: string | undefined,
  projectRoot: string,
  format: OutputFormat | null,
  emit: (row: Bundle, format: OutputFormat | null) => void,
): number {
  if (!ref) {
    process.stderr.write("Error: missing argument 'REF'\n");
    return 2;
  }
  let row: Bundle;
  try {
    row = showBundle(ref, projectRoot);
  } catch (exc) {
    if (exc instanceof ShowBundleError) {
      process.stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
  emit(row, format);
  return 0;
}
