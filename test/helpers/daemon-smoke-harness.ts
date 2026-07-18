/**
 * Sandboxed real-daemon smoke harness (ADR 0073).
 *
 * The correctness tier tests every daemon decision through a pure seam — fast and
 * flake-free, but structurally blind to a defect that lives in the CONTRACT
 * between a real component and its real consumer, because the fixture is written
 * from the same misunderstanding as the code (the restart-verdict defect survived
 * five fixture-green fix generations). This harness is the slow-tier answer: it
 * boots an ACTUAL keeperd subprocess with every state class sandboxed under a
 * per-test tmpdir (via {@link sandboxEnv} plus the serve socket, which is NOT one
 * of that builder's classes), owns a hard wall-clock deadline that force-kills the
 * whole process tree on expiry so a hang is a BOUNDED red rather than a wedge that
 * rides the gate's 2-minute hang deadline, absorbs environment noise with one
 * disclosed retry, and tears the daemon down on every path.
 *
 * It is a slow-tier member only — never imported by a correctness gate. See
 * `test/slow/daemon-smoke.test.ts` for the scenarios and `scripts/test-gate.ts`
 * `--phase=slow-daemon` for the named gate.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RestartIdentity } from "../../src/restart-observation";
import { sandboxEnv } from "./sandbox-env";
import { freshDbFile } from "./template-db";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const DAEMON_ENTRY = join(REPO_ROOT, "src", "daemon.ts");

/** Bounded tail of a daemon's stderr kept for failure diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * One served reply frame as it arrives on the wire — deliberately loose so the
 * harness asserts the CONTRACT (the presence/shape of `boot`), never a typed
 * projection the daemon and test could drift together.
 */
export interface ServeFrame {
  type?: unknown;
  boot?: {
    boot_id?: unknown;
    pid?: unknown;
    start_time?: unknown;
    catching_up?: unknown;
  };
  [key: string]: unknown;
}

export function servedBootIdentity(frame: ServeFrame): RestartIdentity | null {
  const boot = frame.boot;
  if (
    boot === undefined ||
    typeof boot.boot_id !== "string" ||
    boot.boot_id.length === 0 ||
    typeof boot.pid !== "number" ||
    !Number.isInteger(boot.pid) ||
    boot.pid <= 0 ||
    typeof boot.start_time !== "string" ||
    boot.start_time.length === 0
  ) {
    return null;
  }
  return {
    boot_id: boot.boot_id,
    pid: boot.pid,
    start_time: boot.start_time,
  };
}

/** A handle to a live sandboxed keeperd subprocess. */
export interface SandboxedDaemon {
  /** The UDS path the daemon's server worker bound — under {@link tmpDir}. */
  readonly sockPath: string;
  /** The per-run sandbox root; every state class lives beneath it. */
  readonly tmpDir: string;
  /** The daemon leader pid (also its process-group id — see {@link teardown}). */
  readonly pid: number;
  /** Resolves once the daemon process exits. */
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  /** The last {@link STDERR_TAIL_BYTES} of daemon stderr, for diagnostics. */
  stderrTail(): string;
  /**
   * SIGKILL the whole process TREE (the detached leader's process group, so
   * transient git/ps children die with it — worker THREADS die with the process),
   * WAIT for the leader to be reaped (bounded) so a caller can immediately observe
   * it gone rather than as a not-yet-reaped zombie, then remove the sandbox
   * tmpdir. Idempotent and best-effort: safe to call on every path, including
   * after the process already exited.
   */
  teardown(): Promise<void>;
}

export interface SpawnSandboxedDaemonOptions {
  /**
   * Seed this many synthetic events into the sandboxed DB before boot so the
   * from-scratch re-fold PACES long enough (`BOOT_DRAIN_PACE_MS` per event over
   * the first `BOOT_DRAIN_PACE_EVENTS`) to observe the catching-up frame shape
   * over the wire. An empty DB catches up faster than a client can connect, so
   * the steady-state shape is all that is observable without a seed.
   */
  seedEvents?: number;
  /** Extra env overlay; the sandbox state paths still win over it. */
  extraEnv?: Record<string, string | undefined>;
}

/**
 * Seed `count` foldable events (a `PreToolUse`/Bash shape that folds cleanly, so
 * the drain does real paced work and mints no dead letters) into a freshly
 * migrated DB at `dbPath`. Runs before the daemon opens the file.
 */
