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
 * backpressure path, PLUS the production per-register ancestry work — then hammers
 * it with the load dimensions the wedge rides on, while a real-read probe (a
 * faithful copy of the shipped `probeSocketRead` / `decideServeLivenessWatchdog`
 * watchdog) and an event-loop-lag detector watch for the serve loop going dark. A
 * minimal-but-real `Bun.listen` server exercises the same accept/read/write path
 * as `startServer` — so the harness needs no daemon, no DB, no RPC wiring.
 *
 * Why a real read probe (not connect-only): the #8044-family stall kept the send
 * path alive while READS died — a connect-only or write-only probe sails straight
 * through it. Only a round-trip that gets a frame back proves the serve loop lives.
 *
 * Two detectors, because there are two failure shapes. The socket real-read probe
 * catches a Bun-internal accept/read stall (JS keeps scheduling, sockets go dark).
 * The CONFIRMED wedge is different: a SYNCHRONOUS `ps` spawn in the register path
 * parks the ENTIRE JS loop. In this single-process harness that also parks the
 * socket probe, so it can never fail-while-parked — an event-loop-LAG detector
 * (a fine-cadence timer that returns late) is what catches a full-loop park, the
 * in-process proxy for what the production main-thread watchdog sees cross-thread.
 * A wedge is EITHER detector crossing --stuck-ms after a first green (boot grace).
 *
 * The load dimensions (bisect knobs — each probes a distinct mechanism; combine
 * them to search the trigger space). The CONFIRMED wedge rides the register-work
 * + stampede pair — the others are the earlier #8044-family hypotheses kept as a
 * bisect surface:
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
 *   --register-hops         per-register `ps` ancestry spawns run ON the serve
 *                           loop — the production `opRegister` → `ppidViaPs` work.
 *                           SYNC (`Bun.spawnSync`, the pre-fix shape) by default:
 *                           each spawn parks the kqueue loop, so a burst of cold
 *                           registers starves every socket event. This is the
 *                           mechanism the epic fixes.
 *   --async-register        run the --register-hops spawns OFF the loop (async
 *                           `Bun.spawn` + await, the first-fix shape). Moves the
 *                           ancestry walk off-loop but NOT the start_time probe.
 *   --start-time-probe      per-register `ps -ww … -o lstart=,args=` spawns — the
 *                           HEAVIER `enrichPeerFromJobs`/`readOsStartTime` recycle
 *                           probe run ONCE per register that hits a keeper jobs
 *                           row. SYNC on the loop by default. This is the site the
 *                           FIRST fix missed: the daemon still wedged from bind
 *                           with `--async-register` set because this probe stayed
 *                           synchronous on the serve loop.
 *   --async-start-time      run the --start-time-probe spawns OFF the loop (the
 *                           SECOND fix). With --async-register, flips the surviving
 *                           red run green.
 *   --stampede              N clients that connect + register near-simultaneously
 *                           at bind — the boot reconnect stampede where every
 *                           watcher's identity is cold. Combined with any SYNC
 *                           register-work phase (hops OR start-time), the red repro.
 *   --peer-probe            run a per-accept getsockopt(LOCAL_PEERPID) FFI probe
 *                           (the production per-accept peer-pid read, suspect #3).
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
  --register-hops <n>  Per-register 'ps -o ppid=' ancestry spawns on the serve
                       loop — the opRegister/ppidViaPs walk (default: 0)
  --async-register     Run the --register-hops spawns OFF the loop (first-fix
                       shape) and defer the register ack (default: sync/pre-fix)
  --start-time-probe <n>
                       Per-register 'ps -ww … lstart=' spawns — the heavier
                       enrichPeerFromJobs/readOsStartTime recycle probe run once
                       per jobs-row hit; the site the first fix MISSED (default: 0)
  --async-start-time   Run the --start-time-probe spawns OFF the loop (second-fix
                       shape) — with --async-register, flips the survivor green
  --stampede <n>       Clients that connect + register near-simultaneously at
                       bind — the boot reconnect stampede (default: 0)
  --peer-probe         Per-accept getsockopt(LOCAL_PEERPID) FFI probe (default off)

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

Red repro (the confirmed wedge — sync register-work under a boot stampede):
  bun scripts/repro-serve-wedge.ts --clients 20 --rate-hz 10 \\
    --register-hops 1 --start-time-probe 2 --stampede 50 --peer-probe \\
    --stuck-ms 400 --duration-ms 10000

Post-FIRST-fix red (ancestry moved off-loop, start_time probe STILL sync — the
survivor this task fixes; matches the live daemon that still wedged from bind):
  bun scripts/repro-serve-wedge.ts --clients 20 --rate-hz 10 \\
    --register-hops 1 --start-time-probe 2 --stampede 50 --peer-probe \\
    --stuck-ms 400 --duration-ms 10000 --async-register

Green (both register-work phases off the loop — the second fix):
  bun scripts/repro-serve-wedge.ts --clients 20 --rate-hz 10 \\
    --register-hops 1 --start-time-probe 2 --stampede 50 --peer-probe \\
    --stuck-ms 400 --duration-ms 10000 --async-register --async-start-time

Note on scale: --stuck-ms/--stampede above are tuned modest on purpose. Pushed
much higher (many hundreds of concurrent stampede registers), REAL subprocess
fork/exec contention dominates and can wedge even the fully-async (fixed) shape
— that is genuine OS-level scheduling cost under extreme concurrency, a
different and expected class of overhead, NOT the JS-event-loop-parking bug
this harness targets. Keep the demo commands at a scale where the sync/async
flag is the only variable that flips the verdict.

Aggressive search (push the #8044-family dimensions):
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
  registerHops: number;
  asyncRegister: boolean;
  startTimeProbe: number;
  asyncStartTime: boolean;
  stampede: number;
  peerProbe: boolean;
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
      "register-hops": { type: "string" },
      "async-register": { type: "boolean", default: false },
      "start-time-probe": { type: "string" },
      "async-start-time": { type: "boolean", default: false },
      stampede: { type: "string" },
      "peer-probe": { type: "boolean", default: false },
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
    registerHops: Math.floor(
      numOr(values["register-hops"], 0, "register-hops"),
    ),
    asyncRegister: values["async-register"] ?? false,
    startTimeProbe: Math.floor(
      numOr(values["start-time-probe"], 0, "start-time-probe"),
    ),
    asyncStartTime: values["async-start-time"] ?? false,
    stampede: Math.floor(numOr(values.stampede, 0, "stampede")),
    peerProbe: values["peer-probe"] ?? false,
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
  registers: number;
}

// ── per-register ancestry work (the production opRegister → ppidViaPs) ────────
//
// Each register runs `--register-hops` `ps -o ppid=` spawns — the exact per-hop
// ancestry probe `src/bus-worker.ts` runs while resolving a watcher's identity.
// SYNC (`Bun.spawnSync`, the pre-fix shape) parks the kqueue serve loop for the
// whole spawn; a burst of cold registers (the boot stampede) starves every other
// socket event — the wedge. ASYNC (`Bun.spawn` + await, the post-fix shape) runs
// the same spawns off the loop, so accepts/reads keep flowing.

function registerWorkSync(hops: number): void {
  for (let i = 0; i < hops; i++) {
    try {
      Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(process.pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
    } catch {
      // a spawn failure terminates the walk early, exactly like production
      return;
    }
  }
}

async function registerWorkAsync(hops: number): Promise<void> {
  for (let i = 0; i < hops; i++) {
    try {
      const proc = Bun.spawn(["ps", "-o", "ppid=", "-p", String(process.pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      await new Response(proc.stdout).text();
      await proc.exited;
    } catch {
      return;
    }
  }
}

// ── per-row-hit start_time probe (the production opRegister → enrichment) ──────
//
// The FIRST fix moved the ancestry walk (--register-hops) off the loop, but the
// live daemon STILL wedged from bind: `enrichPeerFromJobs` runs a HEAVIER `ps -ww
// … -o lstart=,args=` spawn (the exact `readOsStartTime` shape) ONCE per register
// that hits a keeper `jobs` row, as its pid-reuse recycle defense — and that
// probe was still SYNCHRONOUS on the serve loop. In a boot reconnect stampede
// every watcher's register climbs to its harness and hits a row, so this fires
// once per register. SYNC (`Bun.spawnSync`) parks the kqueue loop even though the
// ancestry hops are async — the surviving wedge THIS task fixes. ASYNC
// (`Bun.spawn` + await) runs it off the loop, the fix. Gated INDEPENDENTLY of
// --async-register so the harness can model the post-first-fix daemon exactly:
// ancestry off-loop + start_time on-loop (still red).

function startTimeWorkSync(probes: number): void {
  for (let i = 0; i < probes; i++) {
    try {
      Bun.spawnSync(
        ["ps", "-ww", "-p", String(process.pid), "-o", "lstart=,args="],
        { stdout: "pipe", stderr: "ignore" },
      );
    } catch {
      return;
    }
  }
}

async function startTimeWorkAsync(probes: number): Promise<void> {
  for (let i = 0; i < probes; i++) {
    try {
      const proc = Bun.spawn(
        ["ps", "-ww", "-p", String(process.pid), "-o", "lstart=,args="],
        { stdout: "pipe", stderr: "ignore" },
      );
      await new Response(proc.stdout).text();
      await proc.exited;
    } catch {
      return;
    }
  }
}

/**
 * One register's full subprocess cost profile: the ancestry walk (--register-hops
 * `ps -o ppid=` spawns) THEN the on-hit start_time probe (--start-time-probe
 * `ps … lstart=` spawns), each independently on- or off-loop. A SYNC phase parks
 * the serve loop inline (the sync portion of this async fn runs on the invoking
 * tick, before any await); an ASYNC phase runs off it. Returns a promise that
 * resolves when both finish — the register ack defers until then.
 *
 * The three states this expresses:
 *   pre-any-fix:        sync hops + sync start_time         (both on-loop)  RED
 *   post-first-fix:     --async-register + sync start_time  (mixed)         RED
 *   post-this-fix:      --async-register + --async-start-time (both off)    GREEN
 */
async function runRegisterWork(
  hops: number,
  asyncHops: boolean,
  startTimeProbes: number,
  asyncStartTime: boolean,
): Promise<void> {
  if (asyncHops) await registerWorkAsync(hops);
  else registerWorkSync(hops);
  if (asyncStartTime) await startTimeWorkAsync(startTimeProbes);
  else startTimeWorkSync(startTimeProbes);
}

/** The register ack the server replies once the ancestry work resolves. */
function ackLine(id: string | undefined): Uint8Array {
  const idSeg = id !== undefined ? `,"id":${JSON.stringify(id)}` : "";
  return encoder.encode(`{"type":"ack","op":"register"${idSeg}}\n`);
}

// ── per-accept peer-pid probe (mirrors src/server-worker.ts peerPidForFd) ─────
//
// The production serve path runs a getsockopt(SOL_LOCAL, LOCAL_PEERPID) FFI call
// per accept. The --peer-probe dimension replays it to rule the probe in or out
// as a wedge contributor (suspect #3). Replicated here (not imported) to keep the
// harness standalone — server-worker pulls in the DB layer. macOS-only; inert
// elsewhere. A faithful copy, like probeRealRead below.

const SOL_LOCAL = 0;
const LOCAL_PEERPID = 0x002;
let getsockoptLib:
  | { getsockopt: (...args: number[]) => number }
  | null
  | undefined;

function peerPidForFd(fd: number): number | null {
  if (!Number.isInteger(fd) || fd < 0 || process.platform !== "darwin") {
    return null;
  }
  if (getsockoptLib === undefined) {
    try {
      const { dlopen, FFIType, suffix } =
        require("bun:ffi") as typeof import("bun:ffi");
      const lib = dlopen(`libc.${suffix}`, {
        getsockopt: {
          args: [
            FFIType.i32,
            FFIType.i32,
            FFIType.i32,
            FFIType.ptr,
            FFIType.ptr,
          ],
          returns: FFIType.i32,
        },
      });
      getsockoptLib = lib.symbols as unknown as {
        getsockopt: (...args: number[]) => number;
      };
    } catch {
      getsockoptLib = null;
    }
  }
  if (getsockoptLib === null) return null;
  try {
    const { ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const out = new Int32Array(1);
    const len = new Uint32Array(1);
    len[0] = 4;
    const rc = getsockoptLib.getsockopt(
      fd,
      SOL_LOCAL,
      LOCAL_PEERPID,
      ptr(out),
      ptr(len),
    );
    if (rc !== 0) return null;
    return out[0] > 0 ? out[0] : null;
  } catch {
    return null;
  }
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
  registerHops: number,
  asyncRegister: boolean,
  startTimeProbe: number,
  asyncStartTime: boolean,
  peerProbe: boolean,
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
        // Per-accept peer-pid probe (the production getsockopt read, suspect #3).
        if (peerProbe) {
          peerPidForFd((socket as unknown as { fd?: number }).fd ?? -1);
        }
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
          } else if (frame.type === "register") {
            metrics.registers += 1;
            const id = frame.id;
            // The register's subprocess cost — ancestry walk then on-hit
            // start_time probe, each independently on/off-loop (see
            // runRegisterWork). A SYNC phase parks the kqueue loop inline before
            // the first await; the ack defers until BOTH phases resolve. This is
            // where the wedge lives: async hops + sync start_time (the
            // post-first-fix daemon) still parks the loop once per register.
            void runRegisterWork(
              registerHops,
              asyncRegister,
              startTimeProbe,
              asyncStartTime,
            ).then(() => {
              writeOrQueue(sock, ackLine(id));
            });
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
    let haveSocket = false;
    let sock: { end: () => void; write: (s: string) => number } | null = null;

    const closeSock = (): void => {
      try {
        sock?.end();
      } catch {
        // best-effort
      }
    };

    // Close whatever connection we hold on EVERY settle path — including one that
    // arrives after we already settled (a timeout that fired before `open`), the
    // orphan-conn leak this detector must not itself reproduce. Faithful copy of
    // src/daemon.ts probeSocketRead / probeSettleStep.
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (haveSocket) closeSock();
      resolve(ok);
    };

    // A reply proves life when it ANSWERS this probe: a `result` / any frame
    // echoing our id, or an accept-time admission rejection (which precedes the
    // request read and so cannot carry the id) — faithful copy of src/daemon.ts
    // probeReplyProvesLife, so a probe's own cap-reject is never a false death.
    const provesLife = (frame: {
      type?: string;
      id?: string;
      code?: string;
    }): boolean => {
      if (frame.id === "probe") return true;
      if (frame.type === "result") return true;
      if (
        frame.type === "error" &&
        (frame.code === "too_many_connections" ||
          frame.code === "max_connections")
      ) {
        return true;
      }
      return false;
    };

    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();

    void Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          sock = s as unknown as typeof sock;
          haveSocket = true;
          // A timeout that already settled us just left this socket unclosed —
          // end it now so a timeout-before-open never leaks a connection.
          if (settled) {
            closeSock();
            return;
          }
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
                const frame = JSON.parse(line) as {
                  type?: string;
                  id?: string;
                  code?: string;
                };
                if (provesLife(frame)) {
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

/**
 * The boot reconnect stampede: `stampede` clients connect and each send ONE
 * register frame near-simultaneously at bind — the production condition where a
 * respawn re-connects every `keeper bus watch` at once and every watcher's
 * identity is cold. Each register triggers the server's per-register ancestry
 * work; under the sync (pre-fix) shape that burst parks the serve loop. The
 * clients stay open (a real watcher holds its subscription) so the FINs do not
 * confound the accept loop — the wedge is the register-work, not a close storm.
 */
function startStampede(
  sockPath: string,
  stampede: number,
  state: LoadState,
): void {
  for (let i = 0; i < stampede; i++) {
    void Bun.connect({
      unix: sockPath,
      socket: {
        open(s) {
          try {
            s.write(`${JSON.stringify({ type: "register", id: `reg${i}` })}\n`);
            state.sent += 1;
          } catch {
            // a failed register write just drops this stampede slot
          }
        },
        data() {
          // hold the connection open; the ack is not read (a watcher would
          // subscribe next, but the wedge lives in the register-work already run)
        },
        close() {},
        error() {},
      },
    }).catch(() => {
      /* a failed connect during the stampede is itself signal */
    });
  }
}

// ── run ────────────────────────────────────────────────────────────────────

interface Report {
  args: Args;
  durationRanMs: number;
  accepts: number;
  serverQueries: number;
  serverReplies: number;
  serverShortWrites: number;
  serverRegisters: number;
  clientSent: number;
  clientReceived: number;
  probeOk: number;
  probeFail: number;
  maxProbeDarkMs: number;
  maxLoopLagMs: number;
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
    registers: 0,
  };
  const server = startServer(
    sockPath,
    args.payloadBytes,
    metrics,
    args.registerHops,
    args.asyncRegister,
    args.startTimeProbe,
    args.asyncStartTime,
    args.peerProbe,
  );

  // Let the socket bind before dialing.
  await sleep(50);

  const loadState: LoadState = { stop: false, sent: 0, received: 0 };
  const slowCount = Math.round(args.clients * args.slowReaders);
  for (let i = 0; i < args.clients; i++) {
    startClient(sockPath, args.rateHz, i < slowCount, loadState);
  }
  if (args.churn > 0) startChurn(sockPath, args.churn, loadState);
  // The boot reconnect stampede fires AFTER the first green probe (below), so the
  // serve loop is proven live first — the production crash-loop shape is boot →
  // brief serve → stampede → wedge, and the wedge verdict needs a prior success
  // (boot grace) to fire.
  let stampedeFired = false;

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

  // Event-loop-lag detector. The register-work wedge is a SYNCHRONOUS spawn that
  // parks the WHOLE JS loop — in this single-process harness that also parks the
  // socket probe, which therefore never fails-while-parked (it just can't run,
  // then succeeds once the loop frees). So a co-resident socket probe is blind to
  // a full-loop park; event-loop lag is the faithful in-process proxy for what the
  // production main-thread watchdog observes cross-thread. A fine-cadence timer
  // that comes back late measures exactly how long the loop was starved.
  const LAG_INTERVAL_MS = 100;
  let maxLoopLagMs = 0;
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastTick - LAG_INTERVAL_MS;
    if (lag > maxLoopLagMs) maxLoopLagMs = lag;
    lastTick = now;
  }, LAG_INTERVAL_MS);
  lagTimer.unref?.();

  while (Date.now() - startedAt < args.durationMs && !wedged) {
    const ok = await probeRealRead(sockPath, args.probeTimeoutMs);
    const now = Date.now();
    if (ok) {
      probeOk += 1;
      everProbedOk = true;
      lastProbeOkAt = now;
      // The serve loop is proven live — now fire the reconnect stampede (once).
      if (!stampedeFired && args.stampede > 0) {
        stampedeFired = true;
        startStampede(sockPath, args.stampede, loadState);
      }
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
    // Loop-lag verdict (checked on every iteration, not just a probe miss): a
    // full-loop park past --stuck-ms is a wedge even when the co-parked socket
    // probe never registered a miss. Boot-grace applies here too.
    if (everProbedOk && !wedged && maxLoopLagMs >= args.stuckMs) {
      wedged = true;
      wedgeAtMs = now - startedAt;
    }
    if (!args.quiet && !args.json) {
      process.stderr.write(
        `t=${String(now - startedAt).padStart(6)}ms  probe=${ok ? "ok " : "DARK"}  ` +
          `dark=${(now - lastProbeOkAt).toFixed(0)}ms  loop-lag=${maxLoopLagMs.toFixed(0)}ms  ` +
          `accepts=${metrics.accepts}  q=${metrics.queries}  reg=${metrics.registers}\n`,
      );
    }
    await sleep(args.probeMs);
  }

  loadState.stop = true;
  clearInterval(lagTimer);
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
    serverRegisters: metrics.registers,
    clientSent: loadState.sent,
    clientReceived: loadState.received,
    probeOk,
    probeFail,
    maxProbeDarkMs,
    maxLoopLagMs,
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
  out += w(
    "register work",
    `hops=${r.args.registerHops} ${r.args.asyncRegister ? "async(off-loop)" : "sync(on-loop)"} ` +
      `start-time=${r.args.startTimeProbe} ${r.args.asyncStartTime ? "async(off-loop)" : "sync(on-loop)"} ` +
      `stampede=${r.args.stampede} peer-probe=${r.args.peerProbe}`,
  );
  out += w("ran", `${(r.durationRanMs / 1000).toFixed(1)}s`);
  out += w("accepts", String(r.accepts));
  out += w("server queries", String(r.serverQueries));
  out += w("server replies", String(r.serverReplies));
  out += w("server registers", String(r.serverRegisters));
  out += w("short writes", String(r.serverShortWrites));
  out += w("client sent", String(r.clientSent));
  out += w("client received", String(r.clientReceived));
  out += w("probe ok / fail", `${r.probeOk} / ${r.probeFail}`);
  out += w(
    "max probe-dark",
    `${r.maxProbeDarkMs.toFixed(0)}ms (stuck ${r.args.stuckMs}ms)`,
  );
  out += w(
    "max loop-lag",
    `${r.maxLoopLagMs.toFixed(0)}ms (stuck ${r.args.stuckMs}ms)`,
  );
  out += w(
    "verdict",
    r.wedged
      ? `WEDGE REPRODUCED at ${r.wedgeAtMs}ms — probe-dark or loop-lag past --stuck-ms while server live`
      : "no wedge — serve loop stayed live (probe answered, loop lag bounded) throughout",
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
