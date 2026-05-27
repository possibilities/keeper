#!/usr/bin/env bun
/**
 * keeper-autopilot — dispatch log viewer over the keeper subscribe server.
 *
 * Subscribes to keeperd and auto-dispatches ready rows. Each frame lists
 * every command dispatched so far, oldest first. Each line is prefixed
 * with the basename of the cd target so the project is scannable at a
 * glance (matches the `(dir)` shape used by `board.ts`). The summary
 * form is `(<dir>) <verb>::<id>`; dry runs append the would-have-run
 * shell command on two indented lines beneath:
 *
 *   (keeper) work::fn-619-pin-inputrequest-mid-subagent-state.1
 *   (keeper) [dry] approve::fn-619-pin-inputrequest-mid-subagent-state.1
 *     cd /Users/mike/code/keeper && \
 *       claude '/plan:approve fn-619-pin-inputrequest-mid-subagent-state.1'
 *
 * Dispatches are persisted to ~/.local/state/keeper/dispatch.log (JSONL)
 * for forensic tailing AND for the cross-run re-dispatch guard. Two
 * line kinds:
 *
 *   `{"kind":"launch", ts, rowId, dir, dirFull, verb, id, command,
 *    dry?, pid?}` — written by `logDispatch` the moment autopilot
 *    fires (or would-have-fired in dry mode).
 *   `{"kind":"fulfilled", ts, verb, id, pid?}` — written by
 *    `detectFulfillments` the first time an embedded job for the
 *    dispatched `(verb, id)` appears in the readiness snapshot. Marks
 *    the dispatch as claimed for life — section 1's "queued → current"
 *    move pivots on this, and the durable re-dispatch guard rides on
 *    the matching `dispatchedKeys` set so a session-ended → verdict-
 *    flips-back-to-ready cycle cannot open a second Ghostty window.
 *
 * Section 1 is scoped to THIS RUN — it never shows dispatches that
 * landed before the UI started. On startup `hydrateDispatchLog` folds
 * the on-disk log back into the durable `dispatchedKeys` /
 * `fulfilledKeys` sets (so the re-dispatch guard survives restarts),
 * but the in-memory `dispatchLog` array that drives section 1 starts
 * empty. Section 1 partitions this-run's dispatches on fulfillment:
 * rows whose key has been observed registered ("current") render above,
 * then a blank-line gutter, then rows still waiting on the agent to
 * boot ("queued") below. In wet mode queued is transient (~1-3 frames
 * between dispatch and SessionStart fold); in dry mode it persists
 * for the lifetime of the run since no claude session is actually
 * spawned. A real mid-flight crash loses section-1 display state for
 * in-flight dispatches — the dispatches themselves still happened
 * (Ghostty windows exist; dispatch.log records them), and the
 * re-dispatch guard still fires, but they won't re-appear in the
 * frame on restart.
 *
 * A new frame is emitted immediately after each dispatch AND whenever
 * `detectFulfillments` observes a key flip from queued → current.
 *
 * Below a `---` separator (only present when non-empty), the frame
 * previews the next dispatches autopilot will fire as current sessions
 * finish — approvals first (one per currently-active row whose approval
 * isn't already "approved"), then workers, then closers (rows that flip
 * blocked→ready in a simulation that forces every currently-active row
 * to completed). Preview rows are single-line `(<dir>) <verb>::<id>` —
 * no `[dry]` tag, no shell-command footer. The preview recomputes from
 * the live readiness snapshot on every emit; section 1 above the `---`
 * is the per-run current+queued view described above:
 *
 *   (keeper) work::fn-619-pin-inputrequest-mid-subagent-state.1
 *   ---
 *   (keeper) approve::fn-619-pin-inputrequest-mid-subagent-state.1
 *   (keeper) work::fn-619-pin-inputrequest-mid-subagent-state.2
 *   (keeper) close::fn-619-pin-inputrequest-mid-subagent-state
 *
 * Fires side effects on EDGES in the readiness verdicts:
 *   → ready          spawn a Ghostty window running the worker command
 *                    (`cd … && claude '/plan:work …'` or '/plan:close …')
 *   → job-pending    spawn a Ghostty window running the approve command
 *                    (`cd … && claude '/plan:approve …'`) so the human
 *                    lands directly in the review session.
 * Per-row verdict signature is carried in a Map across snapshots; the
 * map is NOT cleared on reconnect so reconnects don't refire already
 * -seen edges.
 *
 * Connection / sidecar / SIGINT: the helper (`src/readiness-client.ts`)
 * owns capped-backoff reconnect, the all-three-strict first-paint gate,
 * per-collection coalesce, and the computeReadiness handoff. SIGINT calls
 * the live-shell's `dispose()` THEN `handle.dispose()`. THREE indexed
 * sidecar files per frame (state JSON + frame text + per-frame unified
 * diff) plus a session meta file at
 * `/tmp/keeper-autopilot.<pid>.meta.txt`.
 *
 * Usage:
 *   bun scripts/autopilot.ts [--sock <path>] [--dry-run]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --dry-run        Log edges without spawning Ghostty or notifyctl.
 *   --help           Show this help.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import { computeReadiness, type Verdict } from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import type { Epic, Task } from "../src/types";

const HELP = `keeper-autopilot — dispatch log viewer over the keeper subscribe server

Usage: bun scripts/autopilot.ts [--sock <path>] [--dry-run]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --dry-run        Log dispatches to the frame and disk but skip the
                   actual Ghostty spawn. The summary line carries a
                   [dry] tag and is followed by the would-have-run
                   shell command on two indented lines.
  --help           Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  p pause/resume dispatches, q/Ctrl-C quit. Per-frame sidecars are
  indexed; lifecycle + warn output is appended to
  /tmp/keeper-autopilot.<pid>.lifecycle.txt. Session paths print on
  exit.

Always starts paused — the title shows '[PAUSED]' until you press
'p', at which point any currently ready/pending rows fire
immediately (using the last snapshot, no wait for the next push) and
new edges fire as they arrive. Pause has no effect in --dry-run mode
(dispatches are already side-effect-free there), so the [PAUSED] tag
is suppressed and the 'p' key is a silent no-op.

Each frame lists every command dispatched so far, oldest first. Each
line is prefixed with the basename of the cd target so the project is
scannable at a glance (matches the (dir) shape used by board.ts). The
summary form is '(<dir>) <verb>::<id>'; dry runs append the would-have
-run shell command on two indented lines:

  (keeper) work::fn-619-pin-inputrequest-mid-subagent-state.1
  (keeper) [dry] approve::fn-619-pin-inputrequest-mid-subagent-state.1
    cd /Users/mike/code/keeper && \\
      claude '/plan:approve fn-619-pin-inputrequest-mid-subagent-state.1'

Section 1 is scoped to this run — it never shows dispatches that
landed before the UI started. Within the run, it partitions on
fulfillment: rows whose dispatched (verb, id) has been observed
registered in keeper land in "current" (above); rows still waiting on
the agent to boot land in "queued" (below), separated by a blank-line
gutter. In wet mode queued is transient (~1-3 frames before
SessionStart folds); in dry mode it persists for the lifetime of the
run. The JSONL log at ~/.local/state/keeper/dispatch.log carries two
kinds — 'launch' (every dispatch) and 'fulfilled' (first observation
of the registered session) — and is folded into the durable
re-dispatch guard on startup so cross-run double-fires are
suppressed, but the section-1 array starts empty each run. A new
frame is emitted after each dispatch AND whenever a queued row moves
to current.

Below a '---' separator (only when non-empty), the frame previews the next
dispatches autopilot will fire as current sessions finish — approvals
first (one per currently-active row whose approval isn't "approved"),
then workers, then closers (rows that flip blocked→ready when every
currently-active row is forced to completed). Preview rows are
single-line '(<dir>) <verb>::<id>' — no [dry] tag, no shell-command
footer.

The helper waits for keeperd to come up and reconnects across restarts;
each connection-lifecycle change is appended to the lifecycle sidecar.
Ctrl-C calls dispose() and exits 0.
`;

const seg = (v: unknown) => (v == null ? "" : String(v));

interface DispatchEntry {
  ts: string;
  kind: "launch";
  rowId: string;
  // Basename of the cd target — empty string when none. Rendered as the
  // leading `(<dir>) ` segment of the frame line.
  dir: string;
  // Full cd target path — used to reconstruct the indented `cd … && \`
  // line in the dry-run multi-line frame form. Empty string when none.
  dirFull: string;
  verb: "work" | "close" | "approve";
  id: string;
  // The fused `cd … && claude …` shell string used by the actual `sh -c`
  // spawn AND persisted to the JSONL dispatch log for forensic tailing
  // across restarts. Frames render `verb`/`id`/`dirFull` instead; this
  // field exists so a re-fold of dispatch.log doesn't lose what ran.
  command: string;
  dry?: boolean;
  // Stamped at logDispatch time; lets future post-mortems correlate a
  // dispatch.log row to a specific autopilot process without grepping
  // sidecar mtimes. Frames don't render this field.
  pid?: number;
}

// --- command rendering (module-scope so test/autopilot.test.ts can import) ---

/**
 * Render the command block for a single epic: two lines per task (work +
 * approve), then two lines for the virtual close row (close + approve).
 *
 * `task.target_repo` is the cd path for worker commands (the task may
 * live in a different repo than its epic). Falls back to `epic.project_dir`
 * when `target_repo` is null or empty — same fallback used by the plan
 * worker when seeding tasks.
 *
 * Block 1 calls this directly. Block 2 calls
 * `renderEpicCommandsFiltered` below with a verdict predicate.
 */
