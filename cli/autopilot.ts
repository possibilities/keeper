#!/usr/bin/env bun
/**
 * `keeper autopilot` — thin viewer + control surface for the server-side
 * autopilot reconciler.
 *
 * The reconciler itself lives in `src/autopilot-worker.ts`; this CLI does NOT
 * dispatch, dedup, suppress, settle, confirm, reap, or persist anything. It
 * renders the current / stopped / failed / dependencies sections plus a
 * paused/playing banner, and offers control subcommands that each round-trip
 * one RPC (same one-shot shape as `scripts/approve.ts`).
 *
 * Data plumbing: the readiness collections ride one `subscribeReadiness`
 * connection; `dispatch_failures`, the `autopilot_state` singleton (the
 * banner-truth substrate), and `armed_epics` each ride their own
 * `subscribeCollection`. There is NO daemon boot-append — a fresh board has no
 * `autopilot_state` row at all; the viewer seeds `[paused] · yolo · max ∞` and
 * the first folded edge overwrites it. The singleton materializes lazily on the
 * first pause/play/mode/config event.
 *
 * Usage:
 *   keeper autopilot [--sock <path>]            # viewer
 *   keeper autopilot pause [--sock <path>]      # control
 *   keeper autopilot play  [--sock <path>]      # control
 *   keeper autopilot config <key> <value> [--sock <path>]  # control
 *   keeper autopilot retry <verb::id> [--sock <path>]  # control
 *   keeper autopilot --help
 */

import { basename } from "node:path";
import { parseArgs } from "node:util";
import {
  DEFAULT_MAX_CONCURRENT_PER_ROOT,
  effectivePerRootCap,
  resolveSockPath,
} from "../src/db";
import {
  createFramesEmitter,
  defaultDiffFn,
  defaultFramesIo,
} from "../src/frames-emitter";
import type { ClientFrame } from "../src/protocol";
import {
  isEpicStarted,
  orderEpicsForScheduling,
  type Verdict,
} from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeCollection,
  subscribeReadiness,
} from "../src/readiness-client";
import {
  resolveSnapshotMode,
  SnapshotCliMisuseError,
  type SnapshotMode,
} from "../src/snapshot";
import type { Epic, Task } from "../src/types";
import { createViewShell } from "../src/view-shell";
import { queryCollection, sendControlRpc } from "./control-rpc";
import { AUTOPILOT_FLAGS, buildParseOptions } from "./descriptor";
import { parseDuration } from "./duration";
import {
  type Envelope,
  emitEnvelope,
  errorEnvelope,
  RECOVERY_DAEMON_DOWN,
  successEnvelope,
} from "./envelope";

/** Envelope schema version for `keeper autopilot show`. */
export const AUTOPILOT_SHOW_SCHEMA_VERSION = 1;

const HELP = `keeper autopilot — thin viewer + control surface for the server-side autopilot reconciler

Usage:
  keeper autopilot [--sock <path>] [--snapshot | --watch] [--timeout <dur>]
  keeper autopilot pause [--sock <path>]
  keeper autopilot play  [--sock <path>]
  keeper autopilot mode <yolo|armed> [--sock <path>]
  keeper autopilot config <key> <value> [--sock <path>]
  keeper autopilot arm <epic-id> [--sock <path>]
  keeper autopilot disarm <epic-id> [--sock <path>]
  keeper autopilot worktree <on|off> [--force] [--sock <path>]
  keeper autopilot retry <verb::id> [--sock <path>]
  keeper autopilot show [--sock <path>]
  keeper autopilot --help

Subcommands:
  (none)   Open the alt-screen viewer rendering the live current /
           stopped / failed / armed / dependencies sections plus the
           paused + mode + armed-count banner.
  show     Print the durable autopilot config as ONE
           {schema_version, ok, error, data} JSON envelope and exit:
           {paused, mode, worktree_mode, worktree_multi_repo, armed,
           max_concurrent_jobs, max_concurrent_per_root,
           max_concurrent_per_root_stored}. max_concurrent_per_root is the
           EFFECTIVE cap (worktree off => 1); _stored is the durable intent you
           set. Read-only — the capture surface for a take-over (every durable
           knob round-trips; restore stored via 'config max_concurrent_per_root').
  pause    Send set_autopilot_paused {paused:true} and exit.
  play     Send set_autopilot_paused {paused:false} and exit.
  mode     Send set_autopilot_mode {mode:<yolo|armed>} and exit. yolo works
           every ready epic; armed works ONLY explicitly-armed epics plus
           their transitive upstream dep-closure.
  config   Send set_autopilot_config {<key>:<value>} and exit. Runtime-sets a
           scalar autopilot config value. Keys: max_concurrent_jobs (a positive
           integer cap, or 'unlimited' to clear it); max_concurrent_per_root (a
           positive integer count of concurrent tasks per root, or 'default'/1);
           worktree_multi_repo (an on/off rollout flag — see below).
           max_concurrent_per_root is stored as durable INTENT and accepted
           regardless of worktree mode; the EFFECTIVE cap dispatch honors is
           derived — the stored value while worktree mode is on, floored to 1
           while it is off (a root's workers share the one main checkout). Set it
           while worktree is off and it is stored untouched at an effective cap of
           1 until you turn worktree mode on. worktree_multi_repo on lets worktree
           mode CLUSTER a >1-toplevel epic into independent per-repo lane groups
           instead of rejecting it worktree-multi-repo (OFF by default).
           e.g. keeper autopilot config max_concurrent_jobs 8
                keeper autopilot config max_concurrent_per_root 3
                keeper autopilot config worktree_multi_repo on
  arm      Send set_epic_armed {epic_id:<id>, armed:true} and exit.
  disarm   Send set_epic_armed {epic_id:<id>, armed:false} and exit.
  worktree Send set_autopilot_config {worktree_mode:<on|off>} and exit. Durable
           toggle for worktree-shaped autopilot dispatch (OFF by default).
           REJECTED only when a started open epic is in flight (so a flip never
           half-migrates an in-progress epic); a drained / unstarted-open /
           zero-epic board toggles freely. Pass --force to override. Turning it
           off leaves the stored max_concurrent_per_root untouched but floors the
           EFFECTIVE per-root cap to 1 (worktree-off workers share the main
           checkout); turning it back on restores the stored cap with no re-set.
           Even with it ON, a not-worktree-friendly repo
           (a workspace/monorepo marker, no language manifest, or submodules) falls
           back to sequential shared-checkout dispatch — a NEUTRAL state shown in
           the viewer's --- worktree --- section, never a failure. Also with it ON, a
           dependent epic whose satisfied same-repo upstream is not yet merged into
           the local default branch is SILENTLY deferred (its lane is not cut) for
           that cycle and provisions once the upstream's finalize merge lands — an
           ephemeral per-cycle wait, never a sticky failure.
  retry    Send retry_dispatch {id:<verb::id>} and exit. <verb::id> is
           the canonical composite key (e.g. work::fn-619-foo.3). verb is
           one of work|close|approve; approve clears a resurrected/phantom
           approve pending (the reconciler never dispatches approve itself).

Options:
  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot     (viewer only) Force one-shot snapshot mode (print one frame +
                 a machine-parseable keeper-meta: line, then exit) even on a TTY
  --watch        (viewer only) Force the live subscribe stream even when piped
  --timeout <dur>  (viewer only) Snapshot wait before the timeout escape (~2s;
                 unit required, e.g. 500ms, 2s)
  --force        (worktree only) Bypass the started-epic toggle guard
  --help         Show this help

By default the viewer's stdout that is NOT a TTY (piped into an agent)
auto-detects snapshot mode; a TTY gets the live alt-screen viewer. \`CI\` /
\`TERM=dumb\` force snapshot.

The viewer is read-only — every dispatch, dedup, confirm, settle, and reap
decision happens in keeperd's autopilot worker thread. Use pause / play
to toggle the worker (boots PAUSED for safety), mode / arm / disarm to gate
which epics armed mode works, and retry to clear a sticky failure row.

Run \`keeper autopilot --agent-help\` for the terse operator runbook.
`;

