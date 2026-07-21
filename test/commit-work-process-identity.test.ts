import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isHarnessProcessCommand,
  type SessionTerminationResult,
  type TerminationProcessObservation,
  terminateSessionProcess,
} from "../cli/agent";
import type { EnvelopeSink } from "../cli/envelope";
import { type TerminateMainDeps, terminateMain } from "../cli/session";
import type { LoadedTrackedSessionResolution } from "../cli/session-reference";
import type { GitRunner } from "../src/commit-work/git-exec";
import {
  invocationDescendsFrom,
  type ProcessIdentityReader,
  parseDarwinProcessIdentity,
  parseLinuxProcessIdentity,
  recordedProcessIdentity,
} from "../src/commit-work/process-identity";
import {
  discoverCommitWorkSurface,
  type OwnershipClaim,
  type ReleaseRecord,
} from "../src/commit-work/surface";

describe("commit-work invocation process identity", () => {
  test("parses Linux ppid and recycle-safe start time around a hostile comm", () => {
    const fields = [
      "S",
      "42",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
      "14",
      "15",
      "16",
      "17",
      "18",
      "19",
      "777",
    ];
    expect(
      parseLinuxProcessIdentity(`123 (odd ) process) ${fields.join(" ")}\n`),
    ).toEqual({ ppid: 42, startTime: "linux:777" });
    expect(parseLinuxProcessIdentity("malformed")).toBeNull();
  });

  test("parses only the fixed Darwin ps identity row", () => {
    expect(
      parseDarwinProcessIdentity("  42 Tue Jul 14 23:40:31 2026    \n"),
    ).toEqual({
      ppid: 42,
      startTime: "darwin:Tue Jul 14 23:40:31 2026",
    });
    expect(parseDarwinProcessIdentity("42 garbage\n")).toBeNull();
  });

  test("accepts only an exact ancestor pid and start-time pair", async () => {
    const rows = new Map([
      [9000, { ppid: 8000, startTime: "linux:900" }],
      [8000, { ppid: 4242, startTime: "linux:800" }],
      [4242, { ppid: 1, startTime: "linux:100" }],
      [5252, { ppid: 1, startTime: "linux:200" }],
    ]);
    const read: ProcessIdentityReader = (pid) => rows.get(pid) ?? null;

    expect(
      await invocationDescendsFrom(4242, "linux:100", {
        currentPid: 9000,
        read,
      }),
    ).toBe(true);
    expect(
      await invocationDescendsFrom(4242, "linux:wrong", {
        currentPid: 9000,
        read,
      }),
    ).toBe(false);
    expect(
      await invocationDescendsFrom(5252, "linux:200", {
        currentPid: 9000,
        read,
      }),
    ).toBe(false);
  });

  test("classifies only absent or recycled recorded identities as gone", () => {
    const esrch = Object.assign(new Error("gone"), { code: "ESRCH" });
    expect(
      recordedProcessIdentity(42, "linux:1", {
        signalZero: () => {
          throw esrch;
        },
        read: () => {
          throw new Error("must not read an absent pid");
        },
      }),
    ).toBe("gone");
    expect(
      recordedProcessIdentity(42, "linux:1", {
        signalZero: () => {},
        read: () => ({ ppid: 1, startTime: "linux:2" }),
      }),
    ).toBe("gone");
    expect(
      recordedProcessIdentity(42, "linux:1", {
        signalZero: () => {},
        read: () => ({ ppid: 1, startTime: "linux:1" }),
      }),
    ).toBe("matching");
    expect(
      recordedProcessIdentity(42, "linux:1", {
        signalZero: () => {},
        read: () => null,
      }),
    ).toBe("inconclusive");
  });

  test("probe failures, cycles, and depth exhaustion fail closed", async () => {
    expect(
      await invocationDescendsFrom(42, "linux:1", {
        currentPid: 100,
        read: () => null,
      }),
    ).toBe(false);
    expect(
      await invocationDescendsFrom(42, "linux:1", {
        currentPid: 100,
        read: (pid) => ({ ppid: pid === 100 ? 99 : 100, startTime: "x" }),
      }),
    ).toBe(false);
    expect(
      await invocationDescendsFrom(42, "linux:1", {
        currentPid: 100,
        maxDepth: 1,
        read: () => ({ ppid: 42, startTime: "x" }),
      }),
    ).toBe(false);
  });
});

