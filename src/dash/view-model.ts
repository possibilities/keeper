/**
 * `keeper dash` view-model — the pure, OpenTUI-free projection layer for the
 * robot job-card screen. One entry point, {@link buildDashModel}, folds the
 * live `jobs` projection plus the flat running-subagent stream into a typed
 * `{ bands }` CARD model the OpenTUI paint layer (`./app.ts`) consumes: three
 * urgency BANDS, each an ordered list of keyed {@link CardVM} cards (one per
 * job).
 *
 * Status is DUAL-ENCODED per card: a Nerd Font md-robot face ({@link robotGlyph})
 * plus a colored left rail ({@link CardVM.railRole}), both resolved fresh from
 * the six-rung ladder in {@link robotRung} — annotation columns (api-error,
 * awaiting permission/input) outrank the base `state`. The robot codepoints live
 * in a DASH-LOCAL map ({@link ROBOT_CP}); the shared `ACTIVE_THEME` / `FA_CLASSIC`
 * (the board/jobs `fa-classic` glyphs) are untouched.
 *
 * Cards group into three bands — needs-you (api-error|awaiting) / in-motion
 * (working) / idle (stopped|ended|killed) — stable `created_at` ASC within a
 * band (`job_id` tiebreak) so a live card never teleports on a metadata tick.
 * Ended/killed cards are terminal and hidden unless `showTerminal` is set.
 *
 * Pure — no I/O, no wall-clock (the caller injects `nowSec`), no `@opentui`
 * import anywhere in this file. That last property is load-bearing: it keeps
 * `test/dash-view-model.test.ts` on the fast tier.
 */

import { planVerbLabel } from "../board-render";
import type { Job, SubagentInvocation } from "../types";
import type { RailRole } from "./theme";

// ---------------------------------------------------------------------------
// Status ladder — the six robot rungs
// ---------------------------------------------------------------------------

/**
 * The six rungs of the robot status ladder, in precedence order. Annotation
 * rungs (`error`, `awaiting`) outrank the base-state rungs (`working`, `ended`,
 * `stopped`, `killed`) so a working-but-blocked job reads as blocked, never as
 * quietly running. A malformed/unknown `state` folds to `stopped` (the calm
 * gray idle default — never thrown).
 */
export type RobotRung =
  | "error"
  | "awaiting"
  | "working"
  | "ended"
  | "stopped"
  | "killed";

/**
 * Dash-LOCAL md-robot codepoints (Nerd Font MDI), one per rung. Verified
 * present in the user's JetBrainsMono Nerd Font (nerd-fonts `i_md.sh`). Kept
 * here, NOT in `icon-theme.ts`'s `FA_CLASSIC` / `ACTIVE_THEME`, so the board and
 * `keeper jobs` views keep their `fa-classic` glyph map untouched.
 */
const ROBOT_CP: Record<RobotRung, string> = {
  error: "f169d", // robot_angry
  awaiting: "f169f", // robot_confused
  working: "f06a9", // robot
  ended: "f1719", // robot_happy
  stopped: "f167a", // robot_outline
  killed: "f16a1", // robot_dead
};

/** The rail role each rung paints. Mirrors the ladder's color column. */
const RUNG_RAIL: Record<RobotRung, RailRole> = {
  error: "error",
  awaiting: "awaiting",
  working: "working",
  ended: "idle-ended",
  stopped: "idle-stopped",
  killed: "idle-killed",
};

/** The status WORD each rung surfaces (the screen reads the glyph + rail; the
 * word is the accessible/label fallback the paint layer may place in a tooltip
 * or census). */
const RUNG_WORD: Record<RobotRung, string> = {
  error: "error",
  awaiting: "awaiting",
  working: "working",
  ended: "ended",
  stopped: "stopped",
  killed: "killed",
};

/**
 * Materialize a hex codepoint string (e.g. `"f169d"`) to its glyph. Mirrors
 * `icon-theme.ts`'s `cp` — `String.fromCodePoint(parseInt(hex, 16))` already
 * handles the 5-digit MDI codepoints.
 */
function cp(hex: string): string {
  return String.fromCodePoint(Number.parseInt(hex, 16));
}

/** The robot glyph for a rung (dash-local map). Pure. */
export function robotGlyph(rung: RobotRung): string {
  return cp(ROBOT_CP[rung]);
}

/**
 * Derive a job's status rung FRESH from `state` + the annotation columns,
 * mirroring the precedence the legacy `buildJobRows` encoded and `keeper jobs`
 * surfaces: ended/killed → api-error → awaiting (permission OR input) →
 * working → stopped. An unknown/malformed `state` folds to `stopped` (calm idle)
 * — never throws. Deliberately NOT `rolledUpJobVerdict`, which only emits
 * running/null and cannot express the six rungs.
 */
