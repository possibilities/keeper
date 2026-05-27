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
 *    `detectJobTransitions` the first time an embedded job for the
 *    dispatched `(verb, id)` appears in the readiness snapshot. Marks
 *    the dispatch as claimed for life — section 1's "queued → current"
 *    move pivots on this, and the durable re-dispatch guard rides on
 *    the matching `dispatchedKeys` set so a session-ended → verdict-
 *    flips-back-to-ready cycle cannot open a second Ghostty window.
 *   `{"kind":"completed", ts, verb, id, pid?}` — written by
 *    `detectJobTransitions` the first time the embedded job for the
 *    dispatched `(verb, id)` is observed in a terminal state
 *    (`state === "ended" | "killed"`). Migrates the row from
 *    `--- current ---` to `--- completed ---`.
 *
 * The frame has four named-header sections, each emitted only when
 * non-empty, rendered in this order: `--- current ---`, `--- queued ---`,
 * `--- predicted ---`, `--- completed ---`. The ordering is attention-
 * first (live agents at the top, then about-to-be-active, then future,
 * then growing history at the bottom so completed entries don't push
 * live state around).
 *
 * The first three (current / queued / completed) are scoped to THIS
 * RUN — they never show dispatches that landed before the UI started.
 * On startup `hydrateDispatchLog` folds the on-disk log back into the
 * durable `dispatchedKeys` / `fulfilledKeys` / `completedKeys` sets
 * (so the re-dispatch guard survives restarts), but the in-memory
 * `dispatchLog` array that drives them starts empty. This-run
 * dispatches partition three ways: rows whose key has been observed
 * terminal (`state in {ended, killed}`) render under
 * `--- completed ---`; rows whose key has been observed registered
 * but not yet terminal render under `--- current ---`; rows still
 * waiting on the agent to boot render under `--- queued ---`. In wet
 * mode queued is transient (~1-3 frames between dispatch and
 * SessionStart fold); in dry mode it persists for the lifetime of the
 * run since no claude session is actually spawned. A real mid-flight
 * crash loses display state for in-flight dispatches — the dispatches
 * themselves still happened (Ghostty windows exist; dispatch.log
 * records them), and the re-dispatch guard still fires, but they
 * won't re-appear in the frame on restart.
 *
 * A new frame is emitted immediately after each dispatch AND whenever
 * `detectJobTransitions` observes a key flip from queued → current or
 * current → completed.
 *
 * The `--- predicted ---` section previews the next dispatches
 * autopilot will fire as current sessions finish — approvals first,
 * then informational `git-dirty::<id>` rows (worker's future verdict
 * is `git-uncommitted` / `git-orphans`, collapsed to one signal;
 * renders alongside the others but has NO dispatch behind it — the
 * human resolves it by cleaning the worktree, after which the row
 * drops off and re-appears as `approve::<id>`), then workers, then
 * closers (rows that flip blocked→ready in a simulation that forces
 * every currently-active row to completed). Preview rows are
 * single-line `(<dir>) [<pill>] <verb>::<id>` where the pill sits
 * immediately after the dir column and is `[claude]` for dispatch-
 * backed rows (approve / work / close) or `[info  ]` for the
 * informational `git-dirty` row (label right-padded to "claude"'s
 * width so all pills are 8 chars). The dir column itself is padded to
 * the widest `(<dir>) ` across the predicted rows so pills align
 * across projects. No `[dry]` tag, no shell-command footer. The
 * preview recomputes from the live readiness snapshot on every emit:
 *
 *   --- current ---
 *   (keeper) work::fn-619-pin-inputrequest-mid-subagent-state.1
 *   --- predicted ---
 *   (arthack) [claude] approve::fn-594-fix-silent-failure-paths-in-templates.1
 *   (arthack) [info  ] git-dirty::fn-594-fix-silent-failure-paths-in-templates.1
 *   (keeper)  [claude] work::fn-619-pin-inputrequest-mid-subagent-state.3
 *   (keeper)  [claude] close::fn-619-pin-inputrequest-mid-subagent-state
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
import { buildDebugSnapshot, copyToClipboard } from "../src/clipboard-debug";
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
  space pause/resume dispatches,
  c copy current frame + sidecar paths to clipboard, q/Ctrl-C quit.
  Per-frame sidecars are indexed; lifecycle + warn output is appended to
  /tmp/keeper-autopilot.<pid>.lifecycle.txt. Session paths print on
  exit.

