#!/usr/bin/env bun
/**
 * `repro-serve-wedge` — the red-capable reproduction loop for the epic fn-1082
 * task `.2` serve-wedge investigation: keeperd's UDS serve layer twice went dark
 * while every worker thread stayed healthy (status/board reads timed out, the bus
 * `list` hung while `chat send` still delivered), recoverable only by kickstart.
 * The captured CPU sample (`/tmp/keeperd-spin.sample.txt`) shows the main thread
 * parked in `kevent64` — LOW lag, ZERO read throughput — the classic Bun UDS
 * accept/read-loop stall signature (issue #8044 and neighbors).
 *
 * Debug-skill method: this is the LOOP built BEFORE any fix hypothesis. It stands
 * up a REAL `Bun.listen` UDS server that mirrors keeper's serve shape — the raw
 * unix listener both `src/server-worker.ts` and `src/bus-worker.ts` use, the
 * production `LineBuffer` NDJSON framing, and the same short-write→queue→`drain`
 * backpressure path — then hammers it with the four load dimensions the wedge was
 * hypothesized to ride on, while a dedicated real-read probe (a faithful copy of
 * the shipped `probeSocketRead` / `decideServeLivenessWatchdog` watchdog from task
 * `.1`) watches for the socket going dark. The wedge lives in Bun's OWN accept/read
 * loop, which a minimal-but-real `Bun.listen` server exercises byte-for-byte the
 * same as `startServer` — so the harness needs no daemon, no DB, no RPC wiring.
 *
 * Why a real read probe (not connect-only): the observed wedge kept the send path
 * alive while READS died — a connect-only or write-only probe sails straight
 * through it. Only a round-trip that gets a frame back proves the serve loop lives.
 *
 * The four load dimensions (bisect knobs — each probes a distinct #8044-family
 * mechanism; combine them to search the trigger space):
 *   --clients / --rate-hz   steady concurrent request load (accept + read + write
 *                           under concurrency — the core #8044 accept-loop stall).
 *   --payload-bytes         large replies past the kernel send buffer — probes the
 *                           silent `socket.write` drop / backpressure-loss class.
 *   --slow-readers          a fraction of clients that connect + query but NEVER
 *                           read, pinning the server's per-conn write queue — the
 *                           head-of-line backpressure class.
 *   --churn                 concurrent connect-then-immediately-destroy storms
 *                           racing live accepts — the dead-peer-reap-races-accept
 *                           class (a close storm interleaved with the accept loop).
 *
 * BOUNDED / OPT-IN / MANUAL. Never imported by any test tier; spawns no daemon,
 * opens no production DB or socket, writes no events/RPC. The UDS server is a
 * throwaway in THIS process bound to a per-run scratch socket under the OS tmpdir
 * (sandbox-style isolation — the repro can never touch the live daemon). A hard
 * wall-clock guard force-exits so a genuine wedge cannot hang the harness itself.
 *
 *   bun scripts/repro-serve-wedge.ts [options]
 *
 * Exit code: 0 when NO wedge was observed within the run (the serve loop answered
 * the real-read probe throughout) — a clean "did not reproduce" for the finding
 * doc; 1 when the probe went dark past --stuck-ms while the server process stayed
 * live (WEDGE REPRODUCED) — the red the loop is built to catch. So it doubles as a
 * go/no-go gate: a future Bun bump can re-run it to confirm the wedge is gone.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LineBuffer } from "../src/protocol";

const HELP = `repro-serve-wedge — fn-1082.2 UDS serve-wedge reproduction loop

Usage:
  bun scripts/repro-serve-wedge.ts [options]

Load dimensions (bisect knobs):
  --clients <n>        Persistent concurrent request clients (default: 200)
  --rate-hz <n>        Queries/sec PER client (default: 50)
  --payload-bytes <n>  Reply payload size — large values probe the send-buffer /
                       silent-write-drop class (default: 256)
  --slow-readers <f>   Fraction [0..1] of clients that query but NEVER read,
                       pinning the write queue — backpressure class (default: 0)
  --churn <n>          Concurrent connect-then-destroy storms racing accepts —
                       the dead-peer-reap-races-accept class (default: 0)

Run control:
  --duration-ms <n>    Total run window (default: 20000)
  --probe-ms <n>       Real-read probe cadence (default: 1000)
  --probe-timeout <n>  Hard per-probe read timeout (default: 2000)
  --stuck-ms <n>       Probe-dark age that declares a WEDGE (default: 6000)
  --json               Emit the report as JSON
  --quiet              Only print the verdict
  --help, -h           Show this help

Exits 0 when the serve loop answered the real-read probe throughout (no wedge),
1 when the probe went dark past --stuck-ms while the server stayed alive (WEDGE
REPRODUCED). Standalone — no daemon, no production DB, scratch socket only.

Aggressive search (push all four dimensions):
  bun scripts/repro-serve-wedge.ts --clients 400 --rate-hz 100 \\
    --payload-bytes 65536 --slow-readers 0.25 --churn 64 --duration-ms 60000
`;

// ── CLI parsing (models scripts/subscribe-bounce-soak.ts) ────────────────────

interface Args {
  clients: number;
  rateHz: number;
  payloadBytes: number;
  slowReaders: number;
  churn: number;
  durationMs: number;
  probeMs: number;
  probeTimeoutMs: number;
  stuckMs: number;
  json: boolean;
  quiet: boolean;
}

function parse(argv: string[]): Args | "help" {
  const { values } = parseArgs({
    args: argv,
    options: {
      clients: { type: "string" },
      "rate-hz": { type: "string" },
      "payload-bytes": { type: "string" },
      "slow-readers": { type: "string" },
      churn: { type: "string" },
      "duration-ms": { type: "string" },
      "probe-ms": { type: "string" },
      "probe-timeout": { type: "string" },
      "stuck-ms": { type: "string" },
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
    min = 0,
  ): number => {
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) {
      throw new Error(`--${label} must be a number >= ${min}`);
    }
    return n;
  };

  const slowReaders = numOr(values["slow-readers"], 0, "slow-readers");
  if (slowReaders > 1) throw new Error("--slow-readers must be in [0, 1]");

  return {
    clients: Math.floor(numOr(values.clients, 200, "clients", 1)),
    rateHz: numOr(values["rate-hz"], 50, "rate-hz", 0.1),
    payloadBytes: Math.floor(
      numOr(values["payload-bytes"], 256, "payload-bytes"),
    ),
    slowReaders,
    churn: Math.floor(numOr(values.churn, 0, "churn")),
    durationMs: Math.floor(
      numOr(values["duration-ms"], 20_000, "duration-ms", 1),
    ),
    probeMs: Math.floor(numOr(values["probe-ms"], 1_000, "probe-ms", 1)),
    probeTimeoutMs: Math.floor(
      numOr(values["probe-timeout"], 2_000, "probe-timeout", 1),
    ),
    stuckMs: Math.floor(numOr(values["stuck-ms"], 6_000, "stuck-ms", 1)),
    json: values.json ?? false,
    quiet: values.quiet ?? false,
  };
}

// ── faithful serve-shape UDS server ──────────────────────────────────────────
//
// Mirrors keeper's raw `Bun.listen<T>({ unix })` serve workers: NDJSON framing
// via the production `LineBuffer`, one `result` frame per `query`, and the exact
// short-write → per-conn byte-tail queue → resume-on-`drain` backpressure path
// `src/server-worker.ts` / `src/bus-worker.ts` use. No DB — the reply is a
// synthetic fixed-size payload, which is all the accept/read/write loop the wedge
// lives in ever touches.

const encoder = new TextEncoder();

interface ServerConn {
  buffer: LineBuffer;
  /** Backpressured byte tail not yet accepted by the socket; resumed in drain. */
  pending: Uint8Array | null;
}

