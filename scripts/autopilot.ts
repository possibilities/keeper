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
 * When both are empty the body is `===` alone — same `---` lead, just a
 * divider line.
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
 * computeReadiness handoff. SIGINT calls `handle.dispose()` — which
 * drops every subscription via a bare `unsubscribe` frame, releases
 * timers, and exits cleanly. THREE sidecar files (state JSON + frame
 * text + per-frame unified diff against the previous emit) are
 * overwritten each frame. In `--clear` mode each frame's sidecars are
 * indexed so past frames persist, and a session meta file at
 * `/tmp/keeper-autopilot.<pid>.meta.txt` accumulates the full index
 * (tab-separated: frame# state frame diff).
 *
 * Usage:
 *   bun scripts/autopilot.ts [--sock <path>] [--clear]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --clear          Clear the terminal before each frame (live-panel mode).
 *   --help           Show this help.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import type { Epic } from "../src/types";

const HELP = `keeper-autopilot — live command list over the keeper subscribe server

Usage: bun scripts/autopilot.ts [--sock <path>] [--clear]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --clear          Clear the terminal before each frame (live-panel mode).
                   Each frame's sidecars are written to indexed paths
                   instead of overwriting, and a session meta file at
                   /tmp/keeper-autopilot.<pid>.meta.txt accumulates the full
                   index (tab-separated: frame# state frame diff).
  --help           Show this help

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

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      clear: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const clearMode = values.clear;
  let frameCount = 0;

  // Byte-compare the COMBINED two-block body — internal row churn that
  // doesn't surface in either block's render is invisible by design.
  // A verdict transition with no task-set change still changes block 2,
  // so the byte compare correctly emits.
  let lastBody: string | null = null;
  // Snapshot of the most recent emitted state, for the JSON sidecar.
  let lastEpicsSnapshot: Epic[] = [];

  // --- command rendering ---

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
  function renderEpicCommands(epic: Epic): string {
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
  function renderEpicCommandsFiltered(
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

  /**
   * Full frame body: two `===`-delimited blocks.
   *
   * Block 1 — every task pair + close pair per epic, server order.
   * Block 2 — only rows whose readiness verdict tag is `"ready"`, with
   *           a one-line `#`-prefixed header explaining the single-root
   *           post-pass semantics.
   *
   * When both blocks are empty the body is `===` alone (preserves the
   * divider — mirrors board's empty-section policy).
   */
  function renderBody(snap: ReadinessClientSnapshot): string {
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

    return `${block1}\n===\n${block2}`;
  }

  // --- sidecar paths ---

  const stateSidecar = `/tmp/keeper-autopilot.${process.pid}.state.json`;
  const frameSidecar = `/tmp/keeper-autopilot.${process.pid}.frame.txt`;
  const diffSidecar = `/tmp/keeper-autopilot.${process.pid}.diff.txt`;
  // Internal scratch path for the previous frame text — fed to `diff -u`.
  const prevFrameTmp = `/tmp/keeper-autopilot.${process.pid}.prev.frame.txt`;
  // Session-level meta file: one tab-separated line per frame. Only written
  // in `--clear` mode; accumulates across the session.
  const metaSidecar = `/tmp/keeper-autopilot.${process.pid}.meta.txt`;
  // In-memory copy of the last emitted frame text (for the diff).
  let lastFrameText: string | null = null;

  function writeSidecars(frameText: string): void {
    // In --clear mode each frame's sidecars are indexed so past frames persist.
    const sState = clearMode
      ? `/tmp/keeper-autopilot.${process.pid}.state.${frameCount}.json`
      : stateSidecar;
    const sFrame = clearMode
      ? `/tmp/keeper-autopilot.${process.pid}.frame.${frameCount}.txt`
      : frameSidecar;
    const sDiff = clearMode
      ? `/tmp/keeper-autopilot.${process.pid}.diff.${frameCount}.txt`
      : diffSidecar;

    const stateJson = { epics: lastEpicsSnapshot };
    try {
      writeFileSync(sState, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      log(`# warn: sidecar write failed: ${(err as Error).message}`);
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
      log(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    if (clearMode) {
      try {
        appendFileSync(
          metaSidecar,
          `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
        );
      } catch (err) {
        log(`# warn: meta write failed: ${(err as Error).message}`);
      }
    }
    lastFrameText = frameText;
    log("...");
    log(`state: ${sState}`);
    log(`frame: ${sFrame}`);
    log(`diff: ${sDiff}`);
    if (clearMode) {
      log(`meta: ${metaSidecar}`);
    }
    log("...");
  }

  /**
   * Emit a frame iff the rendered body changed since the last emit.
   * The all-three-strict first-paint gate lives in the helper — by the
   * time this fires, the snapshot is guaranteed complete.
   */
  function emitFrameIfChanged(snap: ReadinessClientSnapshot): void {
    const body = renderBody(snap);
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    lastEpicsSnapshot = snap.epics;
    frameCount += 1;
    if (clearMode) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    const frameText = `---\n${body}`;
    log(frameText);
    writeSidecars(frameText);
  }

  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    log("...");
    log(`event: ${event}`);
    for (const [k, v] of Object.entries(detail)) {
      log(`${k}: ${String(v)}`);
    }
    log("...");
    // On disconnect, clear `lastBody` so the next first-paint emits even
    // if the post-reconnect snapshot happens to match the last pre-
    // disconnect body byte-for-byte. (The helper resets its own collection
    // state and re-gates first-paint behind all three `result`s.)
    if (event === "disconnected") {
      lastBody = null;
    }
  }

  const handle = subscribeReadiness({
    sockPath,
    idPrefix: "autopilot",
    onSnapshot: emitFrameIfChanged,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
    handle.dispose();
    process.exit(0);
  });
}

await main();
