#!/usr/bin/env bun
/**
 * `subscribe-bounce-soak` — the diagnostic repro + evidence gate for epic
 * fn-750 task `.3` (the ~2GB `keeper await` / subscribe-client reconnect leak).
 *
 * Background (epic fn-750): a runaway `keeper await` spun ~4h and leaked ~2GB
 * because the shared subscribe client (`subscribeMulti`,
 * `src/readiness-client.ts`) reconnects forever with no give-up while keeperd
 * bounced under it. Task `.1` added the per-caller bounded give-up; task `.3`
 * (this harness) is the actual leak fix — give-up alone does NOT cover it,
 * because the board TUI deliberately opts OUT of give-up (reconnect-forever),
 * so the leak is unbounded for the one client meant to run forever.
 *
 * Static analysis this session ruled OUT in-process re-fold (TUI-only refold
 * poller, never loaded by `keeper await`), reconnect-chain accumulation (the
 * `close` handler spawns exactly one fresh `connectWithRetry`; the original
 * loop returns), per-collection map growth (`teardownConnection` clears
 * byId/order/rows/lastSeenVersion every disconnect), and await-runner retention
 * (fixed slots, newest snapshot only). The remaining suspect — confirmed by
 * this harness — is UNDESTROYED SOCKETS: `teardownConnection` nulled
 * `currentSock` without ever `terminate()`/`end()`-ing it, so on a flapping
 * daemon thousands of Bun sockets + their native read buffers accumulate faster
 * than GC reclaims them. Native buffers are invisible to the JS heap, so RSS
 * climbs while the heap stays small — exactly the ~2GB-over-4h signature.
 *
 * What it does
 * ------------
 * Stands up a REAL `Bun.listen` UDS server speaking the minimal subscribe
 * protocol (parse `query` frames via the production `LineBuffer`) and drives a
 * real `subscribeCollection` client at it over the default `connect` factory →
 * real `Bun.connect`, so the NATIVE socket path the leak lives in is exercised
 * (a pure in-memory mock socket would not allocate the native read/write
 * buffers that leak). Two modes:
 *
 *   - churn (default, the FAITHFUL repro): a HALF-UP server (accepts + holds,
 *     never replies) + a client subscribed with a tiny give-up deadline, so
 *     each cycle paints nothing, gives up, and the CLIENT tears its OWN open
 *     socket down; we then `dispose()` and re-subscribe. That is the exact
 *     runaway path — a client-initiated destroy of an open socket against a
 *     peer that never sends its FIN. Pre-fix (`end()`/bare drop) the native
 *     buffers pin and RSS climbs LINEARLY under `--no-gc`; post-fix
 *     (`terminate()`) the slope collapses to flat.
 *   - bounce: a HEALTHY server stopped + relistened each cycle, with one
 *     long-lived reconnect-forever client (the board/TUI default). Each bounce
 *     is a peer-initiated close → reconnect → re-paint.
 *
 * RSS is sampled per cycle. The verdict is SLOPE-AWARE: a leak is LINEAR (never
 * plateaus), so PASS requires both absolute growth within `--bound-mb` AND a
 * flat steady-state least-squares slope (MB/1k cycles, second-half samples).
 * `--no-gc` samples RAW RSS so the native-buffer accumulation shows; forcing a
 * GC every sample (the default) masks it because the leak is invisible to the
 * JS heap and so never triggers a heap-pressure collection.
 *
 * BOUNDED / OPT-IN / MANUAL. Never imported by the default test tier; spawns no
 * daemon, opens no production DB, writes no events/RPC. The UDS server is a
 * throwaway in this process bound to a per-run scratch socket under the OS
 * tmpdir. Run it by hand:
 *
 *   bun scripts/subscribe-bounce-soak.ts [options]
 *
 * Options:
 *   --mode <m>         churn (default) | bounce
 *   --cycles <n>       Number of cycles (default: churn 2000, bounce 200)
 *   --down-ms <n>      Server-DOWN window per bounce cycle (default: 15)
 *   --up-ms <n>        UP / per-cycle window in ms (default: 35)
 *   --sample-every <n> Sample RSS every N cycles (default: churn 200, bounce 10)
 *   --bound-mb <n>     PASS threshold: max RSS growth start→end (default: 50)
 *   --heap-snapshot    Write a heap snapshot at the high-water mark
 *   --no-gc            Sample RAW RSS (no forced GC) — exposes the leak (pre-fix)
 *   --json             Emit the report as JSON
 *   --quiet            Suppress per-sample progress; print only the verdict
 *   --help, -h         Show this help
 *
 * Exit code: 0 when RSS is flat (growth within `--bound-mb` AND slope below the
 * leak threshold), 1 when it leaks — so it doubles as a manual go/no-go gate.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type ResultFrame,
} from "../src/protocol";
import { type FatalError, subscribeCollection } from "../src/readiness-client";

const HELP = `subscribe-bounce-soak — fn-750.3 reconnect-leak repro + evidence gate

Usage:
  bun scripts/subscribe-bounce-soak.ts [options]

Options:
  --mode <m>         churn (default) | bounce
                       churn  — FAITHFUL leak repro: half-up server (accepts,
                                never replies); client gives up + disposes each
                                cycle → client-initiated destroy of an OPEN
                                socket against a non-responsive peer.
                       bounce — healthy server stopped/relistened each cycle;
                                one reconnect-forever client (board/TUI default).
  --cycles <n>       Number of cycles (default: churn 2000, bounce 200)
  --down-ms <n>      Server-DOWN window per bounce cycle (default: 15)
  --up-ms <n>        UP / per-cycle window in ms (default: 35)
  --sample-every <n> Sample RSS every N cycles (default: churn 200, bounce 10)
  --bound-mb <n>     PASS threshold: max RSS growth start→end MB (default: 50)
  --heap-snapshot    Write a heap snapshot at the high-water mark
  --no-gc            Sample RAW RSS (no forced GC) — exposes the native-buffer
                     leak (pre-fix); use with --mode churn for the repro
  --json             Emit the report as JSON
  --quiet            Only print the verdict
  --help, -h         Show this help

Drives a real subscribe client against a real Bun.listen UDS server, sampling
RSS per cycle. Exits 0 when RSS stays flat within --bound-mb, 1 when it grows
past the bound. Standalone — no daemon, no production DB.

Repro the leak (run on the PRE-FIX checkout):
  bun scripts/subscribe-bounce-soak.ts --mode churn --no-gc --cycles 4000
Validate the fix (current checkout):
  bun scripts/subscribe-bounce-soak.ts --mode churn --no-gc --cycles 4000
`;

// ── CLI parsing (models scripts/git-worker-cpu-soak.ts) ──────────────────────

type Mode = "bounce" | "churn";

interface Args {
  mode: Mode;
  cycles: number;
  downMs: number;
  upMs: number;
  sampleEvery: number;
  boundMb: number;
  heapSnapshot: boolean;
  noGc: boolean;
  json: boolean;
  quiet: boolean;
}

function parse(argv: string[]): Args | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string" },
      cycles: { type: "string" },
      "down-ms": { type: "string" },
      "up-ms": { type: "string" },
      "sample-every": { type: "string" },
      "bound-mb": { type: "string" },
      "heap-snapshot": { type: "boolean", default: false },
      "no-gc": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) return "help";

  const numOr = (
    raw: string | undefined,
    dflt: number,
    label: string,
  ): number => {
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--${label} must be a positive number`);
    }
    return n;
  };

  const mode = values.mode ?? "churn";
  if (mode !== "bounce" && mode !== "churn") {
    throw new Error(`--mode must be "bounce" or "churn" (got "${mode}")`);
  }

  return {
    mode,
    cycles: Math.floor(
      numOr(values.cycles, mode === "churn" ? 2000 : 200, "cycles"),
    ),
    downMs: numOr(values["down-ms"], 15, "down-ms"),
    upMs: numOr(values["up-ms"], 35, "up-ms"),
    sampleEvery: Math.floor(
      numOr(
        values["sample-every"],
        mode === "churn" ? 200 : 10,
        "sample-every",
      ),
    ),
    boundMb: numOr(values["bound-mb"], 50, "bound-mb"),
    heapSnapshot: values["heap-snapshot"] ?? false,
    noGc: values["no-gc"] ?? false,
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  };
}

// ── minimal subscribe-protocol UDS server ────────────────────────────────────
//
// One result frame per query, no patch/meta stream — the harness only needs the
// FIRST-PAINT handshake to drive the reconnect/teardown path, not a live feed.
// A small synthetic row so the result is non-empty (closer to the board's real
// payload than `rows: []`). `Bun.listen`'s data callback hands a per-conn
// context object as `socket.data`; we stash a LineBuffer there.

interface ConnData {
  buffer: LineBuffer;
}

const SAMPLE_ROW: Record<string, unknown> = {
  job_id: "soak-row",
  cwd: "/tmp/soak",
  status: "working",
  version: 1,
};

function resultFor(query: QueryFrame): ResultFrame {
  return {
    type: "result",
    ...(query.id === undefined ? {} : { id: query.id }),
    collection: query.collection,
    rev: 1,
    total: 1,
    rows: [SAMPLE_ROW],
  };
}

type Listener = ReturnType<typeof Bun.listen<ConnData>>;

/**
 * Start the scratch UDS server.
 *
 * `halfUp = false` — a HEALTHY daemon: replies to every `query` with a
 * `result`, so the client paints. Drives the SERVER-BOUNCE mode (stop/relisten
 * loop), where each bounce is a peer-initiated close.
 *
 * `halfUp = true` — a HALF-UP daemon: accepts connections and HOLDS them open
 * but NEVER replies (no `result`). This is the exact runaway scenario — the
 * client connects, never paints, and the CLIENT must tear the socket down
 * (give-up / dispose). Combined with the client-churn loop, this is the
 * faithful, fast repro of the leak: a client-initiated destroy of an OPEN
 * socket against a peer that never sends its FIN.
 */
