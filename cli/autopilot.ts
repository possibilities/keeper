#!/usr/bin/env bun
/**
 * `keeper autopilot` — thin viewer + control surface for the server-side
 * autopilot reconciler (fn-661).
 *
 * The reconciler itself lives in `src/autopilot-worker.ts` as a daemon
 * worker thread; this CLI does NOT dispatch, dedup, suppress, settle,
 * confirm, reap, or persist anything. Its only jobs are:
 *
 *   1. Render three sections of state, refreshed on every subscribe edge:
 *        --- current ---   live `jobs` rows (the reconciler's observed
 *                          dispatches), ordered for human scan
 *        --- predicted --- `predictNextDispatches` over the live readiness
 *                          snapshot — pure preview, NO dispatch behind it
 *        --- failed ---    rows from the `dispatch_failures` projection
 *                          (the only durable autopilot-owned state, fed by
 *                          the reducer's `DispatchFailed` fold arm)
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
 *
 * Paused-state surfacing:
 *  - The daemon does NOT expose a `get_autopilot_paused` query — the
 *    `paused` flag is in-memory on main and boots `true` by safety
 *    invariant. The viewer mirrors that: starts the banner at `[paused]`
 *    and flips to `[playing]` / back when a successful pause/play RPC
 *    round-trips. Until the human runs `play` / `pause`, the banner is
 *    showing the boot-time default, not a real read — that's an
 *    intentional simplification of the epic ("never persisted" applies to
 *    the daemon side too).
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
import { computeReadiness } from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeCollection,
  subscribeReadiness,
} from "../src/readiness-client";
import type { Epic, Task } from "../src/types";
import { createViewShell } from "../src/view-shell";

const HELP = `keeper autopilot — thin viewer + control surface for the server-side autopilot reconciler

Usage:
  keeper autopilot [--sock <path>]
  keeper autopilot pause [--sock <path>]
  keeper autopilot play  [--sock <path>]
  keeper autopilot retry <verb::id> [--sock <path>]
  keeper autopilot --help

Subcommands:
  (none)   Open the alt-screen viewer rendering the live current /
           predicted / failed sections plus the paused indicator.
  pause    Send set_autopilot_paused {paused:true} and exit.
  play     Send set_autopilot_paused {paused:false} and exit.
  retry    Send retry_dispatch {id:<verb::id>} and exit. <verb::id> is
           the canonical composite key (e.g. work::fn-619-foo.3).

Options:
  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --help         Show this help

The viewer is read-only — every dispatch, dedup, confirm, settle, and reap
decision happens in keeperd's autopilot worker thread. Use pause / play
to toggle the worker (boots PAUSED for safety) and retry to clear a
sticky failure row.
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
// Predicted-section preview — pure transform over the live readiness snapshot.
// ---------------------------------------------------------------------------

/**
 * One row in the predicted section's preview. `verb` is the dispatch verb
 * (`work` / `close` / `approve`) or the informational `git-dirty` signal
 * (no dispatch behind it — surfaces when the worker has uncommitted /
 * orphan files that block the approve dispatch).
 */
export interface PreviewRow {
  verb: "work" | "close" | "approve" | "git-dirty";
  id: string;
  /** Basename of the cd target — empty string when none. */
  dir: string;
  /** Full cd target path — empty string when none. */
  dirFull: string;
  /** Task tier (work rows only); `null` for close/approve/git-dirty. */
  tier: string | null;
}

export interface PreviewSections {
  approvals: PreviewRow[];
  informational: PreviewRow[];
  workers: PreviewRow[];
  closers: PreviewRow[];
}

function taskCdDir(task: Task, projectDir: string): string {
  if (task.target_repo != null && seg(task.target_repo) !== "") {
    return seg(task.target_repo);
  }
  return projectDir;
}

function previewRowFromTask(
  task: Task,
  projectDir: string,
  verb: "work" | "approve" | "git-dirty",
): PreviewRow {
  const dirFull = taskCdDir(task, projectDir);
  return {
    verb,
    id: seg(task.task_id),
    dir: dirFull === "" ? "" : basename(dirFull),
    dirFull,
    tier: verb === "work" ? task.tier : null,
  };
}

