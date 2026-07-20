#!/usr/bin/env bun
/**
 * Aggregate the keeper backstop-telemetry sidecar (epic fn-720) into a
 * per-(backstop,class) before/after metric surface: rescue COUNT, rescue
 * RATE (rescues ÷ total fires — the denominator that makes a before/after
 * comparison honest), and staleness percentiles (p50/p95/p99). This is the
 * artifact that proves a future timeliness fix actually worked.
 *
 * The sidecar carries two record kinds (see `src/backstop-telemetry.ts`):
 *   - `backstop-rescue` — one line per genuine RESCUE; carries `staleness_ms`.
 *   - `backstop-rollup`  — periodic + on-shutdown `{fires_total,rescues_total}`
 *     per (backstop,class); the DENOMINATOR. Rescue lines alone are a
 *     survivorship-biased numerator — without rollups the true RATE is
 *     unknowable, so the script reports rate as `n/a (no denominator)` rather
 *     than dividing by a wrong number.
 *
 * Mirrors `scripts/srv-ts-stats.ts`: arg parsing (path | `-` for stdin |
 * default sidecar), percentile math, padded table output. OBSERVABILITY-ONLY:
 * reads a pure consumer-side side-file; touches no DB, no projection, no fold.
 *
 * Usage:
 *   bun scripts/backstop-stats.ts                    # ~/.local/state/keeper/backstop.ndjson
 *   bun scripts/backstop-stats.ts <path>             # named file (or KEEPER_BACKSTOP_LOG)
 *   tail -c 50M backstop.ndjson | bun scripts/backstop-stats.ts -   # stdin
 */

import { readFileSync } from "node:fs";
import { COMPOSITE_KEY_SEPARATOR } from "../src/composite-key";
import type {
  BackstopClass,
  BackstopName,
  BackstopRecord,
  BackstopRollup,
} from "../src/backstop-telemetry";
import { resolveBackstopLogPath } from "../src/db";

/** One aggregated row: a (backstop,class) pair's count/rate/staleness. */
export interface StatsRow {
  backstop: BackstopName;
  class: BackstopClass;
  /** Rescue lines seen (the numerator the histogram is built from). */
  rescue_lines: number;
  /** `fires_total` from the latest rollup; `null` when no rollup was seen. */
  fires_total: number | null;
  /** `rescues_total` from the latest rollup; `null` when no rollup was seen. */
  rescues_total: number | null;
  /**
   * `rescues_total / fires_total` from the latest rollup, in [0,1]; `null`
   * when no rollup landed (the denominator is unknown — reported `n/a`, never
   * faked from the rescue-line count, which is survivorship-biased).
   */
  rate: number | null;
  /** Staleness percentiles over the non-null `staleness_ms` of rescue lines. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export interface StatsResult {
  /** Total lines consumed (rescue + rollup) — partial final line excluded. */
  parsed: number;
  rescues: number;
  rollups: number;
  /** Lines that were JSON but neither a rescue nor a rollup (skipped). */
  skipped: number;
  /** A trailing partial/blank line was tolerated (not counted). */
  partialTail: boolean;
  rows: StatsRow[];
}

/** Stable composite key for a (backstop,class) bucket. */
function bucketKey(backstop: string, cls: string): string {
  return `${backstop}${COMPOSITE_KEY_SEPARATOR}${cls}`;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((p / 100) * sorted.length)),
  );
  return sorted[idx];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Fold an NDJSON sidecar dump into per-(backstop,class) stats. Pure — takes
 * the raw text, returns the aggregate; the table renderer and the test both
 * call this. Tolerates a partial final line (a write torn mid-flush): a final
 * non-empty line that fails `JSON.parse` is dropped, NOT an error. A blank
 * trailing line (the normal newline-terminated case) is silently ignored.
 *
 * The DENOMINATOR is the latest rollup per (backstop,class) — rollups carry
 * running totals (monotonic within a process life), so take-last wins. Rescue
 * lines feed the staleness histogram (non-null `staleness_ms` only) and a
 * fallback rescue-line count when no rollup ever landed.
 */
