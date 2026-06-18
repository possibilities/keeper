// ready verb — the port of planctl/run_ready.py. Classifies an epic's tasks into
// ready / in_progress / blocked: an in_progress or blocked merged status lands
// directly; a todo task with any unmet dependency (a dep whose merged status is
// not "done") is blocked-by those deps, else it is ready. Each bucket sorts by
// (task_priority, task_num, title). A missing epic emits the {success:false}
// envelope + exit 1. Returns the resolved project root for the read-only trailer
// (--epic is an OPTION, not a positional, so the trailer target is null).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { parseId } from "../ids.ts";
import { mergeTaskState, taskPriority } from "../models.ts";
import { resolveProject } from "../project.ts";
import { getActor, LocalFileStateStore, loadJsonSafe } from "../store.ts";

/** Render the ready envelope as human text (mirrors _render_human). */
function renderHuman(data: Record<string, unknown>): string {
  const epicId = (data.epic as string | undefined) ?? "";
  const actor = (data.actor as string | undefined) ?? "";
  const ready = (data.ready as Record<string, unknown>[] | undefined) ?? [];
  const inProgress =
    (data.in_progress as Record<string, unknown>[] | undefined) ?? [];
  const blocked = (data.blocked as Record<string, unknown>[] | undefined) ?? [];

  const lines: string[] = [`Epic: ${epicId}`];
  if (ready.length > 0) {
    lines.push("\nReady:");
    for (const t of ready) {
      lines.push(`  ${String(t.id)}  ${String(t.title ?? "")}`);
    }
  }
  if (inProgress.length > 0) {
    lines.push("\nIn Progress:");
    for (const t of inProgress) {
      const you = t.assignee === actor ? " (you)" : "";
      const assignee = String(t.assignee ?? "");
      lines.push(
        `  ${String(t.id)}  ${String(t.title ?? "")} ${assignee}${you}`,
      );
    }
  }
  if (blocked.length > 0) {
    lines.push("\nBlocked:");
    for (const t of blocked) {
      const bb = (t.blocked_by as string[] | undefined) ?? [];
      const suffix = bb.length > 0 ? `\n    blocked by: ${bb.join(", ")}` : "";
      lines.push(`  ${String(t.id)}  ${String(t.title ?? "")}${suffix}`);
    }
  }
  if (ready.length === 0 && inProgress.length === 0 && blocked.length === 0) {
    lines.push("\nNo tasks.");
  }
  return lines.join("\n");
}

export function runReady(epicId: string, format: OutputFormat | null): string {
  const ctx = resolveProject(format);
  const store = new LocalFileStateStore(ctx.stateDir);
  const actor = getActor();

  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    formatOutput(
      { success: false, error: `Epic not found: ${epicId}` },
      format,
    );
    process.exit(1);
  }

  // Load every task for this epic, keyed by id, with runtime merged in.
  const allTasks: Record<string, Record<string, unknown>> = {};
  const tasksDir = join(ctx.dataDir, "tasks");
  if (existsSync(tasksDir)) {
    for (const name of readdirSync(tasksDir).sort()) {
      if (!isEpicTaskFile(name, epicId)) {
        continue;
      }
      const td = loadJsonSafe(join(tasksDir, name));
      if (td) {
        const tid =
          typeof td.id === "string" ? td.id : name.slice(0, -".json".length);
        const runtime = store.loadRuntime(tid);
        allTasks[tid] = mergeTaskState(td, runtime);
      }
    }
  }

  const ready: Record<string, unknown>[] = [];
  const inProgress: Record<string, unknown>[] = [];
  const blocked: Record<string, unknown>[] = [];

  for (const t of Object.values(allTasks)) {
    const status = (t.status as string | undefined) ?? "todo";
    if (status === "in_progress") {
      inProgress.push(t);
    } else if (status === "blocked") {
      blocked.push(t);
    } else if (status === "todo") {
      const deps = (t.depends_on as string[] | undefined) ?? [];
      const unmet = deps.filter((d) => allTasks[d]?.status !== "done");
      if (unmet.length > 0) {
        t._blocked_by = unmet;
        blocked.push(t);
      } else {
        ready.push(t);
      }
    }
  }

  const sortKey = (t: Record<string, unknown>): [number, number, string] => {
    const [, tn] = parseId((t.id as string | undefined) ?? "");
    return [taskPriority(t), tn ?? 999, (t.title as string | undefined) ?? ""];
  };
  const cmp = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): number => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka[0] !== kb[0]) {
      return ka[0] - kb[0];
    }
    if (ka[1] !== kb[1]) {
      return ka[1] - kb[1];
    }
    return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
  };
  ready.sort(cmp);
  inProgress.sort(cmp);
  blocked.sort(cmp);

  formatOutput(
    {
      success: true,
      epic: epicId,
      actor,
      ready: ready.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        priority: t.priority ?? null,
        depends_on: t.depends_on ?? [],
      })),
      in_progress: inProgress.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        assignee: t.assignee ?? null,
        priority: t.priority ?? null,
      })),
      blocked: blocked.map((t) => ({
        id: t.id,
        title: t.title ?? "",
        blocked_by: t._blocked_by ?? [],
      })),
    },
    format,
    (d) => renderHuman(d as Record<string, unknown>),
  );
  return ctx.projectPath;
}

/** Match Path.glob(`<eid>.*.json`): single ordinal segment, not a deeper id. */
function isEpicTaskFile(name: string, eid: string): boolean {
  const prefix = `${eid}.`;
  if (!name.startsWith(prefix) || !name.endsWith(".json")) {
    return false;
  }
  const middle = name.slice(prefix.length, -".json".length);
  return middle.length > 0 && !middle.includes(".");
}