function seedEvents(dbPath: string, count: number): void {
  const kdb = freshDbFile(dbPath);
  try {
    const insert = kdb.db.prepare(
      "INSERT INTO events (ts, session_id, hook_event, event_type, tool_name, cwd, data) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const base = Date.now() / 1000;
    kdb.db.transaction(() => {
      for (let i = 0; i < count; i++) {
        insert.run(
          base + i,
          `smoke-seed-${i}`,
          "PreToolUse",
          "PreToolUse",
          "Bash",
          REPO_ROOT,
          JSON.stringify({ tool_input: { command: `echo ${i}` } }),
        );
      }
    })();
    kdb.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    kdb.db.close();
  }
}

/** True when `pid` is still a live process this session may signal. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The two state paths every sandbox tmpdir carries, derived deterministically
 *  from the tmpdir so a {@link respawnSandboxedDaemon} successor lands on the
 *  exact paths a fresh {@link spawnSandboxedDaemon} would have picked. */
function sandboxPaths(tmpDir: string): { dbPath: string; sockPath: string } {
  return {
    dbPath: join(tmpDir, "keeper.db"),
    // Short leaf: a UDS path must fit the ~104-byte sun_path limit, and the OS
    // tmpdir base is already long.
    sockPath: join(tmpDir, "d.sock"),
  };
}

/**
 * Spawn one real keeperd subprocess pointed at the given sandbox paths, every
 * state class sandboxed under `tmpDir` — the DB, sockets, ledgers, spools, and
 * config redirected by {@link sandboxEnv}, PLUS `KEEPER_SOCK` (the serve
 * socket, which sandboxEnv does not own) pointed under the tmpdir so the
 * daemon never binds the host socket or touches the host daemon. Detached so
 * its pid is a process-group leader the teardown/kill can tree-kill. Shared by
 * a fresh {@link spawnSandboxedDaemon} boot and a {@link respawnSandboxedDaemon}
 * successor reusing an existing sandbox — neither creates nor removes `tmpDir`.
 */
function spawnDaemonAt(
  tmpDir: string,
  dbPath: string,
  sockPath: string,
  extraEnv?: Record<string, string | undefined>,
): SandboxedDaemon {
  const env = sandboxEnv({
    tmpDir,
    dbPath,
    extra: { ...extraEnv, KEEPER_SOCK: sockPath },
  });

  const child: ChildProcess = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });

  const pid = child.pid ?? -1;
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: null }));
  });

  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    if (pid > 1) {
      // Kill the process GROUP first (detached leader → its transient children
      // share the group), then the leader directly as a fallback. Worker threads
      // die with the process. Both are best-effort: the leader may have exited.
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // leader already gone
      }
      // Wait for the reap (bounded) — a just-SIGKILLed child lingers as a zombie
      // until this process reaps it, and a zombie still answers `kill(pid, 0)`, so
      // a caller checking liveness right after teardown would see a false positive.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
    }
    rmSync(tmpDir, { recursive: true, force: true });
  };

  return {
    sockPath,
    tmpDir,
    pid,
    exited,
    stderrTail: () => stderrBuf,
    teardown,
  };
}

/**
 * Boot a real keeperd subprocess with every state class sandboxed under a fresh
 * per-run tmpdir. See {@link spawnDaemonAt} for the sandboxing detail.
 */
export function spawnSandboxedDaemon(
  opts: SpawnSandboxedDaemonOptions = {},
): SandboxedDaemon {
  const tmpDir = mkdtempSync(join(tmpdir(), "keeper-daemon-smoke-"));
  const { dbPath, sockPath } = sandboxPaths(tmpDir);

  if (opts.seedEvents && opts.seedEvents > 0) {
    seedEvents(dbPath, opts.seedEvents);
  }

  return spawnDaemonAt(tmpDir, dbPath, sockPath, opts.extraEnv);
}

/**
 * Boot a successor keeperd into an EXISTING sandbox `tmpDir` — the same DB,
 * socket, restart-ledger, and lock paths a predecessor (now dead — see
 * {@link killDaemonProcess}) already established. This is the harness's
 * stand-in for `launchctl kickstart -k`'s kill-and-respawn: the daemon's own
 * boot path runs for real (real kernel-flock reclaim, real stale-socket-lock
 * reclaim, real restart-ledger boot line), only the OS-level respawn TRIGGER
 * is test-driven. The caller owns tearing the successor down — its
 * `teardown()` removes the same `tmpDir` a predecessor's `teardown()` would
 * (idempotent either order), so prefer {@link killDaemonProcess} on a
 * successor whose tmpDir a caller still needs to inspect afterward.
 */
export function respawnSandboxedDaemon(
  tmpDir: string,
  extraEnv?: Record<string, string | undefined>,
): SandboxedDaemon {
  const { dbPath, sockPath } = sandboxPaths(tmpDir);
  return spawnDaemonAt(tmpDir, dbPath, sockPath, extraEnv);
}

