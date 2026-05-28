#!/usr/bin/env bun
/**
 * Aggregate `[srv-ts]` stage timings from keeper's server.stderr into
 * p50/p95/p99 percentiles per (op, col, stage).
 *
 * Sole consumer today: the Tier 4 post-shipment measurement pass that
 * decides whether further architectural work (decoded-row cache, frame
 * cache, reducer fan-out restructuring) is warranted vs the
 * "ship as-is" verdict.
 *
 * Usage:
 *   bun scripts/srv-ts-stats.ts                       # reads ~/.local/state/keeper/server.stderr
 *   bun scripts/srv-ts-stats.ts <path>                # reads named file
 *   tail -c 50M server.stderr | bun scripts/srv-ts-stats.ts -  # reads stdin
 *
 * Parses three line shapes from `formatStages` / writeFrames in
 * src/server-worker.ts:
 *   op=runQuery     col=<c> rows=<N> countAndToken pageSelect decodeRow frameEncode total
 *   op=diffTick     col=*  readWorldRev unionWatched probeVersions selectByIds patchFanout metaCount total
 *   op=writeFrames  col=<c> bytes=<N> frames=<N>
 *
 * `total=` is the canonical wall-clock for the op. All ms values are
 * `.toFixed(2)` per the formatStages contract.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const DEFAULT_PATH = resolve(homedir(), ".local/state/keeper/server.stderr");

const LINE_RE = /^\[srv-ts\] T=(\d+) (.+)$/;
const KV_RE = /(\w+)=(\S+)/g;

interface Sample {
  op: string;
  col: string;
  ts: number;
  fields: Record<string, number>; // includes stages, bytes, frames, rows
}

function parseLine(line: string): Sample | null {
  const m = line.match(LINE_RE);
  if (!m) return null;
  const ts = Number.parseInt(m[1], 10);
  let op = "";
  let col = "";
  const fields: Record<string, number> = {};
  for (const kv of m[2].matchAll(KV_RE)) {
    const [, k, v] = kv;
    if (k === "op") op = v;
    else if (k === "col") col = v;
    else {
      const n = Number.parseFloat(v);
      if (Number.isFinite(n)) fields[k] = n;
    }
  }
  if (!op || !col) return null;
  return { op, col, ts, fields };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx];
}

function fmt(n: number): string {
  if (n >= 10000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(3);
}

function readInput(): string {
  const arg = process.argv[2];
  if (arg === "-") return readFileSync(0, "utf8");
  return readFileSync(arg ?? DEFAULT_PATH, "utf8");
}

function main(): void {
  const text = readInput();
  const lines = text.split("\n");

  // (op|col|stage) → samples
  const buckets = new Map<string, number[]>();
  // (op|col) → count
  const counts = new Map<string, number>();
  let parsed = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = 0;

  for (const line of lines) {
    if (!line.startsWith("[srv-ts]")) continue;
    const s = parseLine(line);
    if (!s) continue;
    parsed++;
    if (s.ts < earliest) earliest = s.ts;
    if (s.ts > latest) latest = s.ts;
    const opCol = `${s.op}|${s.col}`;
    counts.set(opCol, (counts.get(opCol) ?? 0) + 1);
    for (const [stage, v] of Object.entries(s.fields)) {
      const key = `${s.op}|${s.col}|${stage}`;
      let arr = buckets.get(key);
      if (!arr) {
        arr = [];
        buckets.set(key, arr);
      }
      arr.push(v);
    }
  }

  console.log(`Parsed ${parsed} [srv-ts] lines.`);
  if (parsed === 0) {
    console.log(
      "No data. Is KEEPER_TRACE_SERVER=1 on the running daemon? Plist key in",
      "plist/arthack.keeperd.plist; flip and `launchctl kickstart -k gui/$UID/arthack.keeperd`.",
    );
    return;
  }
  const spanSec = (latest - earliest) / 1000;
  console.log(
    `Window: ${spanSec.toFixed(0)}s (${(spanSec / 60).toFixed(1)}m)\n`,
  );

  console.log("Counts by (op, col):");
  const countEntries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [opCol, n] of countEntries) {
    console.log(`  ${opCol.padEnd(40)} ${n}`);
  }
  console.log();

  // Per-(op, col, stage) percentile rows
  type Row = {
    op: string;
    col: string;
    stage: string;
    n: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
  const rows: Row[] = [];
  for (const [key, samples] of buckets) {
    const [op, col, stage] = key.split("|");
    samples.sort((a, b) => a - b);
    rows.push({
      op,
      col,
      stage,
      n: samples.length,
      p50: percentile(samples, 50),
      p95: percentile(samples, 95),
      p99: percentile(samples, 99),
      max: samples[samples.length - 1],
    });
  }
  // Sort: op asc, col asc, then p95 desc within group
  rows.sort((a, b) => {
    if (a.op !== b.op) return a.op.localeCompare(b.op);
    if (a.col !== b.col) return a.col.localeCompare(b.col);
    return b.p95 - a.p95;
  });

  const H = (s: string, w: number, right = false) =>
    right ? s.padStart(w) : s.padEnd(w);
  console.log(
    H("op", 12) +
      H("col", 24) +
      H("stage", 16) +
      H("n", 8, true) +
      H("p50", 10, true) +
      H("p95", 10, true) +
      H("p99", 10, true) +
      H("max", 10, true),
  );
  console.log("-".repeat(100));
  let lastOpCol = "";
  for (const r of rows) {
    const opCol = `${r.op}|${r.col}`;
    if (lastOpCol && lastOpCol !== opCol) console.log();
    lastOpCol = opCol;
    console.log(
      H(r.op, 12) +
        H(r.col, 24) +
        H(r.stage, 16) +
        H(String(r.n), 8, true) +
        H(fmt(r.p50), 10, true) +
        H(fmt(r.p95), 10, true) +
        H(fmt(r.p99), 10, true) +
        H(fmt(r.max), 10, true),
    );
  }
}

main();
