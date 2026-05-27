#!/usr/bin/env bun
/**
 * keeper-autopilot — dispatch log viewer over the keeper subscribe server.
 *
 * Subscribes to keeperd and auto-dispatches ready rows. Each frame lists
 * every command dispatched so far, oldest first:
 *
 *   launch  cd <dir> && claude '/plan:work <task_id>'
 *   notify  task <id> done — needs approval
 *
 * Dispatches are persisted to ~/.local/state/keeper/dispatch.log (JSONL)
 * for forensic tailing across restarts, but each run's frame only shows
 * dispatches from this run — the file is write-only from autopilot's
 * perspective. A new frame is emitted immediately after each dispatch.
 *
 * Fires side effects on EDGES in the readiness verdicts:
 *   → ready          spawn a Ghostty window running the worker command
 *                    (`cd … && claude '/plan:work …'` or '/plan:close …')
 *   → job-pending    fire `notifyctl` (worker done, approval needed)
 * The approval step is always the human's prerogative. Per-row verdict
 * signature is carried in a Map across snapshots; the map is NOT cleared
 * on reconnect so reconnects don't refire already-seen edges.
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

import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import type { Verdict } from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import type { Epic } from "../src/types";

const HELP = `keeper-autopilot — dispatch log viewer over the keeper subscribe server

Usage: bun scripts/autopilot.ts [--sock <path>] [--dry-run]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --dry-run        Log dispatches to the frame and disk but skip the
                   actual Ghostty spawn and notifyctl call. Entries
                   appear as "launch (dry)  <command>".
  --help           Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  q/Ctrl-C quit. Per-frame sidecars are indexed; lifecycle + warn output
  is appended to /tmp/keeper-autopilot.<pid>.lifecycle.txt. Session
  paths print on exit.

Each frame lists every command dispatched so far, oldest first:

  launch  cd <dir> && claude '/plan:work <task_id>'
  notify  task <id> done — needs approval

Each run's frame shows only dispatches from this run; the JSONL log at
~/.local/state/keeper/dispatch.log is still appended for forensic tailing
across restarts. A new frame is emitted after each dispatch.

The helper waits for keeperd to come up and reconnects across restarts;
each connection-lifecycle change is appended to the lifecycle sidecar.
Ctrl-C calls dispose() and exits 0.
`;

const seg = (v: unknown) => (v == null ? "" : String(v));

interface DispatchEntry {
  ts: string;
  kind: "launch" | "notify";
  rowId: string;
  command?: string;
  message?: string;
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
  const liveShell = createLiveShell({ enabled: true });
  let frameCount = 0;

  let lastBody: string | null = null;

  // Frames show only dispatches from this run; logDispatch still appends
  // to `dispatchLogPath` for forensic tailing across restarts.
  const dispatchLog: DispatchEntry[] = [];

  function renderDispatchFrame(): string[] {
    if (dispatchLog.length === 0) {
      return ["# no commands dispatched yet"];
    }
    return dispatchLog.map((e) => {
      const dry = e.dry ? " (dry)" : "";
      if (e.kind === "launch") {
        return `launch${dry}  ${e.command ?? ""}`;
      }
      return `notify${dry}  ${e.message ?? ""}`;
    });
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
  // effects (Ghostty window for "→ ready", notifyctl for "→ approval
  // pending") on the EDGE — `prev !== cur` with `cur` being one of those
  // two signatures. The map is INTENTIONALLY not cleared on disconnect:
  // a reconnect's first paint will see the same signatures as the last
  // pre-disconnect frame and produce no spurious fires. The empty initial
  // map means autopilot's first paint DOES fire for everything currently
  // ready / pending — that is desired: "start autopilot, things you need
  // to do open up."
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
  function launchInGhostty(workerShellCommand: string, rowId: string): void {
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

  function notifyApprovalPending(rowId: string, kind: "task" | "close"): void {
    const title = "keeper: approval needed";
    const message =
      kind === "task"
        ? `task ${rowId} done — needs approval`
        : `epic ${rowId} close done — needs approval`;
    logDispatch({
      ts: new Date().toISOString(),
      kind: "notify",
      rowId,
      message,
      dry: dryRun || undefined,
    });
    if (dryRun) return;
    try {
      const proc = Bun.spawn(
        [
          "notifyctl",
          "show-message",
          "-t",
          title,
          "-m",
          message,
          "--sound",
          "Ping",
        ],
        { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      );
      proc.exited
        .then(async () => {
          const errText = await new Response(proc.stderr).text();
          if (errText.length > 0) {
            noteLine(`# notify stderr (${rowId}): ${errText.trim()}`);
          }
        })
        .catch((err) => {
          noteLine(
            `# warn: notify spawn for ${rowId} failed: ${(err as Error).message}`,
          );
        });
    } catch (err) {
      noteLine(
        `# warn: notify spawn for ${rowId} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Walk every task + close row in the snapshot and fire side effects on
   * EDGES into "ready" (Ghostty) or "blocked:job-pending" (notifyctl).
   * `lastVerdictSig` is updated unconditionally so transitions out of
   * those states (back to running, etc.) are recorded for the next edge.
   *
   * Worker commands MIRROR `renderEpicCommands` but DROP the approval
   * line — the worker is what we want spawned; the approval step stays
   * the human's prerogative (and is what notifyctl alerts about).
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
        if (cur === "ready") {
          const dir =
            task.target_repo != null && seg(task.target_repo) !== ""
              ? seg(task.target_repo)
              : projectDir;
          const cdPrefix = dir === "" ? "" : `cd ${dir} && `;
          launchInGhostty(
            `${cdPrefix}claude '/plan:work ${taskId}'`,
            `task ${taskId}`,
          );
        } else if (cur === "blocked:job-pending") {
          notifyApprovalPending(taskId, "task");
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
      if (closeCur === "ready") {
        const cdPrefix = projectDir === "" ? "" : `cd ${projectDir} && `;
        launchInGhostty(
          `${cdPrefix}claude '/plan:close ${epicId}'`,
          `close ${epicId}`,
        );
      } else if (closeCur === "blocked:job-pending") {
        notifyApprovalPending(epicId, "close");
      }
    }
  }

  let firstPaintLogged = false;
  const onSnapshot = (snap: ReadinessClientSnapshot): void => {
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