export function computeStats(text: string): StatsResult {
  const lines = text.split("\n");
  // staleness samples per bucket
  const staleness = new Map<string, number[]>();
  // latest rollup per bucket (take-last — running totals are monotonic)
  const rollups = new Map<string, BackstopRollup>();
  // rescue-line count per bucket (the no-denominator fallback)
  const rescueLines = new Map<string, number>();
  // remember backstop/class identity for buckets seen only via rescue lines
  const identity = new Map<string, { backstop: string; cls: string }>();

  let parsed = 0;
  let rescues = 0;
  let rollupCount = 0;
  let skipped = 0;
  let partialTail = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;
    if (line.trim() === "") {
      // Blank line: the normal newline-terminated tail (last) or a stray
      // blank — never an error.
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      if (isLast) {
        // Partial final line (write torn mid-flush) — tolerate, don't fail.
        partialTail = true;
        continue;
      }
      // A non-terminal unparseable line is genuinely malformed; skip it so
      // one bad row never poisons the whole aggregate.
      skipped++;
      continue;
    }
    if (!isRecord(obj)) {
      skipped++;
      continue;
    }
    const kind = obj.kind;
    if (kind === "backstop-rescue") {
      const rec = obj as unknown as BackstopRecord;
      const key = bucketKey(rec.backstop, rec.class);
      identity.set(key, { backstop: rec.backstop, cls: rec.class });
      rescueLines.set(key, (rescueLines.get(key) ?? 0) + 1);
      const stalenessMs =
        typeof rec.staleness_ms === "number" &&
        Number.isFinite(rec.staleness_ms)
          ? rec.staleness_ms
          : null;
      if (stalenessMs !== null) {
        let arr = staleness.get(key);
        if (!arr) {
          arr = [];
          staleness.set(key, arr);
        }
        arr.push(stalenessMs);
      }
      parsed++;
      rescues++;
    } else if (kind === "backstop-rollup") {
      const roll = obj as unknown as BackstopRollup;
      const key = bucketKey(roll.backstop, roll.class);
      identity.set(key, { backstop: roll.backstop, cls: roll.class });
      rollups.set(key, roll);
      parsed++;
      rollupCount++;
    } else {
      skipped++;
    }
  }

  const rows: StatsRow[] = [];
  for (const [key, id] of identity) {
    const roll = rollups.get(key) ?? null;
    const samples = (staleness.get(key) ?? []).slice().sort((a, b) => a - b);
    const fires = roll ? roll.fires_total : null;
    const rescuesTotal = roll ? roll.rescues_total : null;
    const rate =
      fires !== null && fires > 0 && rescuesTotal !== null
        ? rescuesTotal / fires
        : null;
    rows.push({
      backstop: id.backstop as BackstopName,
      class: id.cls as BackstopClass,
      rescue_lines: rescueLines.get(key) ?? 0,
      fires_total: fires,
      rescues_total: rescuesTotal,
      rate,
      p50: samples.length ? percentile(samples, 50) : null,
      p95: samples.length ? percentile(samples, 95) : null,
      p99: samples.length ? percentile(samples, 99) : null,
      max: samples.length ? samples[samples.length - 1] : null,
    });
  }
  // Deterministic order: backstop asc, class asc.
  rows.sort((a, b) => {
    if (a.backstop !== b.backstop) return a.backstop.localeCompare(b.backstop);
    return a.class.localeCompare(b.class);
  });

  return {
    parsed,
    rescues,
    rollups: rollupCount,
    skipped,
    partialTail,
    rows,
  };
}

function fmtMs(n: number | null): string {
  if (n === null) return "-";
  if (n >= 10000) return n.toFixed(0);
  if (n >= 1) return n.toFixed(0);
  return n.toFixed(2);
}

function fmtRate(row: StatsRow): string {
  if (row.rate === null) return "n/a (no denom)";
  const pct = (row.rate * 100).toFixed(1);
  return `${row.rescues_total}/${row.fires_total} (${pct}%)`;
}

function readInput(): string {
  const arg = process.argv[2];
  if (arg === "-") return readFileSync(0, "utf8");
  return readFileSync(arg ?? resolveBackstopLogPath(), "utf8");
}

function render(result: StatsResult): void {
  console.log(
    `Parsed ${result.parsed} backstop lines ` +
      `(${result.rescues} rescue, ${result.rollups} rollup` +
      `${result.skipped ? `, ${result.skipped} skipped` : ""}` +
      `${result.partialTail ? ", partial tail tolerated" : ""}).`,
  );
  if (result.rows.length === 0) {
    console.log(
      "No backstop fires recorded. A quiet channel is the GOOD case " +
        "(no fast path is dropping wake-ups). Is KEEPER_BACKSTOP_LOG / " +
        "~/.local/state/keeper/backstop.ndjson the running daemon's sidecar?",
    );
    return;
  }

  const H = (s: string, w: number, right = false) =>
    right ? s.padStart(w) : s.padEnd(w);
  console.log();
  console.log(
    H("backstop", 24) +
      H("class", 12) +
      H("rescues", 10, true) +
      H("rate", 20, true) +
      H("p50", 9, true) +
      H("p95", 9, true) +
      H("p99", 9, true) +
      H("max", 9, true),
  );
  console.log("-".repeat(102));
  for (const r of result.rows) {
    console.log(
      H(r.backstop, 24) +
        H(r.class, 12) +
        H(String(r.rescue_lines), 10, true) +
        H(fmtRate(r), 20, true) +
        H(fmtMs(r.p50), 9, true) +
        H(fmtMs(r.p95), 9, true) +
        H(fmtMs(r.p99), 9, true) +
        H(fmtMs(r.max), 9, true),
    );
  }
  console.log();
  console.log(
    "rescues = backstop-rescue lines (numerator); rate = " +
      "rescues_total/fires_total from the latest rollup (the honest " +
      "denominator); staleness percentiles in ms over rescue lines. " +
      "Observability-only: nothing here feeds a projection or the reducer.",
  );
}

if (import.meta.main) {
  render(computeStats(readInput()));
}
