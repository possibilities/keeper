#!/usr/bin/env bun
/**
 * `bench-latency` — passively measure keeper's end-to-end "reality → surface"
 * latency against the LIVE daemon, with zero state pollution.
 *
 * The trick: every `jobs` / `epics` projection row carries `updated_at`, which
 * the reducer sets to `event.ts` (see `src/reducer.ts:671`). For a `jobs` row
 * that `ts` is the hook's own `Date.now()` at invocation
 * (`plugins/keeper/plugin/hooks/events-writer.ts:590`) — i.e. the wall-clock instant reality
 * changed. We subscribe to a collection exactly the way the TUIs do (via
 * `subscribeCollection`, so we traverse the identical pipeline: wake-worker
 * poll → fold → server-worker poll → patch-nudge → refetch → result), and the
 * moment a freshly-changed row lands in our `onRows` callback we stamp
 * `Date.now()` and record:
 *
 *     Δ_ms = Date.now() − updated_at × 1000
 *
 * Both clocks are the same host's wall clock (the only comparable origin across
 * the hook process and this one — NOT `performance.now()`, whose epoch is
 * per-process), so the subtraction is the full surfacing latency for that one
 * change.
 *
 * Freshness gate: `onRows` also fires on the 500 ms steady-poll backstop and on
 * the initial snapshot, where rows carry OLD `updated_at` (that's staleness, not
 * latency). So we seed a per-row high-water mark on the FIRST result per
 * collection without recording, and thereafter record a sample only when a
 * row's `updated_at` strictly advances (or a new id appears). Whichever path
 * surfaces the change first — the fast patch-nudge refetch or the 500 ms
 * backstop — is the one we measure, which is exactly what "when does it appear
 * on the surface" means.
 *
 * Caveat on epics: an `epics` row's `updated_at` is the SYNTHETIC event's mint
 * time on main, AFTER the plan-worker's `@parcel/watcher` + `git cat-file`
 * observation gate. So an epics Δ measures mint → surface and EXCLUDES the
 * `.planctl` → mint producer latency. A jobs Δ is the full reality → surface
 * chain. The summary labels this.
 *
 * Usage:
 *   bun scripts/bench-latency.ts [options]
 *
 * Options:
 *   --collections jobs,epics   Which collections to watch (default: jobs,epics)
 *   --duration <seconds>       Auto-stop after N seconds (default: until Ctrl-C)
 *   --slow-ms <n>              Flag samples ≥ n ms as slow (default: 500)
 *   --quiet                    Suppress per-sample lines; print only the summary
 *   --json                     Emit the final summary as JSON
 *   --verbose                  Log connect/disconnect lifecycle to stderr
 *   --help, -h                 Show this help
 */

import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { type FatalError, subscribeCollection } from "../src/readiness-client";

const HELP = `bench-latency — measure keeper's reality→surface latency (passive, live, non-invasive)

Usage:
  bun scripts/bench-latency.ts [options]

Options:
  --collections jobs,epics   Collections to watch (default: jobs,epics)
  --duration <seconds>       Auto-stop after N seconds (default: until Ctrl-C)
  --slow-ms <n>              Flag samples >= n ms as slow (default: 500)
  --quiet                    Only print the summary
  --json                     Emit the final summary as JSON
  --verbose                  Log connect/disconnect lifecycle to stderr
  --help, -h                 Show this help

Measures Δ = now − updated_at the instant each freshly-changed row surfaces.
jobs Δ is the full hook→surface chain; epics Δ is mint→surface (excludes the
.planctl→mint producer latency). Needs the keeperd daemon running.
`;

const KNOWN_COLLECTIONS = new Set(["jobs", "epics"]);

interface Sample {
  readonly collection: string;
  readonly id: string;
  readonly deltaMs: number;
}

/** Per-collection accumulator: high-water marks + recorded samples. */
interface Tracker {
  readonly collection: string;
  readonly pk: string;
  /** Row id → highest `updated_at` (ms) seen so far. */
  readonly highWater: Map<string, number>;
  /** Whether the first (seed) result has been consumed. */
  seeded: boolean;
  readonly samples: number[];
}

