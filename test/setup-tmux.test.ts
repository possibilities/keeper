import { describe, expect, test } from "bun:test";
import {
  buildDashNewSessionArgs,
  buildDashServerIdentityArgs,
  buildDashSplitArgs,
  buildHasSessionArgs,
  buildKillDashServerArgs,
  buildKillSessionArgs,
  buildListPanesArgs,
  buildListSessionsArgs,
  buildSelectLayoutArgs,
  buildSelectPaneArgs,
  buildSetMainPaneWidthArgs,
  buildSourceShellConfArgs,
  buildTabsRestoreArgv,
  buildWorkNewSessionArgs,
  DASH_SUB_PANES,
  type DashServerRecovery,
  dashPaneArgv,
  dashTmux,
  type GuardFs,
  guardConfLink,
  guardConfSource,
  HELP,
  isBusyCommand,
  isInsideDashServer,
  isRestoreSessionSkeleton,
  main,
  notesConfLink,
  notesConfSource,
  parseBusyPanes,
  parseDashServerIdentity,
  type RestoreOffer,
  type RestoreOfferBundle,
  type RestoreRetryStore,
  readMirrorJobIds,
  renderBusyTable,
  renderRestoreOutcome,
  resolveDashSize,
  SETUP_TMUX_COMMAND_TIMEOUT_MS,
  SETUP_TMUX_NEW_SESSION_TIMEOUT_MS,
  SETUP_TMUX_RESTORE_TIMEOUT_MS,
  type SyncSpawnFn,
  type SyncSpawnResult,
  selectionToOfferBundle,
  setupTmuxSpawnTimeoutMs,
  shellConfLink,
  shellConfSource,
  sweepBusyPanes,
} from "../cli/setup-tmux";
import { TABS_EXIT_PARTIAL_FAILURE } from "../cli/tabs";
import type { GenerationSummary } from "../src/restore-set";
import type { RestoreSelection } from "../src/tabs-core";
import { keeperTmuxSessionCwd } from "../src/tmux-session-cwd";

