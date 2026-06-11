/**
 * `keeper dash` view-model — the pure, OpenTUI-free projection layer. One
 * entry point, {@link buildDashModel}, folds a readiness snapshot plus the two
 * autopilot side-streams into a typed `{ header, plan, agents, placeholders }`
 * model where every row is a list of `{ text, role }` SEGMENTS the materializer
 * (task .2) renders verbatim. The role vocabulary lives in `./theme.ts` and is
 * semantic (motion / ready / attention / failed / terminal / accent), never
 * widget-specific — that is the contract the theme fork preserves.
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
import type { Job, SubagentInvocation } from "../types";
import type { Role } from "./theme";

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** One rendered run of text in a single role. The materializer renders the
 * `text` verbatim and colors it via `colorForRole(role)`. */
export interface Segment {
  readonly text: string;
  readonly role: Role;
}

/** A row is an ordered list of role-tagged segments. */
export type Row = readonly Segment[];

/** One epic row in the PLAN region, in server (`sort_path`) order. */
export interface PlanRow {
  readonly epicId: string;
  readonly segments: Row;
}

/** One session row in the AGENTS region. */
export interface AgentRow {
  readonly jobId: string;
  readonly segments: Row;
}

/** The three connection lifecycle states the dash surfaces. */
export type ConnectionState = "connecting" | "live" | "reconnecting";

/** Dim placeholders the materializer paints when a region is empty or the
 * connection has not yet painted. `planEmpty` / `agentsEmpty` are the
 * loaded-but-empty lines; `waiting` is the pre-paint body line shown while
 * connecting / reconnecting (null once live). */
export interface Placeholders {
  readonly planEmpty: Segment;
  readonly agentsEmpty: Segment;
  readonly waiting: Segment | null;
}

