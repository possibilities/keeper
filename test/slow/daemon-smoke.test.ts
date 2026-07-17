/**
 * Sandboxed real-daemon smoke tier (ADR 0073) — scenario (a): boot → catch-up →
 * the served frame/probe contract, plus the harness's own deadline/tree-kill
 * guarantee.
 *
 * This is the slow-tier answer to a blind spot the correctness gates cannot cover:
 * a defect in the CONTRACT between a live serve frame and its live consumer. The
 * restart-verdict defect proved fixture-invisible because both the probe and the
 * code were written from the same misunderstanding — the probe demanded a boot
 * header the serve protocol deliberately OMITS on memoized steady-state replies.
 * So here nothing is a fixture: a real keeperd boots fully sandboxed, and the
 * shipped {@link isCaughtUpFrame} (imported from the restart CLI, the exact
 * consumer) is asserted to AGREE with both live frame shapes off the real wire.
 *
 * Runs behind the `slow-daemon` named gate only (`bun run test:slow-daemon`);
 * never a correctness gate. See `test/helpers/daemon-smoke-harness.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isCaughtUpFrame } from "../../cli/restart";
import {
  isProcessAlive,
  pollUntilCaughtUp,
  probeServeFrame,
  runScenario,
  type SandboxedDaemon,
  type ServeFrame,
} from "../helpers/daemon-smoke-harness";
import { retryUntil } from "../helpers/retry-until";

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
    // restart-verdict defect got wrong. Assert the header is absent from the wire
    // bytes AND from the parsed frame.
    expect(frame.boot).toBeUndefined();
    expect(observations.steadyStateRaw).not.toContain("boot");
    // The shipped consumer must read a header-less result as caught up.
    expect(isCaughtUpFrame(frame)).toBe(true);
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