Always starts paused — the banner row carries a '[paused]' /
'[playing]' indicator (live-only chrome; toggling it doesn't push a
frame to history). Pressing space flips the state; on unpause any
currently ready/pending rows fire immediately against the last
snapshot, no wait for keeperd's next push. Pause has no effect in
--dry-run mode (dispatches are already side-effect-free there), so
the indicator is suppressed and the space key is a silent no-op.

Each frame lists every command dispatched so far, oldest first. Each
line is prefixed with the basename of the cd target so the project is
scannable at a glance (matches the (dir) shape used by board.ts). The
summary form is '(<dir>) <verb>::<id>'; dry runs append the would-have
-run shell command on two indented lines:

  (keeper) work::fn-619-pin-inputrequest-mid-subagent-state.1
  (keeper) [dry] approve::fn-619-pin-inputrequest-mid-subagent-state.1
    cd /Users/mike/code/keeper && \\
      claude '/plan:approve fn-619-pin-inputrequest-mid-subagent-state.1'

The frame has four named-header sections, each emitted only when
non-empty, rendered in this order: '--- current ---',
'--- queued ---', '--- predicted ---', '--- completed ---'.

The current/queued/completed sections are scoped to this run — they
never show dispatches that landed before the UI started. Within the
run, dispatches partition three ways: rows observed terminal
(state in {ended, killed}) render under '--- completed ---'; rows
observed registered but not yet terminal render under
'--- current ---'; rows still waiting on the agent to boot render
under '--- queued ---'. In wet mode queued is transient (~1-3 frames
before SessionStart folds); in dry mode it persists for the lifetime
of the run. The JSONL log at ~/.local/state/keeper/dispatch.log
carries three kinds — 'launch' (every dispatch), 'fulfilled' (first
observation of the registered session), and 'completed' (first
observation of the session in a terminal state) — and is folded
into the durable re-dispatch guard on startup so cross-run double-
fires are suppressed, but the in-memory display array starts empty
each run. A new frame is emitted after each dispatch AND whenever a
row moves between sections.