type BunSocket = {
  write: (data: Uint8Array, byteOffset?: number, byteLength?: number) => number;
  end: () => void;
  data: ServerConn;
};

interface ServerMetrics {
  accepts: number;
  queries: number;
  replies: number;
  shortWrites: number;
}

/** Build the fixed-size reply line for a query id, padded to `payloadBytes`. */
function replyLine(id: string | undefined, payloadBytes: number): Uint8Array {
  const idSeg = id !== undefined ? `,"id":${JSON.stringify(id)}` : "";
  // A `pad` field carries the requested payload size so the reply crosses the
  // kernel send buffer on large --payload-bytes runs (the silent-drop probe).
  const head = `{"type":"result"${idSeg},"collection":"jobs","rev":1,"total":0,"pad":"`;
  const tail = `"}\n`;
  const padLen = Math.max(0, payloadBytes - head.length - tail.length);
  return encoder.encode(head + "x".repeat(padLen) + tail);
}

function startServer(
  sockPath: string,
  payloadBytes: number,
  metrics: ServerMetrics,
): ReturnType<typeof Bun.listen<ServerConn>> {
  const writeOrQueue = (sock: BunSocket, bytes: Uint8Array): void => {
    // Mirror the server worker's flush: try the socket, stash the unaccepted
    // tail on a short write, and resume it from `drain`. Never awaits a drain
    // (that is the head-of-line block the real serve path also refuses).
    if (sock.data.pending !== null) {
      // Already backpressured — the real server SKIPS further writes to a
      // pending conn; we drop this reply the same way (the client's read death
      // under backpressure is the condition we are trying to induce).
      return;
    }
    let accepted: number;
    try {
      accepted = sock.write(bytes, 0, bytes.length);
    } catch {
      return;
    }
    if (accepted < bytes.length) {
      metrics.shortWrites += 1;
      sock.data.pending = bytes.subarray(Math.max(0, accepted));
    }
  };

  return Bun.listen<ServerConn>({
    unix: sockPath,
    socket: {
      open(socket) {
        metrics.accepts += 1;
        socket.data = { buffer: new LineBuffer(), pending: null };
      },
      data(socket, chunk) {
        const sock = socket as unknown as BunSocket;
        let lines: string[];
        try {
          lines = socket.data.buffer.push(chunk.toString("utf8"));
        } catch {
          socket.end();
          return;
        }
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          let frame: { type?: string; id?: string };
          try {
            frame = JSON.parse(line);
          } catch {
            continue;
          }
          if (frame.type === "query") {
            metrics.queries += 1;
            writeOrQueue(sock, replyLine(frame.id, payloadBytes));
            metrics.replies += 1;
          }
        }
      },
      drain(socket) {
        const sock = socket as unknown as BunSocket;
        const tail = sock.data.pending;
        if (tail === null) return;
        try {
          const accepted = sock.write(tail, 0, tail.length);
          sock.data.pending =
            accepted >= tail.length ? null : tail.subarray(accepted);
        } catch {
          sock.data.pending = null;
        }
      },
      close() {},
      error() {},
    },
  });
}

