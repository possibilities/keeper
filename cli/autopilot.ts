#!/usr/bin/env bun
/**
 * `keeper autopilot` — thin viewer + control surface for the server-side
 * autopilot reconciler (fn-661).
 *
 * The reconciler itself lives in `src/autopilot-worker.ts` as a daemon
 * worker thread; this CLI does NOT dispatch, dedup, suppress, settle,
 * confirm, reap, or persist anything. Its only jobs are:
 *
 *   1. Render six sections of state, refreshed on every subscribe edge:
 *        --- current ---   live `working` `jobs` rows (the reconciler's
 *                          observed in-flight dispatches), ordered for scan
 *        --- predicted --- `predictNextDispatches` over the live readiness
 *                          snapshot — pure ONE-STEP preview, NO dispatch
 *                          behind it
 *        --- schedule ---  `predictFullSchedule` — the SAME simulation
 *                          iterated to a fixed point: every dispatch the
 *                          reconciler will fire, round by round, until the
 *                          queue drains. Pure preview, NO dispatch behind it
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
import { computeReadiness, type Verdict } from "../src/readiness";
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
           predicted / stopped / failed sections plus the paused indicator.
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
// Full-schedule preview — iterate the one-step simulation to a fixed point.
// ---------------------------------------------------------------------------

/** The three dispatch verbs the reconciler emits. No `git-dirty` here — the
 * schedule lists ACTUAL dispatches, not informational blockers. */
type DispatchVerb = "work" | "approve" | "close";

/**
 * One dispatch in the predicted run order. `round` is the simulation wave
 * (1-based): every step in the same round becomes dispatchable at the same
 * time, so rows in one round may run concurrently subject to the live
 * per-root mutex; rows in a later round only unblock after the prior round's
 * work completes. Within an epic the per-epic mutex serializes tasks across
 * rounds automatically (one `ready` task per epic per `computeReadiness`).
 */
export interface ScheduleStep {
  round: number;
  verb: DispatchVerb;
  id: string;
  /** Basename of the cd target — empty when none. */
  dir: string;
  /** Full cd target path — empty when none. */
  dirFull: string;
  /** Task tier (work rows only); `null` otherwise. */
  tier: string | null;
}

const asArray = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

/** Map a task verdict to the verb the reconciler would dispatch, or null.
 * Mirrors `verbForVerdict("task", …)` in the autopilot worker — inlined to
 * keep cli → worker import coupling out (same stance as `predictNextDispatches`). */
function taskVerb(v: Verdict | undefined): DispatchVerb | null {
  if (v === undefined) {
    return null;
  }
  if (v.tag === "ready") {
    return "work";
  }
  if (v.tag === "blocked" && v.reason.kind === "job-pending") {
    return "approve";
  }
  return null;
}

/** Map a close-row verdict to its dispatch verb, or null. Mirrors
 * `verbForVerdict("close", …)`. */
function closeVerb(v: Verdict | undefined): DispatchVerb | null {
  if (v === undefined) {
    return null;
  }
  if (v.tag === "ready") {
    return "close";
  }
  if (v.tag === "blocked" && v.reason.kind === "job-pending") {
    return "approve";
  }
  return null;
}

/** End every `working` embedded job and zero its git counters — the
 * post-completion shape the live readiness pass expects. */
function endWorkingJobs<J extends { state?: unknown }>(jobs: J[]): J[] {
  return jobs.map((j) =>
    j.state === "working"
      ? {
          ...j,
          state: "ended",
          git_dirty_count: 0,
          git_unattributed_to_live_count: 0,
          git_orphan_count: 0,
        }
      : j,
  );
}

/** Apply a completed dispatch verb's effect to a task. */
function applyTaskVerb(task: Task, verb: DispatchVerb): Task {
  return {
    ...task,
    worker_phase: verb === "work" ? "done" : task.worker_phase,
    approval: verb === "approve" ? "approved" : task.approval,
    jobs: endWorkingJobs(asArray(task.jobs)),
  };
}

/** Apply a completed dispatch verb's effect to an epic (close row). */
function applyEpicVerb(epic: Epic, verb: DispatchVerb): Epic {
  return {
    ...epic,
    status: verb === "close" ? "done" : epic.status,
    approval: verb === "approve" ? "approved" : epic.approval,
    jobs: endWorkingJobs(asArray(epic.jobs)),
  };
}

