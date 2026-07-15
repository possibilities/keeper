/**
 * `keeper dash` view-model — the pure, OpenTUI-free projection layer for the
 * robot job screen. One entry point, {@link buildDashModel}, folds the live
 * `jobs` projection into a typed `{ bands }` model the OpenTUI paint layer
 * (`./app.ts`) consumes: one BAND per active tmux session, each an ordered list
 * of keyed {@link CardVM} job lines (one per job).
 *
 * Each job paints as a single minimal line — a status ICON, the job name, and a
 * right-justified project name. Status is DUAL-ENCODED on that one glyph: a Nerd
 * Font md-robot FACE ({@link robotGlyph}) plus the icon's COLOR ({@link CardVM.iconRole}),
 * both resolved fresh from the shared six-rung ladder in {@link robotRung} —
 * annotation columns (api-error, awaiting permission/input) outrank the base
 * `state`.
 *
 * Lines group by tmux session (`backend_exec_session_id`) — the priority
 * sessions `work` / `autopilot` first, then any other named
 * session alphabetically, then the `detached` band (no recorded session) last.
 * Within a band, lines sort by live tmux `window_index` (the window's
 * left-to-right VISUAL position) ascending so the board matches the operator's
 * tmux window order and reflects manual swaps on the next pulse; an unknown
 * index (null / non-tmux / not-yet-probed) sorts last, then `created_at` ASC and
 * `job_id` ASC keep a live line from teleporting on a metadata tick. Ended/killed
 * jobs are terminal and hidden unless `showTerminal` is set.
 *
 * Pure — no I/O, no wall-clock, no `@opentui` import anywhere in this file. That
 * last property is load-bearing: it keeps `test/dash-view-model.test.ts` on the
 * fast tier.
 */

import { type RobotRung, robotGlyph, robotRung } from "../job-state-icon";
import type { HandoffLinkEntry, Job } from "../types";
import type { IconRole } from "./theme";

export { type RobotRung, robotGlyph, robotRung } from "../job-state-icon";

// ---------------------------------------------------------------------------
// Status ladder — the six robot rungs
// ---------------------------------------------------------------------------

/** The icon color role each rung paints. Mirrors the ladder's color column. */
const RUNG_ICON: Record<RobotRung, IconRole> = {
  error: "error",
  awaiting: "awaiting",
  working: "working",
  ended: "idle-ended",
  stopped: "idle-stopped",
  killed: "idle-killed",
};

/** A rung is terminal when it represents a finished session — ended or killed.
 * Terminal lines are hidden unless `showTerminal` is set. */
function isTerminalRung(rung: RobotRung): boolean {
  return rung === "ended" || rung === "killed";
}

// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/** A band key — a tmux session name, or {@link DETACHED_KEY} for jobs with no
 * recorded session. */
export type BandKey = string;

/** The session bands ranked first, in this render order, whenever present. Any
 * other named session follows them alphabetically; {@link DETACHED_KEY} is
 * always last. */
const SESSION_PRIORITY: readonly string[] = ["work", "autopilot"];

/** The band key for a job with no recorded tmux session (NULL/blank
 * `backend_exec_session_id`). Empty so an all-ESC/blank session name folds here
 * too; titled by {@link DETACHED_TITLE} and ordered last. */
const DETACHED_KEY = "";

/** The human title of the {@link DETACHED_KEY} band. */
const DETACHED_TITLE = "detached";

/** The tmux session band a job sorts into: its sanitized LIVE
 * `backend_exec_session_id`, falling back to the forensic
 * `backend_exec_birth_session_id` when the live session is unresolved, or
 * {@link DETACHED_KEY} when both are NULL/blank. Pure. */
function sessionBand(job: Job): BandKey {
  const live = sanitize(str(job.backend_exec_session_id)).trim();
  if (live !== DETACHED_KEY) {
    return live;
  }
  return sanitize(str(job.backend_exec_birth_session_id)).trim();
}

/** The display title for a band key — the session name itself, or
 * {@link DETACHED_TITLE} for the detached band. */
function bandTitle(key: BandKey): string {
  return key === DETACHED_KEY ? DETACHED_TITLE : key;
}

