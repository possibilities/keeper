// show verb — the port of planctl/run_show.py. A task id resolves the task
// definition merged with its runtime overlay; an epic id resolves the epic
// definition plus a task_summary computed off the merged statuses. Invalid ids
// and missing entities surface the {success:false, error} envelope + exit 1.
// Returns the resolved project root + the positional id for the read-only
// trailer (whose target is the id, unlike the no-positional list/tasks verbs).
//
// Resolution is cwd-then-global (resolveOwningProjectForId): a globally-unique
// id reads the board that owns it regardless of cwd, so a cross-repo worker can
// read a task/epic owned by another repo's plan board. --project bypasses
// discovery for a legacy ambiguous id.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId, isTaskId } from "../ids.ts";
import { mergeTaskState } from "../models.ts";
import {
  annotateIdReadVantage,
  resolveOwningProjectForId,
} from "../project.ts";
import { LocalFileStateStore, loadJson, loadJsonSafe } from "../store.ts";

interface ShowResult {
  projectPath: string;
}

/** Render the show envelope as labeled key:value text (mirrors _render_human). */
function renderHuman(data: Record<string, unknown>): string {
  const lines: string[] = [];
  const typ = data.type;
  if (typ === "task") {
    const t = (data.task ?? {}) as Record<string, unknown>;
    lines.push(`Task: ${str(t.id)}`);
    lines.push(`Title: ${str(t.title)}`);
    lines.push(`Epic: ${str(t.epic)}`);
    lines.push(`Status: ${str(t.status ?? "todo")}`);
    if (t.assignee) {
      lines.push(
        `Assignee: ${str(t.assignee)} (claimed ${str(t.claimed_at ?? "")})`,
      );
    }
    const p = t.priority;
    lines.push(`Priority: ${p !== null && p !== undefined ? String(p) : "-"}`);
    const deps = (t.depends_on as unknown[] | undefined) ?? [];
    lines.push(`Dependencies: ${deps.length > 0 ? deps.join(", ") : "(none)"}`);
    if (t.target_repo) {
      lines.push(`Target repo: ${str(t.target_repo)}`);
    }
    const snippets = t.snippets as unknown[] | undefined;
    if (snippets && snippets.length > 0) {
      lines.push(`Snippets: ${snippets.join(", ")}`);
    }
    const bundles = t.bundles as unknown[] | undefined;
    if (bundles && bundles.length > 0) {
      lines.push(`Bundles: ${bundles.join(", ")}`);
    }
    lines.push(`Created: ${str(t.created_at ?? "")}`);
    lines.push(`Updated: ${str(t.updated_at ?? "")}`);
  } else if (typ === "epic") {
    const e = (data.epic ?? {}) as Record<string, unknown>;
    lines.push(`Epic: ${str(e.id)}`);
    lines.push(`Title: ${str(e.title)}`);
    lines.push(`Status: ${str(e.status)}`);
    if (e.branch_name) {
      lines.push(`Branch: ${str(e.branch_name)}`);
    }
    const deps = (e.depends_on_epics as unknown[] | undefined) ?? [];
    if (deps.length > 0) {
      lines.push(`Epic deps: ${deps.join(", ")}`);
    }
    if (e.primary_repo) {
      lines.push(`Primary repo: ${str(e.primary_repo)}`);
    }
    const touched = e.touched_repos as unknown[] | undefined;
    if (touched && touched.length > 0) {
      lines.push(`Touched repos: ${touched.join(", ")}`);
    }
    const snippets = e.snippets as unknown[] | undefined;
    if (snippets && snippets.length > 0) {
      lines.push(`Snippets: ${snippets.join(", ")}`);
    }
    const bundles = e.bundles as unknown[] | undefined;
    if (bundles && bundles.length > 0) {
      lines.push(`Bundles: ${bundles.join(", ")}`);
    }
    const s = (e.task_summary ?? {}) as Record<string, number>;
    lines.push(
      `Tasks: ${s.total ?? 0} (${s.todo ?? 0} todo, ${s.in_progress ?? 0} in_progress, ` +
        `${s.done ?? 0} done, ${s.blocked ?? 0} blocked)`,
    );
  }
  return lines.join("\n");
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export function runShow(
  idStr: string,
  project: string | null,
  format: OutputFormat | null,
): ShowResult {
  // Surface the weaker-vantage note the id-bearing resolution would drop (a lane
  // cwd keeps cwd resolution for a lane_no_state / inconclusive vantage but never
  // annotates). No-op under --project or a non-lane cwd.
  if (isTaskId(idStr) || isEpicId(idStr)) {
    annotateIdReadVantage(project);
  }
  if (isTaskId(idStr)) {
    const ctx = resolveOwningProjectForId(idStr, project, format);
    const store = new LocalFileStateStore(ctx.stateDir);

    const taskPath = join(ctx.dataDir, "tasks", `${idStr}.json`);
    if (!existsSync(taskPath)) {
      formatOutput(
        { success: false, error: `Task not found: ${idStr}` },
        format,
      );
      process.exit(1);
    }

    const taskDef = loadJson(taskPath);
    const runtime = store.loadRuntime(idStr);
    const merged = mergeTaskState(taskDef, runtime);

    formatOutput(
      {
        success: true,
        type: "task",
        task: {
          id: merged.id ?? null,
          epic: merged.epic ?? null,
          title: merged.title ?? null,
          priority: merged.priority ?? null,
          depends_on: merged.depends_on ?? [],
          spec_path: `specs/${idStr}.md`,
          status: merged.status ?? "todo",
          assignee: merged.assignee ?? null,
          claimed_at: merged.claimed_at ?? null,
          claim_note: merged.claim_note ?? null,
          evidence: merged.evidence ?? null,
          blocked_reason: merged.blocked_reason ?? null,
          target_repo: merged.target_repo ?? null,
          snippets: merged.snippets ?? [],
          bundles: merged.bundles ?? [],
          tier: merged.tier ?? null,
          created_at: merged.created_at ?? null,
          updated_at: merged.updated_at ?? null,
        },
      },
      format,
      (d) => renderHuman(d as Record<string, unknown>),
    );
    return { projectPath: ctx.projectPath };
  }

  if (isEpicId(idStr)) {
    const ctx = resolveOwningProjectForId(idStr, project, format);
    const store = new LocalFileStateStore(ctx.stateDir);

    const epicPath = join(ctx.dataDir, "epics", `${idStr}.json`);
    if (!existsSync(epicPath)) {
      formatOutput(
        { success: false, error: `Epic not found: ${idStr}` },
        format,
      );
      process.exit(1);
    }

    const epicDef = loadJson(epicPath);

    const summary: Record<string, number> = {
      total: 0,
      todo: 0,
      in_progress: 0,
      done: 0,
      blocked: 0,
    };
    const tasksDir = join(ctx.dataDir, "tasks");
    if (existsSync(tasksDir)) {
      for (const name of readdirSync(tasksDir).sort()) {
        if (!isEpicTaskFile(name, idStr)) {
          continue;
        }
        const td = loadJsonSafe(join(tasksDir, name));
        if (td) {
          const tid =
            typeof td.id === "string" ? td.id : name.slice(0, -".json".length);
          const runtime = store.loadRuntime(tid);
          const merged = mergeTaskState(td, runtime);
          summary.total = (summary.total ?? 0) + 1;
          const st = typeof merged.status === "string" ? merged.status : "todo";
          if (Object.hasOwn(summary, st)) {
            summary[st] = (summary[st] ?? 0) + 1;
          }
        }
      }
    }

    formatOutput(
      {
        success: true,
        type: "epic",
        epic: {
          id: epicDef.id ?? null,
          title: epicDef.title ?? null,
          status: epicDef.status ?? null,
          branch_name: epicDef.branch_name ?? null,
          depends_on_epics: epicDef.depends_on_epics ?? [],
          spec_path: `specs/${idStr}.md`,
          primary_repo: epicDef.primary_repo ?? null,
          touched_repos: epicDef.touched_repos ?? null,
          snippets: epicDef.snippets ?? [],
          bundles: epicDef.bundles ?? [],
          created_at: epicDef.created_at ?? null,
          updated_at: epicDef.updated_at ?? null,
          task_summary: summary,
        },
      },
      format,
      (d) => renderHuman(d as Record<string, unknown>),
    );
    return { projectPath: ctx.projectPath };
  }

  formatOutput(
    { success: false, error: `Invalid ID format: ${idStr}` },
    format,
  );
  process.exit(1);
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