function previewRowFromEpic(
  epic: Epic,
  verb: "close" | "approve" | "git-dirty",
): PreviewRow {
  const projectDir = seg(epic.project_dir);
  return {
    verb,
    id: seg(epic.epic_id),
    dir: projectDir === "" ? "" : basename(projectDir),
    dirFull: projectDir,
    tier: null,
  };
}

/**
 * Predict the next dispatches the reconciler will fire as in-flight jobs
 * finish. Pure transform of the snapshot:
 *
 *   - `--- predicted ---` sources four buckets from ONE `computeReadiness`
 *     pass over a verb-aware simulated tree. Each `working` embedded job
 *     has its post-completion effect mirrored onto the owning row keyed
 *     off `plan_verb` (work → worker_phase=done; close → status=done;
 *     approve → approval=approved). A row currently at `ready` is treated
 *     as if its section-1 dispatch already completed (one step ahead).
 *
 *   - The `git-dirty::<id>` informational bucket is sourced OFF current
 *     readiness, NOT the simulated future — predicate 6.5 only fires once
 *     the worker has stopped, so a `git-dirty` row only surfaces when the
 *     worker is genuinely done and the worktree's dirtiness is the next
 *     blocker.
 *
 * Approval is NEVER auto-flipped for rows whose only in-flight job is a
 * worker — that prevents spurious `approve::<epic>` rows that the legacy
 * "active + not approved" rule emitted via close-row fan-up.
 *
 * Pause-invariance: the function reads ONLY the snapshot; no module-level
 * state, no I/O, no clock.
 */
