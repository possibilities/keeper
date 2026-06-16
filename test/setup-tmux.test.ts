import { describe, expect, test } from "bun:test";
import {
  buildDashNewSessionArgs,
  buildDashSplitArgs,
  buildHasSessionArgs,
  buildKillSessionArgs,
  buildListPanesArgs,
  buildListSessionsArgs,
  buildRestoreAgentsArgv,
  buildSelectLayoutArgs,
  buildSelectPaneArgs,
  buildSetMainPaneWidthArgs,
  buildWorkNewSessionArgs,
  dashPaneArgv,
  isBusyCommand,
  main,
  parseBusyPanes,
  renderBusyTable,
  resolveDashSize,
  type SyncSpawnFn,
  type SyncSpawnResult,
  sweepBusyPanes,
} from "../cli/setup-tmux";

const HOME = process.env.HOME ?? "";
const KEEPER_DIR = `${HOME}/code/keeper`;

/**
 * Sync-spawn stub matching the `Bun.spawnSync` Buffer shape. Records every
 * spawn into `calls` and returns canned results keyed by `cmd[0]:cmd[1]`,
 * falling back to `cmd[0]`, else exit 0 / empty.
 */
function makeSpawnStub(
  table: Record<
    string,
    { stdout?: string; stderr?: string; exitCode?: number | null }
  >,
  calls: string[][],
): SyncSpawnFn {
  return (cmd): SyncSpawnResult => {
    calls.push([...cmd]);
    const compoundKey = cmd.length >= 2 ? `${cmd[0]}:${cmd[1]}` : cmd[0];
    let canned = table[compoundKey ?? ""] ?? table[cmd[0] ?? ""];
    canned ??= { stdout: "", stderr: "", exitCode: 0 };
    return {
      exitCode: canned.exitCode === undefined ? 0 : canned.exitCode,
      stdout: Buffer.from(canned.stdout ?? ""),
      stderr: Buffer.from(canned.stderr ?? ""),
    };
  };
}

// ---------------------------------------------------------------------------
// Pure argv builders
// ---------------------------------------------------------------------------

describe("dash pane argv triple", () => {
  test("zsh -ic triple — never a single joined shell string", () => {
    expect(dashPaneArgv("board")).toEqual([
      "zsh",
      "-ic",
      "keeper board; exec $SHELL",
    ]);
    // Three elements: shell, flag, script — not one string.
    expect(dashPaneArgv("usage")).toHaveLength(3);
  });
});

describe("kill / has-session / list-sessions builders", () => {
  test("kill-session uses =exact-match target", () => {
    expect(buildKillSessionArgs("dash")).toEqual([
      "tmux",
      "kill-session",
      "-t",
      "=dash",
    ]);
  });

  test("has-session uses =exact-match target", () => {
    expect(buildHasSessionArgs("autopilot")).toEqual([
      "tmux",
      "has-session",
      "-t",
      "=autopilot",
    ]);
  });

  test("list-sessions liveness probe", () => {
    expect(buildListSessionsArgs()).toEqual(["tmux", "list-sessions"]);
  });
});

describe("dash build plan", () => {
  test("new-session is detached, sized via -x/-y, cwd set, prints pane id, board triple after --", () => {
    expect(buildDashNewSessionArgs(200, 50)).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "dash",
      "-c",
      KEEPER_DIR,
      "-x",
      "200",
      "-y",
      "50",
      "-P",
      "-F",
      "#{pane_id}",
      "--",
      "zsh",
      "-ic",
      "keeper board; exec $SHELL",
    ]);
  });

  test("set-option main-pane-width 50% on =dash: window target", () => {
    expect(buildSetMainPaneWidthArgs()).toEqual([
      "tmux",
      "set-option",
      "-w",
      "-t",
      "=dash:",
      "main-pane-width",
      "50%",
    ]);
  });

  test("split-window is detached, prints pane id, carries the sub triple after --", () => {
    expect(buildDashSplitArgs("git")).toEqual([
      "tmux",
      "split-window",
      "-d",
      "-t",
      "=dash:",
      "-c",
      KEEPER_DIR,
      "-P",
      "-F",
      "#{pane_id}",
      "--",
      "zsh",
      "-ic",
      "keeper git; exec $SHELL",
    ]);
  });

  test("select-layout is main-vertical on =dash:", () => {
    expect(buildSelectLayoutArgs()).toEqual([
      "tmux",
      "select-layout",
      "-t",
      "=dash:",
      "main-vertical",
    ]);
  });

  test("window/pane-target builders carry the trailing-colon target form", () => {
    // A bare `=dash` resolves only as a SESSION target; these three commands
    // take window/pane targets and need `=dash:` (exact session, current
    // window) to resolve.
    for (const argv of [
      buildSetMainPaneWidthArgs(),
      buildDashSplitArgs("jobs"),
      buildSelectLayoutArgs(),
    ]) {
      expect(argv[argv.indexOf("-t") + 1]).toBe("=dash:");
    }
  });

  test("select-pane targets a captured pane id (not positional)", () => {
    expect(buildSelectPaneArgs("%7")).toEqual([
      "tmux",
      "select-pane",
      "-t",
      "%7",
    ]);
  });
});