The '--- predicted ---' section previews the next dispatches autopilot
will fire as a direct consequence of the embedded jobs currently in
flight. All four buckets fall out of one simulation pass: every
working embedded job has its post-completion effect mirrored onto the
owning row (work→worker_phase=done, close→epic.status=done,
approve→approval=approved; jobs[i].state=ended) and approval is NEVER
auto-flipped for rows whose only in-flight job is a worker. Rows whose
verdict flips to blocked:job-pending in the simulated re-run emit
'approve::<id>'; rows whose verdict flips to blocked:git-uncommitted
or blocked:git-orphans emit an informational 'git-dirty::<id>' row
(same edge shape as approve but autopilot has no dispatch behind it —
the human resolves it by cleaning the worktree, after which the row
drops off and re-emerges as 'approve::<id>'); rows that flip to ready
emit 'work::<task>' / 'close::<epic>'. Preview rows are single-line
'(<dir>) [<pill>] <verb>::<id>' where the pill sits immediately after
the dir column and is '[claude]' for dispatch-backed rows (approve /
work / close) or '[info  ]' for the informational 'git-dirty' row
(label right-padded to 'claude's width so all pills are 8 chars; the
dir column itself is padded to the widest '(<dir>) ' so pills align
across projects). No [dry] tag, no shell-command footer.

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
// fire as a direct consequence of the embedded jobs currently in flight.
// All four buckets (approvals, informational, workers, closers) fall out
// of ONE `computeReadiness` pass over a verb-aware simulated tree. The
// `informational` bucket is the carve-out for rows whose future verdict
// is `blocked:git-uncommitted` / `blocked:git-orphans` — same edge shape
// as approve (worker_phase flipped to done) but no `/plan:<verb>`
// command resolves it, so autopilot renders it as `git-dirty::<id>`
// purely as a signal to the human and never dispatches against it.
//
// Simulation rules (per embedded `EmbeddedJob` whose `state === "working"`):
//   - `plan_verb === "work"`    → owning task's `worker_phase = "done"`
//   - `plan_verb === "close"`   → owning epic's `status        = "done"`
//   - `plan_verb === "approve"` → owning row's `approval       = "approved"`
//   In every case the job's own `state` is stamped `"ended"` AND its
//   `git_dirty_count` / `git_orphan_count` are zeroed — the sim models a
//   worker that finishes AND commits before going idle, so predicate 6.5
//   (git-uncommitted / git-orphans) does not fire in `futureReadiness`
//   and mask the post-completion approve prediction. If the worker
//   actually stops WITHOUT committing, the informational pre-pass off
//   CURRENT readiness catches it as `git-dirty::<id>` once `worker_phase`
//   flips to `"done"` for real; the prediction's job is "next dispatch on
//   the normal path".
//
// Additionally: a row whose CURRENT verdict is `ready` has its own next
// dispatch advanced too (a ready task/close-row is about to fire its
// worker/closer in this frame's section-1 block; previewing the NEXT step
// means modeling that dispatch's completion). For a ready task,
// `worker_phase = "done"`; for a ready close-row, `epic.status = "done"`.
//
// Approval is NEVER auto-flipped for rows whose only in-flight job is a
// worker — approval is a human action, not an in-flight one. This is the
// key fix vs. the prior "force every active row to done+approved" sim,
// which over-eagerly flipped a close-row to `completed` whenever a TASK's
// worker was running and then re-derived approvals from a bespoke
// "active + not approved" rule that emitted spurious `approve::<epic>`
// lines (the close-row's "active" status had fanned up from the task
// worker, not from an in-flight closer).
//
// Bucketing — for each row, compare `snap.readiness` against
// `futureReadiness`:
//   - `cur=blocked → fut=blocked:job-pending` → push `approve::<id>`.
//   - `cur=blocked → fut=ready`               → push `work::<task>` /
//                                                `close::<epic>`.
// Other transitions (incl. `cur=blocked → fut=completed`, which happens
// for rows whose own worker AND approver are both in flight) emit
// nothing — those rows are already past the next-dispatch edge.
//
// The `informational` bucket is sourced separately, off CURRENT readiness
// (NOT the simulated future): a row pushes `git-dirty::<id>` only when
// `cur.tag === "blocked"` and `cur.reason.kind` is `"git-uncommitted"` or
// `"git-orphans"`. Real readiness predicate 6.5 only fires once the
// worker has actually stopped (predicates 5 / 6 must clear first), so
// this gate keeps the informational row from surfacing while a worker
// is still actively editing — the dirtiness might resolve when the
// worker commits before going idle, and previewing it too early would
// be misleading.
//
// Subagent invocations are dropped from the simulation: every running sub
// belongs to an in-flight job whose `state` we just stamped `"ended"`,
// so passing `[]` is equivalent to ending every sub.
//
// `computeReadiness` is pure, so we just hand it the simulated `Epic[]`
// and diff its output. The post-pass mutexes (single-task-per-epic /
// per-root) self-correct in the re-run: if two dependents would both be
// eligible, the first-in-traversal-order wins the slot and the others
// stay blocked under the simulated mutex.
//
// Pause-invariance: `predictNextDispatches` is a PURE function of `snap`
// — no read of `paused`, `lastVerdictSig`, `dispatchedKeys`, or any other
// module-level state. The pause gate lives on the side-effecting
// `processLaunchTransitions` path; the preview keeps rendering
// identically whether autopilot is `[paused]` or `[playing]`.

