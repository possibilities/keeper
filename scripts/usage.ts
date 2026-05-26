#!/usr/bin/env bun
/**
 * keeper-usage — watch the keeperd `usage` collection as frames.
 *
 * The daemon-side usage worker watches `~/.local/state/agentuse/<id>.json`
 * and folds synthetic `UsageSnapshot` / `UsageDeleted` events into the
 * `usage` collection. This script is the primitive frame UI for that
 * surface, mirroring `scripts/git.ts`'s sidecar discipline (per-frame
 * state JSON + frame text + unified diff under `/tmp/keeper-usage.<pid>.*`,
 * indexed meta sidecar, SIGINT teardown that prints sidecar paths).
 *
 * Connection lifecycle is owned by `subscribeCollection` in
 * `src/readiness-client.ts` — same capped-backoff reconnect, per-collection
 * coalesce, steady-poll backstop, and `dispose()` contract as
 * `scripts/git.ts`. The script's job is rendering rows + writing sidecars;
 * the helper handles everything below the rows.
 *
 * First cut is non-TUI: rows are emitted to stdout one frame at a time,
 * `---`-delimited. The reset timestamps render as their raw ISO strings
 * — keeper has no freshness signal yet by design (a later epic may add a
 * client-side countdown).
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { subscribeCollection } from "../src/readiness-client";

const COLLECTION = "usage";

const HELP = `keeper-usage — live usage frames over the keeper subscribe server

Usage: bun scripts/usage.ts [--sock <path>]

  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --help         Show this help

Rows show one agentuse profile: id, target + multiplier, session % +
reset ISO, week % + reset ISO. Per-frame sidecars under
/tmp/keeper-usage.<pid>.{state,frame,diff}.<n>.* with an indexed
meta sidecar; session paths print on SIGINT.
`;

function seg(v: unknown): string {
  return v == null ? "" : String(v);
}

function pct(v: unknown): string {
  if (v == null) return "?";
  if (typeof v === "number") return `${v}%`;
  return `${String(v)}%`;
}

/**
 * Render the `usage`-collection rows into one line per profile.
 *
 *   {id} [{target} {multiplier}x] session {pct}% (resets {iso}) | week {pct}% (resets {iso})
 *
 * The `{id}` segment is right-padded to the widest observed id length so
 * a multi-profile view stays column-aligned. Reset timestamps are raw
 * ISO strings (no client-side countdown — keeper has no freshness signal
 * yet by design; a later epic may add one).
 */
export function renderRowLines(rows: Record<string, unknown>[]): string[] {
  if (rows.length === 0) return [];
  const widestId = rows.reduce(
    (acc, row) => Math.max(acc, seg(row.id).length),
    0,
  );
  const lines: string[] = [];
  for (const row of rows) {
    const id = seg(row.id).padEnd(widestId, " ");
    const target = seg(row.target);
    const mult = seg(row.multiplier);
    const targetSeg =
      target === "" && mult === "" ? "" : `[${target} ${mult}x]`;
    const sPct = pct(row.session_percent);
    const sReset = seg(row.session_resets_at);
    const wPct = pct(row.week_percent);
    const wReset = seg(row.week_resets_at);
    lines.push(
      `${id} ${targetSeg} session ${sPct} (resets ${sReset}) | week ${wPct} (resets ${wReset})`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  let lastFrame: string | null = null;
  let frameCount = 0;
  let lastRows: Record<string, unknown>[] = [];

  const prevFrameTmp = `/tmp/keeper-usage.${process.pid}.prev.frame.txt`;
  const metaSidecar = `/tmp/keeper-usage.${process.pid}.meta.txt`;
  const lifecycleSidecar = `/tmp/keeper-usage.${process.pid}.lifecycle.txt`;

  function log(s: string): void {
    process.stdout.write(`${s}\n`);
  }

  function writeSidecars(frameText: string): void {
    const sState = `/tmp/keeper-usage.${process.pid}.state.${frameCount}.json`;
    const sFrame = `/tmp/keeper-usage.${process.pid}.frame.${frameCount}.txt`;
    const sDiff = `/tmp/keeper-usage.${process.pid}.diff.${frameCount}.txt`;
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
   * Helper-driven row callback. Byte-compares the rendered frame against
   * the last emit and only writes (sidecars + stdout) when the render
   * changes — so a fetch-only refresh that bumps the `usage` row's
   * `last_event_id` without moving any projection-meaningful field
   * produces no visible re-render.
   */
  function emitFrame(rows: Record<string, unknown>[]): void {
    lastRows = rows;
    const bodyLines = renderRowLines(rows);
    const frameText = ["---", ...bodyLines].join("\n");
    if (frameText === lastFrame) return;
    frameCount += 1;
    log(frameText);
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
    // disconnect frame byte-for-byte.
    if (event === "disconnected") {
      lastFrame = null;
    }
  }

  const handle = subscribeCollection({
    sockPath,
    idPrefix: "usage",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "id", dir: "asc" },
    onRows: emitFrame,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
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