export function renderEpicCommands(epic: Epic): string {
  const projectDir = seg(epic.project_dir);
  const epicId = seg(epic.epic_id);
  const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
  const lines: string[] = [];

  for (const task of tasks) {
    const taskId = seg(task.task_id);
    const dir =
      task.target_repo != null && seg(task.target_repo) !== ""
        ? seg(task.target_repo)
        : projectDir;
    const cdPrefix = dir === "" ? "" : `cd ${dir} && `;
    lines.push(
      `${cdPrefix}claude '/plan:work ${taskId}'`,
      `bun ~/code/keeper/scripts/approve.ts ${taskId}`,
    );
  }

  // Virtual close row — always appended, mirrors board.ts.
  const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
  lines.push(
    `${cdPrefix}claude '/plan:close ${epicId}'`,
    `bun ~/code/keeper/scripts/approve.ts ${epicId}`,
  );

  return lines.join(" &&\n");
}

/**
 * Render a filtered command block for a single epic: emits ONLY the
 * task pairs and the close pair for which `isReady(kind, id)` returns
 * true. Returns `null` when no row passes — caller drops the epic from
 * block 2 entirely.
 *
 * Sibling of `renderEpicCommands` rather than a retrofitted filter
 * parameter: keeps the unfiltered renderer pure and trivial, and the
 * filtered renderer self-contained for the (currently single) block-2
 * call site.
 */