const HOME = keeperTmuxSessionCwd(process.env);

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
    expect(dashPaneArgv("git")).toHaveLength(3);
  });

  test("the dashboard has no usage pane", () => {
    expect(DASH_SUB_PANES).toEqual(["autopilot", "jobs", "git"]);
    expect(DASH_SUB_PANES).not.toContain("usage" as never);
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

describe("dash server identity and self-teardown guard", () => {
  test("identity probe stays on the dedicated server", () => {
    expect(buildDashServerIdentityArgs()).toEqual([
      "tmux",
      "-L",
      "dash",
      "display-message",
      "-p",
      "#{pid} #{socket_path}",
    ]);
  });

  test("parses only a positive pid and absolute dash socket", () => {
    expect(
      parseDashServerIdentity("4242 /private/tmp/tmux-501/dash\n"),
    ).toEqual({ pid: 4242, socketPath: "/private/tmp/tmux-501/dash" });
    expect(parseDashServerIdentity("1 /private/tmp/tmux-501/dash")).toBeNull();
    expect(parseDashServerIdentity("4242 relative/dash")).toBeNull();
    expect(
      parseDashServerIdentity("4242 /private/tmp/tmux-501/default"),
    ).toBeNull();
  });

  test("detects only the current dash socket from TMUX", () => {
    expect(isInsideDashServer("/private/tmp/tmux-501/dash,4242,0")).toBe(true);
    expect(isInsideDashServer("/private/tmp/tmux-501/default,4242,0")).toBe(
      false,
    );
    expect(isInsideDashServer(undefined)).toBe(false);
  });
});

describe("bounded setup spawn policy", () => {
  test("bounds ordinary tmux, server creation, and restore separately", () => {
    expect(setupTmuxSpawnTimeoutMs(["tmux", "list-sessions"])).toBe(
      SETUP_TMUX_COMMAND_TIMEOUT_MS,
    );
    expect(setupTmuxSpawnTimeoutMs(buildDashNewSessionArgs(200, 50))).toBe(
      SETUP_TMUX_NEW_SESSION_TIMEOUT_MS,
    );
    expect(
      setupTmuxSpawnTimeoutMs(buildTabsRestoreArgv("work", "generation")),
    ).toBe(SETUP_TMUX_RESTORE_TIMEOUT_MS);
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
      HOME,
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
      HOME,
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
      HOME,
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

describe("restore session skeleton classification", () => {
  test("accepts exactly one known shell pane", () => {
    expect(isRestoreSessionSkeleton("work\t0\tzsh\tshell\n")).toBe(true);
    expect(isRestoreSessionSkeleton("work\t0\t-bash\tshell\n")).toBe(true);
  });

  test("rejects active, multi-pane, empty, and malformed sweeps", () => {
    expect(isRestoreSessionSkeleton("work\t0\tcodex\tdotfiles-102\n")).toBe(
      false,
    );
    expect(
      isRestoreSessionSkeleton("work\t0\tzsh\tshell\nwork\t1\tzsh\tanother\n"),
    ).toBe(false);
    expect(isRestoreSessionSkeleton("")).toBe(false);
    expect(isRestoreSessionSkeleton("work 0 zsh shell\n")).toBe(false);
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

  test("a timed-out sweep is never misclassified as an absent safe-to-kill session", () => {
    const spawn: SyncSpawnFn = () => ({
      exitCode: null,
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      exitedDueToTimeout: true,
    });
    expect(() => sweepBusyPanes(spawn)).toThrow(
      `command timed out after ${SETUP_TMUX_COMMAND_TIMEOUT_MS}ms`,
    );
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
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
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
        writable: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "isTTY", {
        value: savedStdoutTTY,
        writable: true,
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
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      writable: true,
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
        writable: true,
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
      // Must NOT throw (no exit), must complete setup. The restore offer is
      // stubbed empty — the default reads the live keeper.db and probes the
      // real tmux server, whose latency under load breaches the test timeout.
      await main(["--kill-sessions"], spawn, () => ({
        offers: {},
        ambiguous: false,
        eligible: [],
      }));
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
// buildTabsRestoreArgv — the subprocess invocation contract. setup-tmux owns no
// ExecBackend; it spawns `keeper tabs restore --apply` (the subprocess owns
// ExecBackend). --allow-empty makes the count/apply race a benign restored-0.
// ---------------------------------------------------------------------------

describe("buildTabsRestoreArgv", () => {
  test("spawns keeper tabs restore --apply --allow-empty --session <name> --generation <id>", () => {
    expect(buildTabsRestoreArgv("work", "12345")).toEqual([
      "keeper",
      "tabs",
      "restore",
      "--apply",
      "--allow-empty",
      "--session",
      "work",
      "--generation",
      "12345",
    ]);
  });

  test("null/empty generation ⇒ no --generation flag (child auto-picks on the fallback)", () => {
    expect(buildTabsRestoreArgv("work", null)).toEqual([
      "keeper",
      "tabs",
      "restore",
      "--apply",
      "--allow-empty",
      "--session",
      "work",
    ]);
    expect(buildTabsRestoreArgv("work", "")).not.toContain("--generation");
  });
});

// ---------------------------------------------------------------------------
// renderRestoreOutcome — the ONE authoritative outcome line per session.
// ---------------------------------------------------------------------------

const okResult = (stdout: string): SyncSpawnResult => ({
  exitCode: 0,
  stdout: Buffer.from(stdout),
  stderr: Buffer.from(""),
});
const failResult = (
  exitCode: number | null,
  stderr: string,
): SyncSpawnResult => ({
  exitCode,
  stdout: Buffer.from(""),
  stderr: Buffer.from(stderr),
});

describe("renderRestoreOutcome", () => {
  const offer: RestoreOffer = {
    count: 3,
    generationId: "999",
    generationLastTs: 1000,
    generationMaxPanes: 9,
  };

  test("exit 0 ⇒ success line with restored count (parsed) + generation context", () => {
    const line = renderRestoreOutcome(
      "work",
      offer,
      okResult("# summary: restored=3 failed=0\n"),
      1000 + 120,
    );
    expect(line).toBe(
      "keeper setup-tmux: 'work' restored 3 agent(s) from generation 999 (2m ago)",
    );
  });

  test("exit 0 with restored=0 (candidate went live between offer and apply) ⇒ benign, not a failure", () => {
    const line = renderRestoreOutcome(
      "work",
      offer,
      okResult("# summary: restored=0 failed=0\n"),
      1000,
    );
    expect(line).toContain("restored 0 agent(s)");
    expect(line).not.toContain("FAILED");
  });

  test("non-zero exit ⇒ FAILED line carrying the verbatim child stderr (autopilot-gate refusal)", () => {
    const gateRefusal =
      "keeper tabs: autopilot is UNPAUSED — refusing to --apply ...";
    const line = renderRestoreOutcome(
      "work",
      offer,
      failResult(1, gateRefusal),
    );
    expect(line).toBe(
      `keeper setup-tmux: 'work' restore FAILED (exit 1): ${gateRefusal}`,
    );
  });

  test("signal kill (exitCode null) ⇒ FAILED (exit signal)", () => {
    const line = renderRestoreOutcome(
      "work",
      offer,
      failResult(null, "killed"),
    );
    expect(line).toContain("restore FAILED (exit signal): killed");
  });

  test("timeout metadata ⇒ FAILED (exit timeout)", () => {
    const line = renderRestoreOutcome("work", offer, {
      ...failResult(null, "command timed out"),
      exitedDueToTimeout: true,
    });
    expect(line).toContain("restore FAILED (exit timeout): command timed out");
  });

  test("no picked generation (fallback offer) ⇒ success line without generation context", () => {
    const fallbackOffer: RestoreOffer = {
      count: 2,
      generationId: null,
      generationLastTs: null,
      generationMaxPanes: null,
    };
    const line = renderRestoreOutcome(
      "work",
      fallbackOffer,
      okResult("# summary: restored=2 failed=0\n"),
    );
    expect(line).toBe("keeper setup-tmux: 'work' restored 2 agent(s)");
  });

  test("exit 0 with unverified>0 ⇒ success line carries an unverified note (a launched-unverified warn is not a failure)", () => {
    const line = renderRestoreOutcome(
      "work",
      offer,
      okResult("# summary: restored=3 failed=0 unverified=1\n"),
      1000 + 120,
    );
    expect(line).toBe(
      "keeper setup-tmux: 'work' restored 3 agent(s) (unverified=1) from generation 999 (2m ago)",
    );
  });

  test("TABS_EXIT_PARTIAL_FAILURE ⇒ PARTIAL line with the restored/failed/unverified breakdown from the child summary", () => {
    const line = renderRestoreOutcome(
      "work",
      offer,
      {
        exitCode: TABS_EXIT_PARTIAL_FAILURE,
        stdout: Buffer.from("# summary: restored=2 failed=1 unverified=1\n"),
        stderr: Buffer.from(""),
      },
      1000 + 120,
    );
    expect(line).toBe(
      `keeper setup-tmux: 'work' restore PARTIAL (exit ${TABS_EXIT_PARTIAL_FAILURE}): restored=2 failed=1 unverified=1 from generation 999 (2m ago)`,
    );
  });
});

// ---------------------------------------------------------------------------
// main() restore-last-session offer. The offer must be computed BEFORE any
// session-creating call (rebuildDash/ensureWorkSessions mint a new server =
// new generation) and fire ONLY when `work` is absent AND count>0 AND TTY.
// ---------------------------------------------------------------------------

/** True iff `calls` contains a `keeper tabs restore --apply` spawn for `session`
 *  (the `--generation` suffix is offer-dependent, so it is ignored here). */
const spawnedRestoreFor = (calls: string[][], session: string): boolean =>
  calls.some(
    (c) =>
      c[0] === "keeper" &&
      c[1] === "tabs" &&
      c[2] === "restore" &&
      c.includes("--apply") &&
      c[c.indexOf("--session") + 1] === session,
  );
/** True iff ANY `keeper tabs restore` argv (work) was spawned. */
const spawnedAnyRestore = (calls: string[][]): boolean =>
  ["work"].some((s) => spawnedRestoreFor(calls, s));

/** Build a per-session offer with picked-generation context (id/age/panes). */
const offerFor = (count: number): RestoreOffer => ({
  count,
  generationId: "777",
  generationLastTs: 1000,
  generationMaxPanes: 9,
});

/**
 * Spawn stub for the offer path: `has-session` returns the per-session exit from
 * `presentExits` (key = session name; default ABSENT/exit 1), so each work
 * session's presence is controllable independently of the others. The
 * `keeper tabs restore` spawn returns `restoreResult` (default exit 0 with a
 * `restored=<count>` summary). Every other spawn succeeds, with
 * new-session/split-window emitting a pane id so rebuildDash completes. Records
 * into `calls`.
 */
function makeOfferStub(
  presentExits: Record<string, number>,
  calls: string[][],
  restoreResult?: SyncSpawnResult,
  paneOutputs: Record<string, string> = {},
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
    if (cmd[1] === "list-panes") {
      const target = (cmd[4] ?? "").replace(/^=/, "");
      return {
        exitCode: 0,
        stdout: Buffer.from(paneOutputs[target] ?? ""),
        stderr: Buffer.from(""),
      };
    }
    if (cmd[0] === "keeper" && cmd[1] === "tabs" && cmd[2] === "restore") {
      return (
        restoreResult ?? {
          exitCode: 0,
          stdout: Buffer.from("# summary: restored=1 failed=0\n"),
          stderr: Buffer.from(""),
        }
      );
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

/** Run main() with stdin/stdout TTY pinned and a fake EOF/typed stdin, capturing
 *  every stdout write. `answer` of "" ⇒ EOF (confirm → false). `offers` is the
 *  injected per-session restore-offer map. Returns the captured stdout writes so
 *  a test can assert the prompt + outcome lines. */
function memoryRetryStore(
  initial: Record<string, RestoreOffer> = {},
): RestoreRetryStore {
  let state = { ...initial };
  return {
    read: () => ({ ...state }),
    mark: (offers) => {
      state = { ...state, ...offers };
    },
    clear: (sessions) => {
      state = Object.fromEntries(
        Object.entries(state).filter(
          ([session]) => !sessions.includes(session),
        ),
      );
    },
  };
}

async function runWithTTY(opts: {
  spawn: SyncSpawnFn;
  offers: Record<string, RestoreOffer>;
  tty: boolean;
  answer: string;
  /** Multi-prompt input (picker choice THEN confirm y/N); overrides `answer`. */
  answers?: string[];
  retryStore?: RestoreRetryStore;
  /** Force the escalate-or-refuse path; `eligible` is the picker menu. */
  ambiguous?: boolean;
  eligible?: GenerationSummary[];
  /** Offers returned when the picker re-resolves an explicit generation id. */
  pickedOffers?: Record<string, RestoreOffer>;
}): Promise<string[]> {
  const savedStdin = process.stdin;
  const savedStdinTTY = process.stdin.isTTY;
  const savedStdoutTTY = process.stdout.isTTY;
  const savedOut = process.stdout.write;
  const writes: string[] = [];

  const { Readable } = await import("node:stream");
  // Each line resolves one rl.question in order; [] (EOF) resolves via "close".
  const inputLines = opts.answers ?? (opts.answer === "" ? [] : [opts.answer]);
  const fakeStdin = Readable.from(
    inputLines.length === 0 ? [] : [inputLines.map((l) => `${l}\n`).join("")],
  ) as unknown as typeof process.stdin;
  Object.defineProperty(process, "stdin", {
    value: fakeStdin,
    configurable: true,
  });
  Object.defineProperty(process.stdin, "isTTY", {
    value: opts.tty,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: opts.tty,
    writable: true,
    configurable: true,
  });
  process.stdout.write = ((s: string | Uint8Array) => {
    writes.push(String(s));
    return true;
  }) as typeof process.stdout.write;

  try {
    const restoreOfferFake = (
      generationId?: string | null,
    ): RestoreOfferBundle =>
      generationId != null && generationId !== ""
        ? { offers: opts.pickedOffers ?? {}, ambiguous: false, eligible: [] }
        : {
            offers: opts.offers,
            ambiguous: opts.ambiguous ?? false,
            eligible: opts.eligible ?? [],
          };
    await main(
      [],
      opts.spawn,
      restoreOfferFake,
      undefined,
      opts.retryStore ?? memoryRetryStore(),
    );
  } finally {
    Object.defineProperty(process, "stdin", {
      value: savedStdin,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedStdinTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: savedStdoutTTY,
      writable: true,
      configurable: true,
    });
    process.stdout.write = savedOut;
  }
  return writes;
}

describe("main() restore-last-session offer", () => {
  test("work absent + count>0 + TTY + y ⇒ spawns keeper tabs restore for work, synchronously", async () => {
    const calls: string[][] = [];
    // work absent (has-session exits 1, the default).
    const spawn = makeOfferStub({}, calls);
    const writes = await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
      tty: true,
      answer: "y",
    });

    // The offered session spawns its keeper-tabs restore argv, --generation
    // carrying the offer's picked generation (same selection the offer read).
    expect(spawnedRestoreFor(calls, "work")).toBe(true);
    const restoreCall = calls.find(
      (c) => c[0] === "keeper" && c[1] === "tabs" && c[2] === "restore",
    );
    expect(restoreCall?.[restoreCall.indexOf("--generation") + 1]).toBe("777");
    // The outcome line printed synchronously (nothing fire-and-forget).
    expect(writes.some((w) => w.includes("'work' restored"))).toBe(true);
    // Ordering: the has-session absence probe precedes the first
    // session-creating call (dash new-session), so the kill-anchored generation
    // window isn't shifted before the offer/probes are read.
    const newSessionIdx = calls.findIndex((c) => c[1] === "new-session");
    expect(newSessionIdx).toBeGreaterThanOrEqual(0);
    const probeIdx = calls.findIndex(
      (c) => c[1] === "has-session" && c[3] === "=work",
    );
    expect(probeIdx).toBeGreaterThanOrEqual(0);
    expect(newSessionIdx).toBeGreaterThan(probeIdx);
  });

  test("the prompt carries the picked generation's agent count + age (skeleton recognizable)", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    const writes = await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
      tty: true,
      answer: "",
    });
    const prompt = writes.find((w) => w.includes("Restore last-session"));
    expect(prompt).toBeDefined();
    expect(prompt).toContain("work: 2 agent(s)");
    expect(prompt).toContain("ago");
    expect(prompt).toContain("peak 9 pane(s)");
  });

  test("non-zero child exit ⇒ outcome line marked FAILED with the child stderr", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls, {
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("keeper tabs: autopilot is UNPAUSED — refusing"),
    });
    const writes = await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
      tty: true,
      answer: "y",
    });
    const outcome = writes.find((w) => w.includes("'work' restore FAILED"));
    expect(outcome).toBeDefined();
    expect(outcome).toContain("autopilot is UNPAUSED");
  });

  test("accepted restore is marked before apply and remains marked on child failure", async () => {
    const calls: string[][] = [];
    const retryStore = memoryRetryStore();
    const spawn = makeOfferStub({}, calls, {
      exitCode: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("keeper tabs: nope"),
    });
    await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
      tty: true,
      answer: "y",
      retryStore,
    });

    expect(spawnedRestoreFor(calls, "work")).toBe(true);
    expect(retryStore.read().work?.count).toBe(2);
  });

  test("marked retry is offered even when work exists, and success clears it", async () => {
    const calls: string[][] = [];
    const retryStore = memoryRetryStore({ work: offerFor(4) });
    const spawn = makeOfferStub({ work: 0 }, calls, {
      exitCode: 0,
      stdout: Buffer.from("# summary: restored=4 failed=0\n"),
      stderr: Buffer.from(""),
    });
    const writes = await runWithTTY({
      spawn,
      offers: {},
      tty: true,
      answer: "y",
      retryStore,
    });

    expect(spawnedRestoreFor(calls, "work")).toBe(true);
    expect(writes.some((w) => w.includes("'work' restored 4"))).toBe(true);
    expect(retryStore.read().work).toBeUndefined();
  });

  test("declining a marked retry clears the marker", async () => {
    const calls: string[][] = [];
    const retryStore = memoryRetryStore({ work: offerFor(4) });
    const spawn = makeOfferStub({ work: 0 }, calls);
    await runWithTTY({
      spawn,
      offers: {},
      tty: true,
      answer: "",
      retryStore,
    });

    expect(spawnedAnyRestore(calls)).toBe(false);
    expect(retryStore.read().work).toBeUndefined();
  });

  test("work present with an active agent ⇒ no offer, no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({ work: 0 }, calls, undefined, {
      work: "work\t0\tcodex\tkeeper-840\n",
    });
    // count>0 and TTY would otherwise prompt — active content short-circuits.
    await runWithTTY({
      spawn,
      offers: { work: offerFor(5) },
      tty: true,
      answer: "y",
    });
    expect(spawnedAnyRestore(calls)).toBe(false);
  });

  test("work present as one-shell skeleton ⇒ accepted restore still spawns", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({ work: 0 }, calls, undefined, {
      work: "work\t0\tzsh\tshell\n",
    });
    await runWithTTY({
      spawn,
      offers: { work: offerFor(5) },
      tty: true,
      answer: "y",
    });
    expect(spawnedRestoreFor(calls, "work")).toBe(true);
  });

  test("work absent + count>0 + TTY + N (EOF) ⇒ no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
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
      offers: { work: offerFor(0) },
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
      offers: { work: offerFor(3) },
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
      offers: { autopilot: offerFor(4) },
      tty: true,
      answer: "y",
    });
    expect(spawnedRestoreFor(calls, "autopilot")).toBe(false);
    expect(spawnedAnyRestore(calls)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Escalate-or-refuse a CONTESTED auto-pick (the fn-1162 ambiguity gate).
// ---------------------------------------------------------------------------

/** Build a GenerationSummary for picker-menu tests. */
const genSummary = (
  id: string,
  over: Partial<GenerationSummary> = {},
): GenerationSummary => ({
  generation_id: id,
  first_event_id: 1,
  last_event_id: 100,
  snapshot_count: 1,
  first_ts: 1000,
  last_ts: 1000,
  max_pane_count: 3,
  is_current: false,
  degenerate: false,
  restorable: 2,
  ...over,
});

describe("main() ambiguous restore escalate-or-refuse", () => {
  test("ambiguous + TTY ⇒ numbered picker, chosen generation's offers apply", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    // Picker menu of two generations; picking #2 IS the confirmation.
    const writes = await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
      ambiguous: true,
      eligible: [genSummary("111"), genSummary("222")],
      pickedOffers: { work: offerFor(5) },
      tty: true,
      answer: "2",
    });

    // The picker menu rendered both generations, and the picked generation's
    // re-resolved offers drove the actual restore.
    expect(
      writes.some((w) => w.includes("ambiguous last-session restore")),
    ).toBe(true);
    expect(
      writes.some((w) => w.includes("gen 111") && w.includes("gen 222")),
    ).toBe(true);
    expect(spawnedRestoreFor(calls, "work")).toBe(true);
  });

  test("ambiguous picker choice restores into an existing one-shell skeleton", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({ work: 0 }, calls, undefined, {
      work: "work\t0\tzsh\tshell\n",
    });
    await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
      ambiguous: true,
      eligible: [genSummary("111"), genSummary("222")],
      pickedOffers: { work: offerFor(5) },
      tty: true,
      answer: "2",
    });
    expect(spawnedRestoreFor(calls, "work")).toBe(true);
  });

  test("ambiguous + TTY + blank ⇒ abort, restores nothing", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
      ambiguous: true,
      eligible: [genSummary("111"), genSummary("222")],
      tty: true,
      answer: "",
      answers: [""],
    });
    expect(spawnedAnyRestore(calls)).toBe(false);
  });

  test("ambiguous + TTY + skip ⇒ clears retry marker and still provisions", async () => {
    const calls: string[][] = [];
    const retryStore = memoryRetryStore({ work: offerFor(4) });
    const spawn = makeOfferStub({ work: 0 }, calls);
    const writes = await runWithTTY({
      spawn,
      offers: { work: offerFor(2) },
      ambiguous: true,
      eligible: [genSummary("111"), genSummary("222")],
      tty: true,
      answer: "s",
      retryStore,
    });

    expect(spawnedAnyRestore(calls)).toBe(false);
    expect(retryStore.read().work).toBeUndefined();
    expect(spawnedDashKillServer(calls)).toBe(true);
    expect(writes.some((w) => w.includes("work sessions ensured"))).toBe(true);
  });

  test("ambiguous + non-TTY ⇒ visible refusal naming the recovery command, no spawn", async () => {
    const calls: string[][] = [];
    const spawn = makeOfferStub({}, calls);
    const savedErr = process.stderr.write;
    const errWrites: string[] = [];
    process.stderr.write = ((s: string | Uint8Array) => {
      errWrites.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runWithTTY({
        spawn,
        offers: { work: offerFor(2) },
        ambiguous: true,
        eligible: [genSummary("111"), genSummary("222")],
        tty: false,
        answer: "y",
      });
    } finally {
      process.stderr.write = savedErr;
    }
    expect(spawnedAnyRestore(calls)).toBe(false);
    const refusal = errWrites.find((w) => w.includes("refusing an AMBIGUOUS"));
    expect(refusal).toBeDefined();
    expect(errWrites.some((w) => w.includes("keeper tabs restore"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure: selectionToOfferBundle mirror cross-check + readMirrorJobIds.
// ---------------------------------------------------------------------------

const candidate = (
  jobId: string,
  session = "work",
): import("../src/restore-set").RestoreCandidate => ({
  job_id: jobId,
  resume_target: jobId,
  label: jobId,
  window_index: 0,
  cwd: null,
  backend_exec_session_id: session,
  created_at: 1000,
});

const selectionOf = (
  jobIds: string[],
  over: Partial<RestoreSelection> = {},
): RestoreSelection => ({
  candidates: jobIds.map((id) => candidate(id)),
  pickedGeneration: {
    generation_id: "g1",
    last_ts: 1000,
    max_pane_count: 3,
  } as unknown as RestoreSelection["pickedGeneration"],
  eligible: [genSummary("g1")],
  ambiguous: false,
  ...over,
});

describe("selectionToOfferBundle mirror cross-check", () => {
  test("derived cohort disagreeing with a non-empty mirror forces ambiguous", () => {
    const bundle = selectionToOfferBundle(
      selectionOf(["a", "b"]),
      new Set(["a", "c"]),
      true,
    );
    expect(bundle.ambiguous).toBe(true);
  });

  test("derived cohort matching the mirror stays unambiguous", () => {
    const bundle = selectionToOfferBundle(
      selectionOf(["a", "b"]),
      new Set(["b", "a"]),
      true,
    );
    expect(bundle.ambiguous).toBe(false);
  });

  test("an empty mirror never forces ambiguity", () => {
    const bundle = selectionToOfferBundle(
      selectionOf(["a", "b"]),
      new Set<string>(),
      true,
    );
    expect(bundle.ambiguous).toBe(false);
  });

  test("cross-check disabled (explicit --generation pick) never forces ambiguity", () => {
    const bundle = selectionToOfferBundle(
      selectionOf(["a", "b"]),
      new Set(["x", "y"]),
      false,
    );
    expect(bundle.ambiguous).toBe(false);
  });

  test("an already-ambiguous selection stays ambiguous regardless of the mirror", () => {
    const bundle = selectionToOfferBundle(
      selectionOf(["a"], { ambiguous: true }),
      new Set(["a"]),
      true,
    );
    expect(bundle.ambiguous).toBe(true);
  });
});

describe("readMirrorJobIds", () => {
  test("collects every session bucket's agent job ids", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(`${tmpdir()}/keeper-mirror-`);
    const path = `${dir}/restore.json`;
    writeFileSync(
      path,
      JSON.stringify({
        current: {
          sessions: {
            work: { agents: [{ job_id: "a" }, { job_id: "b" }] },
            other: { agents: [{ job_id: "c" }] },
          },
        },
      }),
    );
    expect([...readMirrorJobIds(path)].sort()).toEqual(["a", "b", "c"]);
  });

  test("a missing / unreadable mirror yields an empty set", () => {
    expect(readMirrorJobIds("/no/such/keeper-restore.json").size).toBe(0);
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
  dashRecovery?: DashServerRecovery;
}): Promise<{ stdout: string; stderr: string }> {
  const savedStdinTTY = process.stdin.isTTY;
  const savedStdoutTTY = process.stdout.isTTY;
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  const stdout: string[] = [];
  const stderr: string[] = [];
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    writable: true,
    configurable: true,
  });
  process.stdout.write = ((value: string | Uint8Array) => {
    stdout.push(String(value));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((value: string | Uint8Array) => {
    stderr.push(String(value));
    return true;
  }) as typeof process.stderr.write;
  try {
    await main(
      opts.argv ?? [],
      opts.spawn,
      () => ({ offers: {}, ambiguous: false, eligible: [] }),
      undefined,
      undefined,
      opts.dashRecovery,
    );
  } finally {
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedStdinTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: savedStdoutTTY,
      writable: true,
      configurable: true,
    });
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
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

  test("a timed-out dash kill recovers only through the injected identity owner, then rebuilds", async () => {
    const calls: string[][] = [];
    const recoveryCalls: string[] = [];
    const recorded: Array<{ pid: number; socketPath: string }> = [];
    const dashRecovery: DashServerRecovery = {
      clear: () => recoveryCalls.push("clear"),
      recoverTimedOutServer: () => {
        recoveryCalls.push("recover");
        return { recovered: true, detail: "terminated recorded server" };
      },
      record: (identity) => {
        recoveryCalls.push("record");
        recorded.push(identity);
      },
    };
    const spawn: SyncSpawnFn = (cmd) => {
      calls.push([...cmd]);
      if (cmd.join("\0") === buildKillDashServerArgs().join("\0")) {
        return {
          exitCode: null,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          exitedDueToTimeout: true,
        };
      }
      if (cmd.join("\0") === buildDashServerIdentityArgs().join("\0")) {
        return {
          exitCode: 0,
          stdout: Buffer.from(`${process.pid} /private/tmp/keeper-test/dash\n`),
          stderr: Buffer.from(""),
        };
      }
      if (cmd[1] === "has-session") {
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("no session"),
        };
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(cmd.includes("new-session") ? "%0" : ""),
        stderr: Buffer.from(""),
      };
    };

    const output = await runProvision({ spawn, dashRecovery });
    expect(recoveryCalls).toEqual(["recover", "record"]);
    expect(recorded).toHaveLength(1);
    expect(
      calls.some((cmd) => cmd[1] === "-L" && cmd[3] === "new-session"),
    ).toBe(true);
    expect(output.stderr).toContain("recovered unresponsive dash server");
    expect(output.stdout).toContain("'dash' rebuilt");
  });

  test("a timed-out dash kill with no recorded owner fails open without claiming a rebuild", async () => {
    const calls: string[][] = [];
    const dashRecovery: DashServerRecovery = {
      clear: () => undefined,
      record: () => undefined,
      recoverTimedOutServer: () => ({
        recovered: false,
        detail: "identity mismatch",
      }),
    };
    const spawn: SyncSpawnFn = (cmd) => {
      calls.push([...cmd]);
      if (cmd.join("\0") === buildKillDashServerArgs().join("\0")) {
        return {
          exitCode: null,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          exitedDueToTimeout: true,
        };
      }
      if (cmd[1] === "has-session") {
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("no session"),
        };
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      };
    };

    const output = await runProvision({ spawn, dashRecovery });
    expect(
      calls.some((cmd) => cmd[1] === "-L" && cmd[3] === "new-session"),
    ).toBe(false);
    expect(mintedWorkSession(calls, "work")).toBe(true);
    expect(output.stderr).toContain("identity-guarded recovery refused");
    expect(output.stdout).toContain("'dash' is unavailable");
    expect(output.stdout).not.toContain("'dash' rebuilt");
  });

  test("the macOS tmux ENOENT connection diagnostic is confirmed absence and permits first-run creation", async () => {
    const calls: string[][] = [];
    const spawn: SyncSpawnFn = (cmd) => {
      calls.push([...cmd]);
      if (cmd.join("\0") === buildKillDashServerArgs().join("\0")) {
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from(
            "error connecting to /private/tmp/tmux-501/dash (No such file or directory)\n",
          ),
        };
      }
      if (cmd[1] === "has-session") {
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("no server running"),
        };
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(cmd.includes("new-session") ? "%0" : ""),
        stderr: Buffer.from(""),
      };
    };

    const output = await runProvision({ spawn });
    expect(
      calls.some((cmd) => cmd[1] === "-L" && cmd[3] === "new-session"),
    ).toBe(true);
    expect(output.stdout).toContain("'dash' rebuilt");
  });

  test("an unexpected non-zero kill-server result preserves the lease and issues no further dash commands", async () => {
    const calls: string[][] = [];
    let clearCalls = 0;
    const dashRecovery: DashServerRecovery = {
      clear: () => {
        clearCalls++;
      },
      record: () => undefined,
      recoverTimedOutServer: () => ({ recovered: true, detail: "unused" }),
    };
    const spawn: SyncSpawnFn = (cmd) => {
      calls.push([...cmd]);
      if (cmd.join("\0") === buildKillDashServerArgs().join("\0")) {
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("permission denied"),
        };
      }
      if (cmd[1] === "has-session") {
        return {
          exitCode: 1,
          stdout: Buffer.from(""),
          stderr: Buffer.from("no session"),
        };
      }
      return {
        exitCode: 0,
        stdout: Buffer.from(""),
        stderr: Buffer.from(""),
      };
    };

    const output = await runProvision({ spawn, dashRecovery });
    expect(clearCalls).toBe(0);
    expect(
      calls.some((cmd) => cmd[1] === "-L" && cmd[3] === "new-session"),
    ).toBe(false);
    expect(output.stderr).toContain("permission denied");
    expect(output.stdout).toContain("'dash' is unavailable");
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
    let output: { stdout: string; stderr: string };
    try {
      output = await runProvision({ spawn });
    } finally {
      process.exit = savedExit;
    }
    // Never exited (no process.exit(1) from the dash failure).
    expect(exited).toBe(false);
    // work still provisioned despite the dash failure, without a false rebuild
    // success claim.
    expect(mintedWorkSession(calls, "work")).toBe(true);
    expect(output.stdout).toContain("'dash' is unavailable");
    expect(output.stdout).not.toContain("'dash' rebuilt");
  });
});