const PK_BY_COLLECTION: Record<string, string> = {
  jobs: "job_id",
  epics: "epic_id",
};

/** Parse `updated_at` (seconds float, per the reducer) into epoch ms. */
function toEpochMs(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // event.ts is seconds (Date.now()/1000 ≈ 1.7e9). Anything already in the
  // ms range (> ~1e12) is passed through defensively.
  return n > 1e12 ? n : n * 1000;
}

function nowMs(): number {
  return Date.now();
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0] as number;
  // Nearest-rank.
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] as number;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${Math.round(n)}ms`;
}

function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 6)}…${id.slice(-5)}`;
}

interface Args {
  collections: string[];
  durationSec: number | null;
  slowMs: number;
  quiet: boolean;
  json: boolean;
  verbose: boolean;
}

function parse(argv: string[]): Args | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      collections: { type: "string" },
      duration: { type: "string" },
      "slow-ms": { type: "string" },
      quiet: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return "help";

  const collections = (values.collections ?? "jobs,epics")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const c of collections) {
    if (!KNOWN_COLLECTIONS.has(c)) {
      throw new Error(
        `unknown collection '${c}' — known: ${[...KNOWN_COLLECTIONS].join(", ")}`,
      );
    }
  }

  const durationSec =
    values.duration === undefined ? null : Number(values.duration);
  if (
    durationSec !== null &&
    (!Number.isFinite(durationSec) || durationSec <= 0)
  ) {
    throw new Error(`--duration must be a positive number of seconds`);
  }

  const slowMs =
    values["slow-ms"] === undefined ? 500 : Number(values["slow-ms"]);
  if (!Number.isFinite(slowMs) || slowMs < 0) {
    throw new Error(`--slow-ms must be a non-negative number`);
  }

  return {
    collections,
    durationSec,
    slowMs,
    quiet: values.quiet ?? false,
    json: values.json ?? false,
    verbose: values.verbose ?? false,
  };
}

function makeTracker(collection: string): Tracker {
  return {
    collection,
    pk: PK_BY_COLLECTION[collection] ?? "id",
    highWater: new Map(),
    seeded: false,
    samples: [],
  };
}

/**
 * Fold one `result` frame's rows into the tracker, recording a sample for each
 * row whose `updated_at` strictly advanced past its high-water mark. Returns the
 * samples recorded on THIS frame (for live printing).
 */
function ingest(tracker: Tracker, rows: Record<string, unknown>[]): Sample[] {
  const at = nowMs();
  const recorded: Sample[] = [];
  const firstResult = !tracker.seeded;

  for (const row of rows) {
    const id = String(row[tracker.pk]);
    const updatedMs = toEpochMs(row.updated_at);
    if (updatedMs === null) continue;

    const prev = tracker.highWater.get(id);
    const advanced = prev === undefined || updatedMs > prev;
    if (!advanced) continue;
    tracker.highWater.set(id, updatedMs);

    // The first result is the seed snapshot — pre-existing rows whose
    // updated_at predates the probe. Record nothing; just set high-water marks.
    if (firstResult) continue;

    const deltaMs = at - updatedMs;
    tracker.samples.push(deltaMs);
    recorded.push({ collection: tracker.collection, id, deltaMs });
  }

  tracker.seeded = true;
  return recorded;
}

interface CollectionSummary {
  collection: string;
  count: number;
  minMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  slowCount: number;
}

function summarize(tracker: Tracker, slowMs: number): CollectionSummary {
  const sorted = [...tracker.samples].sort((a, b) => a - b);
  return {
    collection: tracker.collection,
    count: sorted.length,
    minMs: sorted.length ? (sorted[0] as number) : Number.NaN,
    p50Ms: quantile(sorted, 0.5),
    p90Ms: quantile(sorted, 0.9),
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
    maxMs: sorted.length ? (sorted[sorted.length - 1] as number) : Number.NaN,
    meanMs: mean(sorted),
    slowCount: sorted.filter((d) => d >= slowMs).length,
  };
}

