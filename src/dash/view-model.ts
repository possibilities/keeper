/**
 * `keeper dash` view-model — the pure, OpenTUI-free projection layer. One
 * entry point, {@link buildDashModel}, folds a readiness snapshot plus the two
 * autopilot side-streams into a typed `{ header, body }` model: the header is
 * a single segment row; the body is an ORDERED list of keyed rows — split
 * (left/right content) and dividers — the materializer renders verbatim. The
 * role vocabulary lives in `./theme.ts` and is semantic
 * (motion / ready / attention / failed / terminal / accent / heading / text),
 * never widget-specific — that is the contract the theme fork preserves.
 *
 * Visual language: every line leads with its status GLYPH (color = verdict
 * role); titles carry the workability axis — `heading`/`text` (default fg)
 * when workable now, `terminal` (dim) when completed or blocked — so state
 * reads at a glance with no pill words. Metadata (dep refs, project name,
 * needs-eyes glyphs) right-aligns on the split rows.
 *
 * Forked, not shared: the three tiny autopilot projectors
 * (`projectAutopilotPaused` / `projectAutopilotMode` / `projectArmedEpics`)
 * are re-implemented here because `src/` must never import from `cli/`. Glyphs
 * resolve through `glyphForToken` / `FA_CLASSIC` (imported as-is) with a text
 * fallback when a token has no themed glyph.
 *
 * Pure — no I/O, no wall-clock (the caller injects `nowSec`), no `@opentui`
 * import anywhere in this file. That last property is load-bearing: it keeps
 * `test/dash-view-model.test.ts` on the fast tier.
 */

import { FA_CLASSIC, glyphForToken } from "../icon-theme";
import { formatPill, rolledUpJobVerdict, type Verdict } from "../readiness";
import type { ReadinessClientSnapshot } from "../readiness-client";
import type { Epic, Job, SubagentInvocation, Task } from "../types";
import type { Role } from "./theme";

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** One rendered run of text in a single role. The materializer renders the
 * `text` verbatim and styles it via `colorForRole(role)`. */
export interface Segment {
  readonly text: string;
  readonly role: Role;
}

/** A row is an ordered list of role-tagged segments. */
export type Row = readonly Segment[];

/** A content line: `left` hugs the left edge, `right` right-aligns on the
 * same line (metadata — dep refs, project, needs-eyes glyphs). `indent` is
 * extra left padding in columns (task rows nest under their epic). */
export interface SplitRow {
  readonly kind: "split";
  readonly key: string;
  readonly left: Row;
  readonly right: Row;
  readonly indent?: number;
}

/** A full-width rule separating epic blocks and the jobs region. */
export interface DividerRow {
  readonly kind: "divider";
  readonly key: string;
}

/** One keyed body row. Keys are stable across frames (`epic:<id>`,
 * `epic:<id>:task:<tid>`, `job:<id>`, `div:*`, `ph:*`) so the materializer
 * diffs content in place and only restructures when the keyed order changes.
 * A key never changes kind. */
export type DashBodyRow = SplitRow | DividerRow;

/** The three connection lifecycle states the dash surfaces. */
export type ConnectionState = "connecting" | "live" | "reconnecting";

/** The complete dash view-model for one frame. */
export interface DashModel {
  readonly header: Row;
  readonly body: readonly DashBodyRow[];
}

/** Inputs to {@link buildDashModel}. `autopilotRows` / `armedRows` are the raw
 * `autopilot_state` / `armed_epics` wire rows the readiness conn does NOT
 * expose on its snapshot, so the caller subscribes them separately. */
export interface DashModelInput {
  readonly snapshot: ReadinessClientSnapshot | null;
  readonly autopilotRows: Record<string, unknown>[];
  readonly armedRows: Record<string, unknown>[];
  readonly connection: ConnectionState;
  readonly nowSec: number;
}

// ---------------------------------------------------------------------------
// Coercion helpers (local — readiness/view layer never throws on a wire field)
// ---------------------------------------------------------------------------