// ---------------------------------------------------------------------------
// Keeper tmux drop-in symlink install. All idempotence branches are driven
// through an injected GuardFs seam — NO real fs / ~/.config touch.
// ---------------------------------------------------------------------------

interface GuardFsCalls {
  mkdirp: string[];
  symlink: Array<{ target: string; path: string }>;
}

/**
 * Fake GuardFs: records `mkdirp`/`symlink` calls; `lstatIsSymlink`/`readlink`
 * answer from canned state. `throwOn` makes the named method throw to exercise
 * the fs-error fail-open path for either drop-in.
 */
function makeGuardFs(
  opts: {
    isLink?: boolean | null | ((path: string) => boolean | null);
    readlinkTarget?: string | ((path: string) => string);
    throwOn?: "mkdirp" | "symlink" | "lstat";
  },
  calls: GuardFsCalls,
): GuardFs {
  return {
    lstatIsSymlink: (path) => {
      if (opts.throwOn === "lstat") {
        throw new Error("lstat boom");
      }
      return typeof opts.isLink === "function"
        ? opts.isLink(path)
        : (opts.isLink ?? null);
    },
    readlink: (path) =>
      typeof opts.readlinkTarget === "function"
        ? opts.readlinkTarget(path)
        : (opts.readlinkTarget ?? ""),
    symlink: (target, path) => {
      if (opts.throwOn === "symlink") {
        throw new Error("symlink boom");
      }
      calls.symlink.push({ target, path });
    },
    mkdirp: (path) => {
      if (opts.throwOn === "mkdirp") {
        throw new Error("mkdirp boom");
      }
      calls.mkdirp.push(path);
    },
  };
}