/** Render rank for a band key: a priority session by its listed index, any
 * other named session after them, the detached band last. {@link byBand} breaks
 * rank ties alphabetically. */
function bandRank(key: BandKey): number {
  if (key === DETACHED_KEY) {
    return Number.MAX_SAFE_INTEGER;
  }
  const pri = SESSION_PRIORITY.indexOf(key);
  return pri === -1 ? SESSION_PRIORITY.length : pri;
}

/** Total order over band keys: rank ASC, then alphabetical within a rank (so
 * the "other named sessions" tier sorts alphabetically). */
function byBand(a: BandKey, b: BandKey): number {
  const ra = bandRank(a);
  const rb = bandRank(b);
  if (ra !== rb) {
    return ra - rb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Output shapes — the contract the OpenTUI paint layer (`./app.ts`) consumes
// ---------------------------------------------------------------------------

/**
 * One job line. `key` (`job:<id>`) is stable across frames so the paint layer
 * mutates a single line in place (never add/remove per frame). `robotGlyph` +
 * `iconRole` dual-encode status on the leading icon. `title` (job name) leads
 * the line after the icon; `project` (cwd basename) is right-justified.
 * `isTerminal` flags an ended/killed job (only present when `showTerminal`
 * reveals them).
 */
export interface CardVM {
  readonly key: string;
  readonly project: string;
  readonly title: string;
  readonly robotGlyph: string;
  readonly iconRole: IconRole;
  readonly isTerminal: boolean;
  /**
   * Minimal handoff relation badge, or `""` when the job is in no handoff edge.
   * `↳ handed off` flags the INITIATOR side (`handoff-from`, work flowed OUT);
   * `↰ from <peer>` flags the HANDOFF-EE side (`handoff-to`, work flowed IN,
   * peer = the initiator's label). The dash renders no other relationships, so
   * this stays a single pre-rendered string — not a relationship subsystem.
   */
  readonly handoffBadge: string;
}

/** One session band: a keyed (tmux session name, or {@link DETACHED_KEY}),
 * titled, ordered run of job lines. Only sessions with at least one visible line
 * get a band — there are no empty bands. */
export interface Band {
  readonly key: BandKey;
  readonly title: string;
  readonly cards: readonly CardVM[];
}

/**
 * The dash readiness gate's loading state — present while the daemon is down
 * or catching up, absent once ready. `line` is pre-formatted by the app shell
 * off the freshest boot-status header (re-fold percentage, a generic
 * git-seed wait, or a plain catching-up label — no per-root list); the view-model stays free of any
 * wire-protocol dependency.
 */
export interface DashLoadingState {
  readonly line: string;
}

/** The complete dash model for one frame. `loading`, when present, means the
 *  gate is holding — `bands` is empty and the paint layer renders the
 *  loading line instead of cards. */
export interface DashModel {
  readonly bands: readonly Band[];
  readonly loading?: DashLoadingState;
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
 * The job's label, coalescing `title → plan_ref → job_id` so a line is NEVER
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

/**
 * Minimal handoff relation badge off the job's `handoff_links` (absent ≡ no
 * edges). The first edge wins (a job is normally only one end of one handoff):
 * `handoff-to` → `↰ from <peer>` (this job was handed work; peer = initiator),
 * `handoff-from` → `↳ handed off` (this job handed work out). The peer label
 * coalesces `title → peer_job_id`; a `handoff-to` whose peer is unknown still
 * renders the bare `↰ from` arm. Returns `""` for no edge. Pure, never throws.
 */
function handoffBadge(job: Job): string {
  const links = job.handoff_links;
  if (!Array.isArray(links) || links.length === 0) {
    return "";
  }
  const link = links[0] as HandoffLinkEntry;
  if (link.kind === "handoff-to") {
    const peer = sanitize(str(link.title) || str(link.peer_job_id));
    return peer === "" ? "↰ from" : `↰ from ${peer}`;
  }
  return "↳ handed off";
}

// ---------------------------------------------------------------------------
// Line build
// ---------------------------------------------------------------------------

/** Build one job line from a job. Pure. */
function buildCard(job: Job, rung: RobotRung): CardVM {
  return {
    key: `job:${job.job_id}`,
    project: sanitize(projectBasename(str(job.cwd) || null)),
    title: sanitize(jobLabel(job)),
    robotGlyph: robotGlyph(rung),
    iconRole: RUNG_ICON[rung],
    isTerminal: isTerminalRung(rung),
    handoffBadge: handoffBadge(job),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the complete dash model for one frame.
 *
 * - `jobs` — the live `jobs` projection (a `Map` keyed by `job_id`, or any
 *   iterable of `Job`). Terminal (ended/killed) lines are dropped unless
 *   `showTerminal` is set.
 * - `showTerminal` — when false (default toggle state) ended/killed lines are
 *   hidden; when true they join their session band.
 * - `loading` — when non-null, the gate is holding: `jobs` is never walked
 *   and the model short-circuits to `{ bands: [], loading }`, so a launch or
 *   reconnect mid-catch-up never renders a partially-folded card. Absent/null
 *   (default) ⇒ today's ready-state behavior, unchanged.
 *
 * Returns `{ bands }`: one band per active tmux session in render order (priority
 * sessions first, the rest alphabetical, `detached` last), each carrying its job
 * lines ordered by live tmux `window_index` ASC (known precedes unknown, then
 * `created_at`/`job_id`). Pure, never throws.
 */
export function buildDashModel(
  jobs: Map<string, Job> | Iterable<Job>,
  showTerminal: boolean,
  loading?: DashLoadingState | null,
): DashModel {
  if (loading != null) {
    return { bands: [], loading };
  }
  const jobList =
    jobs instanceof Map ? Array.from(jobs.values()) : Array.from(jobs);

  // Bucket lines by tmux-session band, dropping terminal lines unless revealed.
  // Only sessions that contribute a line get a bucket, so there are no empty
  // bands.
  const buckets = new Map<BandKey, CardVM[]>();
  // Parallel sort keys so the intra-band sort can read window_index /
  // created_at / job_id off the source row without threading them onto the
  // immutable CardVM.
  const sortKey = new Map<
    string,
    { window: number | null; created: number; id: string }
  >();

  for (const job of jobList) {
    const rung = robotRung(job);
    if (isTerminalRung(rung) && !showTerminal) {
      continue;
    }
    const card = buildCard(job, rung);
    const key = sessionBand(job);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [card]);
    } else {
      bucket.push(card);
    }
    sortKey.set(card.key, {
      window: job.window_index,
      created: job.created_at,
      id: job.job_id,
    });
  }

  // Stable intra-band sort: known tmux `window_index` ASC (the window's
  // left-to-right VISUAL position) precedes any unknown one, then `created_at`
  // ASC, then `job_id` ASC. A null/non-finite index sorts LAST via an explicit
  // `Number.isFinite` guard — window 0 is a real leftmost slot, so it must NOT
  // coerce to unknown. Mirrors `compareCandidates` in `src/restore-set.ts` (a
  // separate impl, not a shared helper). The final `job_id` tiebreak keeps a
  // live line from teleporting on a metadata tick.
  const byWindow = (a: CardVM, b: CardVM): number => {
    const ka = sortKey.get(a.key);
    const kb = sortKey.get(b.key);
    const wa = ka?.window;
    const wb = kb?.window;
    const aKnown = typeof wa === "number" && Number.isFinite(wa);
    const bKnown = typeof wb === "number" && Number.isFinite(wb);
    if (aKnown && bKnown) {
      if (wa !== wb) {
        return wa - wb;
      }
    } else if (aKnown !== bKnown) {
      return aKnown ? -1 : 1;
    }
    const ca = ka?.created ?? 0;
    const cb = kb?.created ?? 0;
    if (ca !== cb) {
      return ca - cb;
    }
    const ia = ka?.id ?? "";
    const ib = kb?.id ?? "";
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };

  // One band per active session, ordered by `byBand` (priority sessions first,
  // the rest alphabetical, detached last), lines stable-sorted within.
  const bands: Band[] = Array.from(buckets.keys())
    .sort(byBand)
    .map((key) => {
      const cards = buckets.get(key) ?? [];
      cards.sort(byWindow);
      return { key, title: bandTitle(key), cards };
    });

  return { bands };
}
