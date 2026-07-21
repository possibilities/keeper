import { describe, expect, test } from "bun:test";
import {
  type LaunchHandleDeps,
  launchToResolvedHandle,
} from "../src/agent/launch-handle";
import { main } from "../src/agent/main";
import type { TmuxCommandResult } from "../src/agent/tmux-launch";
import {
  awaitProviderLegGrant,
  PROVIDER_LEG_GATE_ENV,
  PROVIDER_LEG_LAUNCH_ID_ENV,
  PROVIDER_LEG_LAUNCHER_PID_ENV,
  PROVIDER_LEG_LAUNCHER_START_TIME_ENV,
  PROVIDER_LEG_SHIM_PROCESS_TITLE,
  PROVIDER_LEG_WRAPPER_ATTEMPT_ENV,
  PROVIDER_LEG_WRAPPER_JOB_ID_ENV,
} from "../src/birth-record";
import { isBareShellCommand } from "../src/reconcile-core";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

const OWNER_ENV = {
  [PROVIDER_LEG_GATE_ENV]: "1",
  [PROVIDER_LEG_LAUNCH_ID_ENV]: "leg-launch-1",
  [PROVIDER_LEG_WRAPPER_JOB_ID_ENV]: "work::fn-1300.2",
  [PROVIDER_LEG_WRAPPER_ATTEMPT_ENV]: "42",
  [PROVIDER_LEG_LAUNCHER_PID_ENV]: "900",
  [PROVIDER_LEG_LAUNCHER_START_TIME_ENV]: "darwin:Wed Jul  3 12:00:00 2026",
};