/** Coerce an unknown wire scalar to a trimmed string; non-strings → "". */
function seg(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Resolve a themed glyph for a token, or fall back to `fallback` text when the
 * token has no glyph in `FA_CLASSIC`. Mirrors the board renderer's null-guard
 * around `glyphForToken`.
 */
function glyphOr(token: string, fallback: string): string {
  return glyphForToken(token, FA_CLASSIC) ?? fallback;
}

// ---------------------------------------------------------------------------
// Forked autopilot projectors (src/ must not import from cli/)
// ---------------------------------------------------------------------------

/**
 * `autopilot_state.paused` (INTEGER 1=paused, 0=playing) → boolean. Empty row
 * set (singleton not yet folded) returns `null` so the caller keeps the seed;
 * a non-0/1 value falls back to `true` (the safer boot-default side). Forked
 * from `cli/autopilot.ts` `projectAutopilotPaused`.
 */
export function projectPaused(rows: Record<string, unknown>[]): boolean | null {
  if (rows.length === 0) {
    return null;
  }
  const raw = rows[0]?.paused;
  if (typeof raw !== "number") {
    return true;
  }
  return raw !== 0;
}

/**
 * `autopilot_state.mode` (TEXT) → `'yolo' | 'armed'`. Empty row set returns
 * `null` (keep the seed); any non-`'armed'` value falls back to `'yolo'` (the
 * backward-compatible default). Forked from `cli/autopilot.ts`.
 */
export function projectMode(
  rows: Record<string, unknown>[],
): "yolo" | "armed" | null {
  if (rows.length === 0) {
    return null;
  }
  return rows[0]?.mode === "armed" ? "armed" : "yolo";
}

/**
 * `armed_epics` rows → sorted epic-id list (`epic_id` ASC) for a stable
 * render. Forked from `cli/autopilot.ts`.
 */
export function projectArmed(rows: Record<string, unknown>[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    const id = seg(row.epic_id);
    if (id !== "") {
      ids.push(id);
    }
  }
  ids.sort();
  return ids;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * Build the header strip: the play/pause + mode + armed-count autopilot
 * banner, the connection marker (only when not live), and the dead-letter
 * segment (only when the backlog is non-empty). Mirrors
 * `autopilotBannerLabel`: seed state before the `autopilot_state` first edge
 * is `paused=true` / `mode='yolo'`; the empty-armed-in-armed-mode case renders
 * the distinct `nothing armed` callout so idle-by-design never reads as a bug.
 */
function buildHeader(
  paused: boolean,
  mode: "yolo" | "armed",
  armed: string[],
  deadLetterCount: number,
  connection: ConnectionState,
): Row {
  const out: Segment[] = [];

  // Play/pause pill — motion when playing (live), terminal/dim when paused.
  const pausedGlyph = glyphOr("rt:blocked", "||");
  const playingGlyph = glyphOr("ready", ">");
  out.push(
    paused
      ? { text: `${pausedGlyph} autopilot`, role: "terminal" }
      : { text: `${playingGlyph} autopilot`, role: "motion" },
  );

  out.push({ text: " · ", role: "terminal" });
  out.push({ text: mode, role: "accent" });

  // Armed-count suffix — only in armed mode; the empty set renders the
  // distinct `nothing armed` callout (mirrors the banner).
  if (mode === "armed") {
    out.push({ text: " · ", role: "terminal" });
    out.push(
      armed.length === 0
        ? { text: "nothing armed", role: "attention" }
        : { text: `${armed.length} armed`, role: "accent" },
    );
  }

  // Dead-letter segment — only when the backlog is non-empty.
  if (deadLetterCount > 0) {
    out.push({ text: " · ", role: "terminal" });
    out.push({
      text: `${glyphOr("dead-letter:", "!")} ${deadLetterCount} dead-letter`,
      role: "attention",
    });
  }

  // Connection marker — only when not live (live needs no marker).
  if (connection !== "live") {
    out.push({ text: " · ", role: "terminal" });
    out.push({
      text: connection === "connecting" ? "connecting…" : "reconnecting…",
      role: "attention",
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Verdict styling
// ---------------------------------------------------------------------------

/** The verdict a renderer-side map miss resolves to — blocked/unknown,
 * visible (bug indicator) and inert. Mirrors board's `verdictFromMap`. */
const UNKNOWN_VERDICT: Verdict = {
  tag: "blocked",
  reason: { kind: "unknown" },
};

function verdictFromMap(map: Map<string, Verdict>, id: string): Verdict {
  return map.get(id) ?? UNKNOWN_VERDICT;
}

/** The role a verdict's glyph renders in — forked from board's bucket
 * semantics: completed → terminal (inert tail), ready/running → ready/motion,
 * blocked → attention. */
function roleForVerdict(v: Verdict): Role {
  switch (v.tag) {
    case "completed":
      return "terminal";
    case "ready":
      return "ready";
    case "running":
      return "motion";
    case "blocked":
      return "attention";
  }
}

/** The verdict's status glyph. `formatPill` yields `[ready]` / `[completed]`
 * / `[running:<kind>]` / `[blocked:<reason>]`; the inner token (brackets
 * stripped) resolves the glyph via `glyphForToken` (prefix-matched for the
 * `running:` / `blocked:` families). Glyph ONLY — the word never renders; the
 * glyph + its role color carry the state. */
function verdictGlyph(v: Verdict): string {
  const token = formatPill(v).slice(1, -1); // strip the [ ]
  return glyphOr(token, "·");
}

/** The title role on the workability axis: workable now (ready / running) →
 * full-intensity `epicTitle` ? `heading` : `text`; inert (completed /
 * blocked) → the dim `terminal` tone so the whole line recedes. */
function titleRole(v: Verdict, epicTitle: boolean): Role {
  if (v.tag === "ready" || v.tag === "running") {
    return epicTitle ? "heading" : "text";
  }
  return "terminal";
}

// ---------------------------------------------------------------------------
// EPICS
// ---------------------------------------------------------------------------

/** Trailing `.N` task-number from a planctl task id (`fn-812-slug.3` → `3`),
 * or `null` when the id has no numeric tail. */
function taskNumFromDep(id: string): string | null {
  const m = /\.(\d+)$/.exec(id);
  return m === null ? null : (m[1] ?? null);
}

/** Leading epic number from a planctl epic id (`fn-631-slug` or bare
 * `fn-631`), or `null` when the token doesn't match. */
function epicNumFromDep(token: string): string | null {
  const m = /^[a-z][a-z0-9]*-(\d+)(?:-|$)/.exec(token);
  return m === null ? null : (m[1] ?? null);
}

/**
 * The epic's dep-ref segments — a dim `after` lead then one ref per
 * `depends_on_epics` token. Prefers the reducer's `resolved_epic_deps`
 * projection (epic numbers + cross-project basenames + per-dep state);
 * falls back to parsing the raw tokens when the projection is null
 * (not-yet-computed). Per-ref role carries the dep's weight: satisfied →
 * dim (history), blocked-incomplete → attention (the live gate), dangling →
 * failed (a typo to fix). Empty array when the epic has no deps.
 */
function epicDepSegments(epic: Epic): Segment[] {
  const resolved = epic.resolved_epic_deps;
  const refs: { label: string; role: Role }[] = [];
  if (resolved !== null) {
    for (const dep of resolved) {
      const num = dep.epic_number;
      if (num === null) {
        refs.push({ label: `?${dep.dep_token}`, role: "failed" });
        continue;
      }
      const label =
        dep.cross_project && dep.project_basename !== null
          ? `${dep.project_basename}#${num}`
          : `#${num}`;
      refs.push({
        label,
        role: dep.state === "blocked-incomplete" ? "attention" : "terminal",
      });
    }
  } else {
    for (const token of epic.depends_on_epics) {
      const num = epicNumFromDep(token);
      refs.push({
        label: num === null ? `?${token}` : `#${num}`,
        role: "terminal",
      });
    }
  }
  if (refs.length === 0) {
    return [];
  }
  const out: Segment[] = [{ text: "after ", role: "terminal" }];
  refs.forEach((ref, i) => {
    if (i > 0) {
      out.push({ text: " ", role: "terminal" });
    }
    out.push({ text: ref.label, role: ref.role });
  });
  return out;
}

/**
 * The task's dep-ref segments — dim `after` then the dep task NUMBERS, each
 * colored by the dep's own perTask verdict: completed → dim (satisfied),
 * anything else → attention (still gating). A dep id with no parseable
 * number renders its raw tail so the ref never silently disappears.
 */
function taskDepSegments(task: Task, perTask: Map<string, Verdict>): Segment[] {
  if (task.depends_on.length === 0) {
    return [];
  }
  const out: Segment[] = [{ text: "after ", role: "terminal" }];
  task.depends_on.forEach((depId, i) => {
    if (i > 0) {
      out.push({ text: " ", role: "terminal" });
    }
    const num = taskNumFromDep(depId);
    const done = perTask.get(depId)?.tag === "completed";
    out.push({
      text: num === null ? depId : num,
      role: done ? "terminal" : "attention",
    });
  });
  return out;
}

/** Stable task order: `task_number` ASC nulls-last, `task_id` ASC tiebreak. */
function sortedTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const na = a.task_number;
    const nb = b.task_number;
    if (na !== nb) {
      if (na === null) {
        return 1;
      }
      if (nb === null) {
        return -1;
      }
      return na - nb;
    }
    return a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0;
  });
}

/** Basename of a project dir path, or "" when null/empty. */
function projectBasename(dir: string | null): string {
  if (dir === null || dir === "") {
    return "";
  }
  const trimmed = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Build the epic rows — one block per epic in SERVER order (`snapshot.epics`
 * is already `sort_path` ASC; NO client re-sort), blocks separated by a
 * divider keyed on the epic ABOVE it (stable as epics append below).
 *
 * Epic header row: leading verdict glyph (role-colored); the armed bolt
 * (accent) ONLY in armed mode for an armed epic; the dim epic number; the
 * title on the workability axis (bold default-fg `heading` when workable,
 * dim when inert); right side = dep refs then the dim project basename.
 *
 * Task rows: indented under the epic, leading perTask verdict glyph (map
 * miss → the visible blocked/unknown form), dim task number, title on the
 * same workability axis (`text` tier), right side = task dep refs.
 */
function buildEpicRows(
  snapshot: ReadinessClientSnapshot,
  armed: Set<string>,
  mode: "yolo" | "armed",
): DashBodyRow[] {
  const out: DashBodyRow[] = [];
  snapshot.epics.forEach((epic, i) => {
    const epicId = seg(epic.epic_id);
    if (i > 0) {
      const prev = seg(snapshot.epics[i - 1]?.epic_id);
      out.push({ kind: "divider", key: `div:${prev}` });
    }

    const verdict = verdictFromMap(snapshot.readiness.perEpic, epicId);
    const left: Segment[] = [
      { text: `${verdictGlyph(verdict)}  `, role: roleForVerdict(verdict) },
    ];

    // Armed bolt — armed mode only; in yolo the armed set is not dispatch
    // policy, so the marker would lie about behavior.
    if (mode === "armed" && armed.has(epicId)) {
      left.push({ text: `${glyphOr("armed", "*")} `, role: "accent" });
    }

    if (epic.epic_number !== null) {
      left.push({ text: `${epic.epic_number}  `, role: "terminal" });
    }
    const title = epic.title ?? "";
    left.push({
      text: title === "" && epic.epic_number === null ? epicId : title,
      role: titleRole(verdict, true),
    });

    const right: Segment[] = epicDepSegments(epic);
    const project = projectBasename(epic.project_dir);
    if (project !== "") {
      if (right.length > 0) {
        right.push({ text: " · ", role: "terminal" });
      }
      right.push({ text: project, role: "terminal" });
    }

    out.push({ kind: "split", key: `epic:${epicId}`, left, right });

    for (const task of sortedTasks(epic.tasks)) {
      const taskId = seg(task.task_id);
      const tv = verdictFromMap(snapshot.readiness.perTask, taskId);
      const tleft: Segment[] = [
        { text: `${verdictGlyph(tv)}  `, role: roleForVerdict(tv) },
      ];
      if (task.task_number !== null) {
        tleft.push({ text: `${task.task_number}  `, role: "terminal" });
      }
      const ttitle = task.title ?? "";
      tleft.push({
        text: ttitle === "" ? taskId : ttitle,
        role: titleRole(tv, false),
      });
      out.push({
        kind: "split",
        key: `epic:${epicId}:task:${taskId}`,
        left: tleft,
        right: taskDepSegments(task, snapshot.readiness.perTask),
        indent: 4,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// JOBS
// ---------------------------------------------------------------------------

/**
 * The job's label, coalescing `title → plan_ref → job_id` so a needs-you row
 * is NEVER blank (and never dropped for a missing title/plan_ref).
 */
function jobLabel(job: Job): string {
  const title = seg(job.title);
  if (title !== "") {
    return title;
  }
  const planRef = seg(job.plan_ref);
  if (planRef !== "") {
    return planRef;
  }
  return job.job_id;
}

/**
 * Build the JOBS rows — EVERY non-terminal job (working AND stopped) on one
 * unified "most-recent-activity-started" timeline. The collections
 * `defaultFilter` already excludes `ended`/`killed`, so every job in
 * `snapshot.jobs` is included.
 *
 * Sort: `COALESCE(active_since, created_at)` DESC with a `job_id` ASC tiebreak
 * — a job rises the moment it starts a run and descends as newer runs start
 * above it, jumping back to the top on a genuine restart. A never-prompted job
 * (`active_since` NULL) sorts by `created_at`. The null guard is explicit so a
 * JS `null` never coerces to `0`.
 *
 * Each row's leading glyph is the per-job rolled-up board verdict
 * ({@link rolledUpJobVerdict}: working→sync, sub-agent→cogs/warn,
 * monitor→eye/warn, idle→circleO); the label rides the workability axis (live
 * → `text`, idle → dim). The right side is the dim project basename (from the
 * job's `cwd`), LED by a needs-eyes glyph when one applies: failed (red ✗) or
 * awaiting-input (attention hand/comment, keyed by which prompt field is set)
 * — glyphs only, no words.
 */
function buildJobRows(
  snapshot: ReadinessClientSnapshot,
  nowSec: number,
): DashBodyRow[] {
  // Running-subagent index, built the SAME way readiness does: filter to
  // `status === "running"` (the only status that signals live motion).
  const subRunningByJobId = new Map<string, SubagentInvocation[]>();
  for (const inv of snapshot.subagentInvocations) {
    if (inv.status !== "running") {
      continue;
    }
    const arr = subRunningByJobId.get(inv.job_id);
    if (arr === undefined) {
      subRunningByJobId.set(inv.job_id, [inv]);
    } else {
      arr.push(inv);
    }
  }

  const jobs = Array.from(snapshot.jobs.values());

  // Unified timeline: COALESCE(active_since, created_at) DESC, job_id ASC
  // tiebreak. Guard the NULL explicitly so it falls back to created_at rather
  // than coercing to 0.
  jobs.sort((a, b) => {
    const ka = a.active_since ?? a.created_at;
    const kb = b.active_since ?? b.created_at;
    if (ka !== kb) {
      return kb - ka; // DESC
    }
    return a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0;
  });

  const rows: DashBodyRow[] = [];
  for (const job of jobs) {
    const left: Segment[] = [];

    // Leading glyph: the per-job rolled-up verdict, colored by the verdict's
    // role. An idle job (null verdict) renders the `stopped` glyph dim.
    const verdict = rolledUpJobVerdict(job, subRunningByJobId, nowSec);
    if (verdict === null) {
      left.push({ text: `${glyphOr("stopped", "○")}  `, role: "terminal" });
      left.push({ text: jobLabel(job), role: "terminal" });
    } else {
      left.push({
        text: `${verdictGlyph(verdict)}  `,
        role: roleForVerdict(verdict),
      });
      left.push({ text: jobLabel(job), role: "text" });
    }

    // Right side: needs-eyes glyph (failed / awaiting) then the dim project.
    const right: Segment[] = [];
    if (job.last_api_error_at != null) {
      right.push({ text: glyphOr("failed", "x"), role: "failed" });
    } else if (job.last_permission_prompt_at != null) {
      right.push({
        text: glyphOr("awaiting:permission", "?"),
        role: "attention",
      });
    } else if (job.last_input_request_at != null) {
      right.push({
        text: glyphOr("awaiting:ask_user_question", "?"),
        role: "attention",
      });
    }
    const project = projectBasename(seg(job.cwd) || null);
    if (project !== "") {
      if (right.length > 0) {
        right.push({ text: " · ", role: "terminal" });
      }
      right.push({ text: project, role: "terminal" });
    }

    rows.push({ kind: "split", key: `job:${job.job_id}`, left, right });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the complete dash view-model for one frame. A `null` snapshot
 * (connecting, no paint yet) yields a body of just the dim `waiting for
 * keeperd…` line; the header still renders off the autopilot seed +
 * side-streams. Once a snapshot lands, the body is the epic blocks then the
 * job rows, divider-separated — no section labels, no empty-state lines: an
 * empty region simply renders nothing.
 */
export function buildDashModel(input: DashModelInput): DashModel {
  const { snapshot, autopilotRows, armedRows, connection, nowSec } = input;

  // Autopilot header state — seed (paused / yolo) until the first edge lands.
  const paused = projectPaused(autopilotRows) ?? true;
  const mode = projectMode(autopilotRows) ?? "yolo";
  const armed = projectArmed(armedRows);
  const armedSet = new Set(armed);

  const deadLetterCount = snapshot?.deadLetters.length ?? 0;
  const header = buildHeader(paused, mode, armed, deadLetterCount, connection);

  if (snapshot === null) {
    return {
      header,
      body: [
        {
          kind: "split",
          key: "ph:waiting",
          left: [{ text: "waiting for keeperd…", role: "terminal" }],
          right: [],
        },
      ],
    };
  }

  const body: DashBodyRow[] = [...buildEpicRows(snapshot, armedSet, mode)];
  const jobRows = buildJobRows(snapshot, nowSec);
  // One divider fences the jobs region off the last epic block — only when
  // both regions have rows (a lone region needs no fence).
  if (body.length > 0 && jobRows.length > 0) {
    body.push({ kind: "divider", key: "div:jobs" });
  }
  body.push(...jobRows);

  return { header, body };
}