export interface PreviewRow {
  // `git-dirty` is informational — section 2 renders it as
  // `git-dirty::<id>` to signal "the worker has uncommitted/orphan
  // files that block the approve dispatch", but autopilot itself
  // never dispatches on this verb. Collapses readiness's
  // `git-uncommitted` + `git-orphans` reasons into one preview signal.
  verb: "work" | "close" | "approve" | "git-dirty";
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
  // Informational rows whose future verdict is `git-uncommitted` or
  // `git-orphans` — the worker has filesystem state to clean up before
  // its approve dispatch can fire. Rendered between approvals and
  // workers; never produces a dispatch. Falls off the frame as soon
  // as the worker commits / clears orphans (predicate 6.5 stops firing
  // and the row migrates to `approvals` on the next emit).
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
  };
}

export function predictNextDispatches(
  snap: ReadinessClientSnapshot,
): PreviewSections {
  // Informational pre-pass. Source `git-dirty::<id>` rows from CURRENT
  // readiness, NOT from the simulated future. Predicate 6.5 in real
  // readiness (`git-uncommitted` / `git-orphans`) only fires once the
  // worker has actually stopped — predicates 5 and 6 must clear first,
  // which requires every embedded job to leave `working` AND every
  // sub-agent to finish. So sourcing off `cur` is the gate the human
  // wants: a row only renders `git-dirty::<id>` once the worker is done
  // and the worktree's dirtiness is genuinely the next blocker; an
  // actively-editing worker's transient dirty state never surfaces
  // here. The fut-driven sim below intentionally omits this bucket.
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
  // is `ready`, advance its own dispatch-completion flag too (a ready
  // row is about to fire its own worker/closer in section 1; this
  // preview models the step AFTER that). Approval is NEVER auto-flipped
  // for rows whose only in-flight job is a worker — that's the
  // semantics that makes downstream approve::<row> emit correctly while
  // refusing to predict an approve beat for a row whose own scope has
  // no running job (e.g. a close-row whose blocked:job-running verdict
  // fans up from a task worker, not from a closer).
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
            ? { ...j, state: "ended", git_dirty_count: 0, git_orphan_count: 0 }
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
            ? { ...j, state: "ended", git_dirty_count: 0, git_orphan_count: 0 }
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

  const futureReadiness = computeReadiness(simulatedEpics, snap.jobs, []);

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
      // `cur === completed` rows are already past the next-dispatch edge;
      // `cur === undefined` is a defensive miss (no prediction). Approve
      // predictions flow from EITHER `blocked → job-pending` (in-flight
      // worker / approver chain) OR `ready → job-pending` (section 1's
      // about-to-dispatch worker, modelled as completed). Worker
      // predictions flow only from `blocked → ready` — a row already at
      // `ready` is firing its worker in section 1, not section 2. The
      // `git-dirty` informational bucket is NOT sourced here — see the
      // pre-pass at the top of this function for why it reads `cur`
      // instead of the simulated `fut`.
      if (cur === undefined || cur.tag === "completed") {
        continue;
      }
      const fut = futureReadiness.perTask.get(taskId);
      if (fut?.tag === "blocked" && fut.reason.kind === "job-pending") {
        approvals.push(previewRowFromTask(task, projectDir, "approve"));
      } else if (cur.tag === "blocked" && fut?.tag === "ready") {
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
    } else if (cur.tag === "blocked" && fut?.tag === "ready") {
      closers.push(previewRowFromEpic(epic, "close"));
    }
  }

  return { approvals, informational, workers, closers };
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
//     `detectJobTransitions` the first time an embedded job appears in
//     the readiness snapshot for the dispatched `(verb, id)` pair. Marks
//     the dispatch as "claimed forever"; once fulfilled, no other
//     autopilot automation re-fires for it (in this run or any future
//     run).
//   - `{"kind":"completed", ts, verb, id, pid?}` — written by
//     `detectJobTransitions` the first time the matching embedded job
//     is observed in a terminal state (`"ended"` / `"killed"`).
//     Migrates the row from `--- current ---` to `--- completed ---`.
//
// On startup, `hydrateDispatchLog` folds all three kinds into the
// durable `dispatchedKeys` + `fulfilledKeys` + `completedKeys` sets so
// the cross-run re-dispatch guard survives restarts. The display array
// (`dispatchLog`) is NOT hydrated — it starts empty each run, so prior-
// run dispatches (including dry-run dispatches that can never reach
// fulfillment) don't leak into the UI.