function tmuxDeps(env: NodeJS.ProcessEnv, calls: string[][]): LaunchHandleDeps {
  return {
    env,
    cwd: "/repo",
    tmuxBin: "tmux",
    launcherStateDir: "/tmp/keeper-provider-leg-test",
    launcherArgvPrefix: ["/bun", "/keeper.ts", "agent"],
    randomUuid: () => "11111111-1111-1111-1111-111111111111",
    probeStartTime: () => "darwin:Wed Jul  3 12:00:00 2026",
    runTmuxCommand: (cmd): TmuxCommandResult => {
      calls.push(cmd);
      if (cmd.includes("has-session")) {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      if (cmd.includes("new-session")) {
        return {
          exitCode: 0,
          stdout: "keeper agent\x01@1\x01%1\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    now: () => 0,
    writeErr: () => {},
  };
}

describe("wrapped provider launch admission", () => {
  test("a wrapped launch missing its owner tuple aborts before tmux spawn", () => {
    const calls: string[][] = [];
    const result = launchToResolvedHandle({
      deps: tmuxDeps({ KEEPER_WRAPPED_CELL: "gpt::high" }, calls),
      agent: "pi",
      prompt: "work",
      posture: {},
      stopTimeoutMs: null,
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a malformed wrapped owner aborts before tmux spawn", () => {
    const calls: string[][] = [];
    const result = launchToResolvedHandle({
      deps: tmuxDeps(
        {
          KEEPER_WRAPPED_CELL: "gpt::high",
          KEEPER_JOB_ID: " owner with spaces ",
          KEEPER_DISPATCH_ATTEMPT_ID: "9007199254740992",
        },
        calls,
      ),
      agent: "pi",
      prompt: "work",
      posture: {},
      stopTimeoutMs: null,
    });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a valid owner is carried to the inert pane and wrapper-only markers are cleared", () => {
    const calls: string[][] = [];
    const result = launchToResolvedHandle({
      deps: tmuxDeps(
        {
          KEEPER_WRAPPED_CELL: "gpt::high",
          KEEPER_WRAPPED_ENVELOPE: "/tmp/envelope",
          KEEPER_JOB_ID: "",
          CLAUDE_CODE_SESSION_ID: "work::fn-1300.2",
          KEEPER_DISPATCH_ATTEMPT_ID: "42",
        },
        calls,
      ),
      agent: "pi",
      prompt: "work",
      posture: {},
      stopTimeoutMs: null,
    });
    expect(result.ok).toBe(true);
    const create = calls.find((cmd) => cmd.includes("new-session"));
    expect(create).toBeDefined();
    expect(create).toContain(`${PROVIDER_LEG_GATE_ENV}=1`);
    expect(create).toContain(
      `${PROVIDER_LEG_WRAPPER_JOB_ID_ENV}=work::fn-1300.2`,
    );
    expect(create).toContain(`${PROVIDER_LEG_WRAPPER_ATTEMPT_ENV}=42`);
    expect(create).toContain("KEEPER_WRAPPED_CELL=");
    expect(create).toContain("KEEPER_DISPATCH_ATTEMPT_ID=");
  });
});

describe("provider shim pre-exec gate", () => {
  test("promotion failure exits before provider spawn or grant wait", async () => {
    const h = makeHarness({
      argv: ["pi", "--x-no-confirm", "work"],
      rawArgv: true,
      env: OWNER_ENV,
    });
    let waited = false;
    h.deps.emitBirthRecord = () => {
      throw new Error("promotion failed");
    };
    h.deps.awaitProviderLegGrantFn = async () => {
      waited = true;
      return "granted";
    };
    const priorTitle = process.title;
    try {
      expect(await expectExit(main(h.deps))).toBe(1);
    } finally {
      process.title = priorTitle;
    }
    expect(waited).toBe(false);
    expect(h.spawned).toEqual([]);
  });

  test("daemon-down timeout holds the shim inert, retires its own birth, and exits without paid work", async () => {
    const h = makeHarness({
      argv: ["pi", "--x-no-confirm", "work"],
      rawArgv: true,
      env: OWNER_ENV,
    });
    const retired: string[] = [];
    h.deps.awaitProviderLegGrantFn = async () => "timeout";
    h.deps.retireBirthRecordFn = (p) => retired.push(p);
    const priorTitle = process.title;
    try {
      expect(await expectExit(main(h.deps))).toBe(1);
    } finally {
      process.title = priorTitle;
    }
    expect(h.birthRecords).toHaveLength(1);
    expect(h.spawned).toEqual([]);
    // A dead-at-gate leg settles its OWN promoted birth record so the ~5min
    // stuck-birth GC never mints a fossil for it.
    expect(retired).toEqual([h.birthRecords[0]?.intentPath]);
  });

  test("a structural admission refusal parks terminal — no exec, and settles its own birth", async () => {
    const h = makeHarness({
      argv: ["pi", "--x-no-confirm", "work"],
      rawArgv: true,
      env: OWNER_ENV,
    });
    const retired: string[] = [];
    // `refused` is the daemon's positive terminal-deny signal (the promoted birth
    // was cleared without a grant). The shim must park terminally, never exec.
    h.deps.awaitProviderLegGrantFn = async () => "refused";
    h.deps.retireBirthRecordFn = (p) => retired.push(p);
    h.deps.execProviderLegFn = () => {
      throw new Error("exec must not be reached on a refusal");
    };
    const priorTitle = process.title;
    try {
      expect(await expectExit(main(h.deps))).toBe(1);
    } finally {
      process.title = priorTitle;
    }
    expect(h.spawned).toEqual([]);
    expect(retired).toEqual([h.birthRecords[0]?.intentPath]);
  });

  test("a grant reaches only the pid-preserving exec seam", async () => {
    const h = makeHarness({
      argv: ["pi", "--x-no-confirm", "work"],
      rawArgv: true,
      env: OWNER_ENV,
    });
    h.deps.awaitProviderLegGrantFn = async () => "granted";
    const execCapture: { command: string[] | null } = { command: null };
    h.deps.execProviderLegFn = (command) => {
      execCapture.command = command;
      throw new Error("exec-seam");
    };
    const priorTitle = process.title;
    try {
      await expect(main(h.deps)).rejects.toThrow("exec-seam");
    } finally {
      process.title = priorTitle;
    }
    expect(execCapture.command?.[0]).toBe("/fake-home/.local/bin/pi");
    expect(h.spawned).toEqual([]);
  });

  test("the bounded poll returns a timeout while the birth record persists (transient re-wait, no early exit)", async () => {
    let now = 0;
    let consumes = 0;
    const verdict = await awaitProviderLegGrant(
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        consume: () => {
          consumes += 1;
          return false;
        },
        // The daemon keeps the birth record while it re-probes a transient lag, so
        // the shim RE-WAITS the same handle to the deadline rather than bailing.
        birthPresent: () => true,
      },
      125,
    );
    expect(verdict).toBe("timeout");
    expect(consumes).toBeGreaterThan(1);
  });

  test("a retired birth record with no grant is a positive terminal refusal — the poll stops early", async () => {
    let now = 0;
    let polls = 0;
    const verdict = await awaitProviderLegGrant(
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
          polls += 1;
        },
        consume: () => false,
        // The daemon cleared the promoted birth without granting: a structural
        // deny that can never heal by waiting.
        birthPresent: () => false,
      },
      10_000,
    );
    expect(verdict).toBe("refused");
    // Stops on the FIRST observation — never burns the (30s-scale) timeout.
    expect(polls).toBe(0);
  });

  test("a grant observed in the same tick a birth is retired still reads as granted", async () => {
    let now = 0;
    const verdict = await awaitProviderLegGrant(
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
        // consume() is checked first, so the daemon's write-grant-then-retire order
        // never lets the retire window be misread as a refusal.
        consume: () => true,
        birthPresent: () => false,
      },
      125,
    );
    expect(verdict).toBe("granted");
  });

  test("the shim command signature is never classified as a parked shell", () => {
    expect(isBareShellCommand(PROVIDER_LEG_SHIM_PROCESS_TITLE)).toBe(false);
  });
});