/**
 * Round-0 setup: complete every currently-`working` embedded job (mirror its
 * `plan_verb` effect) WITHOUT emitting it to the schedule — those are already
 * running and surface under `--- current ---`. Their completion is what
 * unblocks the first predicted wave.
 */
function completeInFlight(epics: Epic[]): Epic[] {
  return epics.map((epic) => {
    let e = epic;
    for (const j of asArray<{ state?: unknown; plan_verb?: unknown }>(
      epic.jobs,
    )) {
      if (j.state !== "working") {
        continue;
      }
      if (j.plan_verb === "close" || j.plan_verb === "approve") {
        e = applyEpicVerb(e, j.plan_verb);
      }
    }
    const tasks = asArray<Task>(epic.tasks).map((task) => {
      let t = task;
      for (const j of asArray<{ state?: unknown; plan_verb?: unknown }>(
        task.jobs,
      )) {
        if (j.state !== "working") {
          continue;
        }
        if (j.plan_verb === "work" || j.plan_verb === "approve") {
          t = applyTaskVerb(t, j.plan_verb);
        }
      }
      return t;
    });
    return { ...e, tasks };
  });
}

/**
 * Predict the FULL run order — every dispatch the reconciler will fire,
 * round by round, until the queue drains.
 *
 * Drives the SAME verb-aware simulation `predictNextDispatches` uses for one
 * step, wrapped in a fixed-point loop: complete the in-flight work (round 0),
 * then repeatedly (a) `computeReadiness` over the simulated tree, (b) collect
 * every row that yields a dispatch verb, (c) emit them as the next round, and
 * (d) mirror each one's completion back into the tree. A `verb::id` seen-set
 * plus a hard iteration cap (each row emits at most work+approve / approve+
 * close, so `rows * 3 + slack` can never be reached) guard against a dep
 * cycle spinning forever.
 *
 * Same simplifications as the one-step preview: it models the plan/dependency
 * order, not live git-dirty stalls — the empty `git_status` map and the fixed
 * top-level `jobs` argument mean a `git-uncommitted` blocker that the worker
 * would hit in reality is NOT simulated here. Pure: reads only the snapshot,
 * no clock / state / I/O.
 */
