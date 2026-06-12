// status verb — the port of planctl/run_status.py. Resolves the project
// (hard-errors on a missing .planctl/), counts epics by status and tasks by
// merged runtime status (absent overlay -> todo), and reads schema_version from
// meta.json with a default of 1 (the intentional asymmetry with detect's 0 — do
// not unify). Returns the resolved project root for the read-only trailer.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { mergeTaskState } from "../models.ts";
import { resolveProject } from "../project.ts";
import { LocalFileStateStore, loadJsonSafe } from "../store.ts";

/** JSON files in `dir`, or [] when the dir is absent. Mirrors Path.glob:
 * non-recursive, names only. */
function globJson(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(dir, name));
}

/** Increment `counts[key]` only when the key already exists — mirrors Python's
 * `if status in counts: counts[status] += 1` (an unknown status is ignored). */
function bump(counts: Record<string, number>, key: string): void {
  if (Object.hasOwn(counts, key)) {
    counts[key] = (counts[key] ?? 0) + 1;
  }
}

export function runStatus(format: OutputFormat | null): string {
  const ctx = resolveProject(format);
  const store = new LocalFileStateStore(ctx.stateDir);

  const meta = loadJsonSafe(join(ctx.dataDir, "meta.json"));
  const schemaVersion =
    meta && typeof meta.schema_version === "number" ? meta.schema_version : 1;

  const epicCounts: Record<string, number> = { total: 0, open: 0, done: 0 };
  for (const f of globJson(join(ctx.dataDir, "epics"))) {
    const epic = loadJsonSafe(f);
    if (epic) {
      bump(epicCounts, "total");
      const status = typeof epic.status === "string" ? epic.status : "open";
      bump(epicCounts, status);
    }
  }

  const taskCounts: Record<string, number> = {
    total: 0,
    todo: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
  };
  for (const f of globJson(join(ctx.dataDir, "tasks"))) {
    const taskDef = loadJsonSafe(f);
    if (taskDef) {
      const taskId = typeof taskDef.id === "string" ? taskDef.id : stem(f);
      const runtime = store.loadRuntime(taskId);
      const merged = mergeTaskState(taskDef, runtime);
      bump(taskCounts, "total");
      const status = typeof merged.status === "string" ? merged.status : "todo";
      bump(taskCounts, status);
    }
  }

  formatOutput(
    {
      success: true,
      project: {
        name: ctx.name,
        path: ctx.projectPath,
        schema_version: schemaVersion,
      },
      epics: epicCounts,
      tasks: taskCounts,
    },
    format,
  );
  return ctx.projectPath;
}

/** Filename stem (Path.stem): basename without the final extension. */
function stem(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}