export function renderEpicCommandsFiltered(
  epic: Epic,
  isReady: (kind: "task" | "close", id: string) => boolean,
): string | null {
  const projectDir = seg(epic.project_dir);
  const epicId = seg(epic.epic_id);
  const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
  const lines: string[] = [];

  for (const task of tasks) {
    const taskId = seg(task.task_id);
    if (!isReady("task", taskId)) {
      continue;
    }
    const dir =
      task.target_repo != null && seg(task.target_repo) !== ""
        ? seg(task.target_repo)
        : projectDir;
    const cdPrefix = dir === "" ? "" : `cd ${dir} && `;
    lines.push(
      `${cdPrefix}claude '/plan:work ${taskId}'`,
      `bun ~/code/keeper/scripts/approve.ts ${taskId}`,
    );
  }

  if (isReady("close", epicId)) {
    const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
    lines.push(
      `${cdPrefix}claude '/plan:close ${epicId}'`,
      `bun ~/code/keeper/scripts/approve.ts ${epicId}`,
    );
  }

  if (lines.length === 0) {
    return null;
  }
  return lines.join(" &&\n");
}

// --- next-dispatch prediction (module-scope so tests can import) ---------
//
// Section 2 of the autopilot frame previews the next dispatches that will
// fire as currently-active sessions finish. The "active set" is every row
// whose current verdict is `ready`, `blocked:job-running`, or
// `blocked:sub-agent-running`. `planner-running` is NOT included — a
// planner finishing produces tasks, not approvals/workers/closers, so
// modeling its completion is outside this preview's scope.
//
// Two layers:
//   - approvals — for every active row whose own `approval` isn't already
//     "approved", autopilot will fire `approve::<id>` on its job-pending
//     edge once the worker session ends. Pre-approved rows skip the
//     approve dispatch (they go straight to completed) so they're
//     excluded from this layer.
//   - workers + closers — rows whose verdict flips `blocked → ready` in
//     a simulation that forces every active row to the completed shape
//     (`worker_phase`/`status`="done", `approval`="approved", embedded
//     jobs[].state="ended"). Subagent invocations are dropped from the
//     simulation: every running sub-agent is on an active-set row (the
//     row would otherwise not be `sub-agent-running`), and the active
//     set is being forced completed — so `[]` is equivalent to ending
//     every sub.
//
// `computeReadiness` is pure, so we just hand it the simulated `Epic[]`
// and diff its output against `snap.readiness`. The post-pass mutexes
// (single-task-per-epic / per-root) self-correct in the re-run: if two
// dependents would both be eligible, the first-in-traversal-order wins
// the slot and the others stay blocked under the simulated mutex.

export interface PreviewRow {
  verb: "work" | "close" | "approve";
  id: string;
  // Basename of the cd target — empty string when none. Rendered as the
  // leading `(<dir>) ` segment of the preview line.
  dir: string;
  // Full cd target path — retained on the descriptor so future renderers
  // (e.g. a multi-line preview shape) can reconstruct the shell command.
  // Today's renderer only consumes `dir` for the `(<dir>)` prefix.
  dirFull: string;
}

export interface PreviewSections {
  approvals: PreviewRow[];
  workers: PreviewRow[];
  closers: PreviewRow[];
}

function isActiveVerdict(v: Verdict | undefined): boolean {
  if (v === undefined) {
    return false;
  }
  if (v.tag === "ready") {
    return true;
  }
  if (v.tag === "blocked") {
    return (
      v.reason.kind === "job-running" || v.reason.kind === "sub-agent-running"
    );
  }
  return false;
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
  verb: "work" | "approve",
): PreviewRow {
  const dirFull = taskCdDir(task, projectDir);
  return {
    verb,
    id: seg(task.task_id),
    dir: dirFull === "" ? "" : basename(dirFull),
    dirFull,
  };
}

function previewRowFromEpic(epic: Epic, verb: "close" | "approve"): PreviewRow {
  const projectDir = seg(epic.project_dir);
  return {
    verb,
    id: seg(epic.epic_id),
    dir: projectDir === "" ? "" : basename(projectDir),
    dirFull: projectDir,
  };
}

export function predictNextDispatches(
  snap: ReadinessClientSnapshot,
): PreviewSections {
  const approvals: PreviewRow[] = [];
  const activeTaskIds = new Set<string>();
  const activeCloseEpicIds = new Set<string>();

  for (const epic of snap.epics) {
    const projectDir = seg(epic.project_dir);
    const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
    for (const task of tasks) {
      const taskId = seg(task.task_id);
      if (taskId === "") {
        continue;
      }
      if (!isActiveVerdict(snap.readiness.perTask.get(taskId))) {
        continue;
      }
      activeTaskIds.add(taskId);
      if (task.approval !== "approved") {
        approvals.push(previewRowFromTask(task, projectDir, "approve"));
      }
    }
    const epicId = seg(epic.epic_id);
    if (epicId === "") {
      continue;
    }
    if (!isActiveVerdict(snap.readiness.perCloseRow.get(epicId))) {
      continue;
    }
    activeCloseEpicIds.add(epicId);
    if (epic.approval !== "approved") {
      approvals.push(previewRowFromEpic(epic, "approve"));
    }
  }

  if (activeTaskIds.size === 0 && activeCloseEpicIds.size === 0) {
    return { approvals, workers: [], closers: [] };
  }

  const simulatedEpics: Epic[] = snap.epics.map((epic) => {
    const epicActive = activeCloseEpicIds.has(epic.epic_id);
    const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
    return {
      ...epic,
      ...(epicActive
        ? {
            status: "done",
            approval: "approved" as const,
            jobs: (Array.isArray(epic.jobs) ? epic.jobs : []).map((j) => ({
              ...j,
              state: "ended",
            })),
          }
        : {}),
      tasks: tasks.map((task) => {
        if (!activeTaskIds.has(task.task_id)) {
          return task;
        }
        const taskJobs = Array.isArray(task.jobs) ? task.jobs : [];
        return {
          ...task,
          worker_phase: "done",
          approval: "approved" as const,
          jobs: taskJobs.map((j) => ({ ...j, state: "ended" })),
        };
      }),
    };
  });

  const futureReadiness = computeReadiness(simulatedEpics, snap.jobs, []);

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
      const fut = futureReadiness.perTask.get(taskId);
      if (cur?.tag === "blocked" && fut?.tag === "ready") {
        workers.push(previewRowFromTask(task, projectDir, "work"));
      }
    }
    const epicId = seg(epic.epic_id);
    if (epicId === "") {
      continue;
    }
    const cur = snap.readiness.perCloseRow.get(epicId);
    const fut = futureReadiness.perCloseRow.get(epicId);
    if (cur?.tag === "blocked" && fut?.tag === "ready") {
      closers.push(previewRowFromEpic(epic, "close"));
    }
  }

  return { approvals, workers, closers };
}