describe("cooperative release binds to recorded process identity", () => {
  const PEER = "11111111-1111-4111-8111-111111111111";
  const HOLDER = "22222222-2222-4222-8222-222222222222";

  const statusGit: GitRunner = async (args) =>
    args[0] === "status"
      ? { code: 0, stdout: "? shared/a.txt\0", stderr: "" }
      : { code: 1, stdout: "", stderr: "" };

  const holderClaim: OwnershipClaim = {
    path: "shared/a.txt",
    sessionId: HOLDER,
    liveness: "live",
    state: "working",
    source: "tool",
    pid: 4242,
    startTime: "linux:100",
  };

  async function adoptedUnder(record: ReleaseRecord): Promise<string[]> {
    const surface = await discoverCommitWorkSurface({
      worktree: "/repo",
      identity: PEER,
      adoptedPaths: ["shared/a.txt"],
      git: statusGit,
      deps: {
        readClaims: () => [holderClaim],
        classifyClaim: (claim) => claim.liveness,
        readReleases: () => [record],
      },
    });
    return surface.adopted;
  }

  test("a release matching the exact pid and start-time relaxes the claim", async () => {
    expect(
      await adoptedUnder({
        sessionId: HOLDER,
        pid: 4242,
        startTime: "linux:100",
        worktree: "/repo",
        paths: new Set(["shared/a.txt"]),
      }),
    ).toEqual(["shared/a.txt"]);
  });

  test("a recycled pid or mismatched start-time never relaxes the claim", async () => {
    for (const [pid, startTime] of [
      [9999, "linux:100"],
      [4242, "linux:999"],
    ] as const) {
      expect(
        await adoptedUnder({
          sessionId: HOLDER,
          pid,
          startTime,
          worktree: "/repo",
          paths: new Set(["shared/a.txt"]),
        }),
      ).toEqual([]);
    }
  });

  test("a peer cannot release the holder's claim by naming the holder's path", async () => {
    expect(
      await adoptedUnder({
        sessionId: PEER,
        pid: 4242,
        startTime: "linux:100",
        worktree: "/repo",
        paths: new Set(["shared/a.txt"]),
      }),
    ).toEqual([]);
  });
});

