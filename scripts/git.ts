#!/usr/bin/env bun
/**
 * keeper-git — watch the keeperd `git` collection as frames.
 *
 * The daemon-side git worker polls planctl-backed git worktrees and folds
 * synthetic `GitSnapshot` events into the `git` collection. This script is the
 * primitive frame UI for that surface, mirroring the sibling scripts' sidecars.
 *
 * Connection lifecycle is owned by `subscribeCollection` in
 * `src/readiness-client.ts` — same capped-backoff reconnect, per-collection
 * coalesce, steady-poll backstop, and `dispose()` contract as
 * `subscribeReadiness` (used by board.ts and autopilot.ts). The script's
 * job is rendering rows + writing sidecars; the helper handles everything
 * below the rows.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import { subscribeCollection } from "../src/readiness-client";

const COLLECTION = "git";

const HELP = `keeper-git — live git status frames over the keeper subscribe server

Usage: bun scripts/git.ts [--sock <path>] [--project-dir <path>]

  --sock <path>         Socket path override ($KEEPER_SOCK / default otherwise)
  --project-dir <path>  Filter to one git worktree root
  --help                Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  q/Ctrl-C quit. Per-frame sidecars are indexed; lifecycle output is
  appended to /tmp/keeper-git.<pid>.lifecycle.txt. Session paths print
  on exit.

Rows show one planctl-backed git worktree, its dirty/orphan counts,
orphaned files, and per-live-job dirty files.
`;

function seg(v: unknown): string {
  return v == null ? "" : String(v);
}

function statusLine(file: Record<string, unknown>): string {
  const xy = seg(file.xy).padEnd(2, " ");
  const path = seg(file.path);
  const orig = file.orig_path == null ? "" : ` <- ${seg(file.orig_path)}`;
  return `${xy} ${path}${orig}`;
}

function actor(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  if (s === "plan") return "planner";
  if (s === "work") return "worker";
  if (s === "close") return "closer";
  return s;
}

/**
 * Render the `git`-collection rows into the per-frame block list. Each row
 * with non-zero ahead / dirty / orphaned counts produces one block; rows
 * with all zeroes are dropped (the empty-row filter matches the
 * pre-refactor `scripts/git.ts:74` behavior). Exported as `string[]`
 * (one entry per kept block) so the live-shell wrapper in task 2 can
 * consume lines, not a joined string; the script's emit seam still joins
 * with `\n` for stdout / sidecar writes.
 */
export function renderRowBlocks(rows: Record<string, unknown>[]): string[] {
  const blocks: string[] = [];
  for (const row of rows) {
    const dir = seg(row.project_dir);
    const name = basename(dir) || dir;
    const branch = row.branch == null ? "detached" : seg(row.branch);
    const aheadCount =
      typeof row.ahead === "number" && row.ahead > 0 ? row.ahead : 0;
    const ahead = aheadCount > 0 ? ` +${aheadCount}` : "";
    const behind =
      typeof row.behind === "number" && row.behind > 0 ? ` -${row.behind}` : "";
    const dirtyCount =
      typeof row.dirty_count === "number" ? row.dirty_count : 0;
    const orphanedCount =
      typeof row.orphaned_count === "number" ? row.orphaned_count : 0;
    if (aheadCount === 0 && dirtyCount === 0 && orphanedCount === 0) continue;

    const lines = [
      `${name} [${branch}${ahead}${behind}] dirty=${seg(row.dirty_count)} orphaned=${seg(row.orphaned_count)}`,
    ];

    const orphaned = Array.isArray(row.orphaned_files)
      ? (row.orphaned_files as Record<string, unknown>[])
      : [];
    for (const file of orphaned) {
      lines.push(`  orphan ${statusLine(file)}`);
    }

    if (aheadCount > 0) {
      lines.push(`  unpushed ${aheadCount}`);
    }

    const jobs = Array.isArray(row.jobs)
      ? (row.jobs as Record<string, unknown>[])
      : [];
    for (const job of jobs) {
      const dirty = Array.isArray(job.dirty)
        ? (job.dirty as Record<string, unknown>[])
        : [];
      const planctl = Array.isArray(job.planctl)
        ? (job.planctl as Record<string, unknown>[])
        : [];
      if (dirty.length === 0 && planctl.length === 0) continue;
      const title = seg(job.title) || seg(job.job_id);
      const role = actor(job.plan_verb);
      const roleSeg = role == null ? "" : ` [${role}]`;
      lines.push(
        `  ${title}${roleSeg} [${seg(job.state)}] dirty=${dirty.length} planctl=${planctl.length}`,
      );
      for (const file of dirty) {
        lines.push(`    ${statusLine(file)}`);
      }
      for (const file of planctl) {
        lines.push(`    planctl ${statusLine(file)}`);
      }
    }

    blocks.push(lines.join("\n"));
  }
  return blocks;
}

