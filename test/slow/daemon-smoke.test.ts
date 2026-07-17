/**
 * Sandboxed real-daemon smoke tier (ADR 0073) — the three enumerated scenarios:
 * (a) boot → catch-up → the served frame/probe contract, plus the harness's own
 * deadline/tree-kill guarantee; (b) killing a real worker and proving the
 * supervision contract (bounded teardown, ledger evidence); (c) the restart
 * CLI's evidence verdict end-to-end against the sandboxed daemon, with only the
 * launchctl seam injected.
 *
 * This is the slow-tier answer to a blind spot the correctness gates cannot cover:
 * a defect in the CONTRACT between a live serve frame and its live consumer. The
 * restart-verdict defect proved fixture-invisible because both the probe and the
 * code were written from the same misunderstanding — the probe demanded a boot
 * header the serve protocol deliberately OMITS on memoized steady-state replies.
 * So here nothing is a fixture: a real keeperd boots fully sandboxed, and the
 * shipped {@link isCaughtUpFrame} (imported from the restart CLI, the exact
 * consumer) is asserted to AGREE with both live frame shapes off the real wire.
 * Scenarios (b) and (c) go further and run the shipped {@link runRestart} itself
 * against a REAL sandboxed daemon — only `runLaunchctl` (the launchctl seam) is
 * test-driven, kill-and-respawning the sandboxed process the way `launchctl
 * kickstart -k` respawns the real LaunchAgent job; `probeHealth` and
 * `readLatestBoot` are the shipped functions, unmodified.
 *
 * Runs behind the `slow-daemon` named gate only (`bun run test:slow-daemon`);
 * never a correctness gate. See `test/helpers/daemon-smoke-harness.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isCaughtUpFrame,
  probeSocketHealth,
  type RestartDeps,
  readLatestBoot,
  runRestart,
} from "../../cli/restart";
import type { EventStoreStatus } from "../../src/protocol";
import {
  isProcessAlive,
  killDaemonProcess,
  openWatchConnection,
  pollUntilCaughtUp,
  probeServeFrame,
  respawnSandboxedDaemon,
  runScenario,
  type SandboxedDaemon,
  type ServeFrame,
} from "../helpers/daemon-smoke-harness";
import { retryUntil } from "../helpers/retry-until";

/** Thrown by a test's `exit` dep so `emitEnvelope`'s `never`-typed call site
 *  unwinds into a catchable value instead of actually exiting the test worker
 *  — the same pattern `test/restart-cli.test.ts` uses against the fixture. */
class ExitError extends Error {
  constructor(
    readonly code: number,
    readonly output: string,
  ) {
    super(`exit ${code}`);
  }
}

/** Run `runRestart` and capture its terminal `exit` call as a value. Throws
 *  (never resolves to null) if `runRestart` returns without exiting — a real
 *  contract violation, not a valid outcome to swallow. */
async function restartAndCapture(
  args: { sock: string; timeoutMs: number },
  deps: RestartDeps,
): Promise<ExitError> {
  try {
    await runRestart(args, deps);
  } catch (error) {
    if (error instanceof ExitError) return error;
    throw error;
  }
  throw new Error("restart did not exit");
}

// A seed large enough that the from-scratch boot re-fold PACES for seconds — far
// longer than the ~150ms a client needs to connect — so the transient
// catching-up frame shape is reliably observable over the wire (an empty DB
// catches up before the first probe lands).
const SEED_EVENTS = 600;