export function predictNextDispatches(
  snap: ReadinessClientSnapshot,
): PreviewSections {
  // Informational pre-pass — see jsdoc above for why this reads `cur`.
  const informational: PreviewRow[] = [];
  for (const epic of snap.epics) {
    const projectDir = seg(epic.project_dir);
    const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
    for (const task of tasks) {
      const taskId = seg(task.task_id);
      if (taskId === "") {
        continue;
      }
      const cur = snap.readiness.perTask.get(taskId);
      if (
        cur?.tag === "blocked" &&
        (cur.reason.kind === "git-uncommitted" ||
          cur.reason.kind === "git-orphans")
      ) {
        informational.push(previewRowFromTask(task, projectDir, "git-dirty"));
      }
    }
    const epicId = seg(epic.epic_id);
    if (epicId === "") {
      continue;
    }
    const curClose = snap.readiness.perCloseRow.get(epicId);
    if (
      curClose?.tag === "blocked" &&
      (curClose.reason.kind === "git-uncommitted" ||
        curClose.reason.kind === "git-orphans")
    ) {
      informational.push(previewRowFromEpic(epic, "git-dirty"));
    }
  }

  // Build a verb-aware simulated tree. For each embedded job whose
  // `state === "working"`, mirror its post-completion effect onto the
  // owning row keyed off `plan_verb`. For each row whose CURRENT verdict
  // is `ready`, advance its own dispatch-completion flag too.
  let dirty = false;
  const simulatedEpics: Epic[] = snap.epics.map((epic) => {
    const epicJobs = Array.isArray(epic.jobs) ? epic.jobs : [];
    const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
    const epicId = seg(epic.epic_id);

    let simEpicStatus = epic.status;
    let simEpicApproval = epic.approval;
    let epicTouched = false;
    for (const job of epicJobs) {
      if (job.state !== "working") {
        continue;
      }
      if (job.plan_verb === "close") {
        simEpicStatus = "done";
        epicTouched = true;
      } else if (job.plan_verb === "approve") {
        simEpicApproval = "approved";
        epicTouched = true;
      }
    }
    const curClose =
      epicId === "" ? undefined : snap.readiness.perCloseRow.get(epicId);
    if (curClose?.tag === "ready") {
      simEpicStatus = "done";
      epicTouched = true;
    }
    const simEpicJobs = epicTouched
      ? epicJobs.map((j) =>
          j.state === "working"
            ? {
                ...j,
                state: "ended",
                git_dirty_count: 0,
                git_unattributed_to_live_count: 0,
                git_orphan_count: 0,
              }
            : j,
        )
      : epicJobs;

    let anyTaskTouched = false;
    const simTasks = tasks.map((task) => {
      const taskJobs = Array.isArray(task.jobs) ? task.jobs : [];
      const taskId = seg(task.task_id);

      let simWorkerPhase = task.worker_phase;
      let simApproval = task.approval;
      let taskTouched = false;
      for (const job of taskJobs) {
        if (job.state !== "working") {
          continue;
        }
        if (job.plan_verb === "work") {
          simWorkerPhase = "done";
          taskTouched = true;
        } else if (job.plan_verb === "approve") {
          simApproval = "approved";
          taskTouched = true;
        }
      }
      const curTask =
        taskId === "" ? undefined : snap.readiness.perTask.get(taskId);
      if (curTask?.tag === "ready") {
        simWorkerPhase = "done";
        taskTouched = true;
      }
      if (!taskTouched) {
        return task;
      }
      anyTaskTouched = true;
      return {
        ...task,
        worker_phase: simWorkerPhase,
        approval: simApproval,
        jobs: taskJobs.map((j) =>
          j.state === "working"
            ? {
                ...j,
                state: "ended",
                git_dirty_count: 0,
                git_unattributed_to_live_count: 0,
                git_orphan_count: 0,
              }
            : j,
        ),
      };
    });

    if (!epicTouched && !anyTaskTouched) {
      return epic;
    }
    dirty = true;
    return {
      ...epic,
      status: simEpicStatus,
      approval: simEpicApproval,
      jobs: simEpicJobs,
      tasks: simTasks,
    };
  });

  if (!dirty) {
    return { approvals: [], informational, workers: [], closers: [] };
  }

  // Empty git-status map: the simulator builds a synthetic `Epic[]` and
  // doesn't model live git state. The real readiness pipeline does the
  // live `git_status` lookup before approve/dispatch lands.
  const futureReadiness = computeReadiness(
    simulatedEpics,
    snap.jobs,
    [],
    new Map(),
  );

  const approvals: PreviewRow[] = [];
  const workers: PreviewRow[] = [];
  const closers: PreviewRow[] = [];
  for (const epic of snap.epics) {
    const projectDir = seg(epic.project_dir);
    const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
    for (const task of tasks) {
      const taskId = seg(task.task_id);
      if (taskId === "") {
        continue;
      }
      const cur = snap.readiness.perTask.get(taskId);
      if (cur === undefined || cur.tag === "completed") {
        continue;
      }
      const fut = futureReadiness.perTask.get(taskId);
      if (fut?.tag === "blocked" && fut.reason.kind === "job-pending") {
        approvals.push(previewRowFromTask(task, projectDir, "approve"));
      } else if (
        (cur.tag === "blocked" || cur.tag === "running") &&
        fut?.tag === "ready"
      ) {
        workers.push(previewRowFromTask(task, projectDir, "work"));
      }
    }
    const epicId = seg(epic.epic_id);
    if (epicId === "") {
      continue;
    }
    const cur = snap.readiness.perCloseRow.get(epicId);
    if (cur === undefined || cur.tag === "completed") {
      continue;
    }
    const fut = futureReadiness.perCloseRow.get(epicId);
    if (fut?.tag === "blocked" && fut.reason.kind === "job-pending") {
      approvals.push(previewRowFromEpic(epic, "approve"));
    } else if (
      (cur.tag === "blocked" || cur.tag === "running") &&
      fut?.tag === "ready"
    ) {
      closers.push(previewRowFromEpic(epic, "close"));
    }
  }

  return { approvals, informational, workers, closers };
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

// ---------------------------------------------------------------------------
// Body renderer — pure (fixtures → lines).
// ---------------------------------------------------------------------------

export interface RenderInput {
  current: CurrentRow[];
  predicted: PreviewSections;
  failed: FailedRow[];
  paused: boolean;
}

/**
 * Render the body lines for one viewer frame. Three sections, each
 * emitted only when non-empty, in priority order: current (live work),
 * predicted (next dispatches), failed (sticky failures awaiting human
 * retry). The leading `[paused]` / `[playing]` indicator lives on the
 * live-shell banner row, not the body — same convention as board's
 * persistent-pill restoration.
 *
 * Pure — exported for tests.
 */
export function renderBody(input: RenderInput): string[] {
  const out: string[] = [];

  if (input.current.length > 0) {
    out.push("--- current ---");
    for (const r of input.current) {
      const dirSeg = r.dir === "" ? "" : `(${r.dir}) `;
      out.push(`${dirSeg}${r.verb}::${r.id}`);
    }
  }

  const { approvals, informational, workers, closers } = input.predicted;
  if (
    approvals.length !== 0 ||
    informational.length !== 0 ||
    workers.length !== 0 ||
    closers.length !== 0
  ) {
    out.push("--- predicted ---");
    const predictedRows = [
      ...approvals,
      ...informational,
      ...workers,
      ...closers,
    ];
    const maxDirLen = predictedRows.reduce(
      (m, r) => Math.max(m, r.dir.length),
      0,
    );
    const dirColWidth = maxDirLen === 0 ? 0 : maxDirLen + 3;
    for (const r of predictedRows) {
      const dirSegRaw = r.dir === "" ? "" : `(${r.dir}) `;
      const dirSeg = dirSegRaw.padEnd(dirColWidth);
      out.push(`${dirSeg}${r.verb}::${r.id}`);
    }
  }

  if (input.failed.length > 0) {
    out.push("--- failed ---");
    for (const r of input.failed) {
      const dirSeg = r.dir === "" ? "" : `(${r.dir}) `;
      out.push(`${dirSeg}${r.verb}::${r.id} — ${r.reason}`);
    }
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
}

async function runViewer(sockPath: string): Promise<void> {
  const state: ViewerState = {
    snap: null,
    failed: [],
    // Boot-time invariant — the daemon also boots paused. The banner
    // flips on the first successful pause/play RPC round-trip.
    paused: true,
  };

  const view = createViewShell<ViewerState>({
    script: "autopilot",
    title: "autopilot",
    persistentBannerPill: () => (state.paused ? "[paused]" : "[playing]"),
    renderBody: (snap) => {
      // The view-shell's TSnap is our own `ViewerState`; we ignore the
      // arg (`snap === state` because we pass it through `view.emit`)
      // and pull from the live `state` reference so a `failed` update
      // that arrives between snapshots can still trigger a body change.
      const current = snap.snap === null ? [] : buildCurrentRows(snap.snap);
      const predicted =
        snap.snap === null
          ? { approvals: [], informational: [], workers: [], closers: [] }
          : predictNextDispatches(snap.snap);
      return {
        bodyLines: renderBody({
          current,
          predicted,
          failed: snap.failed,
          paused: snap.paused,
        }),
        stateJson: {
          paused: snap.paused,
          current,
          predicted,
          failed: snap.failed,
        },
      };
    },
  });

  // Seed the banner immediately so the human sees `[paused]` before the
  // first snapshot lands — same shape as board's persistent-pill restore
  // pattern.
  view.liveShell.setStatus(state.paused ? "[paused]" : "[playing]");

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
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
  });

  view.installSigintHandler(() => {
    readinessHandle.dispose();
    failuresHandle.dispose();
  });
}

// ---------------------------------------------------------------------------
// Dispatcher entry — routes the (none) / pause / play / retry subcommands.
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      sock: { type: "string" },
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
    await runViewer(sockPath);
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

  die(
    `unknown subcommand '${subcommand}' (expected pause | play | retry); pass --help for usage.`,
  );
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical
// entry. Direct `bun cli/autopilot.ts` invocation would bypass the
// dispatcher's arg-pruning.