/**
 * Re-fold `dispatch.log` from disk into the three durable sets that
 * survive across runs:
 *
 *   - `dispatchedKeys` — every `${verb}::${id}` autopilot has ever
 *     dispatched (this run + every prior run). Drives the re-dispatch
 *     guard in `launchInGhostty` so a session-ended → verdict-flips-back-
 *     to-ready cycle cannot open a second Ghostty window for the same
 *     row, and the guard survives restarts.
 *   - `fulfilledKeys` — every `${verb}::${id}` autopilot has observed
 *     register (an embedded job for that row+verb appeared in the
 *     readiness snapshot). Marks the dispatch as claimed for life; the
 *     "queued → current" partition pivots on this for this-run
 *     dispatches.
 *   - `completedKeys` — every `${verb}::${id}` autopilot has observed
 *     reach a terminal job state (`"ended"` / `"killed"`). Drives the
 *     "current → completed" partition for this-run dispatches.
 *
 * The display array is intentionally NOT seeded from the log — prior-
 * run dispatches never appear in this run's UI. The three sets above
 * are enough to make the durable re-dispatch guard work.
 *
 * Malformed JSONL lines skip silently — `dispatch.log` is a forensic
 * audit log, not the event store, so re-fold determinism isn't a goal
 * here. A truncated/corrupt line cannot wedge startup.
 */
export function hydrateDispatchLog(path: string): {
  dispatchedKeys: Set<string>;
  fulfilledKeys: Set<string>;
  completedKeys: Set<string>;
} {
  const dispatchedKeys = new Set<string>();
  const fulfilledKeys = new Set<string>();
  const completedKeys = new Set<string>();
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return { dispatchedKeys, fulfilledKeys, completedKeys };
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
    } else if (row.kind === "completed") {
      completedKeys.add(key);
    }
  }
  return { dispatchedKeys, fulfilledKeys, completedKeys };
}

/**
 * Returns the embedded job that matches this dispatched `(verb, id)`
 * pair, or `undefined` if no such job is in the snapshot yet. Drives
 * both transitions:
 *
 *   - **fulfillment**: any return value (defined job) means an embedded
 *     job for the dispatched row+verb has landed in keeper's
 *     projection — the agent has booted (or any matching session
 *     exists) via the reducer's `syncJobIntoEpic` fan-out (schema v26
 *     widened the verb whitelist to accept `approve` alongside
 *     `work` / `close`).
 *   - **completion**: the matched job's `state` field carries the
 *     observed lifecycle state; the caller treats `"ended"` /
 *     `"killed"` as terminal.
 *
 * Dispatches by `id` shape: a dotted `id` (`fn-619-foo.1`) targets a
 * task — scan that task's `jobs[]`. An undotted `id` (`fn-619-foo`)
 * targets an epic-level row (close or approve on the epic) — scan the
 * epic's `jobs[]`. The matching entry's `plan_verb` must equal the
 * dispatched verb.
 */