/**
 * Top-level renderer — returns the frame body as one element per output
 * line, suitable for `liveShell.pushFrame`. Internally fans out via
 * `renderRowBlocks` (one multi-line block per non-empty worktree row),
 * joins those blocks with `\n`, then splits on `\n` so each individual
 * row becomes its own array element. The caller joins with `\n` for
 * stdout / sidecar / byte-compare.
 */
export function renderRowLines(rows: Record<string, unknown>[]): string[] {
  const body = renderRowBlocks(rows).join("\n");
  return body === "" ? [] : body.split("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      "project-dir": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  const liveShell = createLiveShell({ enabled: true });
  let lastFrame: string | null = null;
  let frameCount = 0;
  let lastRows: Record<string, unknown>[] = [];

  const prevFrameTmp = `/tmp/keeper-git.${process.pid}.prev.frame.txt`;
  const metaSidecar = `/tmp/keeper-git.${process.pid}.meta.txt`;
  // The alt-screen owns stdout; lifecycle events append here instead.
  const lifecycleSidecar = `/tmp/keeper-git.${process.pid}.lifecycle.txt`;

  function log(s: string): void {
    process.stdout.write(`${s}\n`);
  }

  function writeSidecars(frameText: string): void {
    const sState = `/tmp/keeper-git.${process.pid}.state.${frameCount}.json`;
    const sFrame = `/tmp/keeper-git.${process.pid}.frame.${frameCount}.txt`;
    const sDiff = `/tmp/keeper-git.${process.pid}.diff.${frameCount}.txt`;
    writeFileSync(sState, `${JSON.stringify(lastRows, null, 2)}\n`);
    writeFileSync(sFrame, `${frameText}\n`);
    let diff = "# first frame - no previous to diff against\n";
    if (lastFrame != null) {
      writeFileSync(prevFrameTmp, `${lastFrame}\n`);
      const res = Bun.spawnSync(["diff", "-u", prevFrameTmp, sFrame], {
        stdout: "pipe",
        stderr: "pipe",
      });
      diff = res.stdout.toString() || "# no rendered diff\n";
    }
    writeFileSync(sDiff, diff);
    appendFileSync(
      metaSidecar,
      `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
    );
  }

  /**
   * Helper-driven row callback. Renders the row list, byte-compares
   * against the last emit, and writes sidecars + stdout when the render
   * changes. The helper handles the first-paint gate, reconnect, and the
   * `meta`/`patch` refetch coalescer — by the time this fires, `rows`
   * carries the freshest `result` frame in wire order.
   */
  function emitFrame(rows: Record<string, unknown>[]): void {
    lastRows = rows;
    const bodyLines = renderRowLines(rows);
    const frameText = ["---", ...bodyLines].join("\n");
    if (frameText === lastFrame) return;
    frameCount += 1;
    liveShell.pushFrame(bodyLines);
    writeSidecars(frameText);
    lastFrame = frameText;
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
    // On disconnect, clear `lastFrame` so the next first-paint emits even
    // if the post-reconnect snapshot happens to match the last pre-
    // disconnect frame byte-for-byte. (The helper resets its own
    // collection state and re-gates first-paint behind a fresh `result`.)
    if (event === "disconnected") {
      lastFrame = null;
    }
  }

  const projectDir = values["project-dir"];
  const handle = subscribeCollection({
    sockPath,
    idPrefix: "git",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "project_dir", dir: "asc" },
    ...(projectDir === undefined
      ? {}
      : { filter: { project_dir: projectDir } }),
    onRows: emitFrame,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
    // Terminal restoration before subscription teardown.
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
  void main();
}
