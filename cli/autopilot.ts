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
import { resolveSockPath } from "../src/db";
import type { ClientFrame } from "../src/protocol";
import { orderEpicsForScheduling, type Verdict } from "../src/readiness";
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
import type { Task } from "../src/types";
import { createViewShell } from "../src/view-shell";
import { queryCollection, sendControlRpc } from "./control-rpc";

const HELP = `keeper autopilot — thin viewer + control surface for the server-side autopilot reconciler

Usage:
  keeper autopilot [--sock <path>] [--snapshot | --watch] [--timeout <s>]
  keeper autopilot pause [--sock <path>]
  keeper autopilot play  [--sock <path>]
  keeper autopilot mode <yolo|armed> [--sock <path>]
  keeper autopilot config <key> <value> [--sock <path>]
  keeper autopilot arm <epic-id> [--sock <path>]
  keeper autopilot disarm <epic-id> [--sock <path>]
  keeper autopilot worktree <on|off> [--force] [--sock <path>]
  keeper autopilot retry <verb::id> [--sock <path>]
  keeper autopilot --help

Subcommands:
  (none)   Open the alt-screen viewer rendering the live current /
           stopped / failed / armed / dependencies sections plus the
           paused + mode + armed-count banner.
  pause    Send set_autopilot_paused {paused:true} and exit.
  play     Send set_autopilot_paused {paused:false} and exit.
  mode     Send set_autopilot_mode {mode:<yolo|armed>} and exit. yolo works
           every ready epic; armed works ONLY explicitly-armed epics plus
           their transitive upstream dep-closure.
  config   Send set_autopilot_config {<key>:<value>} and exit. Runtime-sets a
           scalar autopilot config value. Keys: max_concurrent_jobs (a positive
           integer cap, or 'unlimited' to clear it); max_concurrent_per_root (a
           positive integer count of concurrent tasks per root, or 'default'/1).
           e.g. keeper autopilot config max_concurrent_jobs 8
                keeper autopilot config max_concurrent_per_root 3
  arm      Send set_epic_armed {epic_id:<id>, armed:true} and exit.
  disarm   Send set_epic_armed {epic_id:<id>, armed:false} and exit.
  worktree Send set_autopilot_config {worktree_mode:<on|off>} and exit. Durable
           toggle for worktree-shaped autopilot dispatch (OFF by default).
           REJECTED mid-epic (any live job or pending dispatch in flight) so a
           flip never half-migrates an epic; pass --force to override.
  retry    Send retry_dispatch {id:<verb::id>} and exit. <verb::id> is
           the canonical composite key (e.g. work::fn-619-foo.3). verb is
           one of work|close|approve; approve clears a resurrected/phantom
           approve pending (the reconciler never dispatches approve itself).

Options:
  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot     (viewer only) Force one-shot snapshot mode (print one frame +
                 a machine-parseable keeper-meta: line, then exit) even on a TTY
  --watch        (viewer only) Force the live subscribe stream even when piped
  --timeout <s>  (viewer only) Snapshot wait before the timeout escape (~2s)
  --force        (worktree only) Bypass the mid-epic toggle guard
  --help         Show this help

By default the viewer's stdout that is NOT a TTY (piped into an agent)
auto-detects snapshot mode; a TTY gets the live alt-screen viewer. \`CI\` /
\`TERM=dumb\` force snapshot.

The viewer is read-only — every dispatch, dedup, confirm, settle, and reap
decision happens in keeperd's autopilot worker thread. Use pause / play
to toggle the worker (boots PAUSED for safety), mode / arm / disarm to gate
which epics armed mode works, and retry to clear a sticky failure row.
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
  },
): ClientFrame {
  return {
    type: "rpc",
    id,
    method: "set_autopilot_config",
    params: patch,
  };
}

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
  // The explicit autopilot mode, sourced from the `autopilot_state` singleton's
  // `mode` column.
  mode: "yolo" | "armed";
  // The durable worktree-mode toggle, sourced from the `autopilot_state`
  // singleton's `worktree_mode` column. `false` (OFF) is the default.
  worktreeMode: boolean;
  // The explicitly-armed epic ids, sourced from the `armed_epics` presence
  // table.
  armedEpics: string[];
}

/**
 * Render the persistent banner pill: the play/pause pill, the mode suffix, the
 * concurrency-cap suffix, (in `armed` mode) the armed-epic count, and the
 * worktree-mode suffix. `[playing] · yolo · max 3 · worktree:off` in yolo mode;
 * `[playing] · armed · 2 armed · max ∞ · worktree:on` with two armed epics and
 * worktree mode on. The empty-armed-set-in-armed-mode case renders DISTINCTLY as
 * `[playing] · armed · nothing armed` so idle-by-design is never mistaken for a
 * broken autopilot. The worktree segment renders for BOTH on and off so the live
 * toggle is always scannable.
 *
 * Pure — exported for tests. All values are socket-sourced; the viewer never
 * reads config.
 */
export function autopilotBannerLabel(state: {
  paused: boolean;
  maxConcurrentJobs: number | null;
  mode: "yolo" | "armed";
  armedCount: number;
  worktreeMode: boolean;
}): string {
  const pill = state.paused ? "[paused]" : "[playing]";
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
  // Worktree segment renders for BOTH states (terse `worktree:on`/`worktree:off`)
  // so the live durable toggle is always visible at a glance.
  const worktreeSeg = state.worktreeMode ? " · worktree:on" : " · worktree:off";
  return `${pill} · ${state.mode}${armedSeg} · max ${cap}${worktreeSeg}`;
}

async function runViewer(
  sockPath: string,
  mode: SnapshotMode = "watch",
  timeoutMs?: number,
): Promise<void> {
  const state: ViewerState = {
    snap: null,
    failed: [],
    // Seed `true` to match the daemon's boots-paused safety default; the first
    // `autopilot_state` subscribe edge overwrites it with the folded value.
    paused: true,
    // Seed `null` (= unlimited) until the `autopilot_state` edge lands the cap.
    maxConcurrentJobs: null,
    // Seed `'yolo'` (the work-everything default) until the edge lands the mode.
    mode: "yolo",
    // Seed `false` (OFF, the default) until the `autopilot_state` edge lands it.
    worktreeMode: false,
    // Seed empty until the `armed_epics` subscribe edge lands.
    armedEpics: [],
  };

  const view = createViewShell<ViewerState>({
    script: "autopilot",
    title: "autopilot",
    // Snapshot: autopilot folds FOUR streams — readiness, dispatch_failures,
    // autopilot_state (paused/mode/cap), and armed_epics. The latch holds the
    // snapshot until ALL FOUR report (readiness auto-reports via `view.emit`,
    // the other three via `reportSnapshotStream` below) so the captured frame
    // reflects the FOLDED state rather than the seed values.
    mode: mode === "snapshot" ? "snapshot" : "live",
    streamCount: 4,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    persistentBannerPill: () =>
      autopilotBannerLabel({
        paused: state.paused,
        maxConcurrentJobs: state.maxConcurrentJobs,
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
        }),
        stateJson: {
          paused: snap.paused,
          mode: snap.mode,
          worktree_mode: snap.worktreeMode,
          armed: snap.armedEpics,
          current,
          dependencies,
          failed: snap.failed,
        },
      };
    },
  });

  const bannerState = (): {
    paused: boolean;
    maxConcurrentJobs: number | null;
    mode: "yolo" | "armed";
    armedCount: number;
    worktreeMode: boolean;
  } => ({
    paused: state.paused,
    maxConcurrentJobs: state.maxConcurrentJobs,
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

  const readinessHandle = subscribeReadiness({
    sockPath,
    idPrefix: "autopilot",
    onSnapshot: (snap) => {
      state.snap = snap;
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
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

  // Dispose ALL FOUR subscription handles before exit — disposing only the
  // primary leaks the other three sockets. The same fan-out feeds both the
  // live SIGINT teardown and the snapshot exit path.
  const disposeAll = (): void => {
    readinessHandle.dispose();
    failuresHandle.dispose();
    pausedHandle.dispose();
    armedHandle.dispose();
  };

  if (mode === "snapshot") {
    view.runSnapshot(disposeAll);
  } else {
    view.installSigintHandler(disposeAll);
  }
}

/**
 * Mid-epic guard for the `worktree <on|off>` toggle — query the daemon for any
 * in-flight dispatch and DIE LOUD if one exists, so a worktree-mode flip never
 * lands mid-epic (where some lanes ran under the old mode and some would run
 * under the new one — a half-migrated, unrecoverable epic). "Mid-flight" means a
 * live (non-terminal) `jobs` row OR an open `pending_dispatches` row (the
 * launch→SessionStart blind window). `--force` bypasses (the documented
 * escape hatch that teaches manual draining).
 *
 * A query transport failure DIES too — refusing to toggle blind is the safe side
 * (the operator can `--force` if they have out-of-band confidence the board is
 * idle). Exported for tests.
 */
export async function assertNoMidEpicDispatch(
  sockPath: string,
  force: boolean,
  die: (message: string) => never,
): Promise<void> {
  if (force) {
    return;
  }
  let liveJobs: Record<string, unknown>[];
  let pending: Record<string, unknown>[];
  try {
    // No explicit filter → the `jobs` descriptor's default `state not_in
    // (ended, killed)` scopes to LIVE rows; `pending_dispatches` carries one row
    // per in-flight dispatch in the launch→SessionStart blind window.
    [liveJobs, pending] = await Promise.all([
      queryCollection(sockPath, "jobs"),
      queryCollection(sockPath, "pending_dispatches"),
    ]);
  } catch (err) {
    die(
      `cannot verify the board is idle before toggling worktree mode (${(err as Error).message}); pass --force to override if you know it is drained`,
    );
  }
  const inFlight = liveJobs.length + pending.length;
  if (inFlight > 0) {
    die(
      `refusing to toggle worktree mode mid-epic: ${liveJobs.length} live job(s) + ${pending.length} pending dispatch(es) in flight. Drain the board (or wait for the current epics to finish) and retry, or pass --force to override.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatcher entry — routes the (none) / pause / play / retry subcommands.
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      sock: { type: "string" },
      snapshot: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      // parseArgs has no number type — capture as a string and validate
      // manually below (exit 2 on a non-positive / non-numeric value).
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
      // `worktree <on|off> --force` — bypass the mid-epic toggle guard.
      force: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (parsed.values.help) {
    process.stdout.write(HELP);
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
    // Validate `--timeout` (seconds) only when snapshotting — a bad value is
    // CLI misuse (exit 2). Watch mode ignores it.
    let timeoutMs: number | undefined;
    if (parsed.values.timeout !== undefined) {
      const secs = Number(parsed.values.timeout);
      if (!Number.isFinite(secs) || secs <= 0) {
        process.stderr.write(
          `keeper autopilot: --timeout must be a positive number of seconds (got '${parsed.values.timeout}')\n`,
        );
        process.exit(2);
      }
      timeoutMs = Math.round(secs * 1000);
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
      die,
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
    await sendControlRpc(sockPath, buildRetryFrame(id, dispatchKey), id, die);
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
    await sendControlRpc(sockPath, buildSetModeFrame(id, mode), id, die);
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
      die,
    );
    return;
  }

  if (subcommand === "config") {
    // `config <key> <value>` — the generic runtime config setter. Validate the
    // key + value CLI-side so a typo dies with a clear message before the
    // round-trip (the server re-validates). Keys: `max_concurrent_jobs` (a
    // positive integer cap, `unlimited`/`null` → unlimited) and
    // `max_concurrent_per_root` (a positive integer count, `default`/`null` → the
    // in-memory default = 1; NO 'unlimited').
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
        die,
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
        die,
      );
      return;
    }
    die(
      `'config' key must be one of max_concurrent_jobs | max_concurrent_per_root (got ${JSON.stringify(key)})`,
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
      die,
    );
    return;
  }

  die(
    `unknown subcommand '${subcommand}' (expected pause | play | mode | config | arm | disarm | retry | worktree); pass --help for usage.`,
  );
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical
// entry; direct `bun cli/autopilot.ts` invocation bypasses the dispatcher's
// arg-pruning.
