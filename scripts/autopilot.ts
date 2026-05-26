#!/usr/bin/env bun
/**
 * keeper-autopilot — live command list over the keeper subscribe server.
 * Renders TWO `===`-delimited blocks per frame:
 *
 *   1. Flat ordered list of shell commands for each task and epic, in the
 *      same traversal order as `scripts/board.ts`'s epic rendering. Every
 *      task pair (work + approve) plus every epic close pair (close +
 *      approve), unfiltered.
 *   2. Only the rows whose readiness verdict is `{ tag: "ready" }` —
 *      the same set surfaced by board's `[ready]` pills. The block opens
 *      with a one-line `# header` reminding the reader that this list is
 *      "any one of these can be dispatched next," NOT a parallel work
 *      queue: the single-root post-pass in `src/readiness.ts` keeps at
 *      most one ready row per project root.
 *
 * The two blocks are joined by `\n===\n` (mirrors board's `\n~~~\n`).
 * When both are empty the body is empty — no `===` divider, no chrome.
 *
 * For each epic, in order:
 *
 *   cd <target_repo> && claude '/plan:work <task_id>'
 *   bun ~/code/keeper/scripts/approve.ts <task_id>
 *   ...                                               (one pair per task)
 *   cd <project_dir> && claude '/plan:close <epic_id>'
 *   bun ~/code/keeper/scripts/approve.ts <epic_id>
 *
 * Epics are separated by a blank line. Each frame is led by `---`.
 * A new frame prints only when the rendered output changes (byte-compare
 * on the COMBINED two-block body — a verdict transition with no task-set
 * change still emits because block 2 changes).
 *
 * `task.target_repo` is used as the `cd` path for worker commands; falls
 * back to `epic.project_dir` when `target_repo` is null.
 *
 * Connection / poll / sidecar / SIGINT semantics: the helper
 * (`src/readiness-client.ts`) owns capped-backoff reconnect, the
 * all-three-strict first-paint gate, per-collection coalesce, and the
 * computeReadiness handoff. SIGINT calls the live-shell's `dispose()`
 * THEN `handle.dispose()` — the shell restores the terminal first, then
 * the helper drops every subscription via a bare `unsubscribe` frame,
 * releases timers, and exits cleanly. THREE indexed sidecar files per
 * frame (state JSON + frame text + per-frame unified diff against the
 * previous emit) plus a session meta file at
 * `/tmp/keeper-autopilot.<pid>.meta.txt` accumulate the full index
 * (tab-separated: frame# state frame diff).
 *
 * Usage:
 *   bun scripts/autopilot.ts [--sock <path>] [--launch]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --launch         Auto-dispatch on verdict edges: spawn a Ghostty
 *                    window running the worker command on the EDGE into
 *                    `{ tag: "ready" }` for both task rows and close
 *                    rows; fire `notifyctl` on the EDGE into
 *                    `{ tag: "blocked", reason: { kind: "job-pending" } }`
 *                    (worker_phase done + approval pending). The Ghostty
 *                    window's command is the `cd … && claude '/plan:work …'`
 *                    line ONLY — never the approval script; approvals
 *                    remain the human's prerogative and are what the
 *                    notifyctl alert is for. After spawn we try
 *                    `yabai -m window --space 5` to shove the new window
 *                    onto space 5; yabai's absence is tolerated.
 *                    Per-row verdict signature is carried across snapshots
 *                    in a `Map<string,string>`; the empty initial map
 *                    means autopilot's first paint after process start
 *                    fires for everything currently ready / pending. The
 *                    map is NOT cleared on reconnect — a re-paint of the
 *                    same verdicts does not refire.
 *   --help           Show this help.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import type { Verdict } from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import type { Epic } from "../src/types";

const HELP = `keeper-autopilot — live command list over the keeper subscribe server

Usage: bun scripts/autopilot.ts [--sock <path>] [--launch]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --launch         Auto-dispatch ready rows: spawn a Ghostty window running
                   the worker command for each task/close row whose verdict
                   transitions into { tag: "ready" }, and notifyctl when a
                   task/close row transitions into "approval pending"
                   (worker_phase done + approval pending). Tries to move
                   the new Ghostty window to yabai space 5 if yabai is
                   installed.
  --help           Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  q/Ctrl-C quit. Per-frame sidecars are indexed; lifecycle + warn output
  is appended to /tmp/keeper-autopilot.<pid>.lifecycle.txt. Session
  paths print on exit.

Emits two ===-delimited blocks per frame. Block 1 lists every task pair
(work + approve) and every epic close pair (close + approve) in
scripts/board.ts traversal order. Block 2 lists only those pairs whose
readiness verdict is { tag: "ready" } — "any one of these can be
dispatched next" (single-root post-pass keeps at most one ready row per
project root), NOT a parallel work queue.

Per-epic command shape:

  cd <target_repo> && claude '/plan:work <task_id>'
  bun ~/code/keeper/scripts/approve.ts <task_id>
  ...
  cd <project_dir> && claude '/plan:close <epic_id>'
  bun ~/code/keeper/scripts/approve.ts <epic_id>

Epics are separated by a blank line within each block. Blocks are joined
by '\\n===\\n'. Each frame is led by '---'. A new frame prints only when
the rendered output changes (byte-compare on the combined two-block body
— a verdict transition with no task-set change still emits).

task.target_repo is used as the cd path for worker commands; falls back
to epic.project_dir when target_repo is null.

The helper waits for keeperd to come up and reconnects across restarts;
each connection-lifecycle change prints a ...-fenced note. Every emitted
frame is mirrored to three /tmp sidecar files (JSON state, frame text,
unified diff vs. the previous emit). Ctrl-C calls dispose() and exits 0.
`;

const seg = (v: unknown) => (v == null ? "" : String(v));

const READY_HEADER =
  "# any one of these can be dispatched next — NOT a parallel work queue";
const READY_HEADER_NOTE =
  "# (single-root post-pass in src/readiness.ts keeps at most one ready row per project root)";

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
      launch: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  const launchEnabled = values.launch === true;
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const liveShell = createLiveShell({ enabled: true });
  let frameCount = 0;

  // Byte-compare the COMBINED two-block body — internal row churn that
  // doesn't surface in either block's render is invisible by design.
  // A verdict transition with no task-set change still changes block 2,
  // so the byte compare correctly emits.
  let lastBody: string | null = null;
  // Snapshot of the most recent emitted state, for the JSON sidecar.
  let lastEpicsSnapshot: Epic[] = [];

  // --- command rendering ---
  // `renderEpicCommands` and `renderEpicCommandsFiltered` live at module
  // scope above so test/autopilot.test.ts can import them directly.

  /**
   * Full frame body: two `===`-delimited blocks, returned as one element
   * per output line so the live-shell can consume lines (per-line ANSI
   * diff). The caller joins with `\n` for stdout / sidecar / byte-compare.
   *
   * Block 1 — every task pair + close pair per epic, server order.
   * Block 2 — only rows whose readiness verdict tag is `"ready"`, with
   *           a one-line `#`-prefixed header explaining the single-root
   *           post-pass semantics.
   *
   * When both blocks are empty the body is `===` alone (preserves the
   * divider — mirrors board's empty-section policy).
   */
  function renderBody(snap: ReadinessClientSnapshot): string[] {
    const epicsArr = snap.epics;
    const readiness = snap.readiness;
    const isReady = (kind: "task" | "close", id: string): boolean => {
      const verdict =
        kind === "task"
          ? readiness.perTask.get(id)
          : readiness.perCloseRow.get(id);
      return verdict !== undefined && verdict.tag === "ready";
    };

    const block1 =
      epicsArr.length === 0
        ? ""
        : epicsArr.map((e) => renderEpicCommands(e)).join("\n\n");

    const readyBlocks: string[] = [];
    for (const epic of epicsArr) {
      const rendered = renderEpicCommandsFiltered(epic, isReady);
      if (rendered != null) {
        readyBlocks.push(rendered);
      }
    }
    const block2 =
      readyBlocks.length === 0
        ? ""
        : `${READY_HEADER}\n${READY_HEADER_NOTE}\n${readyBlocks.join("\n\n")}`;

    let body: string;
    if (block1 === "" && block2 === "") {
      body = "";
    } else if (block1 === "") {
      body = block2;
    } else if (block2 === "") {
      body = block1;
    } else {
      body = `${block1}\n===\n${block2}`;
    }
    return body === "" ? [] : body.split("\n");
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

    const stateJson = { epics: lastEpicsSnapshot };
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

  /**
   * Emit a frame iff the rendered body changed since the last emit.
   * The all-three-strict first-paint gate lives in the helper — by the
   * time this fires, the snapshot is guaranteed complete.
   */
  function emitFrameIfChanged(snap: ReadinessClientSnapshot): void {
    const bodyLines = renderBody(snap);
    const body = bodyLines.join("\n");
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    lastEpicsSnapshot = snap.epics;
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
    noteLine(`# launch: ${rowId} -- ${workerShellCommand}`);
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
    noteLine(`# notify: approval-pending ${kind} ${rowId}`);
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

  const onSnapshot = (snap: ReadinessClientSnapshot): void => {
    if (launchEnabled) {
      processLaunchTransitions(snap);
    }
    emitFrameIfChanged(snap);
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
    log("...");
    log(`meta: ${metaSidecar}`);
    log(`lifecycle: ${lifecycleSidecar}`);
    log("...");
    process.exit(0);
  });
}

if (import.meta.main) {
  await main();
}
