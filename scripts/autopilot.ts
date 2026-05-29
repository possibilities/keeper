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
 * for forensic tailing AND for the cross-run re-dispatch guard. Four
 * line kinds:
 *
 *   `{"kind":"launch", ts, rowId, dir, dirFull, verb, id, command,
 *    dry?, pid?}` — written by `logDispatch` the moment autopilot
 *    fires (or would-have-fired in dry mode).
 *   `{"kind":"window", ts, verb, id, windowId}` — written by
 *    `launchInGhostty` right after osascript's `new window with
 *    configuration cfg` call returns the freshly-spawned Ghostty
 *    window's stable id (a `tab-group-…` token). Stamps `windowId`
 *    onto the in-memory `DispatchEntry` by reference so the same-run
 *    auto-close can fire, and survives a restart via
 *    `hydrateDispatchLog`'s second `Map<string,string>` keyed by
 *    `${verb}::${id}` (latest-ts-wins). Raw `appendFileSync` — NOT
 *    `logDispatch` — to avoid re-pushing a display entry. Fire-and-
 *    forget on failure (window simply won't auto-close).
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
 *    `--- current ---` to `--- completed ---`. ALSO triggers the
 *    `closeWindow(entry.windowId)` auto-close at this edge (both the
 *    terminal-state branch and the disappearance branch), reaping the
 *    Ghostty window in lockstep with the dispatch's terminal state so
 *    the human's screen doesn't accumulate parked surfaces.
 *
 * The frame has four named-header sections, each emitted only when
 * non-empty, rendered in this order: `--- current ---`, `--- queued ---`,
 * `--- predicted ---`, `--- completed ---`. The ordering is attention-
 * first (live agents at the top, then about-to-be-active, then future,
 * then growing history at the bottom so completed entries don't push
 * live state around).
 *
 * `--- current ---` survives a restart; `--- queued ---` and
 * `--- completed ---` are scoped to THIS RUN. On startup
 * `hydrateDispatchLog` folds the on-disk log back into the durable
 * `dispatchedKeys` / `fulfilledKeys` / `completedKeys` sets (so the
 * re-dispatch guard survives restarts) AND walks the parsed launch
 * rows a second time, returning `restoredEntries`: every
 * `kind:"launch"` row where `fulfilledKeys.has(key) &&
 * !completedKeys.has(key) && !dry`, deduped latest-per-key (later
 * `ts` wins), sorted by `ts` ascending. The matching `kind:"window"`
 * row (if any) is folded onto the restored entry's `windowId`
 * (latest-ts-wins) so cross-run auto-close still works. `main()`
 * seeds the in-memory `dispatchLog` array from `restoredEntries`, so
 * a prior-run still-running dispatch renders under `--- current ---`
 * on the very first frame. If the matching embedded job has since
 * fallen off the projection (parent epic became done+approved or was
 * `planctl epic-delete`d), `detectJobTransitions`'s disappearance
 * branch migrates the key to `completedKeys` on the first
 * post-startup snapshot, the row moves to `--- completed ---`, AND
 * `closeWindow(entry.windowId)` fires to reap the parked Ghostty
 * window — same auto-close path the terminal-state branch takes.
 * Dispatches partition three ways: rows whose key has been observed
 * terminal (`state in {ended, killed}`) or whose fulfilled job has
 * disappeared from the snapshot render under `--- completed ---`;
 * rows whose key has been observed registered but not yet terminal
 * render under `--- current ---`; rows still waiting on the agent to
 * boot render under `--- queued ---`. In wet mode queued is transient
 * (~1-3 frames between dispatch and SessionStart fold); in dry mode
 * it persists for the lifetime of the run since no claude session is
 * actually spawned (and dry launches are deliberately NOT restored
 * across runs — they can never reach fulfillment). A real mid-flight
 * crash now PRESERVES `--- current ---` (the next run rehydrates it
 * from disk via the filter above); `--- queued ---` is still lost
 * across the crash because a queued dispatch has no `fulfilled` line
 * yet, and `--- completed ---` is still scoped to this run because
 * completed entries are forensic history the human can tail in
 * `dispatch.log`.
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
 * single-line `(<dir>) <verb>::<id>`; the dir column is padded to the
 * widest `(<dir>) ` across the predicted rows so `<verb>::<id>` aligns
 * across projects. No `[dry]` tag, no shell-command footer. The
 * preview recomputes from the live readiness snapshot on every emit:
 *
 *   --- current ---
 *   (keeper) work::fn-619-pin-inputrequest-mid-subagent-state.1
 *   --- predicted ---
 *   (arthack) approve::fn-594-fix-silent-failure-paths-in-templates.1
 *   (arthack) git-dirty::fn-594-fix-silent-failure-paths-in-templates.1
 *   (keeper)  work::fn-619-pin-inputrequest-mid-subagent-state.3
 *   (keeper)  close::fn-619-pin-inputrequest-mid-subagent-state
 *
 * The `v` key toggles a per-row command display: every command-bearing
 * row (dispatched current/queued/completed rows and dispatch-backed
 * predicted work/close/approve rows) grows one indented line carrying
 * the full `cd … && claude --name … '/plan:…'` shell command for
 * copy-paste when the human wants to run it manually. The
 * informational `git-dirty` preview row has no dispatch behind it and
 * is never annotated. The toggle repaints the live body without
 * growing frame history and lights a `[cmd]` marker in the banner.
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

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
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
import { appendDiagnostic } from "../src/readiness-diagnostics";
import type { Epic, Task } from "../src/types";

const HELP = `keeper-autopilot — dispatch log viewer over the keeper subscribe server

Usage: bun scripts/autopilot.ts [--sock <path>] [--dry-run]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --dry-run        Log dispatches to the frame and disk but skip the
                   actual Ghostty spawn (and the matching auto-close).
                   The summary line carries a [dry] tag and is followed
                   by the would-have-run shell command on two indented
                   lines. Live mode launches each worker through
                   \$SHELL (validated absolute path, /bin/zsh fallback)
                   with -l -i and chains an interactive shell after
                   claude exits, so a dropped session leaves a
                   keyboard-usable shell in the window.
  --help           Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  space pause/resume dispatches,
  v toggle per-row command display (for copy-paste / manual run),
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

'--- current ---' survives a restart; '--- queued ---' and
'--- completed ---' are scoped to this run. On startup
hydrateDispatchLog folds the on-disk log back into the durable
dispatchedKeys / fulfilledKeys / completedKeys sets AND restores any
launch row where fulfilled && !completed && !dry (latest-per-key
wins, sorted by ts ascending) into the in-memory display array, so
prior-run still-running dispatches re-appear under '--- current ---'
on the first frame. If a restored entry's matching embedded job has
since disappeared from the projection (parent epic became
done+approved or was planctl epic-deleted), the disappearance rule
in detectJobTransitions migrates it to '--- completed ---' on the
first post-startup snapshot.