// --- dispatch.log hydration + fulfillment detection ---------------------
//
// `dispatch.log` is a forensic JSONL append-only log under
// `~/.local/state/keeper/dispatch.log`. Each line is a JSON object with a
// `kind` discriminator:
//
//   - `{"kind":"launch", ts, rowId, dir, dirFull, verb, id, command,
//     dry?, pid?}` — written by `logDispatch` the moment autopilot fires
//     (or would-have-fired in dry mode).
//   - `{"kind":"fulfilled", ts, verb, id, pid?}` — written by
//     `onSnapshot` the first time an embedded job appears in the
//     readiness snapshot for the dispatched `(verb, id)` pair. Marks the
//     dispatch as "claimed forever"; once fulfilled, no other autopilot
//     automation re-fires for it (in this run or any future run).
//
// On startup, `hydrateDispatchLog` folds both kinds into the durable
// `dispatchedKeys` + `fulfilledKeys` sets so the cross-run re-dispatch
// guard survives restarts. The section-1 display array (`dispatchLog`)
// is NOT hydrated — it starts empty each run, so prior-run dispatches
// (including dry-run dispatches that can never reach fulfillment) don't
// leak into the UI.

/**
 * Re-fold `dispatch.log` from disk into the two durable sets that
 * survive across runs:
 *
 *   - `dispatchedKeys` — every `${verb}::${id}` autopilot has ever
 *     dispatched (this run + every prior run). Drives the re-dispatch
 *     guard in `launchInGhostty` so a session-ended → verdict-flips-back-
 *     to-ready cycle cannot open a second Ghostty window for the same
 *     row, and the guard survives restarts.
 *   - `fulfilledKeys` — every `${verb}::${id}` autopilot has observed
 *     register (an embedded job for that row+verb appeared in the
 *     readiness snapshot). Marks the dispatch as claimed for life;
 *     section 1's "queued → current" partition pivots on this for
 *     this-run dispatches.
 *
 * The section-1 display array is intentionally NOT seeded from the log
 * — prior-run dispatches never appear in this run's UI. The two sets
 * above are enough to make the durable re-dispatch guard work.
 *
 * Malformed JSONL lines skip silently — `dispatch.log` is a forensic
 * audit log, not the event store, so re-fold determinism isn't a goal
 * here. A truncated/corrupt line cannot wedge startup.
 */
export function hydrateDispatchLog(path: string): {
  dispatchedKeys: Set<string>;
  fulfilledKeys: Set<string>;
} {
  const dispatchedKeys = new Set<string>();
  const fulfilledKeys = new Set<string>();
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { dispatchedKeys, fulfilledKeys };
  }
  for (const line of content.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const verb = row.verb;
    const id = row.id;
    if (typeof verb !== "string" || typeof id !== "string") {
      continue;
    }
    const key = `${verb}::${id}`;
    if (row.kind === "launch") {
      dispatchedKeys.add(key);
    } else if (row.kind === "fulfilled") {
      fulfilledKeys.add(key);
    }
  }
  return { dispatchedKeys, fulfilledKeys };
}

/**
 * Returns `true` iff the readiness snapshot carries an embedded job for
 * this `(verb, id)` pair. Used as the fulfillment predicate: once an
 * autopilot dispatch's agent has booted (or any matching session exists
 * in keeper's projection), an `EmbeddedJob` with `plan_verb === verb`
 * lands in the parent row's `jobs[]` array via the reducer's
 * `syncJobIntoEpic` fan-out (schema v26 widened the verb whitelist to
 * accept `approve` alongside `work` / `close`).
 *
 * Dispatches by `id` shape: a dotted `id` (`fn-619-foo.1`) targets a
 * task — scan that task's `jobs[]`. An undotted `id` (`fn-619-foo`)
 * targets an epic-level row (close or approve on the epic) — scan the
 * epic's `jobs[]`. The matching entry's `plan_verb` must equal the
 * dispatched verb.
 */