/**
 * SIGKILL `daemon`'s whole process tree and wait (bounded) for the reap —
 * exactly {@link SandboxedDaemon.teardown}'s kill step, WITHOUT removing the
 * sandbox tmpDir. The worker-kill and restart-verdict scenarios need the
 * on-disk state (DB, restart ledger, lock files, socket file) to survive the
 * kill so a successor can reclaim it, or a caller can read the ledger
 * directly. Best-effort and safe to call on an already-dead process.
 */
export async function killDaemonProcess(
  daemon: SandboxedDaemon,
): Promise<void> {
  if (daemon.pid > 1) {
    try {
      process.kill(-daemon.pid, "SIGKILL");
    } catch {
      // group already gone
    }
    try {
      process.kill(daemon.pid, "SIGKILL");
    } catch {
      // leader already gone
    }
  }
  // Bounded reap wait — see spawnDaemonAt's teardown for why this matters: the
  // kernel releases every fd (flock included) at termination, but a caller
  // checking liveness or reclaiming a lock right after `kill()` returns would
  // otherwise race a not-yet-reaped zombie.
  await Promise.race([daemon.exited, new Promise((r) => setTimeout(r, 5_000))]);
}

/** A live connection left open past its first reply — see
 *  {@link openWatchConnection}. */
export interface WatchConnection {
  /** The first served reply, or `null` on a transport error/timeout. */
  firstReply: Promise<ServeFrame | null>;
  /** Resolves `"closed"` once the socket observably closes/errors, or
   *  `"timeout"` if it hasn't by `timeoutMs` — never hangs a caller. */
  awaitClose(timeoutMs: number): Promise<"closed" | "timeout">;
  /** Best-effort local close, for a path that never reaches the daemon kill. */
  destroy(): void;
}

/**
 * Open a query connection and leave it open past its first reply. The served
 * protocol subscribes ANY `type:"query"` connection to its collection (see
 * `server-worker.ts`'s query handler) — so this is a genuine live watcher
 * subscription, not a synthetic stand-in. {@link WatchConnection.awaitClose}
 * lets a caller prove that subscription tears down boundedly (rather than
 * hanging silently) once its daemon dies.
 */
export function openWatchConnection(sockPath: string): WatchConnection {
  const socket = new Socket();
  let closed = false;
  const closeWaiters: Array<() => void> = [];
  const noteClosed = (): void => {
    if (closed) return;
    closed = true;
    for (const waiter of closeWaiters.splice(0)) waiter();
  };
  socket.on("close", noteClosed);
  socket.on("error", () => {
    // Swallowed here — `close` still follows for a `net.Socket`, so
    // `noteClosed` fires there. Never let an unhandled 'error' throw.
  });

  const firstReply = new Promise<ServeFrame | null>((resolve) => {
    let settled = false;
    let buffered = "";
    const finish = (value: ServeFrame | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(JSON.parse(buffered.slice(0, newline)) as ServeFrame);
      } catch {
        finish(null);
      }
    });
    socket.once("error", () => finish(null));
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "query", collection: "jobs", limit: 1 })}\n`,
      );
    });
    try {
      socket.connect({ path: sockPath });
    } catch {
      finish(null);
    }
  });

  return {
    firstReply,
    awaitClose: (timeoutMs: number) =>
      new Promise((resolve) => {
        if (closed) {
          resolve("closed");
          return;
        }
        const timer = setTimeout(() => resolve("timeout"), timeoutMs);
        closeWaiters.push(() => {
          clearTimeout(timer);
          resolve("closed");
        });
      }),
    destroy: () => {
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    },
  };
}

/**
 * The exact serve probe the restart CLI runs: connect the UDS, write one
 * `jobs`-collection query, and return the first newline-framed reply as both its
 * raw line and parsed frame. Resolves `null` on connect refusal / transport
 * error / timeout so a caller can poll a still-booting (or not-yet-bound) socket.
 *
 * Built on a bare {@link Socket} whose `error` handler is attached BEFORE
 * `connect` — a probe that races ahead of the daemon's socket bind gets a
 * connect-ENOENT, and Node throws an "unhandled error event" if the listener is
 * not already in place (the shape `createConnection` cannot guarantee).
 */
export function probeServeFrame(
  sockPath: string,
  timeoutMs: number,
): Promise<{ raw: string; frame: ServeFrame } | null> {
  return new Promise((resolve) => {
    let buffered = "";
    let settled = false;
    const socket = new Socket();
    const finish = (value: { raw: string; frame: ServeFrame } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("error", () => finish(null));
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      const raw = buffered.slice(0, newline);
      try {
        finish({ raw, frame: JSON.parse(raw) as ServeFrame });
      } catch {
        finish(null);
      }
    });
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ type: "query", collection: "jobs", limit: 1 })}\n`,
      );
    });
    try {
      socket.connect({ path: sockPath });
    } catch {
      finish(null);
    }
  });
}