describe("session terminate process discipline", () => {
  const session = {
    jobId: "job-1",
    state: "stopped",
    harness: "claude" as const,
    pid: 4242,
    startTime: "linux:100",
  };
  const matching: TerminationProcessObservation = {
    identity: "matching",
    command: "/usr/local/bin/claude\0--resume\0session-1",
  };

  test("recognizes only the recorded harness executable", () => {
    expect(isHarnessProcessCommand("/opt/bin/claude\0--resume", "claude")).toBe(
      true,
    );
    expect(isHarnessProcessCommand("/opt/bin/pi --resume x", "pi")).toBe(true);
    expect(isHarnessProcessCommand("node /opt/bin/pi --resume x", "pi")).toBe(
      true,
    );
    expect(isHarnessProcessCommand("/opt/bin/pi --resume x", "claude")).toBe(
      false,
    );
  });

  test("refuses a working session before probing or signaling", async () => {
    let probes = 0;
    const result = await terminateSessionProcess(
      { ...session, state: "working" },
      {
        probe: () => {
          probes += 1;
          return matching;
        },
        signal: () => {
          throw new Error("must not signal");
        },
        nowMs: () => 0,
        sleep: async () => {},
      },
    );
    expect(result).toEqual({ ok: false, reason: "working" });
    expect(probes).toBe(0);
  });

  test("rechecks identity and command before bounded SIGKILL", async () => {
    const signals: string[] = [];
    let now = 0;
    const result = await terminateSessionProcess(session, {
      probe: () => matching,
      signal: (_pid, signal) => signals.push(signal),
      nowMs: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      termGraceMs: 10,
      pollMs: 10,
    });
    expect(result).toEqual({ ok: true, signal: "SIGKILL", exited: false });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("a recycled pid after TERM is never KILLed", async () => {
    const signals: string[] = [];
    let probes = 0;
    let now = 0;
    const result = await terminateSessionProcess(session, {
      probe: () => {
        probes += 1;
        return probes === 1 ? matching : { identity: "gone", command: null };
      },
      signal: (_pid, signal) => signals.push(signal),
      nowMs: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      termGraceMs: 10,
      pollMs: 5,
    });
    expect(result).toEqual({ ok: true, signal: "SIGTERM", exited: true });
    expect(signals).toEqual(["SIGTERM"]);
  });

  test("an unreadable identity or wrong command fails closed", async () => {
    for (const observation of [
      { identity: "inconclusive", command: null },
      { identity: "matching", command: "/usr/bin/python\0agent.py" },
    ] as const) {
      const signals: string[] = [];
      const result = await terminateSessionProcess(session, {
        probe: () => observation,
        signal: (_pid, signal) => signals.push(signal),
        nowMs: () => 0,
        sleep: async () => {},
      });
      expect(result.ok).toBe(false);
      expect(signals).toEqual([]);
    }
  });
});

type RefusalReason = Extract<SessionTerminationResult, { ok: false }>["reason"];

class TerminateExit extends Error {
  constructor(readonly code: number) {
    super(`terminate exited ${code}`);
  }
}

function markerPath(home: string, sessionId: string): string {
  return join(
    home,
    ".local",
    "state",
    "keeper",
    "sessions",
    `${sessionId}.json`,
  );
}

async function withSessionMarker<T>(
  sessionId: string,
  callback: (home: string) => Promise<T>,
): Promise<T> {
  const previousHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "keeper-session-terminate-"));
  const path = markerPath(home, sessionId);
  mkdirSync(join(home, ".local", "state", "keeper", "sessions"), {
    recursive: true,
  });
  writeFileSync(path, JSON.stringify({ session_id: sessionId, kind: "close" }));
  process.env.HOME = home;
  try {
    return await callback(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function resolvedTerminationSession(
  sessionId: string,
): LoadedTrackedSessionResolution {
  return {
    kind: "resolved",
    job: {
      jobId: sessionId,
      harness: "claude",
      state: "stopped",
      pid: 4242,
      startTime: "linux:4242",
    },
  } as LoadedTrackedSessionResolution;
}

async function invokeTerminateMain(
  result: SessionTerminationResult,
): Promise<string> {
  let stdout = "";
  const sink: EnvelopeSink = {
    writeStdout: (value) => {
      stdout += value;
    },
    exit: (code): never => {
      throw new TerminateExit(code);
    },
  };
  const deps: TerminateMainDeps = {
    resolveTrackedCliSession: () => resolvedTerminationSession("dead-session"),
    terminateSessionProcess: async () => result,
    sink,
  };
  try {
    await terminateMain(["dead-session"], deps);
  } catch (err) {
    if (err instanceof TerminateExit) {
      expect(err.code).toBe(result.ok ? 0 : 1);
    } else {
      throw err;
    }
  }
  return stdout;
}

describe("session terminate marker cleanup", () => {
  test("clears the marker after every confirmed-death outcome", async () => {
    for (const result of [
      { ok: true, signal: "SIGTERM", exited: true },
      { ok: true, signal: "SIGKILL", exited: false },
    ] as const) {
      await withSessionMarker("dead-session", async (home) => {
        const output = await invokeTerminateMain(result);
        expect(existsSync(markerPath(home, "dead-session"))).toBe(false);
        expect(JSON.parse(output)).toMatchObject({ ok: true });
      });
    }
  });

  test("retains the marker for every terminate refusal", async () => {
    const reasons: readonly RefusalReason[] = [
      "working",
      "identity_unproven",
      "command_unowned",
      "signal_failed",
    ];
    for (const reason of reasons) {
      await withSessionMarker("dead-session", async (home) => {
        const output = await invokeTerminateMain({ ok: false, reason });
        expect(existsSync(markerPath(home, "dead-session"))).toBe(true);
        expect(JSON.parse(output)).toMatchObject({
          ok: false,
          error: {
            code: `session_${reason}`,
          },
        });
      });
    }
  });
});