// ── real-read probe (faithful copy of src/daemon.ts probeSocketRead) ─────────
//
// A fresh short-lived connection: connect, write one `query`, resolve true on the
// first `result` frame, false on connect-fail / transport error / server close /
// timeout. NEVER rejects. This is the detector task `.1` ships — the ONLY thing
// that distinguishes a live serve loop from the accept-stall wedge (send alive,
// reads dead).

function probeRealRead(sockPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let remainder = "";
    let settled = false;
    let sock: { end: () => void; write: (s: string) => number } | null = null;

    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.end();
      } catch {
        // best-effort
      }
      resolve(ok);
    };

    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();

    void Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s as unknown as typeof sock;
          try {
            s.write(
              `${JSON.stringify({ type: "query", collection: "jobs", id: "probe" })}\n`,
            );
          } catch {
            settle(false);
          }
        },
        data(_s, chunk) {
          remainder += chunk.toString("utf8");
          let nl = remainder.indexOf("\n");
          while (nl !== -1) {
            const line = remainder.slice(0, nl).trim();
            remainder = remainder.slice(nl + 1);
            if (line.length > 0) {
              try {
                const frame = JSON.parse(line) as { type?: string };
                if (frame.type === "result") {
                  settle(true);
                  return;
                }
              } catch {
                // keep scanning
              }
            }
            nl = remainder.indexOf("\n");
          }
        },
        close() {
          settle(false);
        },
        error() {
          settle(false);
        },
      },
    }).catch(() => settle(false));
  });
}