export function findSessionJob(
  snap: ReadinessClientSnapshot,
  verb: string,
  id: string,
): { state: string } | undefined {
  const isTaskForm = id.includes(".");
  if (isTaskForm) {
    for (const epic of snap.epics) {
      const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
      for (const task of tasks) {
        if (task.task_id !== id) {
          continue;
        }
        const jobs = Array.isArray(task.jobs) ? task.jobs : [];
        return jobs.find((j) => j.plan_verb === verb);
      }
    }
    return undefined;
  }
  for (const epic of snap.epics) {
    if (epic.epic_id !== id) {
      continue;
    }
    const jobs = Array.isArray(epic.jobs) ? epic.jobs : [];
    return jobs.find((j) => j.plan_verb === verb);
  }
  return undefined;
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
  // has observed register; `completedKeys` carries every key autopilot
  // has observed reach a terminal job state. The display array
  // (`dispatchLog`) starts empty each run — prior-run dispatches never
  // appear in this run's UI. This run's launches push onto `dispatchLog`
  // as they fire and write a `kind:"launch"` line; the matching
  // `kind:"fulfilled"` and `kind:"completed"` lines are written the
  // first time the snapshot shows an embedded job for the dispatched
  // row+verb and the first time that job's `state` is observed terminal.
  const { dispatchedKeys, fulfilledKeys, completedKeys } =
    hydrateDispatchLog(dispatchLogPath);
  const dispatchLog: DispatchEntry[] = [];

  function renderDispatchFrame(): string[] {
    // Four named-header sections, each only emitted when non-empty,
    // rendered in this order: `--- current ---` (this-run dispatches
    // observed registered but not yet terminal), `--- queued ---`
    // (this-run dispatches still waiting on the agent to boot),
    // `--- predicted ---` (`predictNextDispatches` output for the next
    // edges as in-flight jobs finish), and `--- completed ---` (this-
    // run dispatches whose matching embedded job has been observed in
    // a terminal state `"ended"` / `"killed"`). The ordering is
    // attention-first — live agents at the top, growing history at the
    // bottom so completed rows don't push live state around. In wet
    // mode queued is typically transient (1-3 frames between dispatch
    // and SessionStart fold); in dry mode it persists until the human
    // runs the command manually (no real session ever boots, so neither
    // `current` nor `completed` ever populates for a dry dispatch).
    const current: string[] = [];
    const queued: string[] = [];
    const completed: string[] = [];
    for (const e of dispatchLog) {
      const key = `${e.verb}::${e.id}`;
      const target = completedKeys.has(key)
        ? completed
        : fulfilledKeys.has(key)
          ? current
          : queued;
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

    const out: string[] = [];
    if (current.length > 0) {
      out.push("--- current ---");
      out.push(...current);
    }
    if (queued.length > 0) {
      out.push("--- queued ---");
      out.push(...queued);
    }

    if (lastSnap !== null) {
      const { approvals, informational, workers, closers } =
        predictNextDispatches(lastSnap);
      if (
        approvals.length !== 0 ||
        informational.length !== 0 ||
        workers.length !== 0 ||
        closers.length !== 0
      ) {
        out.push(
          ...renderPredictedSection(approvals, informational, workers, closers),
        );
      }
    }

    if (completed.length > 0) {
      out.push("--- completed ---");
      out.push(...completed);
    }
    return out;
  }

  function renderPredictedSection(
    approvals: PreviewRow[],
    informational: PreviewRow[],
    workers: PreviewRow[],
    closers: PreviewRow[],
  ): string[] {
    const out: string[] = [];
    out.push("--- predicted ---");
    const predictedRows = [
      ...approvals,
      ...informational,
      ...workers,
      ...closers,
    ];
    // Column widths so dir + pill align across all predicted rows:
    //   - dir column: `(<dir>) ` is `dir.length + 3` chars; widen to the
    //     max so e.g. `(keeper) ` gets a trailing space to match
    //     `(arthack) `. Zero when no row has a dir.
    //   - pill: right-pad the label inside the brackets to the longest
    //     label ("claude") so `[claude]` and `[info  ]` are both 8 chars.
    // Pill sits immediately after the dir column, before the verb::id.
    const maxDirLen = predictedRows.reduce(
      (m, r) => Math.max(m, r.dir.length),
      0,
    );
    const dirColWidth = maxDirLen === 0 ? 0 : maxDirLen + 3;
    const PILL_LABEL_WIDTH = 6;
    for (const r of predictedRows) {
      const dirSegRaw = r.dir === "" ? "" : `(${r.dir}) `;
      const dirSeg = dirSegRaw.padEnd(dirColWidth);
      const label = r.verb === "git-dirty" ? "info" : "claude";
      const pill = `[${label.padEnd(PILL_LABEL_WIDTH)}]`;
      out.push(`${dirSeg}${pill} ${r.verb}::${r.id}`);
    }
    return out;
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

  function detectJobTransitions(snap: ReadinessClientSnapshot): void {
    // Walk every dispatch and check whether the snapshot has advanced
    // its matching embedded job:
    //
    //   queued → current      first time a job for (verb, id) is
    //                         observed in the snapshot at all
    //                         (kind:"fulfilled" log line).
    //   current → completed   first time that job's `state` is observed
    //                         in a terminal value (`"ended"` /
    //                         `"killed"`) (kind:"completed" log line).
    //
    // First observation wins for each transition. No-op when nothing
    // changes.
    for (const entry of dispatchLog) {
      const key = `${entry.verb}::${entry.id}`;
      if (completedKeys.has(key)) {
        continue;
      }
      const job = findSessionJob(snap, entry.verb, entry.id);
      if (job === undefined) {
        continue;
      }
      if (!fulfilledKeys.has(key)) {
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
      if (job.state === "ended" || job.state === "killed") {
        completedKeys.add(key);
        try {
          appendFileSync(
            dispatchLogPath,
            `${JSON.stringify({
              kind: "completed",
              ts: new Date().toISOString(),
              verb: entry.verb,
              id: entry.id,
              pid: process.pid,
            })}\n`,
          );
        } catch (err) {
          noteLine(
            `# warn: completed log write failed: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  let firstPaintLogged = false;
  const onSnapshot = (snap: ReadinessClientSnapshot): void => {
    lastSnap = snap;
    detectJobTransitions(snap);
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

  // Space toggles `paused`. On the unpause edge in wet mode we eagerly
  // re-run `processLaunchTransitions` against the cached snapshot so the
  // human doesn't have to wait for keeperd's next push to see things
  // fire. In dry-run the flag toggles but nothing else moves and the
  // banner indicator stays hidden, so the keypress is invisible. The
  // banner indicator is updated via `liveShell.setStatus` — live-only
  // chrome that repaints just row 0 and never grows the frame history.
  // Constructed AFTER the functions it closes over are defined so the
  // closure captures live references.
  const pauseStatus = (): string =>
    dryRun ? "" : paused ? "[paused]" : "[playing]";
  // `c` flashes a debug snapshot to the clipboard. Status is briefly
  // overridden with `[copied frame N]` / `[copy failed]`, then restored
  // to the pause indicator (NOT cleared to "") so the human doesn't
  // lose track of `[paused]` / `[playing]` after pressing c.
  let copyStatusTimer: ReturnType<typeof setTimeout> | undefined;
  const liveShell = createLiveShell({
    enabled: true,
    title: "autopilot",
    onUnhandledKey: (key) => {
      if (key === " " && !dryRun) {
        paused = !paused;
        liveShell.setStatus(pauseStatus());
        if (!paused && lastSnap !== null) {
          processLaunchTransitions(lastSnap);
        }
        return;
      }
      if (key === "c") {
        if (lastFrameText == null) {
          return;
        }
        const payload = buildDebugSnapshot({
          script: "autopilot",
          pid: process.pid,
          frame: lastFrameText,
          frameNumber: frameCount,
          metaSidecar,
          lifecycleSidecar,
          nowIso: new Date().toISOString(),
        });
        const flashed = frameCount;
        void copyToClipboard(payload).then((res) => {
          if (res.ok) {
            liveShell.setStatus(`[copied frame ${flashed}]`);
          } else {
            noteLine(`# warn: clipboard copy failed: ${res.error}`);
            liveShell.setStatus("[copy failed]");
          }
          if (copyStatusTimer !== undefined) {
            clearTimeout(copyStatusTimer);
          }
          // Restore the pause indicator (not "") so toggling [paused] /
          // [playing] state survives the copy flash.
          copyStatusTimer = setTimeout(
            () => liveShell.setStatus(pauseStatus()),
            1500,
          );
        });
      }
    },
  });
  // Seed the banner indicator so the user sees `[paused]` from the very
  // first paint, before keeperd's first snapshot lands. setStatus does a
  // banner-only repaint with no body content, which is exactly what we
  // want here.
  liveShell.setStatus(pauseStatus());

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
