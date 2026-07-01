// detect verb. found-true reads meta.json's schema_version (default 0 when meta
// is absent/corrupt — the intentional asymmetry with status's default of 1) and
// returns exit 0. found-false emits ONE {success:false, found:false, error}
// value and returns exit 1, so `keeper plan detect || keeper plan init` stays
// exit-driven while the stream carries exactly one JSON value. The data dir is
// `.keeper/`.

import { basename, join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { findProjectRoot } from "../project.ts";
import { resolveDataDir } from "../state_path.ts";
import { loadJsonSafe } from "../store.ts";

export function runDetect(format: OutputFormat | null): number {
  const projectRoot = findProjectRoot();
  const dataDir = resolveDataDir(projectRoot);

  if (dataDir !== null) {
    const meta = loadJsonSafe(join(dataDir, "meta.json"));
    const schemaVersion =
      meta && typeof meta.schema_version === "number" ? meta.schema_version : 0;
    formatOutput(
      {
        success: true,
        found: true,
        project: {
          name: basename(projectRoot),
          path: projectRoot,
          schema_version: schemaVersion,
        },
      },
      format,
    );
    return 0;
  }

  // found-false: one value carrying both the found flag and the missing-project
  // error (matching resolveProject's message), then exit 1.
  formatOutput(
    {
      success: false,
      found: false,
      error: "No plan project found. Run 'keeper plan init' first.",
    },
    format,
  );
  return 1;
}