// ── load generators ──────────────────────────────────────────────────────────

interface LoadState {
  stop: boolean;
  sent: number;
  received: number;
}

/**
 * One persistent request client: connect, then fire a `query` every `1000/rateHz`
 * ms. A `slowReader` connects + queries but installs NO data handler that drains —
 * it never reads its replies, pinning the server's per-conn write queue.
 */
function startClient(
  sockPath: string,
  rateHz: number,
  slowReader: boolean,
  state: LoadState,
): void {
  let sock: { write: (s: string) => number; end: () => void } | null = null;
  const periodMs = Math.max(1, Math.floor(1000 / rateHz));
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = (): void => {
    if (state.stop || sock === null) return;
    try {
      sock.write(
        `${JSON.stringify({ type: "query", collection: "jobs", id: `c${state.sent}` })}\n`,
      );
      state.sent += 1;
    } catch {
      // socket died — let the close/error handler reconnect the pressure via a
      // fresh client is unnecessary; a dead load client just stops contributing.
    }
  };

  void Bun.connect({
    unix: sockPath,
    socket: {
      open(s) {
        sock = s as unknown as typeof sock;
        timer = setInterval(tick, periodMs);
        timer.unref?.();
      },
      data(_s, chunk) {
        if (slowReader) return; // never drain — build backpressure
        // Count replies coarsely (newline-framed) for throughput diagnostics.
        const text = chunk.toString("utf8");
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "\n") state.received += 1;
        }
      },
      close() {
        if (timer !== null) clearInterval(timer);
        sock = null;
      },
      error() {
        if (timer !== null) clearInterval(timer);
        sock = null;
      },
    },
  }).catch(() => {
    /* connect failure — this load slot is simply absent */
  });
}

/**
 * The churn storm: repeatedly open `churn` connections in parallel and DESTROY
 * them almost immediately, racing the server's live accept loop — the
 * dead-peer-reap-races-accept class. `end()` right after open is the closest
 * client-side analog to a peer that FINs mid-handshake.
 */
function startChurn(sockPath: string, churn: number, state: LoadState): void {
  const spin = (): void => {
    if (state.stop) return;
    for (let i = 0; i < churn; i++) {
      void Bun.connect({
        unix: sockPath,
        socket: {
          open(s) {
            try {
              s.write(
                `${JSON.stringify({ type: "query", collection: "jobs", id: "churn" })}\n`,
              );
            } catch {
              // ignore
            }
            // Destroy immediately — race the accept loop with a close storm.
            try {
              s.end();
            } catch {
              // ignore
            }
          },
          data() {},
          close() {},
          error() {},
        },
      }).catch(() => {
        /* a failed connect during churn is itself signal — keep spinning */
      });
    }
    const t = setTimeout(spin, 5);
    t.unref?.();
  };
  spin();
}

// ── run ────────────────────────────────────────────────────────────────────