const HOME_FOR_TEST = process.env.HOME ?? "";
const NOTES_LINK = `${HOME_FOR_TEST}/.config/tmux/conf.d/keeper-notes.conf`;
const NOTES_SOURCE = `${HOME_FOR_TEST}/code/keeper/tmux/keeper-notes.conf`;
const SHELL_LINK = `${HOME_FOR_TEST}/.config/tmux/conf.d/keeper-shell.conf`;
const SHELL_SOURCE = `${HOME_FOR_TEST}/code/keeper/tmux/keeper-shell.conf`;
const GUARD_LINK = `${HOME_FOR_TEST}/.config/tmux/conf.d/zz-keeper-guard.conf`;
const GUARD_SOURCE = `${HOME_FOR_TEST}/code/keeper/tmux/keeper-guard.conf`;

/** Run main() (no args) with stdio pinned non-TTY + empty candidate counts so
 *  only the drop-in symlink + provisioning paths run, injecting `guardFs`. */
async function runWithGuardFs(
  guardFs: GuardFs,
  spawnCalls: string[][],
): Promise<void> {
  const spawn = makeOfferStub({ work: 0 }, spawnCalls);
  const savedStdinTTY = process.stdin.isTTY;
  const savedStdoutTTY = process.stdout.isTTY;
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  Object.defineProperty(process.stdin, "isTTY", {
    value: false,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    writable: true,
    configurable: true,
  });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await main(
      [],
      spawn,
      () => ({ offers: {}, ambiguous: false, eligible: [] }),
      guardFs,
    );
  } finally {
    Object.defineProperty(process.stdin, "isTTY", {
      value: savedStdinTTY,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: savedStdoutTTY,
      writable: true,
      configurable: true,
    });
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }
}