export function findSessionMatch(
  snap: ReadinessClientSnapshot,
  verb: string,
  id: string,
): boolean {
  const isTaskForm = id.includes(".");
  if (isTaskForm) {
    for (const epic of snap.epics) {
      const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
      for (const task of tasks) {
        if (task.task_id !== id) {
          continue;
        }
        const jobs = Array.isArray(task.jobs) ? task.jobs : [];
        return jobs.some((j) => j.plan_verb === verb);
      }
    }
    return false;
  }
  for (const epic of snap.epics) {
    if (epic.epic_id !== id) {
      continue;
    }
    const jobs = Array.isArray(epic.jobs) ? epic.jobs : [];
    return jobs.some((j) => j.plan_verb === verb);
  }
  return false;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  const dispatchLogPath = join(dirname(sockPath), "dispatch.log");
  const dryRun = values["dry-run"] === true;
  let frameCount = 0;

  // Always starts paused. While `paused && !dryRun`,
  // `processLaunchTransitions` returns early — no Ghostty windows open and
  // `lastVerdictSig` stays frozen, so any currently ready/pending row will
  // fire on the next snapshot once unpaused. On the unpause edge we ALSO
  // immediately re-run `processLaunchTransitions(lastSnap)` so the human
  // doesn't have to wait for keeperd to push the next snapshot. In
  // --dry-run mode the flag is tracked but ignored: dispatches are
  // already side-effect-free, so the 'p' key is a silent no-op and the
  // title never carries the [PAUSED] tag.
  let paused = true;

  let lastBody: string | null = null;
  // Latest readiness snapshot, captured at the top of `onSnapshot`. The
  // section-2 preview (`predictNextDispatches`) recomputes from this on
  // every frame emit. `null` until the first paint lands.
  let lastSnap: ReadinessClientSnapshot | null = null;

  // Hydrate the durable cross-run guard from disk. `dispatchedKeys`
  // carries every key from every prior run (durable guard against
  // double-fire); `fulfilledKeys` carries every `(verb, id)` autopilot
  // has observed register. The section-1 display array (`dispatchLog`)
  // starts empty each run — prior-run dispatches never appear in this
  // run's UI. This run's launches push onto `dispatchLog` as they fire
  // and write a `kind:"launch"` line; the matching `kind:"fulfilled"`
  // line is written the first time the snapshot shows an embedded job
  // for the dispatched row+verb.
  const { dispatchedKeys, fulfilledKeys } = hydrateDispatchLog(dispatchLogPath);
  const dispatchLog: DispatchEntry[] = [];

  function renderDispatchFrame(): string[] {
    // Partition section 1 by fulfillment: rows whose `(verb, id)` has
    // been observed registered in keeper land in `current`; rows that
    // haven't yet land in `queued`. In wet mode, queued is typically
    // transient (1-3 frames between dispatch and SessionStart fold);
    // in dry mode it persists until the human runs the command
    // manually, since no actual claude session is spawned.
    const current: string[] = [];
    const queued: string[] = [];
    for (const e of dispatchLog) {
      const target = fulfilledKeys.has(`${e.verb}::${e.id}`) ? current : queued;
      const dirSeg = e.dir === "" ? "" : `(${e.dir}) `;
      const dryTag = e.dry ? "[dry] " : "";
      target.push(`${dirSeg}${dryTag}${e.verb}::${e.id}`);
      if (e.dry) {
        // Dry runs append the would-have-run shell command, split
        // across two indented lines for readability: `  cd <full> &&
        // \` then `    claude '/plan:<verb> <id>'`. The `cd` line is
        // dropped when there's no dir, so a no-dir dry dispatch shows
        // just the claude line under the summary.
        if (e.dirFull !== "") {
          target.push(`  cd ${e.dirFull} && \\`);
          target.push(`    claude '/plan:${e.verb} ${e.id}'`);
        } else {
          target.push(`  claude '/plan:${e.verb} ${e.id}'`);
        }
      }
    }
    const section1: string[] = [];
    section1.push(...current);
    if (current.length > 0 && queued.length > 0) {
      // Blank-line gutter between current (fulfilled, above) and
      // queued (unfulfilled, below). No `---` separator here — that's
      // reserved for between section 1 (combined) and section 2
      // (predicted next).
      section1.push("");
    }
    section1.push(...queued);

    const body = composeBody();
    // Wet-mode pause indicator: the live-shell's banner title is fixed at
    // construction (`[[autopilot]] Showing live results …`), so the pause
    // state lives in the body. Prepended unconditionally when paused so
    // it's visible even on a fully-empty frame; suppressed in --dry-run
    // since pause has no observable effect there.
    if (paused && !dryRun) {
      return body.length === 0 ? ["[PAUSED]"] : ["[PAUSED]", "", ...body];
    }
    return body;

    function composeBody(): string[] {
      if (lastSnap === null) {
        return section1;
      }
      const { approvals, workers, closers } = predictNextDispatches(lastSnap);
      if (
        approvals.length === 0 &&
        workers.length === 0 &&
        closers.length === 0
      ) {
        return section1;
      }
      const section2: string[] = [];
      for (const r of [...approvals, ...workers, ...closers]) {
        const dirSeg = r.dir === "" ? "" : `(${r.dir}) `;
        section2.push(`${dirSeg}${r.verb}::${r.id}`);
      }
      // The `---` separator is only emitted between two non-empty
      // sections. When section 1 is empty (no dispatches this run yet)
      // but section 2 has predicted rows, the preview lines render alone.
      if (section1.length === 0) {
        return section2;
      }
      return [...section1, "---", ...section2];
    }
  }

  // --- sidecar paths ---

  // Internal scratch path for the previous frame text — fed to `diff -u`.
  const prevFrameTmp = `/tmp/keeper-autopilot.${process.pid}.prev.frame.txt`;
  // Session-level meta file: one tab-separated line per frame.
  const metaSidecar = `/tmp/keeper-autopilot.${process.pid}.meta.txt`;
  // The alt-screen owns stdout; lifecycle events and warn lines append here.
  const lifecycleSidecar = `/tmp/keeper-autopilot.${process.pid}.lifecycle.txt`;
  const noteLine = (s: string): void => {
    try {
      appendFileSync(lifecycleSidecar, `${s}\n`);
    } catch {
      // best-effort
    }
  };
  // In-memory copy of the last emitted frame text (for the diff).
  let lastFrameText: string | null = null;

  function writeSidecars(frameText: string): void {
    const sState = `/tmp/keeper-autopilot.${process.pid}.state.${frameCount}.json`;
    const sFrame = `/tmp/keeper-autopilot.${process.pid}.frame.${frameCount}.txt`;
    const sDiff = `/tmp/keeper-autopilot.${process.pid}.diff.${frameCount}.txt`;

    const stateJson = { dispatches: dispatchLog };
    try {
      writeFileSync(sState, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      noteLine(`# warn: sidecar write failed: ${(err as Error).message}`);
    }

    // Per-frame unified diff against the previous emit.
    let diffText: string;
    if (lastFrameText == null) {
      diffText = "# first frame — no previous to diff against\n";
    } else {
      try {
        writeFileSync(prevFrameTmp, `${lastFrameText}\n`);
        const proc = Bun.spawnSync({
          cmd: ["diff", "-u", prevFrameTmp, sFrame],
        });
        diffText = proc.stdout.toString();
        if (diffText.length === 0) {
          diffText = "# diff: no textual difference\n";
        }
      } catch (err) {
        diffText = `# diff failed: ${(err as Error).message}\n`;
      }
    }
    try {
      writeFileSync(sDiff, diffText);
    } catch (err) {
      noteLine(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    try {
      appendFileSync(
        metaSidecar,
        `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
      );
    } catch (err) {
      noteLine(`# warn: meta write failed: ${(err as Error).message}`);
    }
    lastFrameText = frameText;
  }

  function emitFrame(): void {
    const bodyLines = renderDispatchFrame();
    const body = bodyLines.join("\n");
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    frameCount += 1;
    const frameText = ["---", ...bodyLines].join("\n");
    liveShell.pushFrame(bodyLines);
    writeSidecars(frameText);
  }

  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    const lines: string[] = ["...", `event: ${event}`];
    for (const [k, v] of Object.entries(detail)) {
      lines.push(`${k}: ${String(v)}`);
    }
    lines.push("...");
    try {
      appendFileSync(lifecycleSidecar, `${lines.join("\n")}\n`);
    } catch {
      // best-effort
    }
    // On disconnect, clear `lastBody` so the next first-paint emits even
    // if the post-reconnect snapshot happens to match the last pre-
    // disconnect body byte-for-byte.
    if (event === "disconnected") {
      lastBody = null;
    }
  }

  // --- --launch dispatch ---
  //
  // Per-row verdict signature carried across snapshots. We fire side
  // effects (Ghostty window for "→ ready" running the worker/closer verb,
  // Ghostty window for "→ approval pending" running the approve verb) on
  // the EDGE — `prev !== cur` with `cur` being one of those two
  // signatures. The map is INTENTIONALLY not cleared on disconnect: a
  // reconnect's first paint will see the same signatures as the last
  // pre-disconnect frame and produce no spurious fires. The empty
  // initial map means autopilot's first paint DOES fire for everything
  // currently ready / pending — that is desired: "start autopilot,
  // things you need to do open up."
  const lastVerdictSig = new Map<string, string>();

  function verdictSignature(v: Verdict | undefined): string {
    if (v === undefined) {
      return "unknown";
    }
    if (v.tag === "ready") {
      return "ready";
    }
    if (v.tag === "completed") {
      return "completed";
    }
    return `blocked:${v.reason.kind}`;
  }

  function logDispatch(entry: DispatchEntry): void {
    const stamped: DispatchEntry = { ...entry, pid: process.pid };
    dispatchLog.push(stamped);
    dispatchedKeys.add(`${stamped.verb}::${stamped.id}`);
    try {
      appendFileSync(dispatchLogPath, `${JSON.stringify(stamped)}\n`);
    } catch (err) {
      noteLine(`# warn: dispatch log write failed: ${(err as Error).message}`);
    }
    emitFrame();
  }

  /**
   * Spawn a Ghostty window running `<command>` (already wrapped in `cd …
   * && claude …` shape by the caller). Fire-and-forget — stdout/stderr
   * captured into the lifecycle sidecar on failure. After the AppleScript
   * returns we attempt `yabai -m window --space 5` to shove the newly-
   * focused window onto space 5; yabai not being installed is fine.
   */
  function launchInGhostty(
    workerShellCommand: string,
    rowId: string,
    dir: string,
    dirFull: string,
    verb: "work" | "close" | "approve",
    id: string,
  ): void {
    // Durable re-dispatch guard. `dispatchedKeys` is seeded from
    // `dispatch.log` on startup and grows on every `logDispatch` call,
    // so a verdict cycle (e.g. ready → job-running → session killed →
    // ready) cannot open a second Ghostty window for the same row in
    // this run OR across a restart. The `lastVerdictSig` map handles
    // same-signature edges in-memory; this set is the persistent
    // backstop. Once-dispatched is once-dispatched for life — if a
    // re-dispatch is genuinely wanted the human edits `dispatch.log`.
    const key = `${verb}::${id}`;
    if (dispatchedKeys.has(key)) {
      noteLine(
        `${new Date().toISOString()} re-dispatch suppressed pid=${process.pid} ${key} (rowId=${rowId})`,
      );
      return;
    }
    // `-l -i` = login + interactive — login alone sources `.zprofile` only,
    // so `claude` (and most user PATH additions) live in `.zshrc` which is
    // interactive-only. Without `-i` the spawned shell can't find `claude`.
    const zshInvocation = `/bin/zsh -l -i -c ${JSON.stringify(workerShellCommand)}`;
    const appleScript = [
      'tell application "Ghostty"',
      "set cfg to new surface configuration",
      `set command of cfg to ${JSON.stringify(zshInvocation)}`,
      "new window with configuration cfg",
      "end tell",
    ];
    const osascriptArgs = ["osascript"];
    for (const line of appleScript) {
      osascriptArgs.push("-e", line);
    }
    // Chain the yabai move into the same shell so we don't have to track
    // the Ghostty PID — `yabai -m window --space 5` operates on the
    // focused window, which is the brand-new Ghostty window.
    const shellLine = `${osascriptArgs
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(
        " ",
      )} && sleep 0.3 && yabai -m window --space 5 2>/dev/null || true`;
    logDispatch({
      ts: new Date().toISOString(),
      kind: "launch",
      rowId,
      dir,
      dirFull,
      verb,
      id,
      command: workerShellCommand,
      dry: dryRun || undefined,
    });
    if (dryRun) return;
    try {
      const proc = Bun.spawn(["sh", "-c", shellLine], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      // Fire-and-forget; surface stderr to the lifecycle sidecar if any.
      proc.exited
        .then(async () => {
          const errText = await new Response(proc.stderr).text();
          if (errText.length > 0) {
            noteLine(`# launch stderr (${rowId}): ${errText.trim()}`);
          }
        })
        .catch((err) => {
          noteLine(
            `# warn: launch spawn for ${rowId} failed: ${(err as Error).message}`,
          );
        });
    } catch (err) {
      noteLine(
        `# warn: launch spawn for ${rowId} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Walk every task + close row in the snapshot and fire side effects on
   * EDGES into "ready" (Ghostty: worker/closer verb) or
   * "blocked:job-pending" (Ghostty: approve verb). `lastVerdictSig` is
   * updated unconditionally so transitions out of those states (back to
   * running, etc.) are recorded for the next edge.
   *
   * Worker commands MIRROR `renderEpicCommands` but DROP the approval
   * line — the approve verb is now its own dispatch path on the
   * job-pending edge.
   */
  // Silent instrumentation: every verdict-signature edge is appended to the
  // lifecycle sidecar so future post-mortems can reconstruct the prev → cur
  // sequence. Compact one-liner shape (sortable, greppable):
  //   <iso-ts> transition pid=<pid> <key> <prev> → <cur> | <detail>
  // <detail> carries the row-state fields that drive predicates 5/6/7:
  // approval, worker_phase (task) / status (close), jobs.length, and the
  // count of running sub-agents for the row's worker jobs.
  function logTransition(
    key: string,
    prev: string | undefined,
    cur: string,
    detail: string,
  ): void {
    noteLine(
      `${new Date().toISOString()} transition pid=${process.pid} ${key} ${prev ?? "∅"} → ${cur} | ${detail}`,
    );
  }

  function taskDetail(
    task: ReadinessClientSnapshot["epics"][number]["tasks"][number],
    snap: ReadinessClientSnapshot,
  ): string {
    const subRunByJob = new Map<string, number>();
    for (const inv of snap.subagentInvocations) {
      if (inv.status === "running") {
        subRunByJob.set(inv.job_id, (subRunByJob.get(inv.job_id) ?? 0) + 1);
      }
    }
    const jobs = Array.isArray(task.jobs) ? task.jobs : [];
    let subRun = 0;
    for (const j of jobs) {
      subRun += subRunByJob.get(seg(j.job_id)) ?? 0;
    }
    const jobStates = jobs.map((j) => seg(j.state)).join(",");
    return `approval=${seg(task.approval)} worker_phase=${seg(task.worker_phase)} jobs=${jobs.length}[${jobStates}] sub_running=${subRun}`;
  }

  function closeDetail(epic: Epic, snap: ReadinessClientSnapshot): string {
    const subRunByJob = new Map<string, number>();
    for (const inv of snap.subagentInvocations) {
      if (inv.status === "running") {
        subRunByJob.set(inv.job_id, (subRunByJob.get(inv.job_id) ?? 0) + 1);
      }
    }
    const jobs = Array.isArray(epic.jobs) ? epic.jobs : [];
    let subRun = 0;
    for (const j of jobs) {
      subRun += subRunByJob.get(seg(j.job_id)) ?? 0;
    }
    const jobStates = jobs.map((j) => seg(j.state)).join(",");
    return `approval=${seg(epic.approval)} status=${seg(epic.status)} jobs=${jobs.length}[${jobStates}] sub_running=${subRun}`;
  }

  function processLaunchTransitions(snap: ReadinessClientSnapshot): void {
    // While paused (wet mode only), skip the entire transition walk —
    // including the `lastVerdictSig` update. The map stays frozen at its
    // pre-pause shape, so on the unpause edge the next snapshot (or the
    // eager call from the 'p' key handler) sees the same prev → cur edge
    // and fires anything currently ready/pending. Already-dispatched rows
    // are still protected by the durable `dispatchedKeys` re-dispatch
    // guard. Dry-run bypasses the gate so pause has no observable effect.
    if (paused && !dryRun) {
      return;
    }
    for (const epic of snap.epics) {
      const projectDir = seg(epic.project_dir);
      const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];

      for (const task of tasks) {
        const taskId = seg(task.task_id);
        if (taskId === "") {
          continue;
        }
        const key = `task:${taskId}`;
        const cur = verdictSignature(snap.readiness.perTask.get(taskId));
        const prev = lastVerdictSig.get(key);
        if (prev === cur) {
          continue;
        }
        logTransition(key, prev, cur, taskDetail(task, snap));
        lastVerdictSig.set(key, cur);
        const dir =
          task.target_repo != null && seg(task.target_repo) !== ""
            ? seg(task.target_repo)
            : projectDir;
        const cdPrefix = dir === "" ? "" : `cd ${dir} && `;
        const dirBase = dir === "" ? "" : basename(dir);
        if (cur === "ready") {
          launchInGhostty(
            `${cdPrefix}claude '/plan:work ${taskId}'`,
            `task ${taskId}`,
            dirBase,
            dir,
            "work",
            taskId,
          );
        } else if (cur === "blocked:job-pending") {
          launchInGhostty(
            `${cdPrefix}claude '/plan:approve ${taskId}'`,
            `approve task ${taskId}`,
            dirBase,
            dir,
            "approve",
            taskId,
          );
        }
      }

      const epicId = seg(epic.epic_id);
      if (epicId === "") {
        continue;
      }
      const closeKey = `close:${epicId}`;
      const closeCur = verdictSignature(snap.readiness.perCloseRow.get(epicId));
      const closePrev = lastVerdictSig.get(closeKey);
      if (closePrev === closeCur) {
        continue;
      }
      logTransition(closeKey, closePrev, closeCur, closeDetail(epic, snap));
      lastVerdictSig.set(closeKey, closeCur);
      const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
      const dirBase = projectDir === "" ? "" : basename(projectDir);
      if (closeCur === "ready") {
        launchInGhostty(
          `${cdPrefix}claude '/plan:close ${epicId}'`,
          `close ${epicId}`,
          dirBase,
          projectDir,
          "close",
          epicId,
        );
      } else if (closeCur === "blocked:job-pending") {
        launchInGhostty(
          `${cdPrefix}claude '/plan:approve ${epicId}'`,
          `approve close ${epicId}`,
          dirBase,
          projectDir,
          "approve",
          epicId,
        );
      }
    }
  }

  function detectFulfillments(snap: ReadinessClientSnapshot): void {
    // Walk every still-unfulfilled dispatch and check whether the
    // snapshot now carries an embedded job for that (verb, id). First
    // observation wins: mark the key, append a `kind:"fulfilled"` line
    // to `dispatch.log`, and move the row from queued → current in the
    // next frame render. No-op when nothing changes.
    for (const entry of dispatchLog) {
      const key = `${entry.verb}::${entry.id}`;
      if (fulfilledKeys.has(key)) {
        continue;
      }
      if (!findSessionMatch(snap, entry.verb, entry.id)) {
        continue;
      }
      fulfilledKeys.add(key);
      try {
        appendFileSync(
          dispatchLogPath,
          `${JSON.stringify({
            kind: "fulfilled",
            ts: new Date().toISOString(),
            verb: entry.verb,
            id: entry.id,
            pid: process.pid,
          })}\n`,
        );
      } catch (err) {
        noteLine(
          `# warn: fulfilled log write failed: ${(err as Error).message}`,
        );
      }
    }
  }

  let firstPaintLogged = false;
  const onSnapshot = (snap: ReadinessClientSnapshot): void => {
    lastSnap = snap;
    detectFulfillments(snap);
    if (!firstPaintLogged) {
      firstPaintLogged = true;
      const ready: string[] = [];
      const pending: string[] = [];
      for (const epic of snap.epics) {
        for (const task of Array.isArray(epic.tasks) ? epic.tasks : []) {
          const sig = verdictSignature(
            snap.readiness.perTask.get(seg(task.task_id)),
          );
          if (sig === "ready") ready.push(`task:${seg(task.task_id)}`);
          else if (sig === "blocked:job-pending")
            pending.push(`task:${seg(task.task_id)}`);
        }
        const cSig = verdictSignature(
          snap.readiness.perCloseRow.get(seg(epic.epic_id)),
        );
        if (cSig === "ready") ready.push(`close:${seg(epic.epic_id)}`);
        else if (cSig === "blocked:job-pending")
          pending.push(`close:${seg(epic.epic_id)}`);
      }
      noteLine(
        `${new Date().toISOString()} first-paint pid=${process.pid} epics=${snap.epics.length} ready=[${ready.join(",")}] pending=[${pending.join(",")}]`,
      );
    }
    processLaunchTransitions(snap);
    emitFrame();
  };

  // `p` toggles `paused`. On the unpause edge in wet mode we eagerly re-run
  // `processLaunchTransitions` against the cached snapshot so the human
  // doesn't have to wait for keeperd's next push to see things fire. In
  // dry-run the flag toggles but nothing else moves (the title doesn't
  // carry [PAUSED] either, so the keypress is invisible). The frame is
  // refreshed via `liveShell.refreshLive` so the title flip lands
  // immediately without growing history. Constructed AFTER the functions
  // it closes over are defined so the closure captures live references.
  const liveShell = createLiveShell({
    enabled: true,
    title: "autopilot",
    onUnhandledKey: (key) => {
      if (key !== "p" || dryRun) {
        return;
      }
      paused = !paused;
      if (!paused && lastSnap !== null) {
        processLaunchTransitions(lastSnap);
      }
      liveShell.refreshLive(renderDispatchFrame());
    },
  });
  // Initial paint so the [PAUSED] indicator shows up before keeperd's
  // first snapshot lands (otherwise the user sees an empty alt-screen for
  // the connection's first few ms). Goes through `emitFrame` so
  // `lastBody` is kept in sync and the post-connect onSnapshot emit
  // doesn't double-push an identical frame.
  emitFrame();

  const handle = subscribeReadiness({
    sockPath,
    idPrefix: "autopilot",
    onSnapshot,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
    liveShell.dispose();
    handle.dispose();
    process.stdout.write("...\n");
    process.stdout.write(`meta: ${metaSidecar}\n`);
    process.stdout.write(`lifecycle: ${lifecycleSidecar}\n`);
    process.stdout.write("...\n");
    process.exit(0);
  });
}

if (import.meta.main) {
  await main();
}
