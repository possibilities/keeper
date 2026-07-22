// list verb — the port of planctl/run_list.py. Builds the epic→tasks tree
// (epics ordered via orderEpicsForListing — open epics first ascending by
// number then done epics most-recent-first by default, restricted to one
// section under --status open/done, flat ascending-by-number under --status
// all; tasks within each epic sorted by ordinal with status merged through
// the runtime overlay) and emits it. The --format human render is
// golden-pinned byte-for-byte: a per-epic header line, one indented line per
// task, and a blank spacer line between epics (never trailing). Returns the
// resolved project root for the read-only trailer (no positional id -> target
// null).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { formatOutput, type OutputFormat } from "../format.ts";
import { parseId } from "../ids.ts";
import { mergeTaskState, normalizeEpic } from "../models.ts";
import { resolveProject } from "../project.ts";
import { LocalFileStateStore, loadJsonSafe } from "../store.ts";

interface ListTask {
  id: string | null;
  title: string;
  status: string;
  assignee: string | null;
}

interface ListEpic {
  id: string;
  title: string;
  status: string;
  tasks: ListTask[];
}

/** Render the list envelope as the tree text view (mirrors _render_human). */
function renderHuman(data: { epics?: ListEpic[] }): string {
  const lines: string[] = [];
  const epics = data.epics ?? [];
  for (let i = 0; i < epics.length; i += 1) {
    const e = epics[i] as ListEpic;
    lines.push(`${e.id}  ${e.title}  [${e.status}]`);
    for (const t of e.tasks) {
      const tid = t.id ?? "";
      const suffix = tid.includes(".") ? (tid.split(".").pop() as string) : tid;
      const assignee = t.assignee ? `  ${t.assignee}` : "";
      lines.push(`  .${suffix}  ${t.title}  [${t.status}]${assignee}`);
    }
    if (i < epics.length - 1) {
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function runList(opts: {
  format: OutputFormat | null;
  limit: number;
  offset: number;
  status: EpicStatusFilter;
}): string {
  const { format, limit, offset, status } = opts;
  const ctx = resolveProject(format);
  const store = new LocalFileStateStore(ctx.stateDir);

  const epicsDir = join(ctx.dataDir, "epics");
  const epics: Record<string, unknown>[] = [];
  if (existsSync(epicsDir)) {
    for (const name of readdirSync(epicsDir).sort()) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const ed = loadJsonSafe(join(epicsDir, name));
      if (ed) {
        epics.push(normalizeEpic(ed));
      }
    }
  }

  const ordered = orderEpicsForListing(epics, status);

  // Cap counts epics (top-level rows); page after the order so --offset is
  // stable. Only the paged epics load their nested tasks — total stays the
  // filtered epic count.
  const total = ordered.length;
  const pagedEpics = ordered.slice(offset, offset + limit);

  const tasksDir = join(ctx.dataDir, "tasks");
  const tasksDirExists = existsSync(tasksDir);
  const result: ListEpic[] = [];

  for (const e of pagedEpics) {
    const eid = typeof e.id === "string" ? e.id : "";
    const epicTasks: Record<string, unknown>[] = [];
    if (tasksDirExists && eid) {
      for (const name of readdirSync(tasksDir).sort()) {
        if (!isEpicTaskFile(name, eid)) {
          continue;
        }
        const td = loadJsonSafe(join(tasksDir, name));
        if (td) {
          const tid =
            typeof td.id === "string" ? td.id : name.slice(0, -".json".length);
          const runtime = store.loadRuntime(tid);
          epicTasks.push(mergeTaskState(td, runtime));
        }
      }
    }

    epicTasks.sort(compareTasks);

    result.push({
      id: eid,
      title: typeof e.title === "string" ? e.title : "",
      status: typeof e.status === "string" ? e.status : "open",
      tasks: epicTasks.map((t) => ({
        id: (t.id as string | null) ?? null,
        title: typeof t.title === "string" ? t.title : "",
        status: typeof t.status === "string" ? t.status : "todo",
        assignee: (t.assignee as string | null) ?? null,
      })),
    });
  }

  const returned = result.length;
  const truncated = offset + returned < total;
  const hint = truncated
    ? "epics truncated; page with --limit/--offset or use 'keeper query epics'"
    : null;

  formatOutput(
    { success: true, epics: result, total, returned, truncated, hint },
    format,
    (d) => renderHuman(d as { epics?: ListEpic[] }),
  );
  return ctx.projectPath;
}

/** The listing `--status` selector. "default" is the open-first composite the
 * shared listing verbs use when no flag is passed. */
export type EpicStatusFilter = "open" | "done" | "all" | "default";

/** Parse a raw `--status` value into the selector: an absent flag (null) is the
 * "default" open-first composite; "open"/"done"/"all" pass through; any other
 * value is an invalid choice the caller reports (returns null). */
export function parseEpicStatusFilter(
  raw: string | null,
): EpicStatusFilter | null {
  if (raw === null) {
    return "default";
  }
  if (raw === "open" || raw === "done" || raw === "all") {
    return raw;
  }
  return null;
}

/** Order + status-filter the full epic set BEFORE paging, shared by the `epics`
 * and `list` verbs. The "default" composite surfaces live work first — open
 * epics ascending by number, then done (any non-open) epics most-recent-first —
 * so a board of hundreds of closed epics never pages the open ones out. "open"
 * / "done" restrict to that section in the same per-section order; "all" is the
 * flat ascending-by-number listing (equal to the historical order, the scripted
 * escape hatch). */
export function orderEpicsForListing(
  epics: Record<string, unknown>[],
  filter: EpicStatusFilter,
): Record<string, unknown>[] {
  if (filter === "all") {
    return [...epics].sort(compareEpics);
  }
  const open = epics.filter(isOpenEpic);
  if (filter === "open") {
    return open.sort(compareEpics);
  }
  const done = epics.filter((e) => !isOpenEpic(e));
  if (filter === "done") {
    return done.sort(compareDoneRecent);
  }
  return [...open.sort(compareEpics), ...done.sort(compareDoneRecent)];
}

/** An epic counts as open when its status is the string "open" or is
 * absent/non-string (a malformed epic stays visible in the open section
 * rather than being buried in history); any other string status falls into
 * the history section. */
function isOpenEpic(e: Record<string, unknown>): boolean {
  return (typeof e.status === "string" ? e.status : "open") === "open";
}

/** Sort done epics newest-first: updated_at descending (its done transition
 * bumps the field), then epic number and id string descending as tiebreakers so
 * the order is a stable total order. */
function compareDoneRecent(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const ua = recencyKey(a);
  const ub = recencyKey(b);
  if (ua !== ub) {
    return ua < ub ? 1 : -1;
  }
  const ka = epicSortKey(a);
  const kb = epicSortKey(b);
  if (ka !== kb) {
    return kb - ka;
  }
  return compareIds(idOf(b), idOf(a));
}

function recencyKey(e: Record<string, unknown>): string {
  return typeof e.updated_at === "string" ? e.updated_at : "";
}

/** Sort epics by epic number (unparseable last), id string as tiebreaker so
 * --offset paging is stable across calls. */
function compareEpics(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const ka = epicSortKey(a);
  const kb = epicSortKey(b);
  if (ka !== kb) {
    return ka - kb;
  }
  return compareIds(idOf(a), idOf(b));
}

/** Sort tasks by ordinal (unparseable last), id string as tiebreaker. */
function compareTasks(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const ka = taskSortKey(a);
  const kb = taskSortKey(b);
  if (ka !== kb) {
    return ka - kb;
  }
  return compareIds(idOf(a), idOf(b));
}

function idOf(x: Record<string, unknown>): string {
  return typeof x.id === "string" ? x.id : "";
}

/** Lexicographic by UTF-16 code unit — matches Array.prototype.sort default. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function epicSortKey(e: Record<string, unknown>): number {
  const [en] = parseId(typeof e.id === "string" ? e.id : "");
  return en ?? 999;
}

function taskSortKey(t: Record<string, unknown>): number {
  const [, tn] = parseId(typeof t.id === "string" ? t.id : "");
  return tn ?? 999;
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