describe("work-session mint", () => {
  test("new-session detached, cwd set, KEEPER_TMUX_SESSION stamped via -e", () => {
    expect(buildWorkNewSessionArgs("background")).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "background",
      "-c",
      KEEPER_DIR,
      "-e",
      "KEEPER_TMUX_SESSION=background",
    ]);
  });
});

describe("list-panes sweep argv", () => {
  test("session-scoped, TAB-delimited, window_name LAST", () => {
    expect(buildListPanesArgs("autopilot")).toEqual([
      "tmux",
      "list-panes",
      "-s",
      "-t",
      "=autopilot",
      "-F",
      "#{session_name}\t#{window_index}\t#{pane_current_command}\t#{window_name}",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Busy classification
// ---------------------------------------------------------------------------

describe("isBusyCommand", () => {
  test("known shells are NOT busy (with or without leading dash)", () => {
    for (const sh of ["zsh", "bash", "sh", "fish", "dash"]) {
      expect(isBusyCommand(sh)).toBe(false);
      expect(isBusyCommand(`-${sh}`)).toBe(false);
    }
  });

  test("non-shell foreground commands ARE busy", () => {
    expect(isBusyCommand("nvim")).toBe(true);
    expect(isBusyCommand("claude")).toBe(true);
    expect(isBusyCommand("sleep")).toBe(true);
  });

  test("empty command is not busy", () => {
    expect(isBusyCommand("")).toBe(false);
  });
});

describe("parseBusyPanes", () => {
  test("classifies shell vs non-shell across a canned sweep", () => {
    const sweep = [
      "background\t0\tzsh\tshell-window",
      "background\t1\tnvim\teditor",
      "background\t2\t-bash\tlogin-shell",
    ].join("\n");
    expect(parseBusyPanes(sweep)).toEqual([
      {
        session: "background",
        windowIndex: "1",
        command: "nvim",
        windowName: "editor",
      },
    ]);
  });

  test("embedded TAB in window_name is absorbed by the bounded split", () => {
    const sweep = "foreground\t3\tclaude\tname\twith\ttab";
    expect(parseBusyPanes(sweep)).toEqual([
      {
        session: "foreground",
        windowIndex: "3",
        command: "claude",
        windowName: "name\twith\ttab",
      },
    ]);
  });

  test("empty sweep and malformed lines yield no busy panes", () => {
    expect(parseBusyPanes("")).toEqual([]);
    expect(parseBusyPanes("\n")).toEqual([]);
    expect(parseBusyPanes("too\tfew")).toEqual([]);
  });
});

describe("renderBusyTable", () => {
  test("session:window  name → command", () => {
    expect(
      renderBusyTable([
        {
          session: "autopilot",
          windowIndex: "0",
          command: "claude",
          windowName: "fn-1-x.2",
        },
      ]),
    ).toBe("autopilot:0  fn-1-x.2 → claude");
  });
});

// ---------------------------------------------------------------------------
// Sizing branches
// ---------------------------------------------------------------------------

describe("resolveDashSize", () => {
  const savedTmux = process.env.TMUX;

  test("inside tmux: reads client_width/client_height via display", () => {
    process.env.TMUX = "/tmp/tmux-501/default,1,0";
    const calls: string[][] = [];
    const spawn = makeSpawnStub(
      { "tmux:display": { stdout: "240", exitCode: 0 } },
      calls,
    );
    expect(resolveDashSize(spawn)).toEqual({ width: 240, height: 240 });
    expect(calls.some((c) => c[1] === "display")).toBe(true);
    process.env.TMUX = savedTmux;
  });

  test("outside tmux: falls to tput cols/lines", () => {
    delete process.env.TMUX;
    const calls: string[][] = [];
    const spawn = makeSpawnStub(
      { tput: { stdout: "180", exitCode: 0 } },
      calls,
    );
    expect(resolveDashSize(spawn)).toEqual({ width: 180, height: 180 });
    expect(calls.some((c) => c[0] === "tput")).toBe(true);
    process.env.TMUX = savedTmux;
  });

  test("non-numeric tput output falls to 200x50", () => {
    delete process.env.TMUX;
    const calls: string[][] = [];
    const spawn = makeSpawnStub(
      { tput: { stdout: "not-a-number", exitCode: 0 } },
      calls,
    );
    expect(resolveDashSize(spawn)).toEqual({ width: 200, height: 50 });
    process.env.TMUX = savedTmux;
  });

  test("tput non-zero exit falls to 200x50", () => {
    delete process.env.TMUX;
    const calls: string[][] = [];
    const spawn = makeSpawnStub({ tput: { stdout: "", exitCode: 1 } }, calls);
    expect(resolveDashSize(spawn)).toEqual({ width: 200, height: 50 });
    process.env.TMUX = savedTmux;
  });
});

// ---------------------------------------------------------------------------
// Sweep decision logic
// ---------------------------------------------------------------------------

describe("sweepBusyPanes", () => {
  test("aggregates busy panes across the three work sessions, skips absent", () => {
    const calls: string[][] = [];
    // list-panes returns the same canned table for every session here; the
    // session arg differs but the stub keys on cmd[0]:cmd[1].
    const spawn = makeSpawnStub(
      {
        "tmux:list-panes": {
          stdout: "autopilot\t0\tnvim\tedit",
          exitCode: 0,
        },
      },
      calls,
    );
    const busy = sweepBusyPanes(spawn);
    // Three sessions swept.
    expect(calls.filter((c) => c[1] === "list-panes")).toHaveLength(3);
    expect(busy).toHaveLength(3);
    expect(busy.every((p) => p.command === "nvim")).toBe(true);
  });

  test("non-zero sweep (absent session) contributes no panes", () => {
    const calls: string[][] = [];
    const spawn = makeSpawnStub(
      { "tmux:list-panes": { stdout: "", stderr: "no session", exitCode: 1 } },
      calls,
    );
    expect(sweepBusyPanes(spawn)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// main() --kill-sessions busy-pane gate — the safety-critical call ordering.
// A regression that reorders busy -> TTY-gate -> killAllSessions silently
// tears down the human's live tmux sessions, so the gate is pinned here:
// both refuse branches must process.exit(1) having spawned NO kill argv.
// ---------------------------------------------------------------------------

/** A server-up stub: list-sessions exits 0 and list-panes reports one busy
 *  (nvim) pane per swept session, so the gate engages. Everything else exits
 *  0. Records every spawn into `calls`. */
function makeKillGateStub(calls: string[][]): SyncSpawnFn {
  return makeSpawnStub(
    {
      "tmux:list-sessions": { stdout: "dash: 1 windows", exitCode: 0 },
      "tmux:list-panes": { stdout: "autopilot\t0\tnvim\tedit", exitCode: 0 },
    },
    calls,
  );
}

const KILL_VERBS = new Set(["kill-session", "kill-server"]);
const spawnedAnyKill = (calls: string[][]): boolean =>
  calls.some((c) => c[0] === "tmux" && KILL_VERBS.has(c[1] ?? ""));

describe("main() --kill-sessions busy-pane gate", () => {
  test("non-TTY stdin with busy panes: exits 1, spawns no kill", async () => {
    const calls: string[][] = [];
    const spawn = makeKillGateStub(calls);

    const savedStdinTTY = process.stdin.isTTY;
    const savedStdoutTTY = process.stdout.isTTY;
    const savedExit = process.exit;
    const savedErr = process.stderr.write;
    // Non-TTY stdin is the refuse trigger.
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    let exitCode: number | undefined;
    // process.exit must not return — throw so execution stops at the gate.
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}`);
    }) as typeof process.exit;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      await main(["--kill-sessions"], spawn);
      throw new Error("main() returned without exiting");
    } catch (e) {
      expect(String((e as Error).message)).toBe("__exit_1");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: savedStdinTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: savedStdoutTTY,
        configurable: true,
      });
      process.exit = savedExit;
      process.stderr.write = savedErr;
    }

    expect(exitCode).toBe(1);
    expect(spawnedAnyKill(calls)).toBe(false);
  });

  test("aborted (N) confirmation with busy panes: exits 1, kills nothing", async () => {
    const calls: string[][] = [];
    const spawn = makeKillGateStub(calls);

    const savedStdin = process.stdin;
    const savedStdinTTY = process.stdin.isTTY;
    const savedStdoutTTY = process.stdout.isTTY;
    const savedExit = process.exit;
    const savedErr = process.stderr.write;
    const savedOut = process.stdout.write;

    // TTY on both ends clears the non-TTY refuse, routing into confirm(). A
    // stdin that ends immediately (EOF) resolves confirm() to false via its
    // readline "close" handler — an aborted prompt without a typed "y".
    const { Readable } = await import("node:stream");
    const fakeStdin = Readable.from([]) as unknown as typeof process.stdin;
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}`);
    }) as typeof process.exit;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await main(["--kill-sessions"], spawn);
      throw new Error("main() returned without exiting");
    } catch (e) {
      expect(String((e as Error).message)).toBe("__exit_1");
    } finally {
      Object.defineProperty(process, "stdin", {
        value: savedStdin,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: savedStdoutTTY,
        configurable: true,
      });
      process.exit = savedExit;
      process.stderr.write = savedErr;
      process.stdout.write = savedOut;
    }
    void savedStdinTTY;

    expect(exitCode).toBe(1);
    expect(spawnedAnyKill(calls)).toBe(false);
  });

  test("empty busy sweep proceeds to setup without prompting", async () => {
    const calls: string[][] = [];
    // Server up, but every pane is an idle shell ⇒ no busy panes ⇒ no prompt.
    const spawn = makeSpawnStub(
      {
        "tmux:list-sessions": { stdout: "dash: 1 windows", exitCode: 0 },
        "tmux:list-panes": { stdout: "autopilot\t0\tzsh\tshell", exitCode: 0 },
        // new-session captures a pane id; rebuildDash needs a non-empty one.
        "tmux:new-session": { stdout: "%0", exitCode: 0 },
        "tmux:split-window": { stdout: "%1", exitCode: 0 },
      },
      calls,
    );

    const savedOut = process.stdout.write;
    const writes: string[] = [];
    process.stdout.write = ((s: string | Uint8Array) => {
      writes.push(String(s));
      return true;
    }) as typeof process.stdout.write;

    try {
      // Must NOT throw (no exit), must complete setup.
      await main(["--kill-sessions"], spawn);
    } finally {
      process.stdout.write = savedOut;
    }

    // killAllSessions ran (busy gate passed without a prompt) so a kill argv
    // is present — that is the proceed path, not a refuse.
    expect(spawnedAnyKill(calls)).toBe(true);
    // No busy table was ever rendered to stdout ⇒ no prompt was shown.
    expect(writes.some((w) => w.includes("→"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildRestoreAgentsArgv — the subprocess invocation contract. setup-tmux owns
// no ExecBackend; it spawns this exact argv (the subprocess owns ExecBackend).
// ---------------------------------------------------------------------------

describe("buildRestoreAgentsArgv", () => {
  test("spawns restore-agents --apply --session foreground --last-generation", () => {
    const argv = buildRestoreAgentsArgv();
    expect(argv[0]).toBe("bun");
    expect(argv[1]).toBe(`${KEEPER_DIR}/scripts/restore-agents.ts`);
    expect(argv.slice(2)).toEqual([
      "--apply",
      "--session",
      "foreground",
      "--last-generation",
    ]);
  });
});

// ---------------------------------------------------------------------------
// main() restore-last-session offer. The offer must be computed BEFORE any
// session-creating call (rebuildDash/ensureWorkSessions mint a new server =
// new generation) and fire ONLY when foreground is absent AND count>0 AND TTY.
// ---------------------------------------------------------------------------

const RESTORE_ARGV = buildRestoreAgentsArgv();
const spawnedRestore = (calls: string[][]): boolean =>
  calls.some(
    (c) =>
      c.length === RESTORE_ARGV.length &&
      c.every((tok, i) => tok === RESTORE_ARGV[i]),
  );

/**
 * Spawn stub for the offer path: `has-session` for the `=foreground` target
 * returns `foregroundExit` (so the offer's absence probe is controllable
 * independently of ensureWorkSessions' other has-session probes); every other
 * spawn succeeds, with new-session/split-window emitting a pane id so
 * rebuildDash completes. Records into `calls`.
 */
function makeOfferStub(foregroundExit: number, calls: string[][]): SyncSpawnFn {
  return (cmd): SyncSpawnResult => {
    calls.push([...cmd]);
    if (cmd[1] === "has-session" && cmd[3] === "=foreground") {
      return {
        exitCode: foregroundExit,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      };
    }
    const out =
      cmd[1] === "new-session" ? "%0" : cmd[1] === "split-window" ? "%1" : "";
    return {
      exitCode: 0,
      stdout: Buffer.from(out),
      stderr: Buffer.from(""),
    };
  };
}

/** Run main() with stdin/stdout TTY pinned and a fake EOF/typed stdin, then
 *  restore every patched global. `answer` of "" ⇒ EOF (confirm → false). */
async function runWithTTY(opts: {
  spawn: SyncSpawnFn;
  count: number;
  tty: boolean;
  answer: string;
}): Promise<void> {
  const savedStdin = process.stdin;
  const savedStdinTTY = process.stdin.isTTY;
  const savedStdoutTTY = process.stdout.isTTY;
  const savedOut = process.stdout.write;

  const { Readable } = await import("node:stream");
  // A line of input resolves rl.question; [] (EOF) resolves via "close".
  const fakeStdin = Readable.from(
    opts.answer === "" ? [] : [`${opts.answer}\n`],
  ) as unknown as typeof process.stdin;
  Object.defineProperty(process, "stdin", {
    value: fakeStdin,
    configurable: true,
  });
  Object.defineProperty(process.stdin, "isTTY", {
    value: opts.tty,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: opts.tty,
    configurable: true,
  });
  process.stdout.write = (() => true) as typeof process.stdout.write;

  try {
    await main([], opts.spawn, () => opts.count);
  } finally {
    Object.defineProperty(process, "stdin", {
      value: savedStdin,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedStdinTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: savedStdoutTTY,
      configurable: true,
    });
    process.stdout.write = savedOut;
  }
}

describe("main() restore-last-session offer", () => {
  test("foreground absent + count>0 + TTY + y ⇒ spawns restore-agents", async () => {
    const calls: string[][] = [];
    // foreground absent (has-session exits 1).
    const spawn = makeOfferStub(1, calls);
    await runWithTTY({ spawn, count: 2, tty: true, answer: "y" });

    expect(spawnedRestore(calls)).toBe(true);
    // Ordering: the foreground has-session probe (the offer's absence check)
    // precedes the first session-creating call (dash new-session).
    const probeIdx = calls.findIndex(
      (c) => c[1] === "has-session" && c[3] === "=foreground",
    );
    const newSessionIdx = calls.findIndex((c) => c[1] === "new-session");
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(newSessionIdx).toBeGreaterThan(probeIdx);
  });

  test("foreground absent + count>0 + TTY + N (EOF) ⇒ no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub(1, calls);
    await runWithTTY({ spawn, count: 2, tty: true, answer: "" });
    expect(spawnedRestore(calls)).toBe(false);
  });

  test("foreground present ⇒ no offer, no spawn", async () => {
    const calls: string[][] = [];
    // foreground present (has-session exits 0).
    const spawn = makeOfferStub(0, calls);
    // count>0 and TTY would otherwise prompt — presence must short-circuit.
    await runWithTTY({ spawn, count: 5, tty: true, answer: "y" });
    expect(spawnedRestore(calls)).toBe(false);
  });

  test("zero candidates ⇒ no offer, no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub(1, calls);
    await runWithTTY({ spawn, count: 0, tty: true, answer: "y" });
    expect(spawnedRestore(calls)).toBe(false);
  });

  test("non-TTY ⇒ never auto-restores, no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub(1, calls);
    // count>0 but non-TTY must skip silently (never auto-yes).
    await runWithTTY({ spawn, count: 3, tty: false, answer: "y" });
    expect(spawnedRestore(calls)).toBe(false);
  });
});