Within a run, dispatches partition three ways: rows observed
terminal (state in {ended, killed}) — OR (post-fulfillment)
disappeared from the snapshot — render under '--- completed ---';
rows observed registered but not yet terminal render under
'--- current ---'; rows still waiting on the agent to boot render
under '--- queued ---'. In wet mode queued is transient (~1-3 frames
before SessionStart folds); in dry mode it persists for the lifetime
of the run, and dry launches are deliberately NOT restored across
runs since they can never reach fulfillment. The JSONL log at
~/.local/state/keeper/dispatch.log carries four kinds — 'launch'
(every dispatch), 'window' (the freshly-spawned Ghostty window's
stable id, emitted right after the osascript spawn returns),
'fulfilled' (first observation of the registered session), and
'completed' (first observation of the session in a terminal state OR
first post-fulfillment disappearance) — and drives both the durable
re-dispatch guard and the cross-run current-section restore. The
'completed' edge ALSO fires the Ghostty window auto-close
(closeWindow on the persisted windowId) so the dispatched window
exits in lockstep with the underlying agent. A real mid-flight crash
now preserves '--- current ---' (next run rehydrates it from disk);
'--- queued ---' is still lost across the crash because a queued
dispatch has no fulfilled line yet. A new frame is emitted after each
dispatch AND whenever a row moves between sections.

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
'(<dir>) <verb>::<id>'; the dir column is padded to the widest
'(<dir>) ' so '<verb>::<id>' aligns across projects. No [dry] tag, no
shell-command footer.

The 'v' key toggles a per-row command display: every command-bearing
row (dispatched current/queued/completed rows and dispatch-backed
predicted work/close/approve rows) grows one indented line carrying
the full 'cd … && claude --name … /plan:…' shell command for copy-
paste when you want to run it manually. The informational 'git-dirty'
preview row has no dispatch behind it and is never annotated. Toggling
repaints the live body without growing frame history and lights a
'[cmd]' marker in the banner.

The helper waits for keeperd to come up and reconnects across restarts;
each connection-lifecycle change is appended to the lifecycle sidecar.
Ctrl-C calls dispose() and exits 0.
`;

const seg = (v: unknown) => (v == null ? "" : String(v));

/**
 * Filesystem root of the arthack monorepo, hosting the per-tier
 * `claude/work-plugins/<tier>/` directories autopilot points the
 * `work` verb at via `--plugin-dir`. fn-602 moves this selection
 * upstream from `arthack-claude.py` into autopilot, so the launcher
 * no longer needs to know about planctl, tiers, or plan-role prompts.
 *
 * Env-overridable via `ARTHACK_ROOT` (mostly for tests / a future
 * non-default workspace layout); the default `~/code/arthack` is the
 * correct path on the dispatch desktop autopilot runs on. `~` is
 * expanded eagerly at module load so downstream `--plugin-dir <root>/…`
 * strings carry an absolute path the launcher's cwd doesn't break.
 */
export const ARTHACK_ROOT: string = ((): string => {
  const raw = process.env.ARTHACK_ROOT;
  const v = raw != null && raw !== "" ? raw : "~/code/arthack";
  if (v === "~" || v.startsWith("~/")) {
    return v === "~" ? homedir() : join(homedir(), v.slice(2));
  }
  return v;
})();

/**
 * Sanity-check a `$SHELL` candidate before threading it into the
 * AppleScript `command` field. Returns the path on success, `null` on
 * any rejection — callers then fall back to `/bin/zsh`.
 *
 * Three rules — minimal but load-bearing:
 *   1. Must be a non-empty string.
 *   2. Must be an absolute path (`/`-rooted) that `fs.existsSync` says
 *      exists. Drops malformed env values and stale paths to deleted
 *      shells. (No `X_OK` mode check — Bun's `existsSync` lacks the
 *      mode flag, and `osascript` will surface an unexec error if the
 *      file is non-executable; falling back on `existsSync` alone is
 *      the right minimum.)
 *   3. Must contain no `"` (AppleScript string-literal injection
 *      guard). The shell path is interpolated into the `set command of
 *      cfg to ...` literal via `JSON.stringify`, but a `"` in the path
 *      itself would still break out of the outer literal once the
 *      JSON-encoded string is re-encoded by AppleScript's parser. A
 *      shell binary with `"` in its name is pathological; reject
 *      defensively.
 *
 * Exported so test/autopilot.test.ts can exercise the validation
 * boundaries without spinning up a real `$SHELL`.
 */
export function validateShell(candidate: string | undefined): string | null {
  if (typeof candidate !== "string" || candidate === "") {
    return null;
  }
  if (!candidate.startsWith("/")) {
    return null;
  }
  if (candidate.includes('"')) {
    return null;
  }
  if (!existsSync(candidate)) {
    return null;
  }
  return candidate;
}

export interface DispatchEntry {
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
  // Ghostty window id (`tab-group-…`) captured from osascript stdout
  // right after the `new window with configuration cfg` call returns —
  // stamped on the LIVE in-memory entry by reference so the same-run
  // auto-close in `detectJobTransitions` can fire `closeWindow(entry.windowId)`
  // when the dispatched row reaches `completedKeys`. Also persisted to
  // disk via a `{"kind":"window", ts, verb, id, windowId}` row that
  // `hydrateDispatchLog` folds back onto the restored entry across runs.
  // `undefined` when the osascript capture failed or hasn't landed yet;
  // `closeWindow` no-ops on that shape (the shell-fallback covers the
  // window — it just won't auto-close).
  windowId?: string;
}

// --- command rendering (module-scope so test/autopilot.test.ts can import) ---

/**
 * Single source of the `claude '/plan:<verb> <id>'` shell command for
 * every autopilot consumer: the live `launchInGhostty` dispatch sites
 * AND the display/dry-run renderers (`renderEpicCommands`,
 * `renderEpicCommandsFiltered`, the predicted-section `v` toggle).
 * Routing both through one helper is the whole point of fn-602.2 — a
 * dry-run vs live drift would be invisible until a real dispatch.
 *
 * Encodes the load-bearing linkage contract: every spawned `claude`
 * carries `--name <verb>::<id>` so the SessionStart hook freezes
 * `events.spawn_name`, the deriver yields `plan_ref={verb,id}`, and
 * the reducer's `syncJobIntoEpic` fan-out routes the session into the
 * embedded `task.jobs[]` array (or epic `jobs[]` for close/approve-close).
 *
 * The emitted name MUST match the deriver regex in `src/derivers.ts`
 * (`SPAWN_VERB_REF_RE`): `^(plan|work|close|approve)::(fn-\d+-[a-z0-9-]+(?:\.\d+)?)$`.
 * Per the epic spec: `work` uses the task id (`fn-N-slug.M`), `close` and
 * `approve` use the appropriate id form chosen by the caller (task id for
 * a task-level approve, epic id for close + approve-close).
 *
 * Flag mapping (fn-602.2 — moves model/effort/work-tier-plugin selection
 * upstream from `arthack-claude.py` into autopilot):
 *   - work, close → `--model sonnet --effort max`
 *   - approve     → `--model sonnet --effort low`
 *   - work        → additionally `--plugin-dir <ARTHACK_ROOT>/claude/work-plugins/<tier>`,
 *                   SKIPPED when `tier == null` (degrade to launcher default)
 *
 * The optional `tier` is consumed only by `work`; passing it for
 * close/approve is a no-op so call sites at the epic level don't need
 * a branch.
 */