describe("sandboxed real-daemon boot + served frame contract", () => {
  let observations: {
    catchingUpFrames: ServeFrame[];
    caughtUpFrame: ServeFrame;
    steadyStateRaw: string;
    steadyStateFrame: ServeFrame;
    sandboxState: { socket: boolean; db: boolean; lock: boolean };
  };

  beforeAll(async () => {
    const verdict = await runScenario(
      async (daemon: SandboxedDaemon) => {
        // Poll the real socket until caught-up, capturing the catching-up replies
        // seen along the way.
        const { catchingUpFrames, caughtUpFrame } = await pollUntilCaughtUp(
          daemon.sockPath,
          30_000,
        );
        // One more query now that the gate is ready: the steady-state reply rides
        // the memo path, which builds its line WITHOUT the boot header.
        const steady = await probeServeFrame(daemon.sockPath, 2_000);
        if (steady === null) {
          throw new Error("steady-state probe returned no frame");
        }
        // Every state class the daemon materialized lives under the sandbox — the
        // observable proof it bound the sandbox socket and never the host daemon.
        return {
          catchingUpFrames,
          caughtUpFrame,
          steadyStateRaw: steady.raw,
          steadyStateFrame: steady.frame,
          sandboxState: {
            socket: existsSync(daemon.sockPath),
            db: existsSync(join(daemon.tmpDir, "keeper.db")),
            lock: existsSync(join(daemon.tmpDir, "keeperd.lock")),
          },
        };
      },
      { deadlineMs: 35_000, retries: 1, seedEvents: SEED_EVENTS },
    );
    if (verdict.kind !== "ok") {
      throw new Error(
        `frame-contract scenario did not succeed: ${JSON.stringify(verdict)}`,
      );
    }
    observations = verdict.value;
  }, 100_000);

  test("a sandboxed keeperd boots, reaches caught-up, and materializes only sandbox state", () => {
    // Reaching this test means beforeAll's scenario got a caught-up reply off the
    // sandbox socket. The socket, DB, and single-instance lock all materialized
    // under the per-run tmpdir — every state class was redirected, so the boot
    // touched zero host state.
    expect(observations.sandboxState).toEqual({
      socket: true,
      db: true,
      lock: true,
    });
    expect(observations.caughtUpFrame.type).toBe("result");
  });

  test("catching-up frames carry boot.catching_up and the shipped isCaughtUpFrame agrees they are not caught up", () => {
    // The seed guarantees a paced re-fold, so at least one catching-up reply is
    // observed; a zero count is a real regression (boot no longer widens), never a
    // flake.
    expect(observations.catchingUpFrames.length).toBeGreaterThan(0);
    for (const frame of observations.catchingUpFrames) {
      expect(frame.type).toBe("result");
      expect(frame.boot?.catching_up).toBe(true);
      // The exact contract: the shipped consumer must read this live shape as
      // still booting.
      expect(isCaughtUpFrame(frame)).toBe(false);
    }
  });

  test("the steady-state memoized reply omits the boot header and the shipped isCaughtUpFrame agrees it is caught up", () => {
    const frame = observations.steadyStateFrame;
    expect(frame.type).toBe("result");
    // The memo line is built without a boot header — the exact shape the
    // restart-verdict defect got wrong. Assert the header is absent from the
    // parsed frame AND that the boot-header KEY is absent from the wire bytes.
    // (A bare "boot" substring check would false-positive on the event-store
    // block's `last_boot_catchup` field, so match the header key precisely.)
    expect(frame.boot).toBeUndefined();
    expect(observations.steadyStateRaw).not.toContain('"boot":');
    // The shipped consumer must read a header-less result as caught up.
    expect(isCaughtUpFrame(frame)).toBe(true);
  });

  // fn-1312 (ADR 0073 amendment): the event-store block rode the boot header,
  // so a caught-up daemon — whose memoized reply omits the header — served
  // `event_store: null` exactly when healthy. The block now rides the `result`
  // frame directly. Assert the live steady-state wire carries the FULL non-null
  // block, the contract this scenario pins so it can't regress blind again.
  test("the steady-state reply carries the full event-store block on the frame (delivered off the omitted boot header)", () => {
    const frame = observations.steadyStateFrame;
    const eventStore = frame.event_store as EventStoreStatus | undefined;
    // Present and non-null against a caught-up daemon — the whole point.
    expect(eventStore).toBeDefined();
    expect(eventStore).not.toBeNull();
    if (eventStore === undefined || eventStore === null) {
      throw new Error("steady-state frame carried no event_store block");
    }
    // Live counts: the seeded store folded SEED_EVENTS, so both are positive.
    expect(typeof eventStore.event_count).toBe("number");
    expect(eventStore.event_count).toBeGreaterThan(0);
    expect(typeof eventStore.db_bytes).toBe("number");
    expect(eventStore.db_bytes).toBeGreaterThan(0);
    // The boot recorded a real catch-up measurement, so the durable observation
    // and both projected durations ride through non-null.
    expect(eventStore.last_boot_catchup).not.toBeNull();
    expect(eventStore.last_boot_catchup?.events_folded).toBeGreaterThan(0);
    expect(typeof eventStore.projected_catchup_duration_ms).toBe("number");
    expect(typeof eventStore.projected_full_replay_duration_ms).toBe("number");
  });
});

