// cat verb — the port of planctl/run_cat.py. Format-free by contract: emits the
// raw spec markdown bytes to stdout regardless of --format, with NO trailing
// plan_invocation line (the dispatcher lists cat in NO_TRACK_COMMANDS). An
// invalid id or a missing spec writes an `Error: ...` line to stderr and exits
// 1 — the missing-spec message names the resolved absolute spec path.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isEpicId, isTaskId } from "../ids.ts";
import { resolveProject } from "../project.ts";

/** Run cat. Returns the process exit code (0 on success, 1 on error). The
 * dispatcher must NOT fire the generic trailer for this verb. */
export function runCat(idStr: string): number {
  if (!isEpicId(idStr) && !isTaskId(idStr)) {
    process.stderr.write(`Error: Invalid ID format: ${idStr}\n`);
    return 1;
  }

  // resolveProject emits the missing-project error envelope + exit 1 itself when
  // there is no .planctl/ — matching Python's resolve_project contract.
  const ctx = resolveProject(null);

  const specPath = join(ctx.dataDir, "specs", `${idStr}.md`);
  if (!existsSync(specPath)) {
    process.stderr.write(`Error: Spec not found: ${specPath}\n`);
    return 1;
  }

  process.stdout.write(readFileSync(specPath, "utf-8"));
  return 0;
}