describe("tmux drop-in symlink path builders", () => {
  test("sources are the Keeper-owned tmux files", () => {
    expect(notesConfSource()).toBe(NOTES_SOURCE);
    expect(shellConfSource()).toBe(SHELL_SOURCE);
    expect(guardConfSource()).toBe(GUARD_SOURCE);
  });

  test("links use ordinary names and the load-last guard name", () => {
    expect(notesConfLink(HOME_FOR_TEST)).toBe(NOTES_LINK);
    expect(shellConfLink(HOME_FOR_TEST)).toBe(SHELL_LINK);
    expect(guardConfLink(HOME_FOR_TEST)).toBe(GUARD_LINK);
  });

  test("empty HOME yields empty links", () => {
    expect(notesConfLink("")).toBe("");
    expect(shellConfLink("")).toBe("");
    expect(guardConfLink("")).toBe("");
  });

  test("warm-server reload sources the Keeper shell drop-in", () => {
    expect(buildSourceShellConfArgs()).toEqual([
      "tmux",
      "source-file",
      SHELL_SOURCE,
    ]);
  });
});

describe("tmux drop-in symlink idempotence (via main, injected fs)", () => {
  test("shell marker is sourced before work-session provisioning is probed", async () => {
    const calls: GuardFsCalls = { mkdirp: [], symlink: [] };
    const spawnCalls: string[][] = [];
    await runWithGuardFs(makeGuardFs({ isLink: null }, calls), spawnCalls);
    const sourceIndex = spawnCalls.findIndex(
      (argv) => argv.join("\0") === buildSourceShellConfArgs().join("\0"),
    );
    const workProbeIndex = spawnCalls.findIndex(
      (argv) => argv.includes("has-session") && argv.includes("=work"),
    );
    expect(sourceIndex).toBeGreaterThanOrEqual(0);
    expect(workProbeIndex).toBeGreaterThan(sourceIndex);
  });

  test("correct existing symlinks ⇒ no relink", async () => {
    const calls: GuardFsCalls = { mkdirp: [], symlink: [] };
    const guardFs = makeGuardFs(
      {
        isLink: true,
        readlinkTarget: (path) =>
          path === NOTES_LINK
            ? NOTES_SOURCE
            : path === SHELL_LINK
              ? SHELL_SOURCE
              : GUARD_SOURCE,
      },
      calls,
    );
    await runWithGuardFs(guardFs, []);
    expect(calls.mkdirp).toHaveLength(1);
    expect(calls.symlink).toHaveLength(0);
  });

  test("wrong symlinks ⇒ relink all to their Keeper sources", async () => {
    const calls: GuardFsCalls = { mkdirp: [], symlink: [] };
    const guardFs = makeGuardFs(
      { isLink: true, readlinkTarget: "/somewhere/stale.conf" },
      calls,
    );
    await runWithGuardFs(guardFs, []);
    expect(calls.symlink).toEqual([
      { target: NOTES_SOURCE, path: NOTES_LINK },
      { target: SHELL_SOURCE, path: SHELL_LINK },
      { target: GUARD_SOURCE, path: GUARD_LINK },
    ]);
  });

  test("absent links ⇒ create all symlinks", async () => {
    const calls: GuardFsCalls = { mkdirp: [], symlink: [] };
    const guardFs = makeGuardFs({ isLink: null }, calls);
    await runWithGuardFs(guardFs, []);
    expect(calls.mkdirp).toHaveLength(1);
    expect(calls.symlink).toEqual([
      { target: NOTES_SOURCE, path: NOTES_LINK },
      { target: SHELL_SOURCE, path: SHELL_LINK },
      { target: GUARD_SOURCE, path: GUARD_LINK },
    ]);
  });

  test("a real notes file is preserved while the other drop-ins install", async () => {
    const calls: GuardFsCalls = { mkdirp: [], symlink: [] };
    const guardFs = makeGuardFs(
      { isLink: (path) => (path === NOTES_LINK ? false : null) },
      calls,
    );
    await runWithGuardFs(guardFs, []);
    expect(calls.symlink).toEqual([
      { target: SHELL_SOURCE, path: SHELL_LINK },
      { target: GUARD_SOURCE, path: GUARD_LINK },
    ]);
  });

  test("parent missing ⇒ mkdir -p once, then link all", async () => {
    const calls: GuardFsCalls = { mkdirp: [], symlink: [] };
    const guardFs = makeGuardFs({ isLink: null }, calls);
    await runWithGuardFs(guardFs, []);
    expect(calls.mkdirp).toEqual([`${HOME_FOR_TEST}/.config/tmux/conf.d`]);
    expect(calls.symlink).toHaveLength(3);
  });

  test("parent mkdir failure warns and still provisions", async () => {
    const calls: GuardFsCalls = { mkdirp: [], symlink: [] };
    const spawnCalls: string[][] = [];
    const guardFs = makeGuardFs({ throwOn: "mkdirp" }, calls);
    await runWithGuardFs(guardFs, spawnCalls);
    expect(calls.symlink).toHaveLength(0);
    expect(spawnedDashKillServer(spawnCalls)).toBe(true);
  });

  test("per-link symlink failures fail open and main still provisions", async () => {
    const calls: GuardFsCalls = { mkdirp: [], symlink: [] };
    const spawnCalls: string[][] = [];
    const guardFs = makeGuardFs({ isLink: null, throwOn: "symlink" }, calls);
    await runWithGuardFs(guardFs, spawnCalls);
    expect(spawnedDashKillServer(spawnCalls)).toBe(true);
  });
});

describe("HELP mentions the tmux drop-in installs", () => {
  test("names every link and the conf.d-sourcing precondition", () => {
    expect(HELP).toContain("keeper-notes.conf");
    expect(HELP).toContain("keeper-shell.conf");
    expect(HELP).toContain("zz-keeper-guard.conf");
    expect(HELP).toContain("conf.d");
  });
});