/** Observations a catch-up poll gathers from the live wire. */
export interface CatchUpObservation {
  /** Every distinct served reply captured while the daemon reported catch-up. */
  catchingUpFrames: ServeFrame[];
  /** The first reply that reported caught-up — the steady-state shape. */
  caughtUpFrame: ServeFrame;
}

/**
 * Poll `sockPath` until a caught-up reply arrives (or `budgetMs` elapses),
 * collecting the catching-up replies seen along the way. A caught-up reply is a
 * `result` frame whose exact served identity reports `catching_up === false`
 * — deliberately re-derived here rather than importing the consumer, so the test
 * can separately assert the shipped `isCaughtUpFrame` AGREES with what this saw.
 * Throws if the budget elapses without a caught-up reply (a real failure, never a
 * silent pass).
 */
export async function pollUntilCaughtUp(
  sockPath: string,
  budgetMs: number,
  probeTimeoutMs = 1_000,
  pollSpacingMs = 25,
): Promise<CatchUpObservation> {
  const deadline = Date.now() + budgetMs;
  const catchingUpFrames: ServeFrame[] = [];
  while (Date.now() < deadline) {
    const reply = await probeServeFrame(sockPath, probeTimeoutMs);
    if (reply) {
      const caughtUp =
        reply.frame.type === "result" &&
        servedBootIdentity(reply.frame) !== null &&
        reply.frame.boot?.catching_up === false;
      if (caughtUp) {
        return { catchingUpFrames, caughtUpFrame: reply.frame };
      }
      if (reply.frame.boot?.catching_up === true) {
        catchingUpFrames.push(reply.frame);
      }
    }
    await new Promise((r) => setTimeout(r, pollSpacingMs));
  }
  throw new Error(
    `daemon did not reach caught-up within ${budgetMs}ms ` +
      `(catching-up frames seen: ${catchingUpFrames.length})`,
  );
}

/** The outcome of a scenario run under the harness deadline. */
export type ScenarioVerdict<T> =
  | { kind: "ok"; value: T; attempts: number; elapsedMs: number }
  | { kind: "timed_out"; attempts: number; elapsedMs: number }
  | { kind: "failed"; error: string; attempts: number; elapsedMs: number };

export interface RunScenarioOptions extends SpawnSandboxedDaemonOptions {
  /** Hard wall-clock bound per attempt. On expiry the tree is killed. */
  deadlineMs: number;
  /**
   * Disclosed retries that absorb environment noise (default 1). A `timed_out`
   * or `failed` attempt is retried up to this many times; the retry is announced
   * on stderr so the gate log discloses it. A second failure is the red verdict.
   */
  retries?: number;
}

/**
 * Run `scenario` against a freshly booted sandboxed daemon under a hard wall-clock
 * deadline. The deadline is the whole point: a scenario that hangs is force-killed
 * (tree + tmpdir) and returns a BOUNDED `timed_out` verdict, never a wedge that
 * waits out the gate. The daemon is torn down on EVERY path (success, throw, or
 * deadline). One disclosed retry (by default) absorbs environment noise.
 */
export async function runScenario<T>(
  scenario: (daemon: SandboxedDaemon) => Promise<T>,
  opts: RunScenarioOptions,
): Promise<ScenarioVerdict<T>> {
  const retries = opts.retries ?? 1;
  const startedAt = Date.now();
  let last: ScenarioVerdict<T> | null = null;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const daemon = spawnSandboxedDaemon({
      seedEvents: opts.seedEvents,
      extraEnv: opts.extraEnv,
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const timedOut = Symbol("timed_out");
      const deadline = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), opts.deadlineMs);
      });
      const outcome = await Promise.race([scenario(daemon), deadline]);
      if (outcome === timedOut) {
        last = {
          kind: "timed_out",
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
        };
      } else {
        return {
          kind: "ok",
          value: outcome as T,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
        };
      }
    } catch (error) {
      last = {
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
      };
    } finally {
      if (timer !== null) clearTimeout(timer);
      // Await teardown so the tree is confirmed reaped before the verdict returns
      // — the deadline/tree-kill guarantee is only meaningful if it has completed.
      await daemon.teardown();
    }
    if (attempt <= retries) {
      process.stderr.write(
        `[daemon-smoke] attempt ${attempt} ${last?.kind}; retrying (disclosed)\n`,
      );
    }
  }
  return (
    last ?? {
      kind: "failed",
      error: "no attempt ran",
      attempts: 0,
      elapsedMs: 0,
    }
  );
}