function startServer(sockPath: string, halfUp: boolean): Listener {
  return Bun.listen<ConnData>({
    unix: sockPath,
    socket: {
      open(socket) {
        socket.data = { buffer: new LineBuffer() };
      },
      data(socket, chunk) {
        let lines: string[];
        try {
          lines = socket.data.buffer.push(chunk.toString("utf8"));
        } catch {
          socket.end();
          return;
        }
        if (halfUp) {
          // Drain the bytes (so the buffer doesn't grow) but send nothing —
          // the client never paints and must give up / dispose on its own.
          return;
        }
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          let frame: { type?: string };
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame.type === "query") {
            socket.write(encodeFrame(resultFor(frame as QueryFrame)));
          }
          // `unsubscribe` and anything else: ignore (the client only needs the
          // result to clear its first-paint gate).
        }
      },
      close() {},
      error() {},
    },
  });
}

// ── RSS sampling ─────────────────────────────────────────────────────────────

interface Sample {
  cycle: number;
  rssMb: number;
  heapMb: number;
}

const MB = 1024 * 1024;

function sample(cycle: number, noGc: boolean): Sample {
  // Default: force a full GC so the reading reflects RETAINED memory, not
  // floating garbage the collector hasn't swept yet — the FIX-VALIDATION view
  // (after `terminate()`, retained sockets are zero so RSS is flat). `--no-gc`
  // samples RAW RSS instead: it is the FAITHFUL REPRO of the 4h/2GB runaway,
  // where the undestroyed native socket buffers — invisible to the JS heap, so
  // they never raise heap pressure and never TRIGGER a GC — accumulate
  // unbounded between the collector's own (heap-driven) cycles. Forcing GC
  // every sample masks exactly that mechanism, so the pre-fix leak only shows
  // under `--no-gc`.
  if (!noGc) {
    Bun.gc(true);
  }
  const mem = process.memoryUsage();
  return {
    cycle,
    rssMb: mem.rss / MB,
    heapMb: mem.heapUsed / MB,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Least-squares RSS slope in MB per 1000 cycles over the SECOND HALF of the
 * samples — the steady-state region, past the initial allocation ramp (page
 * faults, lazy mmap, JIT warm-up) that adds a one-time step on ANY run. The
 * slope is what actually separates a LEAK (linear, never plateaus) from FLAT
 * (plateaus, slope → 0): pre-fix the steady-state slope is a clear positive
 * MB/1k-cycles; post-fix it collapses toward zero. Returns 0 for < 2 points.
 */
function steadySlopeMbPer1k(samples: Sample[]): number {
  const tail = samples.slice(Math.floor(samples.length / 2));
  if (tail.length < 2) return 0;
  const n = tail.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const s of tail) {
    sx += s.cycle;
    sy += s.rssMb;
    sxx += s.cycle * s.cycle;
    sxy += s.cycle * s.rssMb;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  const slopePerCycle = (n * sxy - sx * sy) / denom;
  return slopePerCycle * 1000;
}

// ── main soak loop ───────────────────────────────────────────────────────────

// Steady-state slope above this (MB per 1000 cycles) is treated as a genuine
// monotonic leak rather than the run's one-time allocation step. Pre-fix the
// churn repro slopes ~+5 MB/1k; post-fix it collapses below ~1. 2.0 is a
// comfortable separator with margin on both sides.
const SLOPE_LEAK_THRESHOLD_MB_PER_1K = 2.0;

interface Report {
  mode: Mode;
  cycles: number;
  samples: Sample[];
  startRssMb: number;
  endRssMb: number;
  peakRssMb: number;
  growthMb: number;
  boundMb: number;
  slopeMbPer1k: number;
  slopeThresholdMbPer1k: number;
  pass: boolean;
  heapSnapshotPath: string | null;
}

function progress(args: Args, first: Sample, s: Sample): void {
  if (args.quiet || args.json) return;
  const delta = s.rssMb - first.rssMb;
  const head =
    s.cycle === first.cycle
      ? `cycle ${String(s.cycle).padStart(6)}  rss ${s.rssMb.toFixed(1)} MB  heap ${s.heapMb.toFixed(1)} MB`
      : `cycle ${String(s.cycle).padStart(6)}  rss ${s.rssMb.toFixed(1)} MB  ` +
        `heap ${s.heapMb.toFixed(1)} MB  Δrss ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} MB`;
  process.stderr.write(`${head}\n`);
}

/**
 * BOUNCE mode: one long-lived reconnect-forever client (the board/TUI default,
 * no give-up) against a HEALTHY server stopped + relistened each cycle. Each
 * bounce is a peer-initiated close → reconnect → re-paint.
 */
async function runBounce(
  args: Args,
  sockPath: string,
  samples: Sample[],
): Promise<{ peakRssMb: number; fatal: FatalError | null }> {
  let server: Listener | null = startServer(sockPath, false);
  let fatal: FatalError | null = null;
  const handle = subscribeCollection({
    sockPath,
    idPrefix: "soak",
    collection: "jobs",
    limit: 0,
    onRows() {},
    onFatal(err) {
      fatal = err;
    },
  });

  await sleep(args.upMs);
  const first = sample(0, args.noGc);
  samples.push(first);
  let peakRssMb = first.rssMb;
  progress(args, first, first);

  for (let cycle = 1; cycle <= args.cycles; cycle += 1) {
    server?.stop(true);
    server = null;
    await sleep(args.downMs);
    server = startServer(sockPath, false);
    await sleep(args.upMs);

    if (cycle % args.sampleEvery === 0 || cycle === args.cycles) {
      const s = sample(cycle, args.noGc);
      samples.push(s);
      if (s.rssMb > peakRssMb) peakRssMb = s.rssMb;
      progress(args, first, s);
    }
  }

  handle.dispose();
  server?.stop(true);
  return { peakRssMb, fatal };
}

/**
 * CHURN mode (default — the FAITHFUL leak repro): a HALF-UP server (accepts +
 * holds, never replies) and a client subscribed with a tiny give-up policy so
 * each cycle PAINTS NOTHING, trips give-up, and the CLIENT tears its OWN open
 * socket down — then we `dispose()` and re-subscribe. That is the exact runaway
 * path: a client-initiated destroy of an open socket against a peer that never
 * sends its FIN. Pre-fix (`end()` / bare drop) the native buffers pin and RSS
 * climbs monotonically under `--no-gc`; post-fix (`terminate()`) RSS stays flat.
 */
async function runChurn(
  args: Args,
  sockPath: string,
  samples: Sample[],
): Promise<{ peakRssMb: number; fatal: FatalError | null }> {
  // One persistent half-up server for the whole run.
  const server = startServer(sockPath, true);
  let fatal: FatalError | null = null;

  // Each cycle: a fresh subscribe with a sub-`upMs` give-up deadline so it
  // fires fast, then dispose. Both the give-up teardown AND the dispose are
  // client-initiated socket destroys against the non-responsive peer.
  async function oneCycle(): Promise<void> {
    const handle = subscribeCollection({
      sockPath,
      idPrefix: "soak",
      collection: "jobs",
      limit: 0,
      onRows() {},
      onFatal(err) {
        fatal = err;
      },
      // Tiny deadline → give-up trips within the cycle window even though the
      // peer never paints. This is the OPEN-socket client-teardown path.
      giveUpPolicy: { deadlineMs: Math.max(1, Math.floor(args.upMs / 2)) },
    });
    await sleep(args.upMs);
    handle.dispose();
  }

  await oneCycle();
  const first = sample(0, args.noGc);
  samples.push(first);
  let peakRssMb = first.rssMb;
  progress(args, first, first);

  for (let cycle = 1; cycle <= args.cycles; cycle += 1) {
    await oneCycle();
    if (cycle % args.sampleEvery === 0 || cycle === args.cycles) {
      const s = sample(cycle, args.noGc);
      samples.push(s);
      if (s.rssMb > peakRssMb) peakRssMb = s.rssMb;
      progress(args, first, s);
    }
  }

  server.stop(true);
  return { peakRssMb, fatal };
}

async function runSoak(args: Args): Promise<Report> {
  const tmpDir = mkdtempSync(join(tmpdir(), "keeper-subscribe-bounce-soak-"));
  const sockPath = join(tmpDir, "soak.sock");
  const samples: Sample[] = [];

  const { peakRssMb, fatal } =
    args.mode === "bounce"
      ? await runBounce(args, sockPath, samples)
      : await runChurn(args, sockPath, samples);

  let heapSnapshotPath: string | null = null;
  if (args.heapSnapshot) {
    // Heap snapshot at the high-water mark to NAME the retained allocation
    // (the localization evidence). NOTE: the leak is in NATIVE socket buffers,
    // which a JS heap snapshot does NOT capture — the snapshot's value here is
    // to PROVE the retained set is small (the leak is invisible to JS), which
    // is itself the diagnostic that points at native memory.
    Bun.gc(true);
    const snap = (
      Bun as unknown as { generateHeapSnapshot: () => unknown }
    ).generateHeapSnapshot();
    heapSnapshotPath = join(tmpDir, "heap-at-peak.json");
    writeFileSync(heapSnapshotPath, JSON.stringify(snap));
  } else {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const first = samples[0];
  const startRssMb = first?.rssMb ?? 0;
  const endRssMb = samples[samples.length - 1]?.rssMb ?? startRssMb;
  const growthMb = endRssMb - startRssMb;
  const slopeMbPer1k = steadySlopeMbPer1k(samples);

  if (fatal !== null && args.mode === "bounce") {
    process.stderr.write(
      `WARN: client fired onFatal (code=${(fatal as FatalError).code}) — ` +
        `unexpected on the reconnect-forever bounce path\n`,
    );
  }

  // PASS requires BOTH: absolute growth within the bound AND a flat steady-state
  // slope. The slope is the load-bearing check — a leak is LINEAR (never
  // plateaus), so a short run can stay under an absolute bound while still
  // leaking; the slope catches that regardless of run length.
  const pass =
    growthMb <= args.boundMb && slopeMbPer1k <= SLOPE_LEAK_THRESHOLD_MB_PER_1K;

  return {
    mode: args.mode,
    cycles: args.cycles,
    samples,
    startRssMb,
    endRssMb,
    peakRssMb,
    growthMb,
    boundMb: args.boundMb,
    slopeMbPer1k,
    slopeThresholdMbPer1k: SLOPE_LEAK_THRESHOLD_MB_PER_1K,
    pass,
    heapSnapshotPath,
  };
}

function printSummary(report: Report): void {
  const w = (label: string, val: string): string =>
    `  ${label.padEnd(16)} ${val}\n`;
  let out = "\nsubscribe-bounce-soak — fn-750.3 reconnect-leak gate\n";
  out += w("mode", report.mode);
  out += w("cycles", String(report.cycles));
  out += w("start RSS", `${report.startRssMb.toFixed(1)} MB`);
  out += w("end RSS", `${report.endRssMb.toFixed(1)} MB`);
  out += w("peak RSS", `${report.peakRssMb.toFixed(1)} MB`);
  out += w(
    "growth",
    `${report.growthMb >= 0 ? "+" : ""}${report.growthMb.toFixed(1)} MB ` +
      `(bound ${report.boundMb.toFixed(0)} MB)`,
  );
  out += w(
    "steady slope",
    `${report.slopeMbPer1k >= 0 ? "+" : ""}${report.slopeMbPer1k.toFixed(2)} MB/1k cycles ` +
      `(leak >${report.slopeThresholdMbPer1k.toFixed(1)})`,
  );
  if (report.heapSnapshotPath !== null) {
    out += w("heap snapshot", report.heapSnapshotPath);
  }
  out += w("verdict", report.pass ? "PASS (flat)" : "FAIL (leaking)");
  process.stderr.write(out);
}

async function main(argv: string[]): Promise<void> {
  let args: Args | "help";
  try {
    args = parse(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    process.exit(1);
  }
  if (args === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const report = await runSoak(args);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printSummary(report);
  }

  process.exit(report.pass ? 0 : 1);
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
