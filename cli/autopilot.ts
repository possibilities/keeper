#!/usr/bin/env bun
/**
 * `keeper autopilot` — thin viewer + control surface for the server-side
 * autopilot reconciler (fn-661).
 *
 * The reconciler itself lives in `src/autopilot-worker.ts` as a daemon
 * worker thread; this CLI does NOT dispatch, dedup, suppress, settle,
 * confirm, reap, or persist anything. Its only jobs are:
 *
 *   1. Render four sections of state, refreshed on every subscribe edge:
 *        --- current ---   live `working` `jobs` rows (the reconciler's
 *                          observed in-flight dispatches), ordered for scan
 *        --- stopped ---   `jobs` rows whose turn has ended (state
 *                          `stopped`) but whose session may still be alive
 *                          — the same working+stopped stream as `current`,
 *                          partitioned by state
 *        --- failed ---    rows from the `dispatch_failures` projection
 *                          (the only durable autopilot-owned state, fed by
 *                          the reducer's `DispatchFailed` fold arm)
 *        --- dependencies --- `renderDependencyGraph` — an ASCII DAG of the
 *                          open tasks keyed off `depends_on` (intra-epic)
 *                          and `depends_on_epics` (cross-epic). Reference
 *                          view, no dispatch behind it
 *      plus a `[paused]` / `[playing]` banner indicator.
 *
 *   2. Three control subcommands that round-trip a single RPC each:
 *        keeper autopilot pause          → set_autopilot_paused {paused:true}
 *        keeper autopilot play           → set_autopilot_paused {paused:false}
 *        keeper autopilot retry <key>    → retry_dispatch       {id:<key>}
 *      Where `<key>` is the canonical `${verb}::${id}` composite (e.g.
 *      `work::fn-619-foo.3`). Each subcommand opens a fresh `Bun.connect`,
 *      sends ONE `rpc` frame, awaits the matching `rpc_result` / `error`,
 *      and exits — same one-shot shape as `scripts/approve.ts`.
 *
 * Bare invocation (`keeper autopilot` with no subcommand) opens the
 * viewer. The viewer shares the `createViewShell` harness with `board` /
 * `jobs` / `git` — same alt-screen UX, same sidecar contract.
 *
 * Data plumbing:
 *  - The readiness collections (epics + jobs + subagent_invocations + git
 *    + dead_letters) ride one `subscribeReadiness` connection — same
 *    surface board.ts consumes, identical first-paint gating and
 *    capped-backoff reconnect contract.
 *  - The `dispatch_failures` collection rides its own `subscribeCollection`
 *    connection (server descriptor: `src/collections.ts`'s
 *    `DISPATCH_FAILURES_DESCRIPTOR`). Default-sort is `ts DESC`, so the
 *    freshest failure is on top.
 *  - The `autopilot_state` singleton (schema v47 / fn-667) rides its own
 *    `subscribeCollection` connection (descriptor:
 *    `AUTOPILOT_STATE_DESCRIPTOR`). One row at most (`id = 1`) carrying
 *    the durable paused/playing flag — the banner-truth substrate.
 *
 * Paused-state surfacing (schema v47 / fn-667):
 *  - The viewer subscribes the singleton `autopilot_state` projection
 *    alongside `dispatch_failures` and reflects the daemon's REAL
 *    paused/playing flag in the banner. The projection is fed by the
 *    reducer's `AutopilotPaused` fold arm — every pause/play RPC appends
 *    one synthetic event before flipping the in-memory worker gate, so
 *    the banner is byte-honest with the worker's dispatch decision.
 *  - The daemon boot-appends `AutopilotPaused{paused:true}` BEFORE the
 *    server worker spawns, so a viewer subscribing the instant the socket
 *    opens reads a real row (the boot re-arm), never an empty surface.
 *    The seed `paused: true` on first launch is only visible for the
 *    sub-ms window between viewer launch and the first subscribe edge.
 *
 * Sidecar / SIGINT semantics: identical to the other view-shell siblings —
 * three indexed sidecar files per frame (state JSON + frame text + per-
 * frame unified diff), plus the session meta + lifecycle sidecar.
 *
 * Usage:
 *   keeper autopilot [--sock <path>]            # viewer
 *   keeper autopilot pause [--sock <path>]      # control
 *   keeper autopilot play  [--sock <path>]      # control
 *   keeper autopilot retry <verb::id> [--sock <path>]  # control
 *   keeper autopilot --help
 */