function printSummary(
  trackers: Tracker[],
  args: Args,
  out: (s: string) => void,
): void {
  const summaries = trackers.map((t) => summarize(t, args.slowMs));

  if (args.json) {
    out(`${JSON.stringify({ collections: summaries }, null, 2)}\n`);
    return;
  }

  out("\n");
  out("── reality → surface latency ──────────────────────────────\n");
  for (const s of summaries) {
    if (s.count === 0) {
      out(`  ${s.collection.padEnd(7)} no changes observed during the run\n`);
      continue;
    }
    const lens =
      s.collection === "epics" ? " (mint→surface)" : " (hook→surface)";
    out(`  ${s.collection}${lens}  n=${s.count}\n`);
    out(
      `      min ${fmtMs(s.minMs).padStart(7)}   ` +
        `p50 ${fmtMs(s.p50Ms).padStart(7)}   ` +
        `p90 ${fmtMs(s.p90Ms).padStart(7)}\n`,
    );
    out(
      `      p95 ${fmtMs(s.p95Ms).padStart(7)}   ` +
        `p99 ${fmtMs(s.p99Ms).padStart(7)}   ` +
        `max ${fmtMs(s.maxMs).padStart(7)}\n`,
    );
    out(
      `      mean ${fmtMs(s.meanMs).padStart(6)}   ` +
        `slow(≥${args.slowMs}ms) ${s.slowCount}\n`,
    );
  }
  out("───────────────────────────────────────────────────────────\n");
}

async function main(argv: string[]): Promise<void> {
  let args: Args | "help";
  try {
    args = parse(argv);
  } catch (err) {
    process.stderr.write(`bench-latency: ${(err as Error).message}\n\n${HELP}`);
    process.exit(1);
  }
  if (args === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = resolveSockPath();
  const trackers = args.collections.map(makeTracker);
  const startedAt = nowMs();

  const out = (s: string): void => {
    process.stdout.write(s);
  };

  if (!args.quiet) {
    out(`bench-latency — watching ${args.collections.join(", ")}\n`);
    out(`socket: ${sockPath}\n`);
    out(
      args.durationSec === null
        ? "seeding baseline… (Ctrl-C to stop and print summary)\n\n"
        : `seeding baseline… (auto-stop in ${args.durationSec}s)\n\n`,
    );
  }

  const onFatal = (err: FatalError): never => {
    process.stderr.write(
      `\nbench-latency: subscription failed (${err.code}): ${err.message}\n` +
        `Is keeperd running? Socket: ${sockPath}\n`,
    );
    process.exit(1);
  };

  const onLifecycle = args.verbose
    ? (event: string, detail?: Record<string, unknown>): void => {
        process.stderr.write(
          `[lifecycle] ${event}${detail ? ` ${JSON.stringify(detail)}` : ""}\n`,
        );
      }
    : undefined;

  const handles = trackers.map((tracker) =>
    subscribeCollection({
      sockPath,
      idPrefix: "bench-latency",
      collection: tracker.collection,
      // No limit: we want every changed row, not a page.
      onRows(rows) {
        const recorded = ingest(tracker, rows);
        if (args.quiet) return;
        for (const s of recorded) {
          const flag = s.deltaMs >= args.slowMs ? " !" : "";
          out(
            `  ${s.collection.padEnd(6)} ${shortId(s.id).padEnd(14)} ` +
              `${fmtMs(s.deltaMs).padStart(8)}${flag}\n`,
          );
        }
      },
      onFatal,
      ...(onLifecycle ? { onLifecycle } : {}),
    }),
  );

  let stopped = false;
  const stop = (reason: string): void => {
    if (stopped) return;
    stopped = true;
    for (const h of handles) h.dispose();
    if (!args.quiet) {
      const elapsed = ((nowMs() - startedAt) / 1000).toFixed(1);
      out(`\n(${reason} after ${elapsed}s)\n`);
    }
    printSummary(trackers, args, out);
    process.exit(0);
  };

  process.on("SIGINT", () => stop("stopped"));
  process.on("SIGTERM", () => stop("stopped"));

  if (args.durationSec !== null) {
    setTimeout(() => stop("duration elapsed"), args.durationSec * 1000);
  }

  // Keep the event loop alive; the subscribe handles + timers hold it open.
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
