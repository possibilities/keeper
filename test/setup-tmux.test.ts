import { describe, expect, test } from "bun:test";
import {
  buildDashNewSessionArgs,
  buildDashSplitArgs,
  buildHasSessionArgs,
  buildKillDashServerArgs,
  buildKillSessionArgs,
  buildListPanesArgs,
  buildListSessionsArgs,
  buildRestoreAgentsArgv,
  buildSelectLayoutArgs,
  buildSelectPaneArgs,
  buildSetMainPaneWidthArgs,
  buildWorkNewSessionArgs,
  dashPaneArgv,
  dashTmux,
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

  test("dash teardown is EXACTLY tmux -L dash kill-server (never bare)", () => {
    // The safety crux: a bare `kill-server` would destroy the default server
    // where the human's `work` (and the daemon `autopilot`) live. -L dash is a
    // GLOBAL flag, before the subcommand.
    expect(buildKillDashServerArgs()).toEqual([
      "tmux",
      "-L",
      "dash",
      "kill-server",
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

describe("dashTmux helper", () => {
  test("prefixes -L dash as a GLOBAL flag before the subcommand", () => {
    expect(dashTmux("kill-server")).toEqual([
      "tmux",
      "-L",
      "dash",
      "kill-server",
    ]);
    expect(dashTmux("display", "-p")).toEqual([
      "tmux",
      "-L",
      "dash",
      "display",
      "-p",
    ]);
  });
});

describe("dash build plan", () => {
  test("new-session: -L dash global flag, -e TMUX= clears inherited socket, detached, sized, board triple after --", () => {
    expect(buildDashNewSessionArgs(200, 50)).toEqual([
      "tmux",
      "-L",
      "dash",
      "new-session",
      "-d",
      "-s",
      "dash",
      "-c",
      KEEPER_DIR,
      "-e",
      "TMUX=",
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

  test("set-option main-pane-width 50% on =dash: window target, -L dash", () => {
    expect(buildSetMainPaneWidthArgs()).toEqual([
      "tmux",
      "-L",
      "dash",
      "set-option",
      "-w",
      "-t",
      "=dash:",
      "main-pane-width",
      "50%",
    ]);
  });

  test("split-window: -L dash, detached, prints pane id, sub triple after --", () => {
    expect(buildDashSplitArgs("git")).toEqual([
      "tmux",
      "-L",
      "dash",
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

  test("select-layout is main-vertical on =dash:, -L dash", () => {
    expect(buildSelectLayoutArgs()).toEqual([
      "tmux",
      "-L",
      "dash",
      "select-layout",
      "-t",
      "=dash:",
      "main-vertical",
    ]);
  });

  test("every dash builder carries -L dash in global position (right after tmux)", () => {
    for (const argv of [
      buildDashNewSessionArgs(200, 50),
      buildSetMainPaneWidthArgs(),
      buildDashSplitArgs("jobs"),
      buildSelectLayoutArgs(),
      buildSelectPaneArgs("%7"),
      buildKillDashServerArgs(),
    ]) {
      expect(argv.slice(0, 3)).toEqual(["tmux", "-L", "dash"]);
    }
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

  test("select-pane targets a captured pane id (not positional), -L dash", () => {
    expect(buildSelectPaneArgs("%7")).toEqual([
      "tmux",
      "-L",
      "dash",
      "select-pane",
      "-t",
      "%7",
    ]);
  });
});

describe("work-session mint", () => {
  test("new-session detached, cwd set, KEEPER_TMUX_SESSION stamped via -e", () => {
    expect(buildWorkNewSessionArgs("work")).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "work",
      "-c",
      KEEPER_DIR,
      "-e",
      "KEEPER_TMUX_SESSION=work",
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
      "work\t0\tzsh\tshell-window",
      "work\t1\tnvim\teditor",
      "work\t2\t-bash\tlogin-shell",
    ].join("\n");
    expect(parseBusyPanes(sweep)).toEqual([
      {
        session: "work",
        windowIndex: "1",
        command: "nvim",
        windowName: "editor",
      },
    ]);
  });

  test("embedded TAB in window_name is absorbed by the bounded split", () => {
    const sweep = "work\t3\tclaude\tname\twith\ttab";
    expect(parseBusyPanes(sweep)).toEqual([
      {
        session: "work",
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
  test("aggregates busy panes across the two work sessions, skips absent", () => {
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
    // Two sessions swept.
    expect(calls.filter((c) => c[1] === "list-panes")).toHaveLength(2);
    expect(busy).toHaveLength(2);
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

// A kill is either a default-server `kill-session` (c[1]) or the dash-server
// teardown `tmux -L dash kill-server` (now keyed at c[1]==="-L", verb at c[3]).
// The refuse branches must emit NEITHER — the dash kill-server runs only AFTER
// the busy gate passes, so a refuse that emits it is a regression.
const spawnedAnyKill = (calls: string[][]): boolean =>
  calls.some(
    (c) =>
      (c[0] === "tmux" && c[1] === "kill-session") ||
      (c[0] === "tmux" && c[1] === "-L" && c[3] === "kill-server"),
  );

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
    // Dash calls now key on `tmux:-L` (the global flag), so the canned board
    // pane id rides that key; the work-session mint keys on `tmux:new-session`.
    const spawn = makeSpawnStub(
      {
        "tmux:list-sessions": { stdout: "dash: 1 windows", exitCode: 0 },
        "tmux:list-panes": { stdout: "autopilot\t0\tzsh\tshell", exitCode: 0 },
        // Dash new-session/split capture pane ids; rebuildDash needs a
        // non-empty board pane id (kill-server keys here too — harmless).
        "tmux:-L": { stdout: "%0", exitCode: 0 },
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
  test("spawns restore-agents --apply --session <name> --last-generation per session", () => {
    const session = "work";
    const argv = buildRestoreAgentsArgv(session);
    expect(argv[0]).toBe("bun");
    expect(argv[1]).toBe(`${KEEPER_DIR}/scripts/restore-agents.ts`);
    expect(argv.slice(2)).toEqual([
      "--apply",
      "--session",
      session,
      "--last-generation",
    ]);
  });
});

// ---------------------------------------------------------------------------
// main() restore-last-session offer. The offer must be computed BEFORE any
// session-creating call (rebuildDash/ensureWorkSessions mint a new server =
// new generation) and fire ONLY when `work` is absent AND count>0 AND TTY.
// ---------------------------------------------------------------------------

/** True iff `calls` contains the exact restore-agents argv for `session`. */
const spawnedRestoreFor = (calls: string[][], session: string): boolean => {
  const want = buildRestoreAgentsArgv(session);
  return calls.some(
    (c) => c.length === want.length && c.every((tok, i) => tok === want[i]),
  );
};
/** True iff ANY restore-agents argv (any session) was spawned. */
const spawnedAnyRestore = (calls: string[][]): boolean =>
  ["work"].some((s) => spawnedRestoreFor(calls, s));

/**
 * Spawn stub for the offer path: `has-session` returns the per-session exit from
 * `presentExits` (key = session name; default ABSENT/exit 1), so each work
 * session's presence is controllable independently of the others. Every other
 * spawn succeeds, with new-session/split-window emitting a pane id so
 * rebuildDash completes. Records into `calls`.
 */
function makeOfferStub(
  presentExits: Record<string, number>,
  calls: string[][],
): SyncSpawnFn {
  return (cmd): SyncSpawnResult => {
    calls.push([...cmd]);
    if (cmd[1] === "has-session") {
      const target = (cmd[3] ?? "").replace(/^=/, "");
      return {
        exitCode: presentExits[target] ?? 1,
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
 *  restore every patched global. `answer` of "" ⇒ EOF (confirm → false).
 *  `counts` is the injected per-session candidate-count map. */
async function runWithTTY(opts: {
  spawn: SyncSpawnFn;
  counts: Record<string, number>;
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
    await main([], opts.spawn, () => opts.counts);
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
  test("work absent + count>0 + TTY + y ⇒ spawns restore-agents for work", async () => {
    const calls: string[][] = [];
    // work absent (has-session exits 1, the default).
    const spawn = makeOfferStub({}, calls);
    await runWithTTY({
      spawn,
      counts: { work: 2 },
      tty: true,
      answer: "y",
    });

    // The offered session spawns its restore-agents argv.
    expect(spawnedRestoreFor(calls, "work")).toBe(true);
    // Ordering: the has-session absence probe precedes the first
    // session-creating call (dash new-session), so the kill-anchored generation
    // window isn't shifted before the counts/probes are read.
    const newSessionIdx = calls.findIndex((c) => c[1] === "new-session");
    expect(newSessionIdx).toBeGreaterThanOrEqual(0);
    const probeIdx = calls.findIndex(
      (c) => c[1] === "has-session" && c[3] === "=work",
    );
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(newSessionIdx).toBeGreaterThan(probeIdx);
  });

  test("work present ⇒ no offer, no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({ work: 0 }, calls);
    // count>0 and TTY would otherwise prompt — presence must short-circuit.
    await runWithTTY({
      spawn,
      counts: { work: 5 },
      tty: true,
      answer: "y",
    });
    expect(spawnedAnyRestore(calls)).toBe(false);
  });

  test("work absent + count>0 + TTY + N (EOF) ⇒ no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    await runWithTTY({
      spawn,
      counts: { work: 2 },
      tty: true,
      answer: "",
    });
    expect(spawnedAnyRestore(calls)).toBe(false);
  });

  test("absent but count-0 ⇒ dropped, no offer/spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    // work absent but count 0 ⇒ not offered.
    await runWithTTY({
      spawn,
      counts: { work: 0 },
      tty: true,
      answer: "y",
    });
    expect(spawnedRestoreFor(calls, "work")).toBe(false);
  });

  test("non-TTY ⇒ never auto-restores, no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    // count>0 but non-TTY must skip silently (never auto-yes).
    await runWithTTY({
      spawn,
      counts: { work: 3 },
      tty: false,
      answer: "y",
    });
    expect(spawnedAnyRestore(calls)).toBe(false);
  });

  test("autopilot is never offered even when absent with candidates", async () => {
    const calls: string[][] = [];
    // autopilot absent with candidates, but it is excluded from RESTORABLE.
    const spawn = makeOfferStub({}, calls);
    await runWithTTY({
      spawn,
      counts: { autopilot: 4 },
      tty: true,
      answer: "y",
    });
    expect(spawnedRestoreFor(calls, "autopilot")).toBe(false);
    expect(spawnedAnyRestore(calls)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// main() provision / sweep / teardown roles. setup-tmux provisions ONLY `work`;
// `autopilot` is swept-not-created; the dash server is torn down with
// `tmux -L dash kill-server` on EVERY run regardless of --kill-sessions; a dash
// rebuild failure is fail-open.
// ---------------------------------------------------------------------------

/** True iff `calls` contains a default-server `tmux new-session -s <session>`
 *  (NOT the `-L dash` dash mint, which sits at c[1]==="-L"). */
const mintedWorkSession = (calls: string[][], session: string): boolean =>
  calls.some(
    (c) =>
      c[0] === "tmux" &&
      c[1] === "new-session" &&
      c[c.indexOf("-s") + 1] === session,
  );

/** True iff the exact dash teardown argv was spawned. */
const spawnedDashKillServer = (calls: string[][]): boolean =>
  calls.some(
    (c) =>
      c.length === 4 &&
      c[0] === "tmux" &&
      c[1] === "-L" &&
      c[2] === "dash" &&
      c[3] === "kill-server",
  );

/** Run main() with stdout/stdin pinned non-TTY (so the restore offer never
 *  prompts) and the candidate-count injected empty, then restore globals.
 *  `presentExits` controls each session's has-session exit (default ABSENT). */
async function runProvision(opts: {
  spawn: SyncSpawnFn;
  argv?: string[];
}): Promise<void> {
  const savedStdinTTY = process.stdin.isTTY;
  const savedStdoutTTY = process.stdout.isTTY;
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await main(opts.argv ?? [], opts.spawn, () => ({}));
  } finally {
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedStdinTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: savedStdoutTTY,
      configurable: true,
    });
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }
}

describe("main() provision / sweep / teardown roles", () => {
  test("provisions ONLY work; never mints autopilot", async () => {
    const calls: string[][] = [];
    // All sessions absent (has-session default exit 1) so ensureWorkSessions
    // mints whatever it provisions.
    const spawn = makeOfferStub({}, calls);
    await runProvision({ spawn });
    expect(mintedWorkSession(calls, "work")).toBe(true);
    expect(mintedWorkSession(calls, "autopilot")).toBe(false);
  });

  test("present work is left untouched (no new-session for work)", async () => {
    const calls: string[][] = [];
    // work present (has-session exit 0) ⇒ ensureWorkSessions must NOT mint it.
    const spawn = makeOfferStub({ work: 0 }, calls);
    await runProvision({ spawn });
    expect(mintedWorkSession(calls, "work")).toBe(false);
  });

  test("dash kill-server runs even when --kill-sessions is NOT passed", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    await runProvision({ spawn });
    expect(spawnedDashKillServer(calls)).toBe(true);
    // No bare kill-server is ever emitted.
    expect(calls.some((c) => c[0] === "tmux" && c[1] === "kill-server")).toBe(
      false,
    );
  });

  test("the sweep/kill set is [work, autopilot] under --kill-sessions", async () => {
    const calls: string[][] = [];
    // Server up, all panes idle shells ⇒ no busy gate ⇒ killAllSessions runs.
    const spawn = makeSpawnStub(
      {
        "tmux:list-sessions": { stdout: "work: 1 windows", exitCode: 0 },
        "tmux:list-panes": { stdout: "work\t0\tzsh\tshell", exitCode: 0 },
        "tmux:-L": { stdout: "%0", exitCode: 0 },
      },
      calls,
    );
    await runProvision({ spawn, argv: ["--kill-sessions"] });
    const killed = calls
      .filter((c) => c[0] === "tmux" && c[1] === "kill-session")
      .map((c) => c[3]);
    expect(killed).toEqual(["=work", "=autopilot"]);
    // dash is NOT in the default-server kill loop — it is torn down by the
    // dedicated -L dash kill-server.
    expect(killed).not.toContain("=dash");
    // list-panes swept exactly the two sweep/kill sessions.
    expect(calls.filter((c) => c[1] === "list-panes").map((c) => c[4])).toEqual(
      ["=work", "=autopilot"],
    );
  });

  test("a dash rebuild failure is fail-open: warns, still provisions work, exits 0", async () => {
    const calls: string[][] = [];
    let exited = false;
    const savedExit = process.exit;
    process.exit = ((code?: number) => {
      exited = true;
      throw new Error(`__exit_${code}`);
    }) as typeof process.exit;
    // The dash new-session (keyed tmux:-L) fails; rebuildDash throws TmuxError,
    // which main must catch and continue past to ensureWorkSessions. `work` is
    // ABSENT (has-session exit 1) so ensureWorkSessions tries to mint it.
    const spawn: SyncSpawnFn = (cmd): SyncSpawnResult => {
      calls.push([...cmd]);
      if (cmd[1] === "has-session") {
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
        };
      }
      // Every dash call fails (the -L global flag); everything else succeeds.
      const fail = cmd[1] === "-L";
      return {
        exitCode: fail ? 1 : 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(fail ? "no server" : ""),
      };
    };
    try {
      await runProvision({ spawn });
    } finally {
      process.exit = savedExit;
    }
    // Never exited (no process.exit(1) from the dash failure).
    expect(exited).toBe(false);
    // work still provisioned despite the dash failure.
    expect(mintedWorkSession(calls, "work")).toBe(true);
  });
});