import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "../src/protocol";
import type { Verdict } from "../src/readiness";
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

const HELP = `keeper autopilot — thin viewer + control surface for the server-side autopilot reconciler

Usage:
  keeper autopilot [--sock <path>] [--snapshot | --watch] [--timeout <s>]
  keeper autopilot pause [--sock <path>]
  keeper autopilot play  [--sock <path>]
  keeper autopilot mode <yolo|armed> [--sock <path>]
  keeper autopilot arm <epic-id> [--sock <path>]
  keeper autopilot disarm <epic-id> [--sock <path>]
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
  arm      Send set_epic_armed {epic_id:<id>, armed:true} and exit.
  disarm   Send set_epic_armed {epic_id:<id>, armed:false} and exit.
  retry    Send retry_dispatch {id:<verb::id>} and exit. <verb::id> is
           the canonical composite key (e.g. work::fn-619-foo.3).

Options:
  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot     (viewer only) Force one-shot snapshot mode (print one frame +
                 a machine-parseable keeper-meta: line, then exit) even on a TTY
  --watch        (viewer only) Force the live subscribe stream even when piped
  --timeout <s>  (viewer only) Snapshot wait before the timeout escape (~2s)
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

/**
 * Hard upper bound on how long a control subcommand waits for the
 * `rpc_result` / `error` frame after a successful connect. Matches the
 * sibling shape in `scripts/approve.ts` — 5s is generous; a healthy
 * daemon answers in sub-ms on local UDS.
 */
const RESPONSE_TIMEOUT_MS = 5000;

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
 * the short `.M` suffix; ids that don't belong to `epicId` pass through whole
 * (a cross-epic dep, should not happen for `depends_on` but rendered honestly). */
function shortTaskId(taskId: string, epicId: string): string {
  return epicId !== "" && taskId.startsWith(`${epicId}.`)
    ? taskId.slice(epicId.length)
    : taskId;
}

/**
 * Render the open-task dependency graph as an ASCII DAG. One block per epic
 * in board (`sort_path`) order; within a block, one line per task carrying a
 * status glyph, the short `.M` id, and a `← <deps>` clause naming the
 * `depends_on` upstreams it waits for. An epic that itself waits on other
 * epics annotates its header with `← epic:<id>` per `depends_on_epics`.
 *
 * Pure transform — returns the section body lines (the `--- dependencies ---`
 * header is added by `renderBody`). Empty array when there is nothing open.
 */
export function renderDependencyGraph(snap: ReadinessClientSnapshot): string[] {
  const out: string[] = [];
  for (const epic of snap.epics) {
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
 * One live dispatch row rendered under `--- current ---`. Sourced from
 * the `jobs` map in the readiness snapshot — every `working` /
 * `stopped` row whose `plan_verb` is one of the three dispatch verbs is
 * a current dispatch the reconciler launched.
 */
export interface CurrentRow {
  verb: "work" | "close" | "approve";
  id: string;
  /** Basename of `project_dir` — empty when none. */
  dir: string;
  /**
   * Live job state — `working` (actively running) splits into the
   * `--- current ---` section; `stopped` (turn ended, session may still
   * be alive) splits into `--- stopped ---`. The readiness `jobs` stream
   * is server-filtered to exactly these two states (`state NOT IN
   * ("ended","killed")`), so this is total.
   */
  state: "working" | "stopped";
  /** Sort key: created_at descending puts the freshest at the bottom. */
  created_at: number;
}

/**
 * One row of `dispatch_failures` shipped to the viewer. The wire shape is
 * `Record<string, unknown>` (subscribeCollection's general output); this
 * is the typed projection we render against. The reducer guarantees the
 * column set per `DISPATCH_FAILURES_DESCRIPTOR`.
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
  // Sort ascending by created_at (oldest first) so the freshest dispatch
  // is at the bottom — same scan-order convention the predicted /
  // completed sections used in the legacy renderer.
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
 * Coerce a singleton `autopilot_state` wire row's `paused` column to the
 * banner-facing boolean. The column is stored as INTEGER (`1` paused,
 * `0` playing). Defensive: an empty row set (singleton hasn't folded
 * yet — sub-ms boot race) returns `null` so the caller leaves the
 * seed `state.paused` untouched; a non-0/1 value falls back to `true`
 * (safer side, matches the daemon's boot default). Pure — exported for
 * tests. fn-667.
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
 * Coerce a singleton `autopilot_state` wire row's `max_concurrent_jobs`
 * column to the banner-facing cap. The column is a NULLABLE INTEGER (a
 * positive cap, or SQL NULL = unlimited). Sourced ENTIRELY over the socket —
 * the viewer NEVER reads config.yaml. Defensive across the full
 * absent → unlimited path: an empty row set (singleton hasn't folded yet —
 * sub-ms boot race), a NULL value (wire-decoded as JS `null`), a missing
 * column (pre-v60 wire shape), or any non-positive / non-integer value all
 * return `null` (= unlimited, rendered `∞`); only a positive integer returns
 * a numeric cap. Pure — exported for tests. fn-725.
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
 * Coerce a singleton `autopilot_state` wire row's `mode` column to the
 * banner-facing enum. Stored as TEXT (`'yolo'` work-everything, `'armed'`
 * armed-set-only). Defensive: an empty row set (singleton hasn't folded yet —
 * sub-ms boot race) returns `null` so the caller leaves the seed untouched;
 * any value other than the two legal literals falls back to `'yolo'` (the
 * backward-compatible work-everything default, matching the column default).
 * Pure — exported for tests. fn-751 task .3.
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
 * Project the `armed_epics` wire rows to a sorted list of the explicitly-armed
 * epic ids. The descriptor sorts `created_at DESC` server-side; we re-sort by
 * `epic_id` ASC for a stable, deterministic armed-section render (the screen
 * lists ids, not arm order). Pure — exported for tests. fn-751 task .3.
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
  /** fn-751: the explicitly-armed epic ids. The `--- armed ---` section
   * lists them (v1 shows explicit-armed only). An empty array renders
   * nothing — the "nothing armed in armed mode" callout lives on the banner,
   * not the body. Optional — an absent field renders no section. */
  armed?: string[];
}

/**
 * Render the body lines for one viewer frame. Four sections, each
 * emitted only when non-empty, in priority order: current (live
 * `working` jobs), stopped (jobs whose turn ended but whose session may
 * still be alive), failed (sticky failures awaiting human retry), and
 * dependencies (the open-task DAG). The `current` and `stopped` sections both source
 * from `input.current` — `buildCurrentRows` projects the whole
 * working+stopped jobs stream and `renderBody` partitions by `state`. The
 * leading `[paused]` / `[playing]` indicator lives on the live-shell
 * banner row, not the body — same convention as board's persistent-pill
 * restoration.
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

  // fn-751: the explicitly-armed epics. v1 lists explicit-armed only; the
  // dep-pulled-in/effective-set view is a documented future enhancement. The
  // banner already signals mode + count (incl. the "nothing armed" callout),
  // so an empty armed set renders no body section here.
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
 * exported so tests can assert the wire shape. Fn-751 task .3.
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
 * exported so tests can assert the wire shape. Fn-751 task .3.
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
 * One round-trip on a fresh UDS connection — copy of the proven shape
 * from `scripts/approve.ts:roundTrip`. Opens, writes the frame, awaits
 * the server frame whose `id === matchId`, closes. Resolves with the
 * matching frame; rejects on connect-fail, transport error, malformed
 * frame, server close before reply, or `RESPONSE_TIMEOUT_MS` elapsing
 * post-connect.
 */
async function roundTrip(
  sockPath: string,
  send: ClientFrame,
  matchId: string,
): Promise<ServerFrame> {
  return new Promise<ServerFrame>((resolve, reject) => {
    const buffer = new LineBuffer();
    let settled = false;
    let sock: Awaited<ReturnType<typeof Bun.connect>> | null = null;

    const settle = (err: Error | null, frame: ServerFrame | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        sock?.end();
      } catch {
        // best-effort
      }
      if (err) {
        reject(err);
      } else if (frame) {
        resolve(frame);
      } else {
        reject(new Error("internal: settle called with neither err nor frame"));
      }
    };

    const timeout = setTimeout(() => {
      settle(
        new Error(
          `no response from daemon within ${RESPONSE_TIMEOUT_MS}ms (id ${matchId})`,
        ),
        null,
      );
    }, RESPONSE_TIMEOUT_MS);
    timeout.unref?.();

    Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s;
          s.write(encodeFrame(send));
        },
        data(_s, chunk) {
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            settle(
              new Error(`protocol error: ${(err as Error).message}`),
              null,
            );
            return;
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            let frame: ServerFrame;
            try {
              frame = JSON.parse(line) as ServerFrame;
            } catch (err) {
              settle(
                new Error(`malformed server frame: ${(err as Error).message}`),
                null,
              );
              return;
            }
            if ((frame as { id?: string }).id !== matchId) {
              continue;
            }
            settle(null, frame);
            return;
          }
        },
        close() {
          settle(
            new Error(
              `daemon closed connection before responding (id ${matchId})`,
            ),
            null,
          );
        },
        error(_s, err) {
          settle(new Error(`socket error: ${err.message}`), null);
        },
      },
    }).catch((err: Error) => {
      settle(
        new Error(`failed to connect to ${sockPath}: ${err.message}`),
        null,
      );
    });
  });
}

function die(message: string): never {
  process.stderr.write(`autopilot: ${message}\n`);
  process.exit(1);
}

/**
 * Send one control RPC and exit. On `rpc_result` writes the value as one
 * JSON line to stdout and exits 0; on `error` / connect-fail / timeout
 * surfaces the reason via `die` (exit 1).
 */
async function sendControlRpc(
  sockPath: string,
  frame: ClientFrame,
  matchId: string,
): Promise<void> {
  let response: ServerFrame;
  try {
    response = await roundTrip(sockPath, frame, matchId);
  } catch (err) {
    die((err as Error).message);
  }
  if (response.type === "rpc_result") {
    process.stdout.write(`${JSON.stringify(response.value)}\n`);
    process.exit(0);
  }
  if (response.type === "error") {
    die(`server error ${response.code}: ${response.message}`);
  }
  die(`unexpected frame type: ${response.type}`);
}

// ---------------------------------------------------------------------------
// Viewer entry point.
// ---------------------------------------------------------------------------

interface ViewerState {
  snap: ReadinessClientSnapshot | null;
  failed: FailedRow[];
  paused: boolean;
  // fn-725: the global autopilot concurrency cap, sourced over the socket
  // from the `autopilot_state` singleton (NEVER config.yaml). `null` =
  // unlimited (rendered `∞`). Seeded `null` and overwritten by the
  // `autopilot_state` subscribe edge alongside `paused`.
  maxConcurrentJobs: number | null;
  // fn-751: the explicit autopilot mode, sourced over the socket from the
  // `autopilot_state` singleton's `mode` column. Seeded `'yolo'` (the
  // work-everything default) and overwritten by the `autopilot_state`
  // subscribe edge alongside `paused`.
  mode: "yolo" | "armed";
  // fn-751: the explicitly-armed epic ids, sourced over the socket from the
  // `armed_epics` presence table. v1 shows EXPLICIT-armed only; the
  // dep-pulled-in/effective-set view is a documented future enhancement.
  armedEpics: string[];
}

/**
 * Render the persistent banner pill from viewer state: the play/pause pill,
 * the fn-751 mode suffix, the fn-725 concurrency-cap suffix, and (in `armed`
 * mode) the armed-epic count. `[playing] · yolo · max 3` in yolo mode;
 * `[playing] · armed · 2 armed · max ∞` with two armed epics. The
 * empty-armed-set-in-armed-mode case renders DISTINCTLY as
 * `[playing] · armed · nothing armed` so idle-by-design (armed mode with no
 * armed epics dispatches nothing) is never mistaken for a broken autopilot.
 *
 * Pure — exported for tests. Mode + armed count are socket-sourced (via
 * `projectAutopilotMode` / `projectArmedEpics`); the cap via
 * `projectMaxConcurrentJobs`. The viewer never reads config.
 */
export function autopilotBannerLabel(state: {
  paused: boolean;
  maxConcurrentJobs: number | null;
  mode: "yolo" | "armed";
  armedCount: number;
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
  return `${pill} · ${state.mode}${armedSeg} · max ${cap}`;
}

async function runViewer(
  sockPath: string,
  mode: SnapshotMode = "watch",
  timeoutMs?: number,
): Promise<void> {
  const state: ViewerState = {
    snap: null,
    failed: [],
    // fn-667: seed `true` matches the daemon's boots-paused safety default
    // — the same value the boot-append re-arm folded into
    // `autopilot_state.paused` before the server worker spawned. As soon
    // as the `autopilot_state` subscribe below produces its first `result`
    // frame, `state.paused` is overwritten with the real folded value
    // (`row.paused === 1`), so this seed is only ever visible for the
    // sub-ms window between viewer launch and the first subscribe edge.
    paused: true,
    // fn-725: seed `null` (= unlimited) — the safe default before the
    // `autopilot_state` subscribe edge lands the real folded cap. Sourced
    // ONLY over the socket; the viewer never reads config.yaml.
    maxConcurrentJobs: null,
    // fn-751: seed `'yolo'` (the work-everything default) until the
    // `autopilot_state` subscribe edge lands the real folded mode.
    mode: "yolo",
    // fn-751: seed empty until the `armed_epics` subscribe edge lands.
    armedEpics: [],
  };

  const view = createViewShell<ViewerState>({
    script: "autopilot",
    title: "autopilot",
    // fn-772 snapshot branch: autopilot folds FOUR streams — readiness,
    // dispatch_failures, autopilot_state (paused/mode/cap), and armed_epics
    // — so `streamCount: 4`. The latch holds the snapshot until ALL FOUR
    // report (readiness via the auto-report in `view.emit`, the other three
    // via `reportSnapshotStream` below), so the captured frame reflects the
    // FOLDED mode/armed/failed state rather than the seed values. ALL FOUR
    // handles are disposed before exit (mirrors installSigintHandler's
    // teardown fan-out).
    mode: mode === "snapshot" ? "snapshot" : "live",
    streamCount: 4,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    // fn-751: the banner derives mode + armed-count from the live `state`
    // (the armed count is the explicit-armed list length).
    persistentBannerPill: () =>
      autopilotBannerLabel({
        paused: state.paused,
        maxConcurrentJobs: state.maxConcurrentJobs,
        mode: state.mode,
        armedCount: state.armedEpics.length,
      }),
    renderBody: (snap) => {
      // The view-shell's TSnap is our own `ViewerState`; we ignore the
      // arg (`snap === state` because we pass it through `view.emit`)
      // and pull from the live `state` reference so a `failed` update
      // that arrives between snapshots can still trigger a body change.
      const current = snap.snap === null ? [] : buildCurrentRows(snap.snap);
      const dependencies =
        snap.snap === null ? [] : renderDependencyGraph(snap.snap);
      return {
        bodyLines: renderBody({
          current,
          dependencies,
          failed: snap.failed,
          paused: snap.paused,
          // fn-751: the explicitly-armed epics (v1 lists explicit-armed only).
          armed: snap.armedEpics,
        }),
        stateJson: {
          paused: snap.paused,
          mode: snap.mode,
          armed: snap.armedEpics,
          current,
          dependencies,
          failed: snap.failed,
        },
      };
    },
  });

  // fn-751: derive the banner state from the live `ViewerState` — mode +
  // armed-count ride alongside paused + cap. The armed COUNT comes from the
  // explicit-armed list length.
  const bannerState = (): {
    paused: boolean;
    maxConcurrentJobs: number | null;
    mode: "yolo" | "armed";
    armedCount: number;
  } => ({
    paused: state.paused,
    maxConcurrentJobs: state.maxConcurrentJobs,
    mode: state.mode,
    armedCount: state.armedEpics.length,
  });

  // Seed the banner immediately so the human sees `[paused] · yolo · max ∞`
  // before the first snapshot lands — same shape as board's persistent-pill
  // restore pattern.
  view.liveShell.setStatus(autopilotBannerLabel(bannerState()));

  // fn-772: per-secondary-stream one-shot snapshot-latch reports. The
  // readiness stream auto-reports via `view.emit` (the first emit); the
  // three `subscribeCollection` streams each report their FIRST `onRows`
  // exactly once so `streamCount: 4` is satisfied only when ALL FOUR have
  // folded. The guards keep a re-fired collection edge from over-reporting.
  // CRITICAL: report on the FIRST `onRows` regardless of row contents — an
  // empty `result` (e.g. `autopilot_state` before the singleton folds) is
  // still that stream's first frame, so the latch must count it or the
  // snapshot hangs until timeout. Inert in live mode.
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

  // fn-667: subscribe the singleton `autopilot_state` projection so the
  // banner reflects the daemon's real paused/playing flag (pre-fn-667 the
  // banner was hardcoded `true` because there was no read surface for the
  // in-memory flag). The collection is keyed on `id = 1` (singleton); we
  // expect at most one row. Defensive on empty/missing rows: if the row
  // hasn't folded yet (sub-ms boot race) `rows` is empty and we leave
  // the seed `state.paused` untouched. Re-subscribes cleanly on socket
  // drop via the shared `subscribeCollection` reconnect contract.
  const pausedHandle = subscribeCollection({
    sockPath,
    idPrefix: "autopilot",
    collection: "autopilot_state",
    onRows: (rows) => {
      // fn-772: report this stream's first frame to the snapshot latch
      // BEFORE the empty-rows early-return — an empty `result` is still the
      // `autopilot_state` stream's first delivered frame, so the latch must
      // count it or a freshly-booted daemon (singleton not yet folded)
      // hangs the snapshot until timeout. Once per stream.
      if (!pausedStreamReported) {
        pausedStreamReported = true;
        view.reportSnapshotStream();
      }
      const paused = projectAutopilotPaused(rows);
      if (paused === null) {
        // Singleton hasn't folded yet (sub-ms boot race) — empty row set.
        // Leave the seed `state.paused` / `state.maxConcurrentJobs`
        // untouched and wait for the next edge. (`projectMaxConcurrentJobs`
        // would also return `null` here, so there is nothing real to fold.)
        return;
      }
      state.paused = paused;
      // fn-725: the cap rides the SAME singleton wire row as `paused` — fold
      // it on every edge so a config-change-then-restart's re-minted cap and
      // a live pause/play toggle both land on the banner. `null` = unlimited.
      state.maxConcurrentJobs = projectMaxConcurrentJobs(rows);
      // fn-751: the mode rides the SAME singleton row — fold it on every edge.
      // `projectAutopilotMode` returns `null` only on an empty row set (already
      // handled by the `paused === null` early-return above), so here it always
      // yields a concrete `'yolo' | 'armed'`.
      state.mode = projectAutopilotMode(rows) ?? "yolo";
      view.liveShell.setStatus(autopilotBannerLabel(bannerState()));
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
  });

  // fn-751: subscribe the `armed_epics` presence table so the banner's
  // armed-count + the `--- armed ---` section reflect the live folded set.
  // A row's presence means the epic is explicitly armed. Re-subscribes cleanly
  // on socket drop via the shared reconnect contract.
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

  // fn-772: dispose ALL FOUR subscription handles before exit — wiring only
  // the primary leaks the other three sockets (Bun's "socket closed with
  // buffered data" warning). The same fan-out feeds both the live SIGINT
  // teardown and the snapshot exit path.
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
    await sendControlRpc(sockPath, buildRetryFrame(id, dispatchKey), id);
    return;
  }

  if (subcommand === "mode") {
    // fn-751: `mode <yolo|armed>` → set_autopilot_mode. Validate the enum
    // CLI-side so a typo dies with a clear message before the round-trip (the
    // server also rejects, but a local guard is friendlier).
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
    await sendControlRpc(sockPath, buildSetModeFrame(id, mode), id);
    return;
  }

  if (subcommand === "arm" || subcommand === "disarm") {
    // fn-751: `arm <epic-id>` / `disarm <epic-id>` → set_epic_armed with
    // armed true/false.
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
    );
    return;
  }

  die(
    `unknown subcommand '${subcommand}' (expected pause | play | mode | arm | disarm | retry); pass --help for usage.`,
  );
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical
// entry. Direct `bun cli/autopilot.ts` invocation would bypass the
// dispatcher's arg-pruning.