describe("harness deadline ownership", () => {
  let capturedPid = -1;

  test("a deliberately-hung scenario is killed at the deadline, reads as a bounded red, and tears down the tree", async () => {
    const deadlineMs = 2_500;
    const verdict = await runScenario<never>(
      async (daemon: SandboxedDaemon) => {
        capturedPid = daemon.pid;
        // Never resolves: the harness deadline is the only thing that can end it.
        return new Promise<never>(() => {});
      },
      { deadlineMs, retries: 0 },
    );

    // The red the mechanism produces is a `timed_out` verdict — NOT a wedge that
    // rides the gate's 2-minute hang deadline.
    expect(verdict.kind).toBe("timed_out");
    // Bounded: the deadline fired, and the whole thing returned far under the
    // gate's hang deadline (120s) — a hang is a fast, bounded red.
    expect(verdict.elapsedMs).toBeGreaterThanOrEqual(deadlineMs);
    expect(verdict.elapsedMs).toBeLessThan(30_000);
    // Full tree teardown: the daemon leader (and its process group) is gone. The
    // harness already awaited the reap, but poll to stay robust against any
    // residual zombie-reap delay rather than a fixed sleep.
    expect(capturedPid).toBeGreaterThan(1);
    const dead = await retryUntil(
      () => (isProcessAlive(capturedPid) ? null : "dead"),
      5_000,
      50,
    );
    expect(dead).toBe("dead");
  }, 40_000);

  afterAll(() => {
    // Defensive: if the assertions above threw before teardown could be observed,
    // make sure no sandboxed daemon leaks past the suite.
    if (capturedPid > 1 && isProcessAlive(capturedPid)) {
      try {
        process.kill(-capturedPid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });
});

// Every worker crash in `src/daemon.ts` routes through `fatalExit` (bare, or
// with a reason) — a `Worker` is a THREAD sharing the daemon's one pid (no
// in-process self-heal; see CLAUDE.md), so from outside the process a worker
// dying and the daemon process dying are the same observable event. SIGKILLing
// the sandboxed leader is therefore the faithful black-box stand-in for
// "a real spawned worker died": it is exactly as abrupt as `fatalExit`'s own
// `process.exit(1)`, and every resource claim these assertions exercise
// (the kernel single-instance flock, the server-worker's socket-ownership lock
// file, the bound UDS) is released by the OS at process death regardless of
// which internal path triggered it.
describe("worker-kill supervision contract", () => {
  test("killing the sandboxed daemon boundedly tears down its lock/socket/watcher and the ledger records the restart", async () => {
    const verdict = await runScenario(
      async (daemon: SandboxedDaemon) => {
        await pollUntilCaughtUp(daemon.sockPath, 8_000);

        // A live watcher subscription (any `type:"query"` conn subscribes —
        // see server-worker.ts) opened BEFORE the kill, so its teardown is
        // observable from the client side.
        const watcher = openWatchConnection(daemon.sockPath);
        let watcherClosed: "closed" | "timeout";
        try {
          const firstReply = await watcher.firstReply;
          if (firstReply === null) {
            throw new Error("watcher connection never got its first reply");
          }

          await killDaemonProcess(daemon);

          // Watcher teardown: the live subscription's socket closes boundedly
          // rather than hanging silently past its daemon's death.
          watcherClosed = await watcher.awaitClose(5_000);
        } finally {
          watcher.destroy();
        }

        // Process absence: bounded — killDaemonProcess already awaited the reap.
        const processGone = !isProcessAlive(daemon.pid);
        // Socket state: the dead listener refuses new connections.
        const postKillProbe = await probeServeFrame(daemon.sockPath, 2_000);

        // Lock + socket reclaim: a successor booting into the SAME sandbox
        // must acquire the (now-stale) single-instance flock and the
        // server-worker's socket-ownership lock file cleanly, then reach
        // caught-up — real production reclaim code, not a fixture.
        const successor = respawnSandboxedDaemon(daemon.tmpDir);
        try {
          await pollUntilCaughtUp(successor.sockPath, 8_000);
        } finally {
          await killDaemonProcess(successor);
        }

        // Ledger evidence: the sandboxed restart-ledger now carries two
        // DISTINCT `boot` lines — the original's own boot record plus the
        // successor's — durable proof a daemon-level exit-and-restart
        // happened in between.
        const ledgerRaw = readFileSync(
          join(daemon.tmpDir, "restart-ledger.json"),
          "utf8",
        );
        const bootIds = ledgerRaw
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map(
            (line) => JSON.parse(line) as { kind?: string; boot_id?: string },
          )
          .filter((line) => line.kind === "boot")
          .map((line) => line.boot_id);

        return { processGone, postKillProbe, watcherClosed, bootIds };
      },
      { deadlineMs: 40_000, retries: 1 },
    );
    if (verdict.kind !== "ok") {
      throw new Error(
        `worker-kill scenario did not succeed: ${JSON.stringify(verdict)}`,
      );
    }

    expect(verdict.value.processGone).toBe(true);
    expect(verdict.value.postKillProbe).toBeNull();
    expect(verdict.value.watcherClosed).toBe("closed");
    expect(verdict.value.bootIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(verdict.value.bootIds).size).toBe(
      verdict.value.bootIds.length,
    );
  }, 100_000);
});

describe("restart CLI evidence verdict against the sandboxed daemon", () => {
  test("returns a true success once the launchctl-seam respawn reaches health", async () => {
    const verdict = await runScenario(
      async (daemon: SandboxedDaemon) => {
        await pollUntilCaughtUp(daemon.sockPath, 8_000);

        let current = daemon;
        const stdout: string[] = [];
        const savedLedgerEnv = process.env.KEEPER_RESTART_LEDGER;
        process.env.KEEPER_RESTART_LEDGER = join(
          daemon.tmpDir,
          "restart-ledger.json",
        );
        try {
          const deps: RestartDeps = {
            runLaunchctl: async (args) => {
              if (args[0] !== "kickstart") {
                return { exitCode: 0, stdout: "state = running", stderr: "" };
              }
              // The launchctl seam: real kill + real respawn into the SAME
              // sandbox, mirroring `launchctl kickstart -k`. Everything else
              // (the socket, the ledger, the health probe below) is real.
              await killDaemonProcess(current);
              current = respawnSandboxedDaemon(current.tmpDir);
              return { exitCode: 0, stdout: "", stderr: "" };
            },
            // The shipped consumer, unmodified — it hits the real sandbox
            // socket.
            probeHealth: probeSocketHealth,
            // The shipped consumer, unmodified — it reads
            // `KEEPER_RESTART_LEDGER`, pointed above at the sandbox ledger.
            readLatestBoot,
            sleep: (ms) => Bun.sleep(ms),
            now: () => Date.now(),
            random: () => Math.random(),
            uid: () => 501,
            writeStdout: (text) => stdout.push(text),
            writeStderr: () => {},
            exit: (code): never => {
              throw new ExitError(code, stdout.join(""));
            },
          };

          const exit = await restartAndCapture(
            { sock: daemon.sockPath, timeoutMs: 20_000 },
            deps,
          );
          return { exit, finalPid: current.pid };
        } finally {
          process.env.KEEPER_RESTART_LEDGER = savedLedgerEnv;
          await killDaemonProcess(current);
        }
      },
      { deadlineMs: 35_000, retries: 1 },
    );
    if (verdict.kind !== "ok") {
      throw new Error(
        `restart-verdict success scenario did not succeed: ${JSON.stringify(verdict)}`,
      );
    }

    const { exit } = verdict.value;
    expect(exit.code).toBe(0);
    const envelope = JSON.parse(exit.output);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.healthy_probes).toBeGreaterThanOrEqual(3);
  }, 90_000);

  test("returns the honest failure when the sandboxed daemon never returns", async () => {
    const verdict = await runScenario(
      async (daemon: SandboxedDaemon) => {
        await pollUntilCaughtUp(daemon.sockPath, 8_000);

        const stdout: string[] = [];
        const savedLedgerEnv = process.env.KEEPER_RESTART_LEDGER;
        process.env.KEEPER_RESTART_LEDGER = join(
          daemon.tmpDir,
          "restart-ledger.json",
        );
        try {
          const deps: RestartDeps = {
            runLaunchctl: async (args) => {
              if (args[0] !== "kickstart") {
                return { exitCode: 0, stdout: "state = running", stderr: "" };
              }
              // Kill and deliberately never respawn — the daemon that never
              // returns; kickstart itself still reports success (an honest
              // launchctl would too — the respawn just never lands).
              await killDaemonProcess(daemon);
              return { exitCode: 0, stdout: "", stderr: "" };
            },
            probeHealth: probeSocketHealth,
            readLatestBoot,
            sleep: (ms) => Bun.sleep(ms),
            now: () => Date.now(),
            random: () => Math.random(),
            uid: () => 501,
            writeStdout: (text) => stdout.push(text),
            writeStderr: () => {},
            exit: (code): never => {
              throw new ExitError(code, stdout.join(""));
            },
          };

          return await restartAndCapture(
            { sock: daemon.sockPath, timeoutMs: 4_000 },
            deps,
          );
        } finally {
          process.env.KEEPER_RESTART_LEDGER = savedLedgerEnv;
        }
      },
      { deadlineMs: 18_000, retries: 1 },
    );
    if (verdict.kind !== "ok") {
      throw new Error(
        `restart-verdict failure scenario did not succeed: ${JSON.stringify(verdict)}`,
      );
    }

    const exit = verdict.value;
    expect(exit.code).toBe(1);
    const envelope = JSON.parse(exit.output);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("health-timeout");
  }, 50_000);
});
