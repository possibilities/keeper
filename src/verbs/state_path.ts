// state-path verb — the port of planctl/run_state_path.py. Resolves the project,
// emits {state_dir} (plus task_state_path when --task is given), and returns the
// resolved project root so the dispatch layer can emit the read-only trailer.

import { join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { resolveProject } from "../project.ts";

export function runStatePath(
  format: OutputFormat | null,
  taskId: string | null,
): string {
  const ctx = resolveProject(format);

  const payload: Record<string, unknown> = {
    success: true,
    state_dir: ctx.stateDir,
  };
  if (taskId) {
    payload.task_state_path = join(
      ctx.stateDir,
      "tasks",
      `${taskId}.state.json`,
    );
  }

  formatOutput(payload, format);
  return ctx.projectPath;
}