interface Report {
  args: Args;
  durationRanMs: number;
  accepts: number;
  serverQueries: number;
  serverReplies: number;
  serverShortWrites: number;
  clientSent: number;
  clientReceived: number;
  probeOk: number;
  probeFail: number;
  maxProbeDarkMs: number;
  wedged: boolean;
  wedgeAtMs: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run(args: Args): Promise<Report> {
  const tmpDir = mkdtempSync(join(tmpdir(), "keeper-repro-serve-wedge-"));
  const sockPath = join(tmpDir, "wedge.sock");
  const metrics: ServerMetrics = {
    accepts: 0,
    queries: 0,
    replies: 0,
    shortWrites: 0,
  };
  const server = startServer(sockPath, args.payloadBytes, metrics);

  // Let the socket bind before dialing.
  await sleep(50);

  const loadState: LoadState = { stop: false, sent: 0, received: 0 };
  const slowCount = Math.round(args.clients * args.slowReaders);
  for (let i = 0; i < args.clients; i++) {
    startClient(sockPath, args.rateHz, i < slowCount, loadState);
  }
  if (args.churn > 0) startChurn(sockPath, args.churn, loadState);

  // Probe / wedge-detector state — mirrors decideServeLivenessWatchdog: track the
  // last successful real-read; a wedge is the probe-dark age crossing --stuck-ms
  // AFTER at least one probe has ever succeeded (boot grace).
  const startedAt = Date.now();
  let lastProbeOkAt = startedAt;
  let everProbedOk = false;
  let probeOk = 0;
  let probeFail = 0;
  let maxProbeDarkMs = 0;
  let wedged = false;
  let wedgeAtMs: number | null = null;

  while (Date.now() - startedAt < args.durationMs && !wedged) {
    const ok = await probeRealRead(sockPath, args.probeTimeoutMs);
    const now = Date.now();
    if (ok) {
      probeOk += 1;
      everProbedOk = true;
      lastProbeOkAt = now;
    } else {
      probeFail += 1;
      const darkMs = now - lastProbeOkAt;
      if (darkMs > maxProbeDarkMs) maxProbeDarkMs = darkMs;
      // The wedge verdict: the serve loop stopped answering a real read for
      // longer than --stuck-ms while the server process is manifestly alive
      // (this harness is still scheduling). Boot-grace: require a prior success.
      if (everProbedOk && darkMs >= args.stuckMs) {
        wedged = true;
        wedgeAtMs = now - startedAt;
      }
    }
    if (!args.quiet && !args.json) {
      process.stderr.write(
        `t=${String(now - startedAt).padStart(6)}ms  probe=${ok ? "ok " : "DARK"}  ` +
          `dark=${(now - lastProbeOkAt).toFixed(0)}ms  accepts=${metrics.accepts}  ` +
          `q=${metrics.queries}  sent=${loadState.sent}  recv=${loadState.received}\n`,
      );
    }
    await sleep(args.probeMs);
  }

  loadState.stop = true;
  try {
    server.stop(true);
  } catch {
    // best-effort
  }
  rmSync(tmpDir, { recursive: true, force: true });

  return {
    args,
    durationRanMs: Date.now() - startedAt,
    accepts: metrics.accepts,
    serverQueries: metrics.queries,
    serverReplies: metrics.replies,
    serverShortWrites: metrics.shortWrites,
    clientSent: loadState.sent,
    clientReceived: loadState.received,
    probeOk,
    probeFail,
    maxProbeDarkMs,
    wedged,
    wedgeAtMs,
  };
}

function printSummary(r: Report): void {
  const w = (label: string, val: string): string =>
    `  ${label.padEnd(18)} ${val}\n`;
  let out = "\nrepro-serve-wedge — fn-1082.2 UDS serve-wedge loop\n";
  out += w("clients", `${r.args.clients} @ ${r.args.rateHz} Hz`);
  out += w(
    "load knobs",
    `payload=${r.args.payloadBytes}B slow-readers=${r.args.slowReaders} churn=${r.args.churn}`,
  );
  out += w("ran", `${(r.durationRanMs / 1000).toFixed(1)}s`);
  out += w("accepts", String(r.accepts));
  out += w("server queries", String(r.serverQueries));
  out += w("server replies", String(r.serverReplies));
  out += w("short writes", String(r.serverShortWrites));
  out += w("client sent", String(r.clientSent));
  out += w("client received", String(r.clientReceived));
  out += w("probe ok / fail", `${r.probeOk} / ${r.probeFail}`);
  out += w(
    "max probe-dark",
    `${r.maxProbeDarkMs.toFixed(0)}ms (stuck ${r.args.stuckMs}ms)`,
  );
  out += w(
    "verdict",
    r.wedged
      ? `WEDGE REPRODUCED at ${r.wedgeAtMs}ms — probe dark past --stuck-ms while server live`
      : "no wedge — serve loop answered the real-read probe throughout",
  );
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

  // Hard wall-clock guard: a genuine wedge must not hang the harness itself. Give
  // the run its window plus generous teardown slack, then force-exit non-zero.
  const guard = setTimeout(() => {
    process.stderr.write(
      "repro-serve-wedge: hard guard fired — forcing exit\n",
    );
    process.exit(2);
  }, args.durationMs + 30_000);
  guard.unref?.();

  const report = await run(args);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printSummary(report);
  }

  process.exit(report.wedged ? 1 : 0);
}

if (import.meta.main) {
  void main(process.argv.slice(2));
}
