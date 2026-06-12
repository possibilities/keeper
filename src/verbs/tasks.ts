// tasks verb — the port of planctl/run_tasks.py. Lists tasks across the project
// with optional --epic and --status filters, merged through the runtime overlay,
// sorted by (epic_number, task_number) with an unparseable id sorting last (999).
// Returns the resolved project root for the read-only trailer (--epic / --status
// are OPTIONS, not positionals, so the trailer target is null).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { parseId } from "../ids.ts";
import { mergeTaskState } from "../models.ts";
import { resolveProject } from "../project.ts";
import { LocalFileStateStore, loadJsonSafe } from "../store.ts";

/** Render the tasks envelope as one line per task (mirrors _render_human). */
function renderHuman(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const t of (data.tasks as Record<string, unknown>[] | undefined) ?? []) {
    const assignee = String(t.assignee ?? "");
    const assigneeStr = assignee ? `  ${assignee}` : "";
    lines.push(
      `${String(t.id)}  ${String(t.title ?? "")}  [${String(t.status ?? "todo")}]${assigneeStr}`,
    );
  }
  return lines.join("\n");
}

export function runTasks(opts: {
  epic: string | null;
  status: string | null;
  format: OutputFormat | null;
}): string {
  const { epic: epicId, status: statusFilter, format } = opts;
  const ctx = resolveProject(format);
  const store = new LocalFileStateStore(ctx.stateDir);

  let allTasks: Record<string, unknown>[] = [];
  const tasksDir = join(ctx.dataDir, "tasks");
  if (existsSync(tasksDir)) {
    for (const name of readdirSync(tasksDir).sort()) {
      if (!matchesPattern(name, epicId)) {
        continue;
      }
      const td = loadJsonSafe(join(tasksDir, name));
      if (td) {
        const tid =
          typeof td.id === "string" ? td.id : name.slice(0, -".json".length);
        const runtime = store.loadRuntime(tid);
        allTasks.push(mergeTaskState(td, runtime));
      }
    }
  }

  if (statusFilter) {
    allTasks = allTasks.filter((t) => t.status === statusFilter);
  }

  allTasks.sort((a, b) => {
    const [ea, ta] = parseId((a.id as string | undefined) ?? "");
    const [eb, tb] = parseId((b.id as string | undefined) ?? "");
    const ka0 = ea ?? 999;
    const kb0 = eb ?? 999;
    if (ka0 !== kb0) {
      return ka0 - kb0;
    }
    return (ta ?? 999) - (tb ?? 999);
  });

  formatOutput(
    {
      success: true,
      tasks: allTasks.map((t) => ({
        id: t.id ?? null,
        epic: t.epic ?? null,
        title: t.title ?? null,
        status: t.status ?? "todo",
        priority: t.priority ?? null,
        assignee: t.assignee ?? null,
      })),
    },
    format,
    (d) => renderHuman(d as Record<string, unknown>),
  );
  return ctx.projectPath;
}

/** Match Python's glob: `<epic>.*.json` when filtered, else `*.json`. The
 * filtered form requires a single ordinal segment (not a deeper id). */
function matchesPattern(name: string, epicId: string | null): boolean {
  if (!name.endsWith(".json")) {
    return false;
  }
  if (epicId === null) {
    return true;
  }
  const prefix = `${epicId}.`;
  if (!name.startsWith(prefix)) {
    return false;
  }
  const middle = name.slice(prefix.length, -".json".length);
  return middle.length > 0 && !middle.includes(".");
}
