import { describe, expect, test } from "bun:test";
import {
  buildDashNewSessionArgs,
  buildDashSplitArgs,
  buildHasSessionArgs,
  buildKillSessionArgs,
  buildListPanesArgs,
  buildListSessionsArgs,
  buildSelectLayoutArgs,
  buildSelectPaneArgs,
  buildSetMainPaneWidthArgs,
  buildWorkNewSessionArgs,
  dashPaneArgv,
  isBusyCommand,
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
  test("new-session is detached, sized via -x/-y, cwd set, board triple after --", () => {
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
      "--",
      "zsh",
      "-ic",
      "keeper board; exec $SHELL",
    ]);
  });

  test("set-option main-pane-width 50% on =dash window", () => {
    expect(buildSetMainPaneWidthArgs()).toEqual([
      "tmux",
      "set-option",
      "-w",
      "-t",
      "=dash",
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
      "=dash",
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

  test("select-layout is main-vertical on =dash", () => {
    expect(buildSelectLayoutArgs()).toEqual([
      "tmux",
      "select-layout",
      "-t",
      "=dash",
      "main-vertical",
    ]);
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