export function predictFullSchedule(
  snap: ReadinessClientSnapshot,
): ScheduleStep[] {
  let sim = completeInFlight(snap.epics);
  const seen = new Set<string>();
  const steps: ScheduleStep[] = [];

  const cap =
    snap.epics.reduce((n, e) => n + 1 + asArray(e.tasks).length, 0) * 3 + 10;

  for (let round = 1; round <= cap; round++) {
    const r = computeReadiness(sim, snap.jobs, [], new Map());
    const taskVerbs = new Map<string, DispatchVerb>();
    const epicVerbs = new Map<string, DispatchVerb>();
    const emitted: ScheduleStep[] = [];

    for (const epic of sim) {
      const projectDir = seg(epic.project_dir);
      for (const task of asArray<Task>(epic.tasks)) {
        const id = seg(task.task_id);
        if (id === "") {
          continue;
        }
        const verb = taskVerb(r.perTask.get(id));
        if (verb === null) {
          continue;
        }
        const key = `${verb}::${id}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        taskVerbs.set(id, verb);
        const dirFull = taskCdDir(task, projectDir);
        emitted.push({
          round,
          verb,
          id,
          dir: dirFull === "" ? "" : basename(dirFull),
          dirFull,
          tier: verb === "work" ? task.tier : null,
        });
      }
      const epicId = seg(epic.epic_id);
      if (epicId === "") {
        continue;
      }
      const verb = closeVerb(r.perCloseRow.get(epicId));
      if (verb === null) {
        continue;
      }
      const key = `${verb}::${epicId}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      epicVerbs.set(epicId, verb);
      emitted.push({
        round,
        verb,
        id: epicId,
        dir: projectDir === "" ? "" : basename(projectDir),
        dirFull: projectDir,
        tier: null,
      });
    }

    if (emitted.length === 0) {
      break;
    }
    steps.push(...emitted);

    sim = sim.map((epic) => {
      let e = epic;
      const ev = epicVerbs.get(seg(epic.epic_id));
      if (ev !== undefined) {
        e = applyEpicVerb(e, ev);
      }
      const tasks = asArray<Task>(e.tasks).map((t) => {
        const tv = taskVerbs.get(seg(t.task_id));
        return tv === undefined ? t : applyTaskVerb(t, tv);
      });
      return { ...e, tasks };
    });
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Dependency graph — ASCII DAG of open tasks (epic + task deps).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Body renderer — pure (fixtures → lines).
// ---------------------------------------------------------------------------

export interface RenderInput {
  current: CurrentRow[];
  predicted: PreviewSections;
  /** Full predicted run order, round by round (`predictFullSchedule`).
   * Optional — an absent section renders nothing. */
  schedule?: ScheduleStep[];
  /** Pre-rendered ASCII DAG body lines (`renderDependencyGraph`).
   * Optional — an absent section renders nothing. */
  dependencies?: string[];
  failed: FailedRow[];
  paused: boolean;
}

/**
 * Render the body lines for one viewer frame. Four sections, each
 * emitted only when non-empty, in priority order: current (live
 * `working` jobs), predicted (next dispatches), stopped (jobs whose turn
 * ended but whose session may still be alive), failed (sticky failures
 * awaiting human retry). The `current` and `stopped` sections both source
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

  const schedule = input.schedule ?? [];
  if (schedule.length > 0) {
    out.push("--- schedule ---");
    const maxRound = schedule.reduce((m, s) => Math.max(m, s.round), 0);
    const roundColWidth = String(maxRound).length;
    const maxDirLen = schedule.reduce((m, s) => Math.max(m, s.dir.length), 0);
    const dirColWidth = maxDirLen === 0 ? 0 : maxDirLen + 3;
    for (const s of schedule) {
      const roundSeg = String(s.round).padStart(roundColWidth);
      const dirSeg = (s.dir === "" ? "" : `(${s.dir}) `).padEnd(dirColWidth);
      out.push(`${roundSeg}  ${dirSeg}${s.verb}::${s.id}`);
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
}

/**
 * Render the persistent banner pill from viewer state: the play/pause pill
 * plus the fn-725 concurrency-cap suffix. `[playing] · max 3` for a finite
 * cap, `[playing] · max ∞` for unlimited (`null`). Pure — exported for
 * tests. The cap is read from `state.maxConcurrentJobs` (socket-sourced via
 * `projectMaxConcurrentJobs`), never from config.
 */
export function autopilotBannerLabel(state: {
  paused: boolean;
  maxConcurrentJobs: number | null;
}): string {
  const pill = state.paused ? "[paused]" : "[playing]";
  const cap =
    state.maxConcurrentJobs === null ? "∞" : String(state.maxConcurrentJobs);
  return `${pill} · max ${cap}`;
}

async function runViewer(sockPath: string): Promise<void> {
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
  };

  const view = createViewShell<ViewerState>({
    script: "autopilot",
    title: "autopilot",
    persistentBannerPill: () => autopilotBannerLabel(state),
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
      const schedule = snap.snap === null ? [] : predictFullSchedule(snap.snap);
      const dependencies =
        snap.snap === null ? [] : renderDependencyGraph(snap.snap);
      return {
        bodyLines: renderBody({
          current,
          predicted,
          schedule,
          dependencies,
          failed: snap.failed,
          paused: snap.paused,
        }),
        stateJson: {
          paused: snap.paused,
          current,
          predicted,
          schedule,
          dependencies,
          failed: snap.failed,
        },
      };
    },
  });

  // Seed the banner immediately so the human sees `[paused] · max ∞`
  // before the first snapshot lands — same shape as board's persistent-pill
  // restore pattern.
  view.liveShell.setStatus(autopilotBannerLabel(state));

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
      view.liveShell.setStatus(autopilotBannerLabel(state));
      view.emit(state);
    },
    onLifecycle: view.emitLifecycle,
  });

  view.installSigintHandler(() => {
    readinessHandle.dispose();
    failuresHandle.dispose();
    pausedHandle.dispose();
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
