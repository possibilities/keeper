#!/usr/bin/env bun
/**
 * keeper-git — watch the keeperd `git` collection as frames.
 *
 * The daemon-side git worker polls planctl-backed git worktrees and folds
 * synthetic `GitSnapshot` events into the `git` collection. This script is the
 * primitive frame UI for that surface, mirroring the sibling scripts' sidecars.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type ServerFrame,
} from "../src/protocol";

const COLLECTION = "git";
const POLL_MS = 1000;
const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

const HELP = `keeper-git — live git status frames over the keeper subscribe server

Usage: bun scripts/git.ts [--sock <path>] [--project-dir <path>] [--clear]

  --sock <path>         Socket path override ($KEEPER_SOCK / default otherwise)
  --project-dir <path>  Filter to one git worktree root
  --clear               Clear before each frame and keep indexed sidecars
  --help                Show this help

Each frame is led by '---'. Rows show one planctl-backed git worktree, its
dirty/orphan counts, orphaned files, and per-live-job dirty files.
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

function renderRows(rows: Record<string, unknown>[]): string {
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
  return blocks.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      "project-dir": { type: "string" },
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
  const clearMode = values.clear;
  const rows = new Map<string, Record<string, unknown>>();
  let order: string[] = [];
  let lastFrame: string | null = null;
  let frameCount = 0;
  let inFlight = false;
  let dirty = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;
  let attempt = 0;
  type Sock = Awaited<ReturnType<typeof Bun.connect>>;
  let currentSock: Sock | null = null;

  const stateSidecar = `/tmp/keeper-git.${process.pid}.state.json`;
  const frameSidecar = `/tmp/keeper-git.${process.pid}.frame.txt`;
  const diffSidecar = `/tmp/keeper-git.${process.pid}.diff.txt`;
  const prevFrameTmp = `/tmp/keeper-git.${process.pid}.prev.frame.txt`;
  const metaSidecar = `/tmp/keeper-git.${process.pid}.meta.txt`;

  function log(s: string): void {
    process.stdout.write(`${s}\n`);
  }

  function query(sock: Sock): void {
    if (inFlight) {
      dirty = true;
      return;
    }
    inFlight = true;
    const filter =
      values["project-dir"] == null
        ? undefined
        : { project_dir: values["project-dir"] };
    const frame: QueryFrame = {
      type: "query",
      id: "frames",
      collection: COLLECTION,
      limit: 0,
      sort: { column: "project_dir", dir: "asc" },
      ...(filter ? { filter } : {}),
    };
    sock.write(encodeFrame(frame));
  }

  function writeSidecars(frameText: string): void {
    const sState = clearMode
      ? `/tmp/keeper-git.${process.pid}.state.${frameCount}.json`
      : stateSidecar;
    const sFrame = clearMode
      ? `/tmp/keeper-git.${process.pid}.frame.${frameCount}.txt`
      : frameSidecar;
    const sDiff = clearMode
      ? `/tmp/keeper-git.${process.pid}.diff.${frameCount}.txt`
      : diffSidecar;
    const state = order.map((id) => rows.get(id));
    writeFileSync(sState, `${JSON.stringify(state, null, 2)}\n`);
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
    if (clearMode) {
      appendFileSync(
        metaSidecar,
        `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
      );
    }
    log(`...\nstate: ${sState}\nframe: ${sFrame}\ndiff: ${sDiff}\n...`);
  }

  function emit(): void {
    const rendered = renderRows(
      order.flatMap((id) => {
        const row = rows.get(id);
        return row == null ? [] : [row];
      }),
    );
    const frameText = `---\n${rendered}`;
    if (frameText === lastFrame) return;
    frameCount += 1;
    if (clearMode) process.stdout.write("\x1b[2J\x1b[H");
    log(frameText);
    writeSidecars(frameText);
    lastFrame = frameText;
  }

  function handle(frame: ServerFrame): void {
    if (frame.type === "result" && frame.collection === COLLECTION) {
      inFlight = false;
      rows.clear();
      order = [];
      for (const row of frame.rows) {
        const id = seg(row.project_dir);
        rows.set(id, row);
        order.push(id);
      }
      emit();
      if (dirty) {
        dirty = false;
        if (currentSock != null) query(currentSock);
      }
    } else if (
      (frame.type === "patch" || frame.type === "meta") &&
      frame.collection === COLLECTION
    ) {
      if (currentSock != null) query(currentSock);
    } else if (frame.type === "error") {
      log(`# error ${frame.code}: ${frame.message}`);
      if (frame.collection === COLLECTION) process.exit(1);
    }
  }

  function reconnectSoon(): void {
    if (shuttingDown) return;
    const delay =
      attempt === 0
        ? 0
        : Math.min(INITIAL_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    attempt += 1;
    setTimeout(() => void connect(), delay);
  }

  async function connect(): Promise<void> {
    if (shuttingDown) return;
    const buffer = new LineBuffer();
    try {
      currentSock = await Bun.connect({
        unix: sockPath,
        socket: {
          open(sock) {
            attempt = 0;
            pollTimer = setInterval(() => query(sock), POLL_MS);
            query(sock);
          },
          data(_sock, chunk) {
            const text = new TextDecoder().decode(chunk);
            for (const line of buffer.push(text)) {
              handle(JSON.parse(line) as ServerFrame);
            }
          },
          close() {
            if (pollTimer != null) clearInterval(pollTimer);
            currentSock = null;
            reconnectSoon();
          },
          error(_sock, err) {
            console.error(`# socket error: ${err instanceof Error ? err.message : String(err)}`);
            if (pollTimer != null) clearInterval(pollTimer);
            currentSock = null;
            reconnectSoon();
          },
        },
      });
    } catch {
      reconnectSoon();
    }
  }

  process.on("SIGINT", () => {
    shuttingDown = true;
    if (pollTimer != null) clearInterval(pollTimer);
    currentSock?.write(encodeFrame({ type: "unsubscribe", id: "frames" }));
    currentSock?.end();
    process.exit(0);
  });

  await connect();
}

if (import.meta.main) {
  void main();
}