/** Terse operator runbook (agent-facing), distinct from the full `--help`. */
const AGENT_HELP = `keeper autopilot — operator runbook (agent-facing)

Control the server-side reconciler (the viewer is read-only). It boots PAUSED.

  keeper autopilot pause | play
  keeper autopilot mode <yolo|armed>      # armed works ONLY armed epics + their dep-closure
  keeper autopilot arm <epic> | disarm <epic>
  keeper autopilot retry <verb::id>       # clear a sticky dispatch-failure row
  keeper autopilot config <key> <value>   # max_concurrent_jobs | max_concurrent_per_root | worktree_multi_repo | codex_adoption
  keeper autopilot worktree <on|off> [--force]

Read state from the [paused]/mode/armed banner (\`keeper autopilot --snapshot\`).
An unpaused autopilot that "does nothing" is usually a readiness gate firing
correctly, not a bug. Exit codes: 0 ok · 1 daemon-unreachable/generic · 2 arg fault.
`;

const seg = (v: unknown): string => (v == null ? "" : String(v));

// ---------------------------------------------------------------------------
// Dependency graph — ASCII DAG of open tasks (epic + task deps).
// ---------------------------------------------------------------------------

const asArray = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/** Per-task status glyph keyed off the live verdict. Pure scan key, not a
 * dispatch decision — purely for the dependency-graph legend. */
function statusGlyph(v: Verdict | undefined): string {
  if (v === undefined) {
    return "·";
  }
  if (v.tag === "completed") {
    return "✓";
  }
  if (v.tag === "running") {
    return "▸";
  }
  if (v.tag === "ready") {
    return "○";
  }
  return "·";
}

/** Strip the owning-epic prefix from a task id so intra-epic ids render as
 * the short `.M` suffix; ids not belonging to `epicId` pass through whole. */
function shortTaskId(taskId: string, epicId: string): string {
  return epicId !== "" && taskId.startsWith(`${epicId}.`)
    ? taskId.slice(epicId.length)
    : taskId;
}

/**
 * Render the open-task dependency graph as an ASCII DAG. One block per epic
 * in board scheduling order via `orderEpicsForScheduling` (started epics first,
 * then `epic_number ASC` within each tier);
 * within a block, one line per task carrying a status glyph, the short `.M` id,
 * and a `← <deps>` clause naming the `depends_on` upstreams it waits for. An
 * epic that itself waits on other epics annotates its header with `← epic:<id>`
 * per `depends_on_epics`.
 *
 * Pure transform — returns the section body lines (the `--- dependencies ---`
 * header is added by `renderBody`). Empty array when there is nothing open.
 */
