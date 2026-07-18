// epics verb — the port of planctl/run_epics.py. Lists every epic sorted by
// parse_id epic number (unparseable -> 999, so it sorts last), each with a
// per-epic task summary merged through the runtime overlay. Owns the only
// --format human surface in this epic: _render_human's table view, matched
// byte-for-byte (non-zero-status parenthetical, non-ASCII title preserved).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { parseId } from "../ids.ts";
import { mergeTaskState } from "../models.ts";
import { resolveProject } from "../project.ts";
import { LocalFileStateStore, loadJsonSafe } from "../store.ts";

interface TaskSummary {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  blocked: number;
}

interface EpicEntry {
  id: string;
  title: string;
  status: string;
  branch_name: string | null;
  task_summary: TaskSummary;
}

const STATUS_KEYS = ["todo", "in_progress", "done", "blocked"] as const;
type StatusKey = (typeof STATUS_KEYS)[number];

/** Render the epics envelope as _render_human's table text. */
function renderHuman(data: {
  project: { name: string; path: string };
  epics?: EpicEntry[];
}): string {
  const lines = [`Project: ${data.project.name} (${data.project.path})`];
  for (const epic of data.epics ?? []) {
    const s = epic.task_summary;
    const parts: string[] = [];
    for (const k of STATUS_KEYS) {
      if (s[k] > 0) {
        parts.push(`${s[k]} ${k}`);
      }
    }
    const taskStr =
      parts.length > 0
        ? `${s.total} tasks (${parts.join(", ")})`
        : `${s.total} tasks`;
    lines.push(`${epic.id}  ${epic.title}  [${epic.status}]  ${taskStr}`);
  }
  return lines.join("\n");
}

export function runEpics(opts: {
  format: OutputFormat | null;
  limit: number;
  offset: number;
}): string {
  const { format, limit, offset } = opts;
  const ctx = resolveProject(format);
  const store = new LocalFileStateStore(ctx.stateDir);

  const epicsDir = join(ctx.dataDir, "epics");
  const epics: Record<string, unknown>[] = [];
  if (existsSync(epicsDir)) {
    for (const name of readdirSync(epicsDir)) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const ed = loadJsonSafe(join(epicsDir, name));
      if (ed) {
        epics.push(ed);
      }
    }
  }

  // Sort by epic number; unparseable ids -> 999 (sort last). Stable, matching
  // Python's list.sort.
  epics.sort((a, b) => sortKey(a) - sortKey(b));

  // Cap counts epics (top-level rows); page after the sort so --offset is
  // stable. Only the paged epics load their per-epic task summary — total stays
  // the full epic count. Mirrors the list/tasks paging contract.
  const total = epics.length;
  const pagedEpics = epics.slice(offset, offset + limit);

  const tasksDir = join(ctx.dataDir, "tasks");
  const tasksDirExists = existsSync(tasksDir);
  const resultEpics: EpicEntry[] = [];
  for (const e of pagedEpics) {
    const eid = typeof e.id === "string" ? e.id : "";
    const summary: TaskSummary = {
      total: 0,
      todo: 0,
      in_progress: 0,
      done: 0,
      blocked: 0,
    };
    if (tasksDirExists && eid) {
      for (const name of readdirSync(tasksDir)) {
        if (!isEpicTaskFile(name, eid)) {
          continue;
        }
        const td = loadJsonSafe(join(tasksDir, name));
        if (td) {
          const tid = typeof td.id === "string" ? td.id : "";
          const runtime = store.loadRuntime(tid);
          const merged = mergeTaskState(td, runtime);
          summary.total += 1;
          const s = typeof merged.status === "string" ? merged.status : "todo";
          if (isStatusKey(s)) {
            summary[s] += 1;
          }
        }
      }
    }

    resultEpics.push({
      id: eid,
      title: typeof e.title === "string" ? e.title : "",
      status: typeof e.status === "string" ? e.status : "open",
      branch_name: typeof e.branch_name === "string" ? e.branch_name : null,
      task_summary: summary,
    });
  }

  const returned = resultEpics.length;
  const truncated = offset + returned < total;
  const hint = truncated
    ? "epics truncated; page with --limit/--offset or use 'keeper query epics'"
    : null;

  formatOutput(
    {
      success: true,
      project: { name: ctx.name, path: ctx.projectPath },
      epics: resultEpics,
      total,
      returned,
      truncated,
      hint,
    },
    format,
    (d) =>
      renderHuman(
        d as {
          project: { name: string; path: string };
          epics?: EpicEntry[];
        },
      ),
  );
  return ctx.projectPath;
}

function isStatusKey(s: string): s is StatusKey {
  return (STATUS_KEYS as readonly string[]).includes(s);
}

function sortKey(e: Record<string, unknown>): number {
  const id = typeof e.id === "string" ? e.id : "";
  const [epicNum] = parseId(id);
  return epicNum ?? 999;
}

/** Match Path.glob(`<eid>.*.json`): filename starts `<eid>.`, ends `.json`. */
function isEpicTaskFile(name: string, eid: string): boolean {
  return name.startsWith(`${eid}.`) && name.endsWith(".json");
}