export function buildWorkerCommand(
  verb: "work" | "close" | "approve",
  id: string,
  projectDir: string,
  tier?: string | null,
): string {
  const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
  const flags: string[] = [];
  if (verb === "approve") {
    flags.push("--model", "sonnet", "--effort", "low");
  } else {
    // work, close
    flags.push("--model", "sonnet", "--effort", "max");
  }
  flags.push("--name", `${verb}::${id}`);
  if (verb === "work" && tier != null && tier !== "") {
    flags.push("--plugin-dir", `${ARTHACK_ROOT}/claude/work-plugins/${tier}`);
  }
  return `${cdPrefix}claude ${flags.join(" ")} '/plan:${verb} ${id}'`;
}

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
    lines.push(
      buildWorkerCommand("work", taskId, dir, task.tier),
      `bun ~/code/keeper/scripts/approve.ts ${taskId}`,
    );
  }

  // Virtual close row — always appended, mirrors board.ts.
  lines.push(
    buildWorkerCommand("close", epicId, projectDir),
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
    lines.push(
      buildWorkerCommand("work", taskId, dir, task.tier),
      `bun ~/code/keeper/scripts/approve.ts ${taskId}`,
    );
  }

  if (isReady("close", epicId)) {
    lines.push(
      buildWorkerCommand("close", epicId, projectDir),
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
//   `git_dirty_count` / `git_unattributed_to_live_count` / `git_orphan_count`
//   are zeroed (schema v31 split the legacy `git_orphan_count` into the
//   renamed-and-preserved `git_unattributed_to_live_count` and the new
//   strict-mystery `git_orphan_count`; the sim zeroes BOTH so a future
//   predicate-6.5 source flip is covered symmetrically) — the sim models a
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
  // Owning task's `tier` — present only for `work` rows sourced from a
  // task, threaded into `buildWorkerCommand` by the `v` toggle so the
  // copy-paste command carries `--plugin-dir <work-plugins/<tier>>`.
  // `null` on close/approve/git-dirty rows (no work-tier selection),
  // and `null` on work rows whose task spec carries no tier (legacy
  // pre-fn-602.1 / fn-N.1 tasks; degrades to launcher default).
  tier: string | null;
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

/**
 * Suppression-reason union for `shouldSuppressDispatch` (fn-638.3). A
 * `null` return means "fire the dispatch"; any other value names the
 * specific suppression rule that fired. Exported so tests can pin the
 * exact reason per case.
 */
export type SuppressionReason =
  // Once-for-life launch suppression on `work`/`close`. Set on every
  // launch and persists across restarts via `dispatch.log` →
  // `hydrateDispatchLog`. Double-spawning a worker/closer risks git
  // corruption, so this is intentionally irreversible.
  | "launch-suppressed"
  // Approve-only fulfillment suppression. An approve verb's only side
  // effect happens when the human runs `/plan:approve` (the resulting
  // SessionStart fold lands an embedded job for the row and fulfills
  // the key). A dismissed approve window (launched, never fulfilled)
  // must re-dispatch on the next `job-pending` edge to self-heal.
  | "fulfilled-suppressed"
  // Pre-spawn live-session-in-root gate. Suppress when a sibling row in
  // the same effective root already has a `running`-tag verdict OR
  // when a launched-but-unfulfilled dispatch on the same root is still
  // in the propagation gap. Fail-closed on a partial snapshot.
  | "live-in-root";

/**
 * Decide whether `launchInGhostty` must suppress this dispatch and, if
 * so, name the rule that fired. Pure function over the four pieces of
 * state the call site holds — exported so the test suite can drive it
 * with hand-rolled snapshots and dispatch logs.
 *
 * Three suppression rules, in priority order (matching the `launchInGhostty`
 * branching):
 *
 *   1. `verb === "approve"` AND `fulfilledKeys.has(key)` →
 *      `"fulfilled-suppressed"`. Approve is fulfillment-keyed (not
 *      launch-keyed) so a dismissed approve window re-dispatches on
 *      the next `job-pending` edge.
 *   2. `verb in ("work","close")` AND `dispatchedKeys.has(key)` →
 *      `"launch-suppressed"`. Once-for-life launch suppression.
 *   3. `isLiveSessionInRoot(...)` → `"live-in-root"`. The target root
 *      already has a live session (running-tag verdict OR
 *      launched-but-unfulfilled dispatch); self is excluded.
 *
 * Returns `null` to fire the dispatch.
 */
export function shouldSuppressDispatch(
  verb: "work" | "close" | "approve",
  id: string,
  dir: string,
  snap: ReadinessClientSnapshot | null,
  dispatchedKeys: Set<string>,
  fulfilledKeys: Set<string>,
  dispatchLog: DispatchEntry[],
): SuppressionReason | null {
  const key = `${verb}::${id}`;
  if (verb === "approve") {
    if (fulfilledKeys.has(key)) {
      return "fulfilled-suppressed";
    }
  } else if (dispatchedKeys.has(key)) {
    return "launch-suppressed";
  }
  if (isLiveSessionInRoot(snap, dir, verb, id, dispatchLog, fulfilledKeys)) {
    return "live-in-root";
  }
  return null;
}

/**
 * Pre-spawn live-session-in-root gate (fn-638.3).
 *
 * Returns `true` when the target `dir` already hosts a live session that
 * autopilot is NOT about to dispatch itself, so the caller must suppress.
 * "Live" means EITHER:
 *
 *   - the snapshot carries a `running`-tag verdict on a row whose effective
 *     root (task `target_repo` || epic `project_dir`) equals `dir`. The
 *     `running` tag (`{job-running, sub-agent-running, planner-running}`)
 *     is the readiness signal for "a real worker is in motion on this
 *     row"; a second dispatch to the same root would land two live
 *     workers on one target and risk git corruption — the
 *     false-negative-safe failure mode the epic's "best practices"
 *     section calls out.
 *   - the in-memory `dispatchLog` carries a launch line for the same root
 *     whose key is NOT yet in `fulfilledKeys` (autopilot fired the
 *     window but the SessionStart fold has not yet round-tripped into
 *     an embedded job). Skipping this branch would let a second dispatch
 *     race the first inside the dispatch→projection propagation gap.
 *
 * Self is excluded by `(excludeVerb, excludeId)` so a row never blocks
 * its own dispatch. A row that disappeared from the snapshot post-
 * fulfillment (terminal job, epic-delete) does NOT contribute — only
 * `running`-tag verdicts on rows still on the page count.
 *
 * Fail-closed on a partial/empty snapshot: when `snap === null` OR
 * `snap.epics.length === 0`, return `true` (suppress) — duplicate
 * workers on one task corrupt git history; suppressing a dispatch is
 * recoverable on the next snapshot edge.
 *
 * Exported separately so the test suite can drive it with hand-rolled
 * snapshots and dispatch logs.
 */
export function isLiveSessionInRoot(
  snap: ReadinessClientSnapshot | null,
  dir: string,
  excludeVerb: "work" | "close" | "approve",
  excludeId: string,
  dispatchLog: DispatchEntry[],
  fulfilledKeys: Set<string>,
): boolean {
  // Fail-closed on a partial/empty snapshot — see jsdoc above.
  if (snap === null || snap.epics.length === 0) {
    return true;
  }
  // `dir === ""` is the no-cd case; a target with no root cannot collide
  // with another root, but we still scan the dispatch log + snapshot so
  // the helper is symmetric. An empty-root collision is degenerate (only
  // happens if the caller passes through an empty `project_dir`); treat
  // it as "no collision possible" by short-circuiting empty `dir`.
  if (dir === "") {
    return false;
  }
  const excludeKey = `${excludeVerb}::${excludeId}`;
  // Branch 1: snapshot-driven check. Walk every epic + task in the
  // snapshot. For each row whose effective root === `dir`, look up its
  // verdict; a `running` tag means live work. Self is excluded by id.
  //
  // The close-row verdict deliberately is NOT consulted here: the close
  // row's `running` tag fans up from a task worker's verdict via
  // predicate 5 in `evaluateCloseRow`, so a close row at
  // `epic.project_dir` will report `running` even when the actual worker
  // is editing a task's `target_repo` (a different root entirely). To
  // detect "a real session is about to write to `dir`", check ONLY
  // task-level verdicts whose effective root === `dir`, plus the epic's
  // OWN embedded jobs (close-verb / plan-verb) when
  // `epic.project_dir === dir`. That keeps the gate scoped to "actual
  // worker overlap in this root" instead of being tripped by sibling-
  // root activity that rolls up.
  for (const epic of snap.epics) {
    const projectDir = seg(epic.project_dir);
    const epicId = seg(epic.epic_id);
    const tasks = Array.isArray(epic.tasks) ? epic.tasks : [];
    for (const task of tasks) {
      const taskId = seg(task.task_id);
      if (taskId === "") {
        continue;
      }
      const taskRoot = taskCdDir(task as Task, projectDir);
      if (taskRoot !== dir) {
        continue;
      }
      // Skip self. A task-scope row dispatches as
      // `(work|approve, task_id)`; the close-row dispatches as
      // `(close|approve, epic_id)`. Either id form may be the self
      // exclusion.
      if (taskId === excludeId) {
        continue;
      }
      const verdict = snap.readiness.perTask.get(taskId);
      if (verdict !== undefined && verdict.tag === "running") {
        return true;
      }
    }
    // Epic-level: check the epic's OWN jobs (close-verb / plan-verb /
    // approve-close) when `epic.project_dir === dir`. The epic's close-
    // row verdict is intentionally NOT consulted (it fans up from task
    // workers — see the block-doc above). A close-verb or plan-verb job
    // in `state === "working"` IS a session about to write to
    // `epic.project_dir`, so it counts.
    if (projectDir === dir && epicId !== "" && epicId !== excludeId) {
      const epicJobs = Array.isArray(epic.jobs) ? epic.jobs : [];
      for (const job of epicJobs) {
        if (job.state === "working") {
          return true;
        }
      }
    }
  }
  // Branch 2: launched-but-unfulfilled check. A dispatch that has fired
  // (a `kind:"launch"` line in `dispatchLog`) but whose matching
  // embedded job has not yet appeared in the snapshot (the key is NOT
  // in `fulfilledKeys`) is a live session in the propagation gap.
  // Self is excluded by `(verb, id)`.
  for (const entry of dispatchLog) {
    if (entry.dirFull !== dir) {
      continue;
    }
    const key = `${entry.verb}::${entry.id}`;
    if (key === excludeKey) {
      continue;
    }
    if (!fulfilledKeys.has(key)) {
      return true;
    }
  }
  return false;
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
    // Only `work` consumes `tier` in `buildWorkerCommand`; approve /
    // git-dirty rows zero it so the field shape stays uniform.
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
    // Epic-scoped rows (close / approve-close / git-dirty fan-up) have
    // no tier; the work-tier-plugin selection only applies to work.
    tier: null,
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

  // Empty git-status map is deliberate: the autopilot simulator builds a
  // synthetic `Epic[]` and doesn't model real git state. Passing an empty
  // map keeps the simulator's "predicate 6.5 doesn't fire" semantics — the
  // real `subscribeReadiness` pipeline does the live `git_status` lookup
  // before approve/dispatch lands. Don't "fix" this to forward
  // `snap.gitStatus` without first re-checking what the simulator should
  // do with it (today: nothing, the worker hasn't run yet so the live row
  // is the wrong sample).
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
//     `detectJobTransitions` from EITHER of two triggers:
//       (a) the matching embedded job is observed in a terminal state
//           (`"ended"` / `"killed"`); OR
//       (b) the dispatch was already fulfilled in a prior snapshot and
//           `findSessionJob` now returns `undefined` — the parent epic
//           has fallen off the default subscription scope (typically
//           because it's done+approved per `src/collections.ts:251-254`,
//           or was explicitly `planctl epic-delete`d). Both forms migrate
//           the row from `--- current ---` to `--- completed ---`.
//
//     The disappearance trigger relies on the all-three-collections
//     gate in `subscribeReadiness.emitSnapshotIfReady`
//     (`src/readiness-client.ts:840-841`): the client only emits a
//     snapshot once every collection's `result` frame has landed
//     post-reconnect, so a partial mid-reconnect frame cannot
//     spuriously fire the rule.
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
  // Launch rows that were fulfilled but NOT completed and NOT dry,
  // parsed back into the in-memory `DispatchEntry` shape so the
  // `--- current ---` section can survive a restart. Latest-per-key
  // wins (a later `ts` overwrites an earlier launch for the same
  // `(verb, id)`), then the array is sorted by `ts` ascending so the
  // oldest-first frame ordering is preserved. The partition logic at
  // the render seam already keys off `completedKeys` /
  // `fulfilledKeys`, so the restored entries automatically land under
  // `--- current ---` without further main()-side intervention.
  restoredEntries: DispatchEntry[];
} {
  const dispatchedKeys = new Set<string>();
  const fulfilledKeys = new Set<string>();
  const completedKeys = new Set<string>();
  // Buffer every parsed `kind:"launch"` row keyed by `(verb, id)` so
  // we can apply the latest-per-key rule in a second pass — at parse
  // time we don't yet know whether the key will end up in
  // `completedKeys`, so the filter (`fulfilledKeys.has(key) &&
  // !completedKeys.has(key) && !dry`) has to wait for the first pass
  // to finish populating the three sets.
  const launchRows = new Map<string, DispatchEntry>();
  // Buffer every parsed `kind:"window"` row keyed by `(verb, id)` so
  // we can stamp `windowId` onto the matching surviving restored
  // launch entry in pass 2. Latest-ts-wins (an old log can carry a
  // stale id if the window was already reaped; the freshest row is
  // the closest live signal). Track the `ts` alongside the id so the
  // comparison doesn't pin to insertion order.
  const windowRows = new Map<string, { windowId: string; ts: string }>();
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return {
      dispatchedKeys,
      fulfilledKeys,
      completedKeys,
      restoredEntries: [],
    };
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
      // Parse the launch row into a `DispatchEntry` shape. Every
      // field needed by the renderer already lives on the line (see
      // `logDispatch`); type-guard each one and skip silently on a
      // shape mismatch (forensic log, not the event store).
      if (verb !== "work" && verb !== "close" && verb !== "approve") {
        continue;
      }
      const ts = row.ts;
      const rowId = row.rowId;
      const dir = row.dir;
      const dirFull = row.dirFull;
      const command = row.command;
      if (
        typeof ts !== "string" ||
        typeof rowId !== "string" ||
        typeof dir !== "string" ||
        typeof dirFull !== "string" ||
        typeof command !== "string"
      ) {
        continue;
      }
      const dry = row.dry === true;
      const pid = typeof row.pid === "number" ? row.pid : undefined;
      const entry: DispatchEntry = {
        ts,
        kind: "launch",
        rowId,
        dir,
        dirFull,
        verb,
        id,
        command,
        ...(dry ? { dry: true } : {}),
        ...(pid !== undefined ? { pid } : {}),
      };
      // Latest-per-key wins. A historical re-dispatch for the same
      // `(verb, id)` (rare — the durable guard suppresses it — but
      // possible if `dispatch.log` is older than `dispatchedKeys`)
      // collapses to the most recent row.
      const prev = launchRows.get(key);
      if (prev === undefined || prev.ts <= ts) {
        launchRows.set(key, entry);
      }
    } else if (row.kind === "fulfilled") {
      fulfilledKeys.add(key);
    } else if (row.kind === "completed") {
      completedKeys.add(key);
    } else if (row.kind === "window") {
      const ts = row.ts;
      const windowId = row.windowId;
      // Type-guard every field; a shape mismatch (e.g. `windowId`
      // recorded as a number by a future log-format quirk) skips
      // silently per the "malformed lines skip" forensic-log
      // contract. The latest-ts-wins comparison string-compares ISO
      // timestamps (their lex order matches chronological order).
      if (typeof ts !== "string" || typeof windowId !== "string") {
        continue;
      }
      const prev = windowRows.get(key);
      if (prev === undefined || prev.ts <= ts) {
        windowRows.set(key, { windowId, ts });
      }
    }
  }
  // Second pass: apply the restore filter (`fulfilled && !completed
  // && !dry`) against the now-complete three sets, then sort by `ts`
  // ascending to preserve the oldest-first frame ordering. Stamp the
  // matching `windowRows` entry's `windowId` (if any) onto the
  // restored entry so cross-run auto-close still works on a launch
  // that had a window-id capture before the crash/restart.
  const restoredEntries: DispatchEntry[] = [];
  for (const [key, entry] of launchRows) {
    if (!fulfilledKeys.has(key)) {
      continue;
    }
    if (completedKeys.has(key)) {
      continue;
    }
    if (entry.dry === true) {
      continue;
    }
    const window = windowRows.get(key);
    if (window !== undefined) {
      entry.windowId = window.windowId;
    }
    restoredEntries.push(entry);
  }
  restoredEntries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { dispatchedKeys, fulfilledKeys, completedKeys, restoredEntries };
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

/**
 * Closure-dependency record for `detectJobTransitions`. The function
 * was extracted from `main()` so the new fulfilled-then-disappeared
 * branch could be unit-tested in isolation; the production call site
 * inside `main()` wires `appendLine` to `appendFileSync(dispatchLogPath, …)`
 * and the test wires it to an in-memory recorder.
 */
export interface DetectJobTransitionsDeps {
  // Mutable display array. `detectJobTransitions` does not push to it
  // (only `logDispatch` does), but it walks the array each call to
  // partition keys into the three durable sets.
  dispatchLog: DispatchEntry[];
  // Durable cross-snapshot set: a key lands here the first time
  // `findSessionJob` returns a defined job for `(verb, id)`. Survives
  // restarts via `hydrateDispatchLog`.
  fulfilledKeys: Set<string>;
  // Durable cross-snapshot set: a key lands here when the matching job
  // is observed terminal OR (post-fulfillment) when the key disappears
  // from the snapshot. Survives restarts.
  completedKeys: Set<string>;
  // Production wires to the on-disk JSONL path; tests reuse it for
  // warn-line context only.
  dispatchLogPath: string;
  // Lifecycle-warn sink — wraps `appendFileSync(lifecycleSidecar, …)`
  // in production; tests can hand a no-op.
  noteLine: (s: string) => void;
  // The autopilot process pid stamped into every emitted log line.
  pid: number;
  // The disk-append callback. Production wires
  // `(line) => appendFileSync(dispatchLogPath, line)`; tests inject an
  // in-memory recorder to assert the exact JSON shape without touching
  // the filesystem.
  appendLine: (line: string) => void;
  // Auto-close trigger. Fired at BOTH `completedKeys`-entry sites
  // (terminal-state branch AND disappearance branch) so the dispatched
  // Ghostty window exits in lockstep with the underlying agent's
  // terminal state. Production wires a fire-and-forget osascript spawn
  // using the verified repeat-loop close pattern; tests inject a
  // recording closure to assert the windowId reached the callback. The
  // `entry.windowId` (which may be `undefined`) is passed through
  // unconditionally — the production implementation no-ops on
  // `undefined` so the call site can stay branch-free.
  closeWindow: (windowId: string | undefined) => void;
}

/**
 * Walk every dispatch and check whether the snapshot has advanced
 * its matching embedded job:
 *
 *   queued → current      first time a job for (verb, id) is observed
 *                         in the snapshot at all (kind:"fulfilled"
 *                         log line).
 *   current → completed   EITHER first time that job's `state` is
 *                         observed in a terminal value (`"ended"` /
 *                         `"killed"`), OR (post-fulfillment) the
 *                         first time the matching job disappears
 *                         from the snapshot entirely — the parent
 *                         epic has fallen off the default subscription
 *                         scope (typically done+approved per
 *                         `src/collections.ts:251-254`) or was
 *                         `planctl epic-delete`d. Both emit a
 *                         `kind:"completed"` log line with the same
 *                         `{kind, ts, verb, id, pid}` JSON shape.
 *
 * First observation wins for each transition. No-op when nothing
 * changes.
 *
 * The disappearance branch is gated on `fulfilledKeys.has(key)`:
 * without that gate a queued dispatch whose agent hasn't booted yet
 * (also `findSessionJob === undefined`) would migrate to completed
 * instantly. The gate is load-bearing — do not remove it. The branch
 * also relies on `subscribeReadiness.emitSnapshotIfReady`'s
 * all-three-collections gate (`src/readiness-client.ts:840-841`) to
 * avoid firing on a partial post-reconnect frame.
 */
export function detectJobTransitions(
  deps: DetectJobTransitionsDeps,
  snap: ReadinessClientSnapshot,
): void {
  const {
    dispatchLog,
    fulfilledKeys,
    completedKeys,
    noteLine,
    pid,
    appendLine,
    closeWindow,
  } = deps;
  for (const entry of dispatchLog) {
    const key = `${entry.verb}::${entry.id}`;
    if (completedKeys.has(key)) {
      continue;
    }
    const job = findSessionJob(snap, entry.verb, entry.id);
    // Disappearance branch — MUST precede the `job === undefined`
    // early-return below; a future drive-by reorder would silently
    // break the rule. The `fulfilledKeys.has(key)` gate is what
    // distinguishes "epic dropped off the page after fulfillment"
    // (terminal, migrate to completed) from "agent hasn't booted yet"
    // (queued, stay put).
    if (job === undefined && fulfilledKeys.has(key)) {
      completedKeys.add(key);
      try {
        appendLine(
          `${JSON.stringify({
            kind: "completed",
            ts: new Date().toISOString(),
            verb: entry.verb,
            id: entry.id,
            pid,
          })}\n`,
        );
      } catch (err) {
        noteLine(
          `# warn: completed log write failed: ${(err as Error).message}`,
        );
      }
      // Auto-close trigger (disappearance branch). `entry.windowId`
      // may be `undefined`; the production implementation no-ops on
      // that shape so the call here stays branch-free. The
      // `completedKeys.has(key)` guard at the top of the loop ensures
      // a subsequent snapshot doesn't fire `closeWindow` twice.
      closeWindow(entry.windowId);
      continue;
    }
    // Constraint: the disappearance branch above MUST stay above this
    // early-return — otherwise the `fulfilled && undefined` case is
    // preempted and never reaches `completed`.
    if (job === undefined) {
      continue;
    }
    if (!fulfilledKeys.has(key)) {
      fulfilledKeys.add(key);
      try {
        appendLine(
          `${JSON.stringify({
            kind: "fulfilled",
            ts: new Date().toISOString(),
            verb: entry.verb,
            id: entry.id,
            pid,
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
        appendLine(
          `${JSON.stringify({
            kind: "completed",
            ts: new Date().toISOString(),
            verb: entry.verb,
            id: entry.id,
            pid,
          })}\n`,
        );
      } catch (err) {
        noteLine(
          `# warn: completed log write failed: ${(err as Error).message}`,
        );
      }
      // Auto-close trigger (terminal-state branch). Mirrors the
      // disappearance branch above — same once-per-key guarantee via
      // the `completedKeys.has(key)` top-of-loop guard.
      closeWindow(entry.windowId);
    }
  }
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
  // fn-635: readiness diagnostics JSONL log. Same path keeper-wide
  // (shared with `scripts/board.ts`'s drain) so two processes appending
  // concurrently land in one file. POSIX O_APPEND under PIPE_BUF gives
  // atomicity without flock.
  const diagnosticsLogPath = join(
    dirname(sockPath),
    "readiness-diagnostics.jsonl",
  );
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

  // `v` toggles command display. When on, every command-bearing row
  // (dispatched current/queued/completed + predicted work/close/approve)
  // gets one extra indented line carrying the full shell command, so the
  // human can mouse-select it and run it manually. Informational
  // `git-dirty` predicted rows have no command behind them and are never
  // annotated. The toggle repaints the live body via `refreshLive` (no
  // history growth) and adds a `[cmd]` marker to the banner.
  let showCommands = false;

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
  const { dispatchedKeys, fulfilledKeys, completedKeys, restoredEntries } =
    hydrateDispatchLog(dispatchLogPath);
  // Seed the in-memory display array from any prior-run launches that
  // were fulfilled but not completed (and not dry) — so a still-running
  // cross-run dispatch renders under `--- current ---` immediately on
  // startup instead of waiting for the next snapshot transition. The
  // partition logic in `renderDispatchFrame` already keys off
  // `completedKeys` / `fulfilledKeys`, so the restored entries land
  // under `--- current ---` automatically; if the matching job has
  // since fallen off the projection (epic became done+approved or was
  // epic-deleted), `detectJobTransitions`'s disappearance branch
  // migrates the key to `completedKeys` on the first post-startup
  // snapshot and the row moves to `--- completed ---`.
  const dispatchLog: DispatchEntry[] = restoredEntries;

  function renderDispatchFrame(): string[] {
    // Four named-header sections, each only emitted when non-empty,
    // rendered in this order: `--- current ---` (this-run dispatches
    // observed registered but not yet terminal), `--- queued ---`
    // (this-run dispatches still waiting on the agent to boot),
    // `--- predicted ---` (`predictNextDispatches` output for the next
    // edges as in-flight jobs finish), and `--- completed ---` (this-
    // run dispatches whose matching embedded job has either reached a
    // terminal state `"ended"` / `"killed"` OR — after the dispatch was
    // already fulfilled in a prior snapshot — has disappeared from the
    // subscription page entirely, typically because the parent epic
    // became done+approved and fell out of the default epics scope
    // per `src/collections.ts:251-254`, or because the human ran an
    // explicit `planctl epic-delete` against the fulfilled target).
    // The ordering is attention-first — live agents at the top, growing
    // history at the bottom so completed rows don't push live state
    // around. In wet mode queued is typically transient (1-3 frames
    // between dispatch and SessionStart fold); in dry mode it persists
    // until the human runs the command manually (no real session ever
    // boots, so neither `current` nor `completed` ever populates for a
    // dry dispatch).
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
      } else if (showCommands) {
        // `v` toggle: surface the real fused command (`cd … && claude
        // --name … '/plan:…'`) on one indented line for copy-paste.
        // Dry rows already carry their footer above, so they're skipped.
        target.push(`  ${e.command}`);
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
    // Dir column width so `verb::id` aligns across all predicted rows:
    // `(<dir>) ` is `dir.length + 3` chars; widen to the max so e.g.
    // `(keeper) ` gets a trailing space to match `(arthack) `. Zero when
    // no row has a dir.
    const maxDirLen = predictedRows.reduce(
      (m, r) => Math.max(m, r.dir.length),
      0,
    );
    const dirColWidth = maxDirLen === 0 ? 0 : maxDirLen + 3;
    for (const r of predictedRows) {
      const dirSegRaw = r.dir === "" ? "" : `(${r.dir}) `;
      const dirSeg = dirSegRaw.padEnd(dirColWidth);
      out.push(`${dirSeg}${r.verb}::${r.id}`);
      // `v` toggle: every dispatch-backed preview row (work/close/approve)
      // gets its would-run command on one indented line for copy-paste.
      // The informational `git-dirty` row has no dispatch behind it, so
      // it's never annotated.
      if (showCommands && r.verb !== "git-dirty") {
        out.push(`  ${buildWorkerCommand(r.verb, r.id, r.dirFull, r.tier)}`);
      }
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
    if (v.tag === "running") {
      return `running:${v.reason.kind}`;
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
    snap: ReadinessClientSnapshot | null,
  ): void {
    // Re-dispatch guard (fn-638.3). Three suppression rules, evaluated
    // in `shouldSuppressDispatch` (pure, exported for testing):
    //
    //   - `launch-suppressed`: once-for-life launch guard for `work` /
    //     `close`. Double-spawning a worker or closer can corrupt git
    //     history, so once-dispatched stays once-dispatched across
    //     this run AND across restarts (seeded from `dispatch.log` on
    //     startup via `hydrateDispatchLog`).
    //   - `fulfilled-suppressed`: approve-only fulfillment guard. An
    //     approve verb has no side effect until the human runs
    //     `/plan:approve` — so a dismissed approve window (launch line
    //     written, never fulfilled) must re-dispatch on the next
    //     `job-pending` edge to self-heal. Keying on launch would
    //     deadlock everything queued behind the dismissed approve.
    //   - `live-in-root`: pre-spawn live-session-in-root gate. Refuse
    //     when a sibling row in the same effective root already has a
    //     `running`-tag verdict OR a launched-but-unfulfilled dispatch
    //     on the same root. Self is excluded. Fail-closed on a
    //     partial/empty snapshot.
    //
    // `lastVerdictSig` still handles same-signature edges in-memory at
    // the call site; these guards are the persistent backstop.
    const key = `${verb}::${id}`;
    const suppression = shouldSuppressDispatch(
      verb,
      id,
      dirFull,
      snap,
      dispatchedKeys,
      fulfilledKeys,
      dispatchLog,
    );
    if (suppression !== null) {
      noteLine(
        `${new Date().toISOString()} re-dispatch suppressed (${suppression}) pid=${process.pid} ${key} dir=${dirFull} (rowId=${rowId})`,
      );
      return;
    }
    // `-l -i` = login + interactive — login alone sources `.zprofile` only,
    // so `claude` (and most user PATH additions) live in the interactive
    // rc file (`.zshrc` / `.bashrc`) which is interactive-only. Without
    // `-i` the spawned shell can't find `claude`. zsh's `exec_opt` is OFF
    // under `-i` (verified live), so `exec <shell>` re-spawns rather than
    // replacing — claude stays a CHILD of a live login+interactive shell,
    // and on claude's exit the shell drops into an interactive prompt the
    // human can use (vim fallback for the rare case auto-close fails to
    // fire). Applies to any POSIX-ish login+interactive shell, not just
    // zsh.
    const shell = validateShell(process.env.SHELL) ?? "/bin/zsh";
    // Wrap the worker command so claude is a child of $SHELL and a fresh
    // interactive shell takes over on claude's exit. The outer `-l -i -c`
    // runs the body string; the trailing `exec ${shell} -l -i` keeps a
    // usable shell in the Ghostty window so a dropped session is not a
    // dead window.
    const shellInvocation = `${shell} -l -i -c ${JSON.stringify(`${workerShellCommand} ; exec ${shell} -l -i`)}`;
    const appleScript = [
      'tell application "Ghostty"',
      "set cfg to new surface configuration",
      `set command of cfg to ${JSON.stringify(shellInvocation)}`,
      // `set w to new window …` captures the spawned window so we can
      // `return id of w`; the AppleScript stdout is then piped to
      // osascript's exit-0 stdout (`tab-group-…`) which we parse for the
      // `windowId` stamp. Isolating the osascript spawn from the yabai
      // tail keeps that capture clean.
      "set w to new window with configuration cfg",
      "return id of w",
      "end tell",
    ];
    const osascriptArgs: string[] = [];
    for (const line of appleScript) {
      osascriptArgs.push("-e", line);
    }
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
      // Spawn osascript as its OWN process so its stdout carries ONLY
      // the bare window id (`tab-group-…`). The yabai move below is a
      // separate fire-and-forget step so its output never pollutes the
      // capture.
      const proc = Bun.spawn(["osascript", ...osascriptArgs], {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
        .then(([exitCode, stdoutText, stderrText]) => {
          if (stderrText.length > 0) {
            noteLine(`# launch stderr (${rowId}): ${stderrText.trim()}`);
          }
          const windowId = stdoutText.trim();
          if (exitCode === 0 && windowId.length > 0) {
            // Mutate the LIVE in-memory entry by reference (find by
            // `${verb}::${id}`). The just-pushed entry is the last
            // matching `(verb, id)` in `dispatchLog`; scan backward to
            // grab it without iterating the full array.
            const liveKey = `${verb}::${id}`;
            for (let i = dispatchLog.length - 1; i >= 0; i--) {
              const e = dispatchLog[i];
              if (e !== undefined && `${e.verb}::${e.id}` === liveKey) {
                e.windowId = windowId;
                break;
              }
            }
            // Persist the windowId to disk as a `window` kind row via
            // a raw `appendFileSync` — NOT `logDispatch` (which would
            // re-push a display entry and re-add to `dispatchedKeys`).
            // Try/catch → noteLine on failure; the in-memory stamp
            // still carries the same-run auto-close path forward.
            try {
              appendFileSync(
                dispatchLogPath,
                `${JSON.stringify({
                  kind: "window",
                  ts: new Date().toISOString(),
                  verb,
                  id,
                  windowId,
                })}\n`,
              );
            } catch (err) {
              noteLine(
                `# warn: window log write failed: ${(err as Error).message}`,
              );
            }
          } else if (exitCode !== 0) {
            noteLine(
              `# warn: osascript spawn for ${rowId} exited non-zero (${exitCode}); window will not auto-close`,
            );
          }
        })
        .catch((err) => {
          noteLine(
            `# warn: launch spawn for ${rowId} failed: ${(err as Error).message}`,
          );
        });
      // Separate fire-and-forget yabai move — `yabai -m window --space 5`
      // operates on the focused window, which is the brand-new Ghostty
      // window. The 0.3s sleep gives Ghostty time to claim focus. yabai
      // not being installed is fine (`|| true`).
      try {
        Bun.spawn(
          [
            "sh",
            "-c",
            "sleep 0.3 && yabai -m window --space 5 2>/dev/null || true",
          ],
          { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
        );
      } catch {
        // best-effort; the dispatch already shipped via osascript.
      }
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
      // Within a single epic, defer the side-effecting `launchInGhostty`
      // calls into two buckets so approves fire ahead of any work/close
      // dispatches. Edge detection (prev→cur diff, logTransition,
      // lastVerdictSig.set) stays in the existing one-pass walk so every
      // transition is still recorded exactly once. Matches the
      // predicted-section ordering in `predictNextDispatches`
      // (approvals → informational → workers → closers); an approve still
      // requires `cur === "blocked:job-pending"` for that row, no trigger
      // conditions are relaxed.
      const approveDispatches: Array<() => void> = [];
      const workCloseDispatches: Array<() => void> = [];

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
        const dirBase = dir === "" ? "" : basename(dir);
        if (cur === "ready") {
          workCloseDispatches.push(() =>
            launchInGhostty(
              buildWorkerCommand("work", taskId, dir, task.tier),
              `task ${taskId}`,
              dirBase,
              dir,
              "work",
              taskId,
              snap,
            ),
          );
        } else if (cur === "blocked:job-pending") {
          approveDispatches.push(() =>
            launchInGhostty(
              buildWorkerCommand("approve", taskId, dir),
              `approve task ${taskId}`,
              dirBase,
              dir,
              "approve",
              taskId,
              snap,
            ),
          );
        }
      }

      const epicId = seg(epic.epic_id);
      if (epicId !== "") {
        const closeKey = `close:${epicId}`;
        const closeCur = verdictSignature(
          snap.readiness.perCloseRow.get(epicId),
        );
        const closePrev = lastVerdictSig.get(closeKey);
        if (closePrev !== closeCur) {
          logTransition(closeKey, closePrev, closeCur, closeDetail(epic, snap));
          lastVerdictSig.set(closeKey, closeCur);
          const dirBase = projectDir === "" ? "" : basename(projectDir);
          if (closeCur === "ready") {
            workCloseDispatches.push(() =>
              launchInGhostty(
                buildWorkerCommand("close", epicId, projectDir),
                `close ${epicId}`,
                dirBase,
                projectDir,
                "close",
                epicId,
                snap,
              ),
            );
          } else if (closeCur === "blocked:job-pending") {
            approveDispatches.push(() =>
              launchInGhostty(
                buildWorkerCommand("approve", epicId, projectDir),
                `approve close ${epicId}`,
                dirBase,
                projectDir,
                "approve",
                epicId,
                snap,
              ),
            );
          }
        }
      }

      for (const fire of approveDispatches) {
        fire();
      }
      for (const fire of workCloseDispatches) {
        fire();
      }
    }
  }

  const detectJobTransitionsDeps: DetectJobTransitionsDeps = {
    dispatchLog,
    fulfilledKeys,
    completedKeys,
    dispatchLogPath,
    noteLine,
    pid: process.pid,
    appendLine: (line: string): void => {
      appendFileSync(dispatchLogPath, line);
    },
    closeWindow: (windowId: string | undefined): void => {
      // No-op on undefined (no id was captured at launch — the
      // shell-fallback covers the window; it just won't auto-close)
      // and under `--dry-run` (the spawn itself was suppressed, so
      // there's no window to close). Under dry-run we still
      // `noteLine` the intended close so the lifecycle sidecar
      // shows the would-have-fired path.
      if (windowId === undefined || windowId === "") {
        return;
      }
      if (dryRun) {
        noteLine(
          `# closeWindow (dry) windowId=${windowId} — would close Ghostty window`,
        );
        return;
      }
      // Verified repeat-loop close pattern (tip Ghostty
      // `cb36966a7`, 2026-05-29): `close window id "..."` errors
      // -2741 (text vs integer specifier), `close <w>` errors -1708
      // (verb belongs to the `terminal` class not `window`). The
      // repeat-loop walks the window list, matches by id, and fires
      // `close window <w>` against the AppleScript object reference
      // — the only form that actually reaps the surface.
      const appleScript = [
        `set wid to ${JSON.stringify(windowId)}`,
        'tell application "Ghostty"',
        "repeat with w in every window",
        "if id of w is wid then",
        "close window w",
        "return",
        "end if",
        "end repeat",
        'return "not-found"',
        "end tell",
      ];
      const args: string[] = [];
      for (const line of appleScript) {
        args.push("-e", line);
      }
      try {
        const proc = Bun.spawn(["osascript", ...args], {
          stdout: "ignore",
          stderr: "pipe",
          stdin: "ignore",
        });
        // Fire-and-forget; surface stderr (osascript error or
        // "not-found") to the lifecycle sidecar but never throw
        // back into the transitions loop.
        Promise.all([proc.exited, new Response(proc.stderr).text()])
          .then(([_exitCode, stderrText]) => {
            if (stderrText.length > 0) {
              noteLine(
                `# closeWindow stderr (${windowId}): ${stderrText.trim()}`,
              );
            }
          })
          .catch((err) => {
            noteLine(
              `# warn: closeWindow spawn (${windowId}) failed: ${(err as Error).message}`,
            );
          });
      } catch (err) {
        noteLine(
          `# warn: closeWindow spawn (${windowId}) failed: ${(err as Error).message}`,
        );
      }
    },
  };

  let firstPaintLogged = false;
  const onSnapshot = (snap: ReadinessClientSnapshot): void => {
    lastSnap = snap;
    // fn-635: drain readiness diagnostics first. Verdict-edge handling
    // (`processLaunchTransitions`, `detectJobTransitions`) is unchanged;
    // the drain is a pure observation step that records the resolver's
    // ambiguity findings to a shared JSONL log siblings the dispatch
    // log. Same single-O_APPEND-line-under-PIPE_BUF atomicity contract
    // as the dispatch log.
    for (const d of snap.readiness.diagnostics) {
      appendDiagnostic(d, diagnosticsLogPath);
    }
    detectJobTransitions(detectJobTransitionsDeps, snap);
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
  const statusLine = (): string => {
    const parts: string[] = [];
    if (!dryRun) {
      parts.push(paused ? "[paused]" : "[playing]");
    }
    if (showCommands) {
      parts.push("[cmd]");
    }
    return parts.join(" ");
  };
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
        liveShell.setStatus(statusLine());
        if (!paused && lastSnap !== null) {
          processLaunchTransitions(lastSnap);
        }
        return;
      }
      if (key === "v") {
        // Toggle command display. Repaint the live body via `refreshLive`
        // so the per-row command lines appear/disappear without pushing a
        // frame to history (a pure view toggle, like the pause indicator),
        // and reflect the state in the banner with a `[cmd]` marker.
        showCommands = !showCommands;
        liveShell.setStatus(statusLine());
        liveShell.refreshLive(renderDispatchFrame());
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
          // Restore the status indicator (not "") so the [paused] /
          // [playing] / [cmd] state survives the copy flash.
          copyStatusTimer = setTimeout(
            () => liveShell.setStatus(statusLine()),
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
  liveShell.setStatus(statusLine());

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