export function robotRung(job: Job): RobotRung {
  // Terminal state wins over a stale annotation stamp: the reducer's
  // SessionEnd/Killed transitions never clear last_*_at, so a job that died
  // mid-block keeps its stamp. Resolve ended/killed first so such a job is
  // painted terminal (idle band, hidden by showTerminal) rather than pinned
  // in needs-you forever.
  if (job.state === "ended") {
    return "ended";
  }
  if (job.state === "killed") {
    return "killed";
  }
  if (job.last_api_error_at != null) {
    return "error";
  }
  if (
    job.last_permission_prompt_at != null ||
    job.last_input_request_at != null
  ) {
    return "awaiting";
  }
  switch (job.state) {
    case "working":
      return "working";
    case "stopped":
      return "stopped";
    default:
      return "stopped";
  }
}

/** A rung is terminal when it represents a finished session — ended or killed.
 * Terminal cards are hidden unless `showTerminal` is set. */
function isTerminalRung(rung: RobotRung): boolean {
  return rung === "ended" || rung === "killed";
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/** The three urgency bands, in render order. */
export type BandKey = "needs-you" | "in-motion" | "idle";

/** The band a rung sorts into: error/awaiting → needs-you, working → in-motion,
 * the three idle/terminal rungs → idle. */
function bandForRung(rung: RobotRung): BandKey {
  switch (rung) {
    case "error":
    case "awaiting":
      return "needs-you";
    case "working":
      return "in-motion";
    case "ended":
    case "stopped":
    case "killed":
      return "idle";
  }
}

/** The human band titles the paint layer rules off. */
const BAND_TITLES: Record<BandKey, string> = {
  "needs-you": "needs you",
  "in-motion": "in motion",
  idle: "idle",
};

/** Band render order — needs-you first (the few cards that must pop), idle last
 * (the calm tail). */
const BAND_ORDER: readonly BandKey[] = ["needs-you", "in-motion", "idle"];

// ---------------------------------------------------------------------------
// Output shapes — the contract the OpenTUI paint layer (`./app.ts`) consumes
// ---------------------------------------------------------------------------

/**
 * One job card. `key` (`job:<id>`) is stable across frames so the paint layer
 * mutates a single BoxRenderable per job in place (never add/remove per frame).
 * `robotGlyph` + `railRole` dual-encode status; the border is always
 * structure-gray (the project name in it inherits border color — status lives
 * only in the rail). `isFocused` is always false here — the paint layer
 * (`./app.ts`) owns the live `j`/`k` cursor (keyed on `job_id`), so the model
 * carries the field for shape stability but never sets it. `isTerminal` flags an
 * ended/killed card (only present when `showTerminal` reveals them).
 */
export interface CardVM {
  readonly key: string;
  readonly project: string;
  readonly title: string;
  readonly robotGlyph: string;
  readonly railRole: RailRole;
  readonly statusWord: string;
  readonly roleLabel: string;
  readonly subagentCount: number;
  readonly ageLabel: string;
  readonly sessionLabel: string;
  readonly isFocused: boolean;
  readonly isTerminal: boolean;
}

/** One urgency band: a keyed, titled, ordered run of cards. An empty band emits
 * an empty `cards` array (the paint layer collapses it — no rule). */
export interface Band {
  readonly key: BandKey;
  readonly title: string;
  readonly cards: readonly CardVM[];
}

/** The complete dash card model for one frame. */
export interface DashModel {
  readonly bands: readonly Band[];
}

// ---------------------------------------------------------------------------
// Field helpers
// ---------------------------------------------------------------------------

/** Coerce an unknown scalar to a string; non-strings → "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Strip ESC (`\x1b`) from an untrusted socket string before it enters the
 * model — OSC/DCS injection guard for `title` / `project`. */
function sanitize(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ESC is the point.
  return s.replace(/\x1b/g, "");
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
 * The job's label, coalescing `title → plan_ref → job_id` so a card is NEVER
 * blank (and never dropped for a missing title/plan_ref).
 */
function jobLabel(job: Job): string {
  const title = str(job.title);
  if (title !== "") {
    return title;
  }
  const planRef = str(job.plan_ref);
  if (planRef !== "") {
    return planRef;
  }
  return job.job_id;
}

/** A coarse age label from `created_at` vs the injected `nowSec` — seconds /
 * minutes / hours / days, clamped at zero. Pure (no `Date.now()`). */
function ageLabel(createdAt: number, nowSec: number): string {
  const delta = Math.max(0, Math.floor(nowSec - createdAt));
  if (delta < 60) {
    return `${delta}s`;
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)}m`;
  }
  if (delta < 86_400) {
    return `${Math.floor(delta / 3600)}h`;
  }
  return `${Math.floor(delta / 86_400)}d`;
}

/** The session label from the backend coords — `<session>` or `<session>:<pane>`
 * when both are set, "" when neither is. */
function sessionLabel(job: Job): string {
  const session = str(job.backend_exec_session_id);
  const pane = str(job.backend_exec_pane_id);
  if (session === "") {
    return pane === "" ? "" : pane;
  }
  return pane === "" ? session : `${session}:${pane}`;
}

/** Running-subagent count per job, grouping the FLAT invocation stream on
 * `job_id` filtered to `status === "running"` (the only status that signals
 * live motion — the same filter readiness uses). */
function runningSubByJob(
  subagents: readonly SubagentInvocation[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const inv of subagents) {
    if (inv.status !== "running") {
      continue;
    }
    counts.set(inv.job_id, (counts.get(inv.job_id) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Card build
// ---------------------------------------------------------------------------

/** Build one card from a job. Pure — every wall-clock-derived field rides the
 * injected `nowSec`. */
function buildCard(
  job: Job,
  rung: RobotRung,
  subCount: number,
  nowSec: number,
): CardVM {
  return {
    key: `job:${job.job_id}`,
    project: sanitize(projectBasename(str(job.cwd) || null)),
    title: sanitize(jobLabel(job)),
    robotGlyph: robotGlyph(rung),
    railRole: RUNG_RAIL[rung],
    statusWord: RUNG_WORD[rung],
    roleLabel: planVerbLabel(job.plan_verb) ?? "",
    subagentCount: subCount,
    ageLabel: ageLabel(job.created_at, nowSec),
    sessionLabel: sessionLabel(job),
    isFocused: false,
    isTerminal: isTerminalRung(rung),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the complete dash card model for one frame.
 *
 * - `jobs` — the live `jobs` projection (a `Map` keyed by `job_id`, or any
 *   iterable of `Job`). Terminal (ended/killed) cards are dropped unless
 *   `showTerminal` is set.
 * - `subagents` — the FLAT running-subagent stream, grouped per job for the
 *   live-subagent count.
 * - `showTerminal` — when false (default toggle state) ended/killed cards are
 *   hidden; when true they join the idle band.
 * - `nowSec` — the frame's reference seconds (injected; no `Date.now()`).
 *
 * Returns `{ bands }`: the three bands in render order, each carrying its cards
 * in stable `created_at` ASC (`job_id` tiebreak) order. Empty bands emit an
 * empty `cards` array. Pure, never throws.
 */
export function buildDashModel(
  jobs: Map<string, Job> | Iterable<Job>,
  subagents: readonly SubagentInvocation[],
  showTerminal: boolean,
  nowSec: number,
): DashModel {
  const jobList =
    jobs instanceof Map ? Array.from(jobs.values()) : Array.from(jobs);
  const subCounts = runningSubByJob(subagents);

  // Bucket cards by band, dropping terminal cards unless revealed.
  const buckets: Record<BandKey, CardVM[]> = {
    "needs-you": [],
    "in-motion": [],
    idle: [],
  };
  // Parallel `Job` lists so the intra-band sort can read created_at / job_id
  // off the source row without threading them onto the immutable CardVM.
  const sortKey = new Map<string, { created: number; id: string }>();

  for (const job of jobList) {
    const rung = robotRung(job);
    if (isTerminalRung(rung) && !showTerminal) {
      continue;
    }
    const card = buildCard(job, rung, subCounts.get(job.job_id) ?? 0, nowSec);
    buckets[bandForRung(rung)].push(card);
    sortKey.set(card.key, { created: job.created_at, id: job.job_id });
  }

  // Stable intra-band sort: created_at ASC, job_id ASC tiebreak — a live card
  // never teleports on a metadata tick.
  const byCreated = (a: CardVM, b: CardVM): number => {
    const ka = sortKey.get(a.key);
    const kb = sortKey.get(b.key);
    const ca = ka?.created ?? 0;
    const cb = kb?.created ?? 0;
    if (ca !== cb) {
      return ca - cb;
    }
    const ia = ka?.id ?? "";
    const ib = kb?.id ?? "";
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };

  const bands: Band[] = BAND_ORDER.map((key) => {
    const cards = buckets[key];
    cards.sort(byCreated);
    return { key, title: BAND_TITLES[key], cards };
  });

  return { bands };
}