export function renderDependencyGraph(snap: ReadinessClientSnapshot): string[] {
  const out: string[] = [];
  for (const epic of orderEpicsForScheduling(snap.epics)) {
    const epicId = seg(epic.epic_id);
    const tasks = asArray<Task>(epic.tasks);
    if (tasks.length === 0) {
      continue;
    }
    const epicDeps = asArray<string>(epic.depends_on_epics)
      .map((d) => seg(d))
      .filter((d) => d !== "");
    const header =
      epicDeps.length === 0
        ? epicId
        : `${epicId}  ← epic:${epicDeps.join(", epic:")}`;
    out.push(header);
    for (const task of tasks) {
      const taskId = seg(task.task_id);
      if (taskId === "") {
        continue;
      }
      const glyph = statusGlyph(snap.readiness.perTask.get(taskId));
      const deps = asArray<string>(task.depends_on)
        .map((d) => seg(d))
        .filter((d) => d !== "")
        .map((d) => shortTaskId(d, epicId));
      const depClause = deps.length === 0 ? "" : `  ← ${deps.join(", ")}`;
      out.push(`  ${glyph} ${shortTaskId(taskId, epicId)}${depClause}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live + failed row shapes — the viewer's internal projections.
// ---------------------------------------------------------------------------

/**
 * One live dispatch row rendered under `--- current ---`. Sourced from the
 * `jobs` map in the readiness snapshot — every `working` / `stopped` row whose
 * `plan_verb` is one of the dispatch verbs is a current dispatch.
 */
export interface CurrentRow {
  verb: "work" | "close" | "approve";
  id: string;
  /** Basename of `project_dir` — empty when none. */
  dir: string;
  /**
   * Live job state. `working` splits into `--- current ---`; `stopped` (turn
   * ended, session may still be alive) splits into `--- stopped ---`. The
   * readiness `jobs` stream is server-filtered to exactly these two states.
   */
  state: "working" | "stopped";
  /** Sort key: created_at descending puts the freshest at the bottom. */
  created_at: number;
}

/**
 * One row of `dispatch_failures` shipped to the viewer — the typed projection
 * we render against (the wire shape is the general `Record<string, unknown>`).
 */
export interface FailedRow {
  verb: string;
  id: string;
  reason: string;
  dir: string;
  ts: string;
}

/**
 * One row of the LIVE-ONLY `worktree_repo_status` collection (fn-1013) shipped to
 * the viewer — a neutral worktree-disabled verdict, rendered DISTINCT from the
 * red failed / dispatch-failures block.
 */
export interface WorktreeStatusRow {
  epicId: string;
  dir: string;
  mode: string;
  reason: string;
}

/**
 * Project `worktree_repo_status` wire rows to typed {@link WorktreeStatusRow}s,
 * sorted by `epic_id` ASC for a stable render. Each row is a worktree-disabled
 * epic (serial shared-checkout dispatch); the `repo_dir` renders as its basename.
 * Pure transform — exported for tests.
 */
export function projectWorktreeStatusRows(
  rows: Record<string, unknown>[],
): WorktreeStatusRow[] {
  const out: WorktreeStatusRow[] = [];
  for (const r of rows) {
    const epicId = seg(r.epic_id);
    if (epicId === "") {
      continue;
    }
    const dir = seg(r.repo_dir);
    out.push({
      epicId,
      dir: dir === "" ? "" : basename(dir),
      mode: seg(r.mode) || "serial",
      reason: seg(r.reason),
    });
  }
  out.sort((a, b) => a.epicId.localeCompare(b.epicId));
  return out;
}

/**
 * Project the readiness snapshot's `jobs` map into a `current` row per
 * non-terminal dispatch (verbs work / close / approve, state
 * working|stopped). Pure transform — exported for tests.
 */
export function buildCurrentRows(snap: ReadinessClientSnapshot): CurrentRow[] {
  const out: CurrentRow[] = [];
  for (const job of snap.jobs.values()) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    const verb = job.plan_verb;
    if (verb !== "work" && verb !== "close" && verb !== "approve") {
      continue;
    }
    const id = seg(job.plan_ref);
    if (id === "") {
      continue;
    }
    const cwd = seg(job.cwd);
    out.push({
      verb,
      id,
      dir: cwd === "" ? "" : basename(cwd),
      // The guard above narrowed `job.state` to working|stopped.
      state: job.state === "working" ? "working" : "stopped",
      created_at:
        typeof job.created_at === "number" ? job.created_at : Number(0),
    });
  }
  // Sort ascending by created_at (oldest first) so the freshest dispatch is at
  // the bottom.
  out.sort((a, b) => a.created_at - b.created_at);
  return out;
}

/**
 * Convert `dispatch_failures` wire rows to typed `FailedRow`s. The
 * descriptor sorts `ts DESC` server-side, so the freshest failure is the
 * first element. Pure transform — exported for tests.
 */
export function projectFailedRows(
  rows: Record<string, unknown>[],
): FailedRow[] {
  const out: FailedRow[] = [];
  for (const r of rows) {
    out.push({
      verb: seg(r.verb),
      id: seg(r.id),
      reason: seg(r.reason),
      dir: seg(r.dir),
      ts: seg(r.ts),
    });
  }
  return out;
}

/**
 * Coerce a singleton `autopilot_state` wire row's `paused` column (INTEGER:
 * `1` paused, `0` playing) to the banner boolean. An empty row set (singleton
 * not yet folded) returns `null` so the caller leaves the seed untouched; a
 * non-0/1 value falls back to `true` (the safer side, matching the daemon's
 * boot default). Pure — exported for tests.
 */
export function projectAutopilotPaused(
  rows: Record<string, unknown>[],
): boolean | null {
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
 * Coerce a singleton `autopilot_state` wire row's `max_concurrent_jobs` column
 * (NULLABLE INTEGER: a positive cap, or NULL = unlimited) to the banner cap.
 * Sourced ENTIRELY over the socket — the viewer NEVER reads config.yaml. The
 * whole absent → unlimited path (empty row set, NULL, missing column, or any
 * non-positive / non-integer value) returns `null` (rendered `∞`); only a
 * positive integer returns a numeric cap. Pure — exported for tests.
 */
export function projectMaxConcurrentJobs(
  rows: Record<string, unknown>[],
): number | null {
  if (rows.length === 0) {
    return null;
  }
  const raw = rows[0]?.max_concurrent_jobs;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

/**
 * Coerce a singleton `autopilot_state` wire row's `max_concurrent_per_root`
 * column (NULLABLE INTEGER) to the banner's per-root count. Unlike the global
 * cap there is NO unlimited sentinel: NULL / empty rows / a non-positive or
 * non-integer value ALL resolve to `DEFAULT_MAX_CONCURRENT_PER_ROOT` (= 1)
 * inside the projection, so this always returns a concrete `number`. Pure —
 * exported for tests.
 */
export function projectMaxConcurrentPerRoot(
  rows: Record<string, unknown>[],
): number {
  if (rows.length === 0) {
    return DEFAULT_MAX_CONCURRENT_PER_ROOT;
  }
  const raw = rows[0]?.max_concurrent_per_root;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_MAX_CONCURRENT_PER_ROOT;
  }
  return raw;
}

/**
 * Coerce a singleton `autopilot_state` wire row's `mode` column (TEXT:
 * `'yolo'` work-everything, `'armed'` armed-set-only) to the banner enum. An
 * empty row set returns `null` so the caller leaves the seed untouched; any
 * value other than the two legal literals falls back to `'yolo'` (the
 * backward-compatible default). Pure — exported for tests.
 */
export function projectAutopilotMode(
  rows: Record<string, unknown>[],
): "yolo" | "armed" | null {
  if (rows.length === 0) {
    return null;
  }
  const raw = rows[0]?.mode;
  return raw === "armed" ? "armed" : "yolo";
}

/**
 * Coerce a singleton `autopilot_state` wire row's `worktree_mode` column
 * (NULLABLE INTEGER: `1` ON, NULL/0 OFF) to the banner boolean. An empty row set
 * (singleton not yet folded) returns `null` so the caller leaves the seed
 * untouched; only a stored `1` is ON, every other value (NULL, 0, absent column,
 * non-1) is OFF — the byte-identical default. Pure — exported for tests.
 */
export function projectWorktreeMode(
  rows: Record<string, unknown>[],
): boolean | null {
  if (rows.length === 0) {
    return null;
  }
  return rows[0]?.worktree_mode === 1;
}

/**
 * Coerce a singleton `autopilot_state` wire row's `worktree_multi_repo` column
 * (NULLABLE INTEGER: `1` ON, NULL/0 OFF — the durable multi-repo rollout flag) to
 * a boolean. Mirrors {@link projectWorktreeMode}: an empty row set returns `null`
 * so a caller can leave its seed untouched; only a stored `1` is ON, every other
 * value (NULL, 0, absent column, non-1) is OFF. Pure — exported for tests.
 */
export function projectWorktreeMultiRepo(
  rows: Record<string, unknown>[],
): boolean | null {
  if (rows.length === 0) {
    return null;
  }
  return rows[0]?.worktree_multi_repo === 1;
}

/**
 * Project the `armed_epics` wire rows to a sorted list of the explicitly-armed
 * epic ids. Re-sorted by `epic_id` ASC for a stable, deterministic armed-
 * section render. Pure — exported for tests.
 */
export function projectArmedEpics(rows: Record<string, unknown>[]): string[] {
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
// `autopilot show` — the durable config as ONE envelope-shaped read.
// ---------------------------------------------------------------------------

/**
 * The durable autopilot config + runtime state served by `keeper autopilot
 * show`. Mirrors `keeper status .data.autopilot` field-for-field so the two
 * reads agree, plus `worktree_multi_repo` — the durable rollout flag a
 * capture/restore take-over must round-trip.
 */
export interface AutopilotShowData {
  paused: boolean;
  mode: "yolo" | "armed";
  worktree_mode: boolean;
  worktree_multi_repo: boolean;
  armed: string[];
  max_concurrent_jobs: number | null;
  // The EFFECTIVE per-root cap dispatch honors — derived from the stored intent
  // and worktree mode (off ⇒ 1). Meaning-stable with the old regime, where
  // stored always equaled effective.
  max_concurrent_per_root: number;
  // ADDITIVE: the durable STORED per-root intent a take-over capture/restore
  // round-trips. Equals effective while worktree mode is on; while off it holds
  // the value the operator set even though effective floors to 1.
  max_concurrent_per_root_stored: number;
}

export type AutopilotShowEnvelope = Envelope<AutopilotShowData>;

/**
 * Build the `autopilot show` success envelope from the raw `autopilot_state`
 * singleton rows + `armed_epics` rows. Reuses the SAME projectors the viewer
 * banner and the readiness snapshot consume, so `show`, `status
 * .data.autopilot`, and the banner never diverge. Defaults match the daemon's
 * boot state on a never-configured board: paused (boot-safe), yolo, worktree
 * off, multi-repo off, unlimited global cap, per-root 1. PURE — no socket — so a
 * fixture pins the shape.
 */
export function buildAutopilotShowEnvelope(
  autopilotRows: Record<string, unknown>[],
  armedRows: Record<string, unknown>[],
): AutopilotShowEnvelope {
  const worktreeMode = projectWorktreeMode(autopilotRows) ?? false;
  // The raw column IS the stored intent (post task-.1 inversion); derive the
  // effective cap through the ONE shared helper so `show` never re-interprets
  // the raw value inline and can't drift from `keeper status` / the reconciler.
  const storedPerRoot = projectMaxConcurrentPerRoot(autopilotRows);
  return successEnvelope(AUTOPILOT_SHOW_SCHEMA_VERSION, {
    paused: projectAutopilotPaused(autopilotRows) ?? true,
    mode: projectAutopilotMode(autopilotRows) ?? "yolo",
    worktree_mode: worktreeMode,
    worktree_multi_repo: projectWorktreeMultiRepo(autopilotRows) ?? false,
    armed: projectArmedEpics(armedRows),
    max_concurrent_jobs: projectMaxConcurrentJobs(autopilotRows),
    max_concurrent_per_root: effectivePerRootCap(storedPerRoot, worktreeMode),
    max_concurrent_per_root_stored: storedPerRoot,
  });
}

export interface RunAutopilotShowDeps {
  writeStdout: (s: string) => void;
  exit: (code: number) => never;
  /** Read a collection over the socket (injected for tests). */
  query: (
    sock: string,
    collection: string,
  ) => Promise<Record<string, unknown>[]>;
}

/**
 * Read the `autopilot_state` singleton + `armed_epics` and print the config
 * envelope. Two best-effort `query` round-trips (read-only — never
 * `sendControlRpc`); a transport throw lands an `ok:false` envelope on stdout,
 * exit 1 (mirrors `keeper status` / `keeper query`), never empty stdout + prose.
 */
export async function runAutopilotShow(
  sockPath: string,
  deps: RunAutopilotShowDeps,
): Promise<void> {
  let autopilotRows: Record<string, unknown>[];
  let armedRows: Record<string, unknown>[];
  try {
    autopilotRows = await deps.query(sockPath, "autopilot_state");
    armedRows = await deps.query(sockPath, "armed_epics");
  } catch (err) {
    emitEnvelope(
      errorEnvelope(AUTOPILOT_SHOW_SCHEMA_VERSION, {
        code: "autopilot_show_failed",
        message: err instanceof Error ? err.message : String(err),
        recovery: RECOVERY_DAEMON_DOWN,
      }),
      deps,
    );
    return;
  }
  emitEnvelope(buildAutopilotShowEnvelope(autopilotRows, armedRows), deps);
}

// ---------------------------------------------------------------------------
// Body renderer — pure (fixtures → lines).
// ---------------------------------------------------------------------------

export interface RenderInput {
  current: CurrentRow[];
  /** Pre-rendered ASCII DAG body lines (`renderDependencyGraph`).
   * Optional — an absent section renders nothing. */
  dependencies?: string[];
  failed: FailedRow[];
  paused: boolean;
  /** The explicitly-armed epic ids listed by the `--- armed ---` section. An
   * empty/absent array renders nothing — the "nothing armed" callout lives on
   * the banner, not the body. */
  armed?: string[];
  /** The worktree-disabled epics (fn-1013) listed by the neutral
   * `--- worktree ---` section. An empty/absent array renders nothing — distinct
   * from the red `--- failed ---` block. */
  worktree?: WorktreeStatusRow[];
}

/**
 * Render the body lines for one viewer frame. Each section is emitted only
 * when non-empty, in priority order: current (live `working` jobs), stopped
 * (turn ended, session may still be alive), failed (sticky failures awaiting
 * retry), armed, and dependencies (the open-task DAG). `current` and `stopped`
 * both source from `input.current` — `buildCurrentRows` projects the whole
 * working+stopped stream and this partitions by `state`. The paused/playing
 * indicator lives on the banner row, not the body.
 *
 * Pure — exported for tests.
 */
export function renderBody(input: RenderInput): string[] {
  const out: string[] = [];

  // `(dir) verb::id` — shared by the current + stopped sections (neither
  // pads the dir column; only predicted aligns).
  const dispatchLine = (r: CurrentRow): string => {
    const dirSeg = r.dir === "" ? "" : `(${r.dir}) `;
    return `${dirSeg}${r.verb}::${r.id}`;
  };

  const working = input.current.filter((r) => r.state === "working");
  const stopped = input.current.filter((r) => r.state === "stopped");

  if (working.length > 0) {
    out.push("--- current ---");
    for (const r of working) {
      out.push(dispatchLine(r));
    }
  }

  if (stopped.length > 0) {
    out.push("--- stopped ---");
    for (const r of stopped) {
      out.push(dispatchLine(r));
    }
  }

  if (input.failed.length > 0) {
    out.push("--- failed ---");
    for (const r of input.failed) {
      const dirSeg = r.dir === "" ? "" : `(${r.dir}) `;
      out.push(`${dirSeg}${r.verb}::${r.id} — ${r.reason}`);
    }
  }

  // The banner already signals mode + count (incl. the "nothing armed"
  // callout), so an empty armed set renders no body section here.
  const armed = input.armed ?? [];
  if (armed.length > 0) {
    out.push("--- armed ---");
    for (const epicId of armed) {
      out.push(epicId);
    }
  }

  // Worktree-disabled epics (fn-1013) — a NEUTRAL section: these dispatch
  // sequentially on the shared checkout (a not-worktree-friendly repo), NOT an
  // error. DISTINCT from `--- failed ---`. Empty set renders nothing.
  const worktree = input.worktree ?? [];
  if (worktree.length > 0) {
    out.push("--- worktree ---");
    for (const r of worktree) {
      const dirSeg = r.dir === "" ? "" : `(${r.dir}) `;
      out.push(`${dirSeg}${r.epicId} — ${r.mode} (${r.reason})`);
    }
  }

  const dependencies = input.dependencies ?? [];
  if (dependencies.length > 0) {
    out.push("--- dependencies ---");
    out.push("legend: ✓ done  ▸ running  ○ ready  · blocked   (← waits for)");
    out.push(...dependencies);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Control RPC round-trip — one-shot client, mirrors scripts/approve.ts.
// ---------------------------------------------------------------------------

/**
 * Build a well-formed RPC client frame for `set_autopilot_paused`. Pure —
 * exported so tests can assert the wire shape.
 */
export function buildSetPausedFrame(id: string, paused: boolean): ClientFrame {
  return {
    type: "rpc",
    id,
    method: "set_autopilot_paused",
    params: { paused },
  };
}

/**
 * Build a well-formed RPC client frame for `retry_dispatch`. Pure —
 * exported so tests can assert the wire shape.
 */
export function buildRetryFrame(id: string, dispatchKey: string): ClientFrame {
  return {
    type: "rpc",
    id,
    method: "retry_dispatch",
    params: { id: dispatchKey },
  };
}

/**
 * Build a well-formed RPC client frame for `set_autopilot_mode`. Pure —
 * exported so tests can assert the wire shape.
 */
export function buildSetModeFrame(
  id: string,
  mode: "yolo" | "armed",
): ClientFrame {
  return {
    type: "rpc",
    id,
    method: "set_autopilot_mode",
    params: { mode },
  };
}

/**
 * Build a well-formed RPC client frame for `set_epic_armed`. Pure —
 * exported so tests can assert the wire shape.
 */
export function buildSetArmedFrame(
  id: string,
  epicId: string,
  armed: boolean,
): ClientFrame {
  return {
    type: "rpc",
    id,
    method: "set_epic_armed",
    params: { epic_id: epicId, armed },
  };
}

/**
 * Build a well-formed RPC client frame for `set_autopilot_config` — the generic
 * config-patch setter. `patch` is a partial of the scalar config columns (e.g.
 * `{ max_concurrent_jobs: 8 }`). Pure — exported so tests can assert the wire
 * shape.
 */
export function buildSetConfigFrame(
  id: string,
  patch: {
    max_concurrent_jobs?: number | null;
    max_concurrent_per_root?: number | null;
    worktree_mode?: boolean;
    worktree_multi_repo?: boolean;
    codex_adoption?: boolean;
  },
): ClientFrame {
  return {
    type: "rpc",
    id,
    method: "set_autopilot_config",
    params: patch,
  };
}

/** Envelope schema version for the autopilot control ops (pause/play/mode/
 *  arm/disarm/retry/config/worktree) — versions the `data` payload the daemon
 *  echoes back through `sendControlRpc`. */
export const AUTOPILOT_CONTROL_SCHEMA_VERSION = 1;

/** Emit a CLI-usage error (bad args / unknown subcommand) on stderr, exit 1.
 *  Distinct from server / transport failures, which ride the shared envelope on
 *  stdout via `sendControlRpc`. */
function die(message: string): never {
  process.stderr.write(`autopilot: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Viewer entry point.
// ---------------------------------------------------------------------------

interface ViewerState {
  snap: ReadinessClientSnapshot | null;
  failed: FailedRow[];
  paused: boolean;
  // The global concurrency cap, sourced over the socket from the
  // `autopilot_state` singleton (NEVER config.yaml). `null` = unlimited.
  maxConcurrentJobs: number | null;
  // The durable STORED per-root intent, sourced over the socket from the
  // `autopilot_state` singleton's `max_concurrent_per_root` column. Always a
  // concrete positive integer (NULL = the default 1, never unlimited). The
  // banner derives the EFFECTIVE cap from this pairing with `worktreeMode`
  // through the shared `effectivePerRootCap`.
  maxConcurrentPerRootStored: number;
  // The explicit autopilot mode, sourced from the `autopilot_state` singleton's
  // `mode` column.
  mode: "yolo" | "armed";
  // The durable worktree-mode toggle, sourced from the `autopilot_state`
  // singleton's `worktree_mode` column. `false` (OFF) is the default.
  worktreeMode: boolean;
  // The explicitly-armed epic ids, sourced from the `armed_epics` presence
  // table.
  armedEpics: string[];
  // The worktree-disabled epics (fn-1013), sourced from the LIVE-ONLY
  // `worktree_repo_status` collection — the neutral `--- worktree ---` section.
  worktreeStatus: WorktreeStatusRow[];
}

/**
 * Render the persistent banner pill: the play/pause pill, the mode suffix, the
 * concurrency-cap suffix, (in `armed` mode) the armed-epic count, the per-root
 * count (worktree mode off only), and the worktree-mode suffix.
 * `[playing] · yolo · max 3 · per-root 1 · worktree:off` with worktree mode
 * off; `[playing] · armed · 2 armed · max ∞ · worktree:on` with two armed
 * epics and worktree mode on. The empty-armed-set-in-armed-mode case renders
 * DISTINCTLY as `[playing] · armed · nothing armed · max ∞ · per-root 1 ·
 * worktree:off` so idle-by-design is never mistaken for a broken autopilot.
 * The per-root cap governs dispatch ONLY while worktree mode is off (each
 * ready task gets its own cap-1 lane under worktree mode, so the cap is
 * deliberately ignored there) — the segment renders ONLY in that mode,
 * showing the effective cap (always 1). The raw stored intent stays out of
 * the banner and is still readable via `keeper status` / `keeper watch` JSON.
 * The worktree segment renders ALWAYS so the live state is scannable.
 *
 * Pure — exported for tests. All values are socket-sourced; the viewer never
 * reads config.
 */
export function autopilotBannerLabel(state: {
  paused: boolean;
  maxConcurrentJobs: number | null;
  maxConcurrentPerRoot: number;
  mode: "yolo" | "armed";
  armedCount: number;
  worktreeMode: boolean;
  // Count of host-level `daemon`-verb distress rows (shared-checkout dirty/wedge,
  // lane wedge) that have no epic/task home and so carry no `[failed:]` pill.
  // Omitted or 0 suppresses the segment; > 0 surfaces the board-global signal.
  needsHumanCount?: number;
}): string {
  const pill = state.paused ? "[paused]" : "[playing]";
  // The needs-human pill sits directly after the play/pause pill — an operator
  // must see "N things are wedged on you" before any cap/mode metadata.
  const needsHumanSeg =
    state.needsHumanCount !== undefined && state.needsHumanCount > 0
      ? ` · [needs-human:${state.needsHumanCount}]`
      : "";
  const cap =
    state.maxConcurrentJobs === null ? "∞" : String(state.maxConcurrentJobs);
  // In armed mode surface the armed count — and call out the empty set
  // distinctly so "nothing armed" reads as a deliberate state, not a bug.
  const armedSeg =
    state.mode === "armed"
      ? state.armedCount === 0
        ? " · nothing armed"
        : ` · ${state.armedCount} armed`
      : "";
  // Per-root segment renders ONLY while worktree mode is off — the only mode
  // where the cap governs dispatch — showing the effective cap (always 1).
  const perRootSeg = state.worktreeMode
    ? ""
    : ` · per-root ${state.maxConcurrentPerRoot}`;
  // Worktree segment renders for BOTH states (terse `worktree:on`/`worktree:off`)
  // so the live durable toggle is always visible at a glance.
  const worktreeSeg = state.worktreeMode ? " · worktree:on" : " · worktree:off";
  return `${pill}${needsHumanSeg} · ${state.mode}${armedSeg} · max ${cap}${perRootSeg}${worktreeSeg}`;
}

/** Data-frame bound + `--prev-frame` seed for `keeper frames --view autopilot`. */
export interface AutopilotFramesConfig {
  maxFrames?: number | null;
  durationMs?: number | null;
  prevFrameText?: string | null;
}

/**
 * Drive the autopilot viewer in `frames` mode — the entry `keeper frames --view
 * autopilot` dispatch calls. Mirrors `runBoardFrames` on the frames flag grammar
 * (`maxFrames` / `durationMs` / `prevFrameText`), never `resolveSnapshotMode`.
 */
export async function runAutopilotFrames(config: {
  sockPath?: string;
  maxFrames?: number | null;
  durationMs?: number | null;
  prevFrameText?: string | null;
}): Promise<void> {
  await runViewer(config.sockPath ?? resolveSockPath(), "frames", undefined, {
    maxFrames: config.maxFrames ?? null,
    durationMs: config.durationMs ?? null,
    prevFrameText: config.prevFrameText ?? null,
  });
}

async function runViewer(
  sockPath: string,
  mode: SnapshotMode | "frames" = "watch",
  timeoutMs?: number,
  frames?: AutopilotFramesConfig,
): Promise<void> {
  // Frames mode: build the prod emitter (view `autopilot`, `diff -u` seam, real
  // sidecar IO, the caller's chunk bounds + `--prev-frame` seed). Inert
  // otherwise.
  const framesEmitter =
    mode === "frames"
      ? createFramesEmitter({
          view: "autopilot",
          writeStdout: (line) => void process.stdout.write(line),
          diffFn: defaultDiffFn,
          io: defaultFramesIo(),
          maxFrames: frames?.maxFrames ?? null,
          durationMs: frames?.durationMs ?? null,
          prevFrameText: frames?.prevFrameText ?? null,
        })
      : null;
  const state: ViewerState = {
    snap: null,
    failed: [],
    // Seed `true` to match the daemon's boots-paused safety default; the first
    // `autopilot_state` subscribe edge overwrites it with the folded value.
    paused: true,
    // Seed `null` (= unlimited) until the `autopilot_state` edge lands the cap.
    maxConcurrentJobs: null,
    // Seed `1` (the default stored per-root count) until the `autopilot_state`
    // edge lands the real value.
    maxConcurrentPerRootStored: DEFAULT_MAX_CONCURRENT_PER_ROOT,
    // Seed `'yolo'` (the work-everything default) until the edge lands the mode.
    mode: "yolo",
    // Seed `false` (OFF, the default) until the `autopilot_state` edge lands it.
    worktreeMode: false,
    // Seed empty until the `armed_epics` subscribe edge lands.
    armedEpics: [],
    // Seed empty until the `worktree_repo_status` subscribe edge lands (or stays
    // empty when no epic is worktree-disabled).
    worktreeStatus: [],
  };

  const view = createViewShell<ViewerState>({
    script: "autopilot",
    title: "autopilot",
    // Snapshot: autopilot folds FIVE streams — readiness, dispatch_failures,
    // autopilot_state (paused/mode/cap), armed_epics, and worktree_repo_status.
    // The latch holds the snapshot until ALL FIVE report (readiness auto-reports
    // via `view.emit`, the other four via `reportSnapshotStream` below) so the
    // captured frame reflects the FOLDED state rather than the seed values.
    mode: mode === "watch" ? "live" : mode,
    streamCount: 5,
    // A healthy but fully-idle board (no working/stopped/failed dispatch, no
    // armed epics, no open-task DAG) renders zero body lines — emit an honest
    // idle line so the snapshot frame is never bare separators.
    snapshotEmptyLine: "idle — no active dispatches, failures, or armed epics",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(framesEmitter !== null
      ? {
          frames: {
            emitter: framesEmitter,
            durationMs: frames?.durationMs ?? null,
          },
        }
      : {}),
    persistentBannerPill: () =>
      autopilotBannerLabel({
        paused: state.paused,
        maxConcurrentJobs: state.maxConcurrentJobs,
        maxConcurrentPerRoot: effectivePerRootCap(
          state.maxConcurrentPerRootStored,
          state.worktreeMode,
        ),
        mode: state.mode,
        armedCount: state.armedEpics.length,
        worktreeMode: state.worktreeMode,
      }),
    renderBody: (snap) => {
      // The view-shell's TSnap is our own `ViewerState` (`snap === state`).
      const current = snap.snap === null ? [] : buildCurrentRows(snap.snap);
      const dependencies =
        snap.snap === null ? [] : renderDependencyGraph(snap.snap);
      return {
        bodyLines: renderBody({
          current,
          dependencies,
          failed: snap.failed,
          paused: snap.paused,
          armed: snap.armedEpics,
          worktree: snap.worktreeStatus,
        }),
        stateJson: {
          paused: snap.paused,
          mode: snap.mode,
          worktree_mode: snap.worktreeMode,
          armed: snap.armedEpics,
          current,
          dependencies,
          failed: snap.failed,
          worktree: snap.worktreeStatus,
        },
      };
    },
  });

  const bannerState = (): {
    paused: boolean;
    maxConcurrentJobs: number | null;
    maxConcurrentPerRoot: number;
    mode: "yolo" | "armed";
    armedCount: number;
    worktreeMode: boolean;
  } => ({
    paused: state.paused,
    maxConcurrentJobs: state.maxConcurrentJobs,
    maxConcurrentPerRoot: effectivePerRootCap(
      state.maxConcurrentPerRootStored,
      state.worktreeMode,
    ),
    mode: state.mode,
    armedCount: state.armedEpics.length,
    worktreeMode: state.worktreeMode,
  });

  // Seed the banner immediately so the human sees `[paused] · yolo · max ∞`
  // before the first snapshot lands.
  view.liveShell.setStatus(autopilotBannerLabel(bannerState()));

  // Per-secondary-stream one-shot snapshot-latch reports. The readiness stream
  // auto-reports via `view.emit`; the three `subscribeCollection` streams each
  // report their FIRST `onRows` exactly once. CRITICAL: report on the first
  // `onRows` regardless of row contents — an empty `result` is still that
  // stream's first frame, so the latch must count it or the snapshot hangs
  // until timeout. Inert in live mode.
  let failuresStreamReported = false;
  let pausedStreamReported = false;
  let armedStreamReported = false;
  let worktreeStreamReported = false;

  const readinessHandle = subscribeReadiness({
    sockPath,
    idPrefix: "autopilot",
    onSnapshot: (snap) => {
      state.snap = snap;
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
    // Thread the daemon fold cursor into the frames resume-cursor seam
    // (fn-1161), and the freshest header into the readiness gate so the loading
    // indicator's re-fold % advances during catch-up.
    onBootStatus: (boot) => {
      view.noteCursor(String(boot.rev));
      view.noteCatchingUp(boot.catching_up, boot);
    },
    // Gate live rendering on daemon readiness (the latched catch-up transition).
    onCatchingUp: (catchingUp, boot) => view.noteCatchingUp(catchingUp, boot),
  });

  const failuresHandle = subscribeCollection({
    sockPath,
    idPrefix: "autopilot",
    collection: "dispatch_failures",
    onRows: (rows) => {
      state.failed = projectFailedRows(rows);
      if (!failuresStreamReported) {
        failuresStreamReported = true;
        view.reportSnapshotStream();
      }
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
  });

  // Subscribe the singleton `autopilot_state` projection so the banner reflects
  // the daemon's real paused/playing flag. Keyed on `id = 1`; at most one row.
  // If the row hasn't folded yet (sub-ms boot race) `rows` is empty and the
  // seed `state.paused` is left untouched.
  const pausedHandle = subscribeCollection({
    sockPath,
    idPrefix: "autopilot",
    collection: "autopilot_state",
    onRows: (rows) => {
      // Report this stream's first frame to the snapshot latch BEFORE the
      // empty-rows early-return — an empty `result` is still the stream's first
      // delivered frame, so the latch must count it or a freshly-booted daemon
      // hangs the snapshot until timeout. Once per stream.
      if (!pausedStreamReported) {
        pausedStreamReported = true;
        view.reportSnapshotStream();
      }
      const paused = projectAutopilotPaused(rows);
      if (paused === null) {
        // Singleton not yet folded — leave the seeds untouched and wait.
        return;
      }
      state.paused = paused;
      // The cap + mode + worktree toggle ride the SAME singleton wire row as
      // `paused` — fold them on every edge so a config-change-then-restart and a
      // live toggle both land on the banner.
      state.maxConcurrentJobs = projectMaxConcurrentJobs(rows);
      state.maxConcurrentPerRootStored = projectMaxConcurrentPerRoot(rows);
      state.mode = projectAutopilotMode(rows) ?? "yolo";
      state.worktreeMode = projectWorktreeMode(rows) ?? false;
      view.liveShell.setStatus(autopilotBannerLabel(bannerState()));
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
  });

  // Subscribe the `armed_epics` presence table so the banner's armed-count +
  // the `--- armed ---` section reflect the live folded set. A row's presence
  // means the epic is explicitly armed.
  const armedHandle = subscribeCollection({
    sockPath,
    idPrefix: "autopilot",
    collection: "armed_epics",
    onRows: (rows) => {
      state.armedEpics = projectArmedEpics(rows);
      if (!armedStreamReported) {
        armedStreamReported = true;
        view.reportSnapshotStream();
      }
      view.liveShell.setStatus(autopilotBannerLabel(bannerState()));
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
  });

  // Subscribe the LIVE-ONLY `worktree_repo_status` collection (fn-1013) so the
  // neutral `--- worktree ---` section reflects the live worktree-disabled set. An
  // empty / pre-first-cycle collection leaves `worktreeStatus` empty (no section).
  const worktreeHandle = subscribeCollection({
    sockPath,
    idPrefix: "autopilot",
    collection: "worktree_repo_status",
    onRows: (rows) => {
      state.worktreeStatus = projectWorktreeStatusRows(rows);
      if (!worktreeStreamReported) {
        worktreeStreamReported = true;
        view.reportSnapshotStream();
      }
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
  });

  // Dispose ALL FIVE subscription handles before exit — disposing only the
  // primary leaks the other four sockets. The same fan-out feeds both the
  // live SIGINT teardown and the snapshot exit path.
  const disposeAll = (): void => {
    readinessHandle.dispose();
    failuresHandle.dispose();
    pausedHandle.dispose();
    armedHandle.dispose();
    worktreeHandle.dispose();
  };

  if (mode === "snapshot") {
    view.runSnapshot(disposeAll);
  } else if (mode === "frames") {
    view.runFrames(disposeAll);
  } else {
    view.installSigintHandler(disposeAll);
  }
}

/**
 * Started-epic guard for the `worktree <on|off>` toggle — query the daemon for
 * open epics and DIE LOUD if any is STARTED (`isEpicStarted`), so a worktree-mode
 * flip never lands mid-epic (where some lanes ran under the old mode and some
 * would run under the new one — a half-migrated, unrecoverable epic). A drained
 * board (no started epics), a board whose only open epics are unstarted, and a
 * zero-epic board all toggle freely; the operator's own interactive session no
 * longer trips the guard. `--force` bypasses (the documented escape hatch).
 *
 * The `epics` query passes NO filter so the descriptor's default open-scope
 * clause serves only open epics; ANY explicit filter would drop that clause.
 * Rows decode their `tasks`/`jobs`/`job_links` JSON columns at the read boundary,
 * so the nested fields `isEpicStarted` reads are real arrays — hence the
 * `as unknown as Epic[]` cast.
 *
 * A query transport failure DIES too — refusing to toggle blind is the safe side
 * (the operator can `--force` if they have out-of-band confidence the board is
 * idle). The `query` transport is injectable (defaults to `queryCollection`) so
 * the gate is unit-testable without a daemon. Exported for tests.
 */
export async function assertNoMidEpicDispatch(
  sockPath: string,
  force: boolean,
  die: (message: string) => never,
  query: (
    sockPath: string,
    collection: string,
  ) => Promise<Record<string, unknown>[]> = queryCollection,
): Promise<void> {
  if (force) {
    return;
  }
  let epics: Epic[];
  try {
    epics = (await query(sockPath, "epics")) as unknown as Epic[];
  } catch (err) {
    die(
      `cannot verify the board is idle before toggling worktree mode (${(err as Error).message}); pass --force to override if you know it is drained`,
    );
  }
  const started = epics.filter(isEpicStarted).map((e) => e.epic_id);
  if (started.length > 0) {
    die(
      `refusing to toggle worktree mode mid-epic: ${started.length} started open epic(s) in flight (${started.join(", ")}). Let the current epic(s) finish (or drain the board) and retry, or pass --force to override.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatcher entry — routes the (none) / pause / play / retry subcommands.
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    // Derived from the pure-data descriptor (ADR 0008). `timeout` is a string
    // (parseArgs has no number type), validated below; `force` rides the
    // `worktree <on|off>` mid-epic toggle-guard bypass.
    options: buildParseOptions(AUTOPILOT_FLAGS),
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (parsed.values["agent-help"]) {
    process.stdout.write(AGENT_HELP);
    process.exit(0);
  }

  const sockPath = parsed.values.sock ?? resolveSockPath();
  const [subcommand, ...rest] = parsed.positionals;

  if (subcommand === undefined) {
    // Viewer path only — the snapshot flags gate the viewer's run mode.
    // Resolve mode (flag > CI/TERM=dumb > stdout.isTTY !== true); both
    // `--snapshot` and `--watch` → typed misuse error → exit 2.
    let mode: SnapshotMode;
    try {
      mode = resolveSnapshotMode({
        snapshotFlag: parsed.values.snapshot ?? false,
        watchFlag: parsed.values.watch ?? false,
        stdoutIsTTY: process.stdout.isTTY,
        env: process.env,
      });
    } catch (err) {
      if (err instanceof SnapshotCliMisuseError) {
        process.stderr.write(`keeper autopilot: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
    // Validate `--timeout` (shared duration grammar) only when snapshotting — a
    // bad value is CLI misuse (exit 2). Watch mode ignores it.
    let timeoutMs: number | undefined;
    if (parsed.values.timeout !== undefined) {
      const dur = parseDuration(parsed.values.timeout);
      if (!dur.ok) {
        process.stderr.write(`keeper autopilot: --timeout ${dur.message}\n`);
        process.exit(2);
      }
      timeoutMs = dur.ms;
    }
    await runViewer(sockPath, mode, timeoutMs);
    return;
  }

  if (subcommand === "pause" || subcommand === "play") {
    if (rest.length > 0) {
      die(
        `'${subcommand}' takes no positional args (got ${rest.length}); pass --help for usage.`,
      );
    }
    const id = crypto.randomUUID();
    await sendControlRpc(
      sockPath,
      buildSetPausedFrame(id, subcommand === "pause"),
      id,
      AUTOPILOT_CONTROL_SCHEMA_VERSION,
    );
    return;
  }

  if (subcommand === "retry") {
    if (rest.length !== 1) {
      die(
        `'retry' takes exactly one positional <verb::id> (got ${rest.length}); pass --help for usage.`,
      );
    }
    const dispatchKey = rest[0];
    if (dispatchKey === undefined || dispatchKey === "") {
      die("'retry' requires a non-empty <verb::id> key");
    }
    const id = crypto.randomUUID();
    await sendControlRpc(
      sockPath,
      buildRetryFrame(id, dispatchKey),
      id,
      AUTOPILOT_CONTROL_SCHEMA_VERSION,
    );
    return;
  }

  if (subcommand === "mode") {
    // Validate the enum CLI-side so a typo dies with a clear message before the
    // round-trip (the server also rejects, but a local guard is friendlier).
    if (rest.length !== 1) {
      die(
        `'mode' takes exactly one positional <yolo|armed> (got ${rest.length}); pass --help for usage.`,
      );
    }
    const mode = rest[0];
    if (mode !== "yolo" && mode !== "armed") {
      die(`'mode' must be one of yolo | armed (got ${JSON.stringify(mode)})`);
    }
    const id = crypto.randomUUID();
    await sendControlRpc(
      sockPath,
      buildSetModeFrame(id, mode),
      id,
      AUTOPILOT_CONTROL_SCHEMA_VERSION,
    );
    return;
  }

  if (subcommand === "arm" || subcommand === "disarm") {
    if (rest.length !== 1) {
      die(
        `'${subcommand}' takes exactly one positional <epic-id> (got ${rest.length}); pass --help for usage.`,
      );
    }
    const epicId = rest[0];
    if (epicId === undefined || epicId === "") {
      die(`'${subcommand}' requires a non-empty <epic-id>`);
    }
    const id = crypto.randomUUID();
    await sendControlRpc(
      sockPath,
      buildSetArmedFrame(id, epicId, subcommand === "arm"),
      id,
      AUTOPILOT_CONTROL_SCHEMA_VERSION,
    );
    return;
  }

  if (subcommand === "config") {
    // `config <key> <value>` — the generic runtime config setter. Validate the
    // key + value CLI-side so a typo dies with a clear message before the
    // round-trip (the server re-validates). Keys: `max_concurrent_jobs` (a
    // positive integer cap, `unlimited`/`null` → unlimited), `max_concurrent_per_root`
    // (a positive integer count, `default`/`null` → the in-memory default = 1; NO
    // 'unlimited'), `worktree_multi_repo` (an on/off boolean — the durable
    // rollout flag that clusters a >1-toplevel epic into per-repo lane groups
    // instead of rejecting it; mirrors the `worktree` verb's on/off parsing),
    // and `codex_adoption` (an on/off boolean — the durable codex
    // rollout-adoption knob).
    if (rest.length !== 2) {
      die(
        `'config' takes exactly two positionals <key> <value> (got ${rest.length}); pass --help for usage.`,
      );
    }
    const [key, value] = rest;
    const id = crypto.randomUUID();
    if (key === "max_concurrent_jobs") {
      let cap: number | null;
      if (value === "unlimited" || value === "null") {
        cap = null;
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) {
          die(
            `'config max_concurrent_jobs' value must be a positive integer or 'unlimited' (got ${JSON.stringify(value)})`,
          );
        }
        cap = n;
      }
      await sendControlRpc(
        sockPath,
        buildSetConfigFrame(id, { max_concurrent_jobs: cap }),
        id,
        AUTOPILOT_CONTROL_SCHEMA_VERSION,
      );
      return;
    }
    if (key === "max_concurrent_per_root") {
      let n: number | null;
      if (value === "default" || value === "null") {
        n = null;
      } else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          die(
            `'config max_concurrent_per_root' value must be a positive integer or 'default' (got ${JSON.stringify(value)})`,
          );
        }
        n = parsed;
      }
      await sendControlRpc(
        sockPath,
        buildSetConfigFrame(id, { max_concurrent_per_root: n }),
        id,
        AUTOPILOT_CONTROL_SCHEMA_VERSION,
      );
      return;
    }
    if (key === "worktree_multi_repo") {
      // A durable on/off boolean rollout flag — mirror the `worktree` verb's
      // enum parsing, mapped to a boolean patch through the same generic RPC.
      if (value !== "on" && value !== "off") {
        die(
          `'config worktree_multi_repo' value must be one of on | off (got ${JSON.stringify(value)})`,
        );
      }
      await sendControlRpc(
        sockPath,
        buildSetConfigFrame(id, { worktree_multi_repo: value === "on" }),
        id,
        AUTOPILOT_CONTROL_SCHEMA_VERSION,
      );
      return;
    }
    if (key === "codex_adoption") {
      // The durable codex rollout-adoption knob — same on/off boolean shape as
      // worktree_multi_repo, patched through the same generic RPC.
      if (value !== "on" && value !== "off") {
        die(
          `'config codex_adoption' value must be one of on | off (got ${JSON.stringify(value)})`,
        );
      }
      await sendControlRpc(
        sockPath,
        buildSetConfigFrame(id, { codex_adoption: value === "on" }),
        id,
        AUTOPILOT_CONTROL_SCHEMA_VERSION,
      );
      return;
    }
    die(
      `'config' key must be one of max_concurrent_jobs | max_concurrent_per_root | worktree_multi_repo | codex_adoption (got ${JSON.stringify(key)})`,
    );
  }

  if (subcommand === "worktree") {
    // `worktree <on|off> [--force]` — the durable worktree-mode toggle. Validate
    // the enum CLI-side, run the mid-epic guard (bypassed by --force), then write
    // the boolean via the generic `set_autopilot_config` patch.
    if (rest.length !== 1) {
      die(
        `'worktree' takes exactly one positional <on|off> (got ${rest.length}); pass --help for usage.`,
      );
    }
    const onoff = rest[0];
    if (onoff !== "on" && onoff !== "off") {
      die(`'worktree' must be one of on | off (got ${JSON.stringify(onoff)})`);
    }
    await assertNoMidEpicDispatch(sockPath, parsed.values.force ?? false, die);
    const id = crypto.randomUUID();
    await sendControlRpc(
      sockPath,
      buildSetConfigFrame(id, { worktree_mode: onoff === "on" }),
      id,
      AUTOPILOT_CONTROL_SCHEMA_VERSION,
    );
    return;
  }

  if (subcommand === "show") {
    if (rest.length > 0) {
      die(
        `'show' takes no positional args (got ${rest.length}); pass --help for usage.`,
      );
    }
    await runAutopilotShow(sockPath, {
      writeStdout: (s) => process.stdout.write(s),
      exit: (code) => process.exit(code),
      query: (sock, collection) => queryCollection(sock, collection),
    });
    return;
  }

  die(
    `unknown subcommand '${subcommand}' (expected pause | play | mode | config | arm | disarm | retry | worktree | show); pass --help for usage.`,
  );
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical
// entry; direct `bun cli/autopilot.ts` invocation bypasses the dispatcher's
// arg-pruning.
