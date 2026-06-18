// detect verb — the port of planctl/run_detect.py. found-true reads meta.json's
// schema_version (default 0 when meta is absent/corrupt — the intentional
// asymmetry with status's default of 1); found-false emits a bare {found:false}
// and never hard-errors. The verb itself never resolves a project (it tolerates
// a missing .planctl/), so the read-only trailer is left to dispatch, which
// resolves independently — on found-false that resolve hits the missing-project
// guard and tails the error envelope + exit 1, exactly as Python does.

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { findProjectRoot } from "../project.ts";
import { loadJsonSafe } from "../store.ts";

export function runDetect(format: OutputFormat | null): void {
  const projectRoot = findProjectRoot();
  const planctlDir = join(projectRoot, ".planctl");

  if (existsSync(planctlDir)) {
    const meta = loadJsonSafe(join(planctlDir, "meta.json"));
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
    return;
  }

  formatOutput({ success: true, found: false }, format);
}