/** The complete dash view-model for one frame. */
export interface DashModel {
  readonly header: Row;
  readonly plan: readonly PlanRow[];
  readonly agents: readonly AgentRow[];
  readonly placeholders: Placeholders;
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
 * `armed_epics` wire rows → sorted, de-empty'd list of armed epic ids
 * (`epic_id` ASC) for a stable render. Forked from `cli/autopilot.ts`.
 */
export function projectArmed(rows: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const id = seg(r.epic_id);
    if (id !== "") {
      out.push(id);
    }
  }
  out.sort();
  return out;
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
// PLAN
// ---------------------------------------------------------------------------

/** The verdict a renderer-side map miss resolves to — `[blocked:unknown]`,
 * visible (bug indicator) and inert. Mirrors board's `verdictFromMap`. */
const UNKNOWN_VERDICT: Verdict = {
  tag: "blocked",
  reason: { kind: "unknown" },
};

function verdictFromMap(map: Map<string, Verdict>, id: string): Verdict {
  return map.get(id) ?? UNKNOWN_VERDICT;
}

/** The role a verdict's pill renders in — forked from board's bucket
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

/**
 * The verdict pill's glyph + word. `formatPill` yields `[ready]` /
 * `[completed]` / `[running:<kind>]` / `[blocked:<reason>]`; the inner token
 * (brackets stripped) resolves the glyph via `glyphForToken` (prefix-matched
 * for the `running:` / `blocked:` families), with the token text as fallback.
 */
function verdictPill(v: Verdict): { glyph: string; word: string } {
  const token = formatPill(v).slice(1, -1); // strip the [ ]
  return { glyph: glyphOr(token, "·"), word: token };
}

/**
 * Build the PLAN region — one row per epic in SERVER order (`snapshot.epics`
 * is already `sort_path` ASC; NO client re-sort). Each row carries: an armed
 * marker (accent) when armed; the `epic_number title` label (epic_id fallback
 * when both null); the per-epic verdict glyph + word (map-miss → the visible
 * blocked/unknown form); a blocked reason inline in the terminal/dim role; and
 * an `N/M` completed-task segment counting ONLY `tag==='completed'` verdicts —
 * hidden entirely when the epic has zero tasks.
 */
function buildPlan(
  snapshot: ReadinessClientSnapshot,
  armed: Set<string>,
): PlanRow[] {
  const rows: PlanRow[] = [];
  for (const epic of snapshot.epics) {
    const epicId = seg(epic.epic_id);
    const out: Segment[] = [];

    // Armed marker first (accent) so it reads as a leading structural signal.
    if (armed.has(epicId)) {
      out.push({ text: `${glyphOr("armed", "*")} `, role: "accent" });
    }

    // Label: `epic_number title`, epic_id fallback when both null.
    const numSeg = epic.epic_number == null ? "" : String(epic.epic_number);
    const titleSeg = epic.title == null ? "" : epic.title;
    const label = `${numSeg} ${titleSeg}`.trim();
    out.push({ text: label === "" ? epicId : label, role: "accent" });

    // Per-epic verdict glyph + word.
    const verdict = verdictFromMap(snapshot.readiness.perEpic, epicId);
    const role = roleForVerdict(verdict);
    const { glyph, word } = verdictPill(verdict);
    out.push({ text: "  ", role: "terminal" });
    out.push({ text: `${glyph} ${word}`, role });

    // N/M completed-only — hidden when the epic has zero tasks. M counts ONLY
    // `tag==='completed'` perTask verdicts (a miss is NOT done).
    const tasks = epic.tasks;
    if (tasks.length > 0) {
      let completed = 0;
      for (const task of tasks) {
        const tv = snapshot.readiness.perTask.get(seg(task.task_id));
        if (tv?.tag === "completed") {
          completed += 1;
        }
      }
      out.push({
        text: `  ${completed}/${tasks.length}`,
        role: completed === tasks.length ? "ready" : "terminal",
      });
    }

    rows.push({ epicId, segments: out });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// AGENTS
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

/** Compact fixed-width elapsed band, floored to the largest unit, no "ago":
 * `<60s` → `Ns`, `<60m` → `Nm`, `<24h` → `Nh`, else `Nd`. Negative/NaN
 * clamps to `0s`. */
function elapsedBand(deltaSec: number): string {
  const d =
    Number.isFinite(deltaSec) && deltaSec > 0 ? Math.floor(deltaSec) : 0;
  if (d < 60) {
    return `${d}s`;
  }
  if (d < 3600) {
    return `${Math.floor(d / 60)}m`;
  }
  if (d < 86400) {
    return `${Math.floor(d / 3600)}h`;
  }
  return `${Math.floor(d / 86400)}d`;
}

/**
 * Build the AGENTS region — EVERY non-terminal job (working AND stopped) on one
 * unified "most-recent-activity-started" timeline. The collections
 * `defaultFilter` already excludes `ended`/`killed`, so every job in
 * `snapshot.jobs` is included; needs-you no longer affects ordering (its
 * annotation still renders, only re-positioned).
 *
 * Sort: `COALESCE(active_since, created_at)` DESC with a `job_id` ASC tiebreak
 * — a job rises the moment it starts a run and descends as newer runs start
 * above it, jumping back to the top on a genuine restart. A never-prompted job
 * (`active_since` NULL) sorts by `created_at`. The null guard is explicit so a
 * JS `null` never coerces to `0`.
 *
 * Each row's leading glyph is the per-job rolled-up board verdict
 * ({@link rolledUpJobVerdict}: working→sync, sub-agent→cogs/warn,
 * monitor→eye/warn, idle→circleO), computed uniformly for plan-linked and
 * ad-hoc jobs and rendered via the same `verdictPill`/`roleForVerdict`
 * machinery as the PLAN region. The trailing annotation — the elapsed band
 * (from `updated_at` vs `nowSec`) REPLACED by an `awaiting` (attention) /
 * `failed` (failed) annotation — is unchanged (annotation only, no sort effect).
 */
function buildAgents(
  snapshot: ReadinessClientSnapshot,
  nowSec: number,
): AgentRow[] {
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

  const rows: AgentRow[] = [];
  for (const job of jobs) {
    const out: Segment[] = [];

    // Leading glyph: the per-job rolled-up verdict → pill glyph, colored by the
    // verdict's role. An idle job (null verdict) renders the `stopped` glyph in
    // the terminal/dim role.
    const verdict = rolledUpJobVerdict(job, subRunningByJobId, nowSec);
    if (verdict === null) {
      out.push({ text: `${glyphOr("stopped", "○")} `, role: "terminal" });
    } else {
      const { glyph } = verdictPill(verdict);
      out.push({ text: `${glyph} `, role: roleForVerdict(verdict) });
    }
    out.push({ text: jobLabel(job), role: "accent" });

    // Trailing annotation: awaiting / failed REPLACE the elapsed band.
    out.push({ text: "  ", role: "terminal" });
    if (job.last_api_error_at != null) {
      out.push({ text: "failed", role: "failed" });
    } else if (
      job.last_input_request_at != null ||
      job.last_permission_prompt_at != null
    ) {
      out.push({ text: "awaiting", role: "attention" });
    } else {
      out.push({
        text: elapsedBand(nowSec - job.updated_at),
        role: "terminal",
      });
    }

    rows.push({ jobId: job.job_id, segments: out });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the complete dash view-model for one frame. A `null` snapshot
 * (connecting, no paint yet) yields empty PLAN / AGENTS and the `waiting`
 * placeholder body line; the header still renders off the autopilot seed +
 * side-streams. Once a snapshot lands, loaded-but-empty regions render the dim
 * `no open epics` / `no agents` placeholders (distinguishable from the
 * connecting `waiting` line).
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

  const plan = snapshot === null ? [] : buildPlan(snapshot, armedSet);
  const agents = snapshot === null ? [] : buildAgents(snapshot, nowSec);

  const placeholders: Placeholders = {
    planEmpty: { text: "no open epics", role: "terminal" },
    agentsEmpty: { text: "no agents", role: "terminal" },
    waiting:
      snapshot === null
        ? { text: "waiting for keeperd…", role: "terminal" }
        : null,
  };

  return { header, plan, agents, placeholders };
}
