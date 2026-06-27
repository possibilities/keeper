/**
 * Pure-function + argv-construction tests for `src/exec-backend.ts`.
 *
 * Coverage:
 *  - Pure tmux argv builders (`buildTmuxHasSessionArgs`,
 *    `buildTmuxNewSessionArgs`, `buildTmuxSelectWindowArgs`,
 *    `buildTmuxSelectPaneArgs`) produce the tmux CLI shape the live spec calls
 *    for.
 *  - `createTmuxPaneOps` — the direct session-agnostic pane ops: `focusPane`
 *    id-based select-window+select-pane, `listPanes` tab-safe sweep + null
 *    degrade, `renameWindow`/`killWindow` `@N`/`%N` targets + TOCTOU no-op.
 *  - The agentwrap launch (keeper's sole launch transport) —
 *    `buildAgentwrapLaunchArgv` (byte-pinned contract invocation),
 *    `parseAgentwrapStdout` (line-scan, schema_version check,
 *    empty/non-JSON/missing-field), `mapAgentwrapExit` (the central
 *    0/1/2/3/4 + timeout exit-map), and `agentwrapLaunch`
 *    (launch→parse→exit-map→outcome, worker-cwd-on-spawn, per-call session).
 *  - `execBackendEnvMeta` returns the tmux env-var names, including the
 *    fall-through for unknown backends.
 *
 * No filesystem or process side effects: every spawn is a stub that returns
 * canned stdout/stderr/exit-code via in-memory streams.
 */

import { expect, test } from "bun:test";
import {
  AGENTBUS_EXEC_SESSION,
  AGENTWRAP_SCHEMA_VERSION,
  AGENTWRAP_TMUX_EXIT,
  agentwrapLaunch,
  buildAgentwrapLaunchArgv,
  buildTmuxHasSessionArgs,
  buildTmuxKillWindowArgs,
  buildTmuxListPanesArgs,
  buildTmuxNewSessionArgs,
  buildTmuxRenameWindowArgs,
  buildTmuxSelectPaneArgs,
  buildTmuxSelectWindowArgs,
  buildTmuxServerPidArgs,
  classifyCloseKind,
  createTmuxPaneOps,
  DEFAULT_EXEC_BACKEND,
  execBackendEnvMeta,
  type LaunchResult,
  localeDefaultedEnv,
  MANAGED_EXEC_SESSION,
  mapAgentwrapExit,
  parseAgentwrapStdout,
  type SpawnFn,
  type SyncProbeFn,
} from "../src/exec-backend";

/**
 * Build a `SpawnFn` stub that records every spawn into `calls` and
 * resolves with canned exit + stdout/stderr from a per-prefix table.
 * The table key matches `cmd[0]:cmd[1]` (e.g. `"tmux:has-session"`,
 * `"tmux:new-window"`), falling back to the bare `cmd[0]`.
 */
function makeSpawnStub(
  table: Record<
    string,
    { stdout?: string; stderr?: string; exitCode?: number }
  >,
  calls: string[][],
): SpawnFn {
  return (cmd, _options) => {
    calls.push([...cmd]);
    const compoundKey = cmd.length >= 2 ? `${cmd[0]}:${cmd[1]}` : cmd[0];
    let canned = table[compoundKey ?? ""];
    if (canned == null) {
      canned = table[cmd[0] ?? ""];
    }
    canned ??= { stdout: "", stderr: "", exitCode: 0 };
    const stdoutText = canned.stdout ?? "";
    const stderrText = canned.stderr ?? "";
    const exitCode = canned.exitCode ?? 0;
    return {
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdoutText).body,
      stderr: new Response(stderrText).body,
      kill: () => {},
    };
  };
}

// ---------------------------------------------------------------------------
// DEFAULT_EXEC_BACKEND — the sole-backend constant
// ---------------------------------------------------------------------------

test("DEFAULT_EXEC_BACKEND is 'tmux'", () => {
  expect(DEFAULT_EXEC_BACKEND).toBe("tmux");
});

// ---------------------------------------------------------------------------
// execBackendEnvMeta — env-var names (T3 hook seam). tmux is the sole backend,
// so every tag (default, explicit, unknown) resolves to the tmux env vars.
// ---------------------------------------------------------------------------

test("execBackendEnvMeta: defaults to DEFAULT_EXEC_BACKEND, returns KEEPER_TMUX_SESSION/TMUX_PANE", () => {
  const meta = execBackendEnvMeta();
  expect(meta.backendType).toBe(DEFAULT_EXEC_BACKEND);
  expect(meta.sessionIdEnvVar).toBe("KEEPER_TMUX_SESSION");
  expect(meta.paneIdEnvVar).toBe("TMUX_PANE");
  expect(meta.paneIdCarrierEnvVar).toBe("KEEPER_TMUX_PANE");
});

test("execBackendEnvMeta: 'tmux' returns KEEPER_TMUX_SESSION / TMUX_PANE", () => {
  const meta = execBackendEnvMeta("tmux");
  expect(meta.backendType).toBe("tmux");
  expect(meta.sessionIdEnvVar).toBe("KEEPER_TMUX_SESSION");
  expect(meta.paneIdEnvVar).toBe("TMUX_PANE");
  expect(meta.paneIdCarrierEnvVar).toBe("KEEPER_TMUX_PANE");
});

test("execBackendEnvMeta: unknown backend keeps its label but falls back to tmux env vars", () => {
  const meta = execBackendEnvMeta("wezterm");
  expect(meta.backendType).toBe("wezterm");
  expect(meta.sessionIdEnvVar).toBe("KEEPER_TMUX_SESSION");
  expect(meta.paneIdEnvVar).toBe("TMUX_PANE");
  expect(meta.paneIdCarrierEnvVar).toBe("KEEPER_TMUX_PANE");
});

// ---------------------------------------------------------------------------
// Pure tmux argv builders
// ---------------------------------------------------------------------------

test("buildTmuxHasSessionArgs: `=`-prefixed exact-match target", () => {
  expect(buildTmuxHasSessionArgs("autopilot")).toEqual([
    "tmux",
    "has-session",
    "-t",
    "=autopilot",
  ]);
});

test("buildTmuxNewSessionArgs: detached mint injects KEEPER_TMUX_SESSION via -e", () => {
  expect(buildTmuxNewSessionArgs("autopilot")).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-s",
    "autopilot",
    "-e",
    "KEEPER_TMUX_SESSION=autopilot",
  ]);
});

test("buildTmuxSelectWindowArgs / buildTmuxSelectPaneArgs: id-based targets only", () => {
  expect(buildTmuxSelectWindowArgs("%7")).toEqual([
    "tmux",
    "select-window",
    "-t",
    "%7",
  ]);
  expect(buildTmuxSelectPaneArgs("%7")).toEqual([
    "tmux",
    "select-pane",
    "-t",
    "%7",
  ]);
});

test("buildTmuxListPanesArgs: -a sweep, tab-delimited format with window_name last", () => {
  expect(buildTmuxListPanesArgs()).toEqual([
    "tmux",
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{window_id}\t#{window_name}",
  ]);
});

test("buildTmuxServerPidArgs: display-message -p of the server pid (generation handle)", () => {
  expect(buildTmuxServerPidArgs()).toEqual([
    "tmux",
    "display-message",
    "-p",
    "#{pid}",
  ]);
});

test("buildTmuxRenameWindowArgs: targets @N window id and carries `--` before the name", () => {
  expect(buildTmuxRenameWindowArgs("@3", "fn-1-x.2")).toEqual([
    "tmux",
    "rename-window",
    "-t",
    "@3",
    "--",
    "fn-1-x.2",
  ]);
  // The `--` is load-bearing: a name starting with `-` must not be read as an
  // option by tmux's own parser.
  expect(buildTmuxRenameWindowArgs("@9", "-rf weird")).toEqual([
    "tmux",
    "rename-window",
    "-t",
    "@9",
    "--",
    "-rf weird",
  ]);
});

test("buildTmuxKillWindowArgs: targets the %N pane id, exact argv", () => {
  expect(buildTmuxKillWindowArgs("%7")).toEqual([
    "tmux",
    "kill-window",
    "-t",
    "%7",
  ]);
  // Pane-id targeting is deliberate — tmux resolves it upward to the window.
  expect(buildTmuxKillWindowArgs("%42")).toEqual([
    "tmux",
    "kill-window",
    "-t",
    "%42",
  ]);
});

// ---------------------------------------------------------------------------
// AGENTBUS_EXEC_SESSION — the wake managed session
// ---------------------------------------------------------------------------

test("AGENTBUS_EXEC_SESSION is 'agentbus', distinct from the autopilot session", () => {
  expect(AGENTBUS_EXEC_SESSION).toBe("agentbus");
  expect(AGENTBUS_EXEC_SESSION).not.toBe(MANAGED_EXEC_SESSION);
});

// ---------------------------------------------------------------------------
// createTmuxPaneOps.focusPane — id-based select-window then select-pane
// ---------------------------------------------------------------------------

test("createTmuxPaneOps.focusPane: exit 0 → select-window then select-pane against the pane id, { ok: true }", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:select-window": { exitCode: 0 },
      "tmux:select-pane": { exitCode: 0 },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.focusPane("any-session", "%7");
  expect(got).toEqual({ ok: true });
  // Both ops target the server-global pane id, never the session name.
  expect(calls[0]).toEqual(buildTmuxSelectWindowArgs("%7"));
  expect(calls[1]).toEqual(buildTmuxSelectPaneArgs("%7"));
});

test("createTmuxPaneOps.focusPane: select-window non-zero → { ok: false }, select-pane never runs", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:select-window": { stderr: "can't find pane", exitCode: 1 },
      "tmux:select-pane": { exitCode: 0 },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.focusPane("s", "%99");
  expect(got.ok).toBe(false);
  if (got.ok === false) {
    expect(got.error).toContain("exited 1");
    expect(got.error).toContain("can't find pane");
  }
  // select-pane is gated on a successful select-window.
  expect(calls.some((c) => c[1] === "select-pane")).toBe(false);
});

test("createTmuxPaneOps.focusPane: ENOENT throw → { ok: false }, never throws back", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.focusPane("s", "%1");
  expect(got.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// createTmuxPaneOps.listPanes — server-wide sweep, tab-safe parse, null degrade
// ---------------------------------------------------------------------------

test("createTmuxPaneOps.listPanes: parses (paneId, windowId, windowName) from one -a sweep", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:list-panes": {
        stdout: "%1\t@1\twork::fn-1-x.2\n%2\t@2\tplain shell\n",
        exitCode: 0,
      },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.listPanes();
  expect(calls[0]).toEqual(buildTmuxListPanesArgs());
  expect(got).toEqual([
    { paneId: "%1", windowId: "@1", windowName: "work::fn-1-x.2" },
    { paneId: "%2", windowId: "@2", windowName: "plain shell" },
  ]);
});

test("createTmuxPaneOps.listPanes: a tab inside a window name stays in windowName (2-split limit)", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:list-panes": {
        // window name itself contains a tab, a colon, and unicode.
        stdout: "%7\t@7\tweird:\tname é\n",
        exitCode: 0,
      },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.listPanes();
  expect(got).toEqual([
    { paneId: "%7", windowId: "@7", windowName: "weird:\tname é" },
  ]);
});

test("createTmuxPaneOps.listPanes: drops malformed lines (missing tabs / empty ids), keeps the rest", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:list-panes": {
        // line 1 has no tab; line 2 has one tab only; line 3 has empty pane id;
        // line 4 is well-formed (and a name may be empty — that is valid).
        stdout: "garbage\n%2\tonlyone\n\t@3\tname\n%4\t@4\t\n",
        exitCode: 0,
      },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.listPanes();
  expect(got).toEqual([{ paneId: "%4", windowId: "@4", windowName: "" }]);
});

test("createTmuxPaneOps.listPanes: non-zero exit (no server) → null", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    { "tmux:list-panes": { stderr: "no server running", exitCode: 1 } },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  expect(await ops.listPanes()).toBeNull();
});

// ---------------------------------------------------------------------------
// localeDefaultedEnv — UTF-8 locale default for byte-faithful tmux spawns
// ---------------------------------------------------------------------------

test("localeDefaultedEnv: no locale vars → LANG defaulted to en_US.UTF-8", () => {
  const got = localeDefaultedEnv({ PATH: "/usr/bin", HOME: "/Users/x" });
  expect(got).toEqual({
    PATH: "/usr/bin",
    HOME: "/Users/x",
    LANG: "en_US.UTF-8",
  });
});

test("localeDefaultedEnv: an explicitly configured locale wins (no override)", () => {
  expect(localeDefaultedEnv({ LANG: "fr_FR.UTF-8" }).LANG).toBe("fr_FR.UTF-8");
  const viaCtype = localeDefaultedEnv({ LC_CTYPE: "en_US.UTF-8" });
  expect(viaCtype.LANG).toBeUndefined();
  const viaAll = localeDefaultedEnv({ LC_ALL: "C" });
  expect(viaAll.LANG).toBeUndefined();
});

test("localeDefaultedEnv: empty-string locale vars count as unset; undefined values are dropped", () => {
  const got = localeDefaultedEnv({
    LANG: "",
    LC_CTYPE: "",
    TERM: undefined,
    PATH: "/bin",
  });
  expect(got.LANG).toBe("en_US.UTF-8");
  expect("TERM" in got).toBe(false);
  expect(got.PATH).toBe("/bin");
});

test("createTmuxPaneOps.listPanes: sweep spawn carries a locale-bearing env (C-locale clients sanitize the tab delimiters)", async () => {
  const envByCall: Array<Record<string, string> | undefined> = [];
  const spawn: SpawnFn = (_cmd, options) => {
    envByCall.push(options.env);
    return {
      exited: Promise.resolve(0),
      stdout: new Response("%1\t@1\tname\n").body,
      stderr: new Response("").body,
      kill: () => {},
    };
  };
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  await ops.listPanes();
  const env = envByCall[0];
  expect(env).toBeDefined();
  expect(Boolean(env?.LC_ALL || env?.LC_CTYPE || env?.LANG)).toBe(true);
});

test("createTmuxPaneOps.listPanes: ENOENT (binary missing) → null, never throws", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  expect(await ops.listPanes()).toBeNull();
});

// ---------------------------------------------------------------------------
// createTmuxPaneOps.renameWindow — @N target, `--` guard, TOCTOU no-op, ENOENT
// ---------------------------------------------------------------------------

test("createTmuxPaneOps.renameWindow: exit 0 → { ok: true }, argv targets @N and carries `--`", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub({ "tmux:rename-window": { exitCode: 0 } }, calls);
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.renameWindow("@5", "fn-2-y.1");
  expect(got).toEqual({ ok: true });
  expect(calls[0]).toEqual(buildTmuxRenameWindowArgs("@5", "fn-2-y.1"));
});

test("createTmuxPaneOps.renameWindow: TOCTOU 'can't find window' non-zero → { ok: false }, silent (no noteLine)", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:rename-window": {
        stderr: "can't find window @5",
        exitCode: 1,
      },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: (l) => notes.push(l), spawn });
  const got = await ops.renameWindow("@5", "gone");
  expect(got.ok).toBe(false);
  if (got.ok === false) {
    expect(got.error).toContain("exited 1");
    expect(got.error).toContain("can't find window");
  }
  // A self-healing race must not spam the sidecar.
  expect(notes).toHaveLength(0);
});

test("createTmuxPaneOps.renameWindow: ENOENT (binary missing) → { ok: false }, never throws", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.renameWindow("@1", "x");
  expect(got.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// createTmuxPaneOps.killWindow — %N target, TOCTOU no-op, ENOENT degrade
// ---------------------------------------------------------------------------

test("createTmuxPaneOps.killWindow: exit 0 → { ok: true }, argv targets the %N pane id", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub({ "tmux:kill-window": { exitCode: 0 } }, calls);
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.killWindow("%7");
  expect(got).toEqual({ ok: true });
  expect(calls[0]).toEqual(buildTmuxKillWindowArgs("%7"));
});

test("createTmuxPaneOps.killWindow: TOCTOU 'can't find window' non-zero → { ok: false }, silent (no noteLine)", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:kill-window": {
        stderr: "can't find window %7",
        exitCode: 1,
      },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: (l) => notes.push(l), spawn });
  const got = await ops.killWindow("%7");
  expect(got.ok).toBe(false);
  if (got.ok === false) {
    expect(got.error).toContain("exited 1");
    expect(got.error).toContain("can't find window");
  }
  // An already-gone window is the expected race — it must not spam the sidecar.
  expect(notes).toHaveLength(0);
});

test("createTmuxPaneOps.killWindow: ENOENT (binary missing) → { ok: false }, never throws", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.killWindow("%1");
  expect(got.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// agentwrap launch (keeper's sole launch transport) — buildAgentwrapLaunchArgv
// (byte-pinned), parse, exit-map, and the agentwrapLaunch
// launch→parse→exit-map→outcome path.
// ---------------------------------------------------------------------------

/**
 * A canned `schema_version:1` agentwrap success line — the cross-repo contract
 * keeper parses. Byte-pinned (with `\n`) so the JSON-parse path is exercised on
 * the real one-line shape agentwrap emits, not a hand-trimmed approximation.
 * Task .4 adds the cross-repo fixture pin; this is the in-test canned form.
 */
const AGENTWRAP_OK_LINE = `${JSON.stringify({
  schema_version: 1,
  id: "fn-1-x.1",
  agent: "claude",
  cwd: "/abs",
  session: "autopilot",
  windowId: "@7",
  paneId: "%9",
  runDir: null,
  launchScript: null,
  transcriptPath: null,
  waitedForStop: false,
  stop: null,
  tmux: {
    session: "autopilot",
    windowId: "@7",
    paneId: "%9",
    attachCommand: null,
  },
})}\n`;

/**
 * `keeper agent` launch spawn stub: keys the launch result off the launcher
 * prefix (cmd[0..2] === `[bun, keeper.ts, "agent"]`) and captures every spawn's
 * argv + options (cwd) so the test can assert the invocation shape and the
 * worker-cwd-on-spawn behavior. tmux ops fall through to a zero-exit default.
 */
function makeAgentwrapSpawnStub(
  launcherArgvPrefix: readonly string[],
  launch: { stdout?: string; stderr?: string; exitCode?: number },
  records: Array<{ cmd: string[]; cwd?: string }>,
): SpawnFn {
  return (cmd, options) => {
    records.push({
      cmd: [...cmd],
      ...((options as { cwd?: string }).cwd !== undefined
        ? { cwd: (options as { cwd?: string }).cwd }
        : {}),
    });
    const isLauncher = launcherArgvPrefix.every((tok, i) => cmd[i] === tok);
    const canned = isLauncher
      ? launch
      : { stdout: "", stderr: "", exitCode: 0 };
    return {
      exited: Promise.resolve(canned.exitCode ?? 0),
      stdout: new Response(canned.stdout ?? "").body,
      stderr: new Response(canned.stderr ?? "").body,
      kill: () => {},
    };
  };
}

// The folded-launcher argv prefix the dispatch path spawns: `[bun, cli/keeper.ts,
// "agent"]`. Supersedes the standalone `agentwrap` binary path — the launcher
// folded into `keeper agent`.
const LAP = ["/abs/bin/bun", "/abs/cli/keeper.ts", "agent"] as const;

test("buildAgentwrapLaunchArgv: exact landed-contract invocation (byte-pinned)", () => {
  expect(
    buildAgentwrapLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "autopilot",
      prompt: "/plan:work fn-1-x.1",
      claudeName: "work::fn-1-x.1",
      model: "sonnet",
      effort: "max",
      noConfirm: true,
    }),
  ).toEqual([
    ...LAP,
    "claude",
    "--x-tmux",
    "--x-tmux-detached",
    "--x-tmux-session",
    "autopilot",
    "--x-tmux-env",
    "KEEPER_TMUX_SESSION=autopilot",
    "--model",
    "sonnet",
    "--effort",
    "max",
    "--x-no-confirm",
    "--name",
    "work::fn-1-x.1",
    "/plan:work fn-1-x.1",
  ]);
});

test("buildAgentwrapLaunchArgv: omits absent model/effort/name and the no-confirm flag", () => {
  expect(
    buildAgentwrapLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "autopilot",
      prompt: "do a thing",
      noConfirm: false,
    }),
  ).toEqual([
    ...LAP,
    "claude",
    "--x-tmux",
    "--x-tmux-detached",
    "--x-tmux-session",
    "autopilot",
    "--x-tmux-env",
    "KEEPER_TMUX_SESSION=autopilot",
    "do a thing",
  ]);
});

test("buildAgentwrapLaunchArgv: resume mode emits --resume <target> and NO trailing prompt (byte-pinned)", () => {
  expect(
    buildAgentwrapLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "agentbus",
      prompt: "", // unused in resume mode
      resumeTarget: "planner-session",
      noConfirm: true,
    }),
  ).toEqual([
    ...LAP,
    "claude",
    "--x-tmux",
    "--x-tmux-detached",
    "--x-tmux-session",
    "agentbus",
    "--x-tmux-env",
    "KEEPER_TMUX_SESSION=agentbus",
    "--x-no-confirm",
    "--resume",
    "planner-session",
  ]);
});

test("buildAgentwrapLaunchArgv: an empty resumeTarget falls back to prompt mode", () => {
  // A degenerate empty target must NOT emit `--resume ""` (a quoting/UX hazard);
  // it falls through to the trailing prompt positional.
  expect(
    buildAgentwrapLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "agentbus",
      prompt: "fallback prompt",
      resumeTarget: "",
      noConfirm: false,
    }),
  ).toEqual([
    ...LAP,
    "claude",
    "--x-tmux",
    "--x-tmux-detached",
    "--x-tmux-session",
    "agentbus",
    "--x-tmux-env",
    "KEEPER_TMUX_SESSION=agentbus",
    "fallback prompt",
  ]);
});

test("buildAgentwrapLaunchArgv: a worktree-mode launch emits a 2nd --x-tmux-env KEEPER_PLAN_WORKTREE (byte-pinned)", () => {
  expect(
    buildAgentwrapLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "autopilot",
      prompt: "/plan:work fn-1-x.1",
      claudeName: "work::fn-1-x.1",
      model: "sonnet",
      effort: "max",
      worktreePath: "/private/var/wt/repo--keeper-epic-fn-1-x",
      noConfirm: true,
    }),
  ).toEqual([
    ...LAP,
    "claude",
    "--x-tmux",
    "--x-tmux-detached",
    "--x-tmux-session",
    "autopilot",
    "--x-tmux-env",
    "KEEPER_TMUX_SESSION=autopilot",
    // The 2nd repeated env entry — the worktree lane carrier, right after the
    // session entry and BEFORE the model/effort/name flags.
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE=/private/var/wt/repo--keeper-epic-fn-1-x",
    "--model",
    "sonnet",
    "--effort",
    "max",
    "--x-no-confirm",
    "--name",
    "work::fn-1-x.1",
    "/plan:work fn-1-x.1",
  ]);
});

test("buildAgentwrapLaunchArgv: a worktree-mode RESUME re-injects KEEPER_PLAN_WORKTREE before --resume (byte-pinned)", () => {
  // A resumed worktree worker must NOT re-resolve to the main checkout, so the
  // lane env rides resume mode too — emitted before the `--resume` tail.
  expect(
    buildAgentwrapLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "autopilot",
      prompt: "", // unused in resume mode
      resumeTarget: "work::fn-1-x.1",
      worktreePath: "/private/var/wt/repo--keeper-epic-fn-1-x",
      noConfirm: true,
    }),
  ).toEqual([
    ...LAP,
    "claude",
    "--x-tmux",
    "--x-tmux-detached",
    "--x-tmux-session",
    "autopilot",
    "--x-tmux-env",
    "KEEPER_TMUX_SESSION=autopilot",
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE=/private/var/wt/repo--keeper-epic-fn-1-x",
    "--x-no-confirm",
    "--resume",
    "work::fn-1-x.1",
  ]);
});

test("buildAgentwrapLaunchArgv: an empty worktreePath emits NO 2nd env entry (byte-identical to non-worktree)", () => {
  const base = {
    launcherArgvPrefix: LAP,
    session: "autopilot",
    prompt: "/plan:work fn-1-x.1",
    claudeName: "work::fn-1-x.1",
    model: "sonnet",
    effort: "max",
    noConfirm: true,
  } as const;
  expect(buildAgentwrapLaunchArgv({ ...base, worktreePath: "" })).toEqual(
    buildAgentwrapLaunchArgv(base),
  );
});

// --- parseAgentwrapStdout ---

test("parseAgentwrapStdout: a schema_version:1 line → ok", () => {
  expect(parseAgentwrapStdout(AGENTWRAP_OK_LINE)).toEqual({ ok: true });
});

test("parseAgentwrapStdout: tolerates a banner line before the JSON line", () => {
  expect(
    parseAgentwrapStdout(`some startup banner\n${AGENTWRAP_OK_LINE}`),
  ).toEqual({ ok: true });
});

test("parseAgentwrapStdout: schema_version:2 → permanent fail (contract drift)", () => {
  const line = `${JSON.stringify({ schema_version: 2, session: "autopilot" })}\n`;
  const res = parseAgentwrapStdout(line);
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("schema_version");
  }
});

test("parseAgentwrapStdout: empty stdout → INTERNAL fail", () => {
  const res = parseAgentwrapStdout("");
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("no parseable schema_version");
  }
});

test("parseAgentwrapStdout: non-JSON noise only → INTERNAL fail", () => {
  const res = parseAgentwrapStdout("not json\nstill not json\n");
  expect(res.ok).toBe(false);
});

test("parseAgentwrapStdout: a JSON object without schema_version → INTERNAL fail naming the missing field", () => {
  const res = parseAgentwrapStdout(`${JSON.stringify({ session: "x" })}\n`);
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("no schema_version");
  }
});

test("AGENTWRAP_SCHEMA_VERSION is pinned at 1 (cross-repo contract)", () => {
  expect(AGENTWRAP_SCHEMA_VERSION).toBe(1);
});

// --- cross-repo drift guard: byte-pinned agentwrap stdout fixture ---

/**
 * The JSON shape + exit-code taxonomy is a cross-repo contract with NO shared
 * module (agentwrap `src/main.ts` `tmuxMetadata` / `tmux-launch.ts` `TMUX_EXIT`
 * on one side, keeper `parseAgentwrapStdout` / `AGENTWRAP_TMUX_EXIT` on the
 * other). `test/fixtures/agentwrap-launch-stdout.json` is ONE line of real
 * `agentwrap claude --x-tmux --x-tmux-detached …` stdout
 * (captured from the binary, not hand-authored), so these tests fail loudly the
 * moment agentwrap's emitted shape or keeper's parser drifts apart. Recapture
 * the fixture from real output when the contract is intentionally bumped.
 */
const AGENTWRAP_FIXTURE_STDOUT = await Bun.file(
  new URL("./fixtures/agentwrap-launch-stdout.jsonl", import.meta.url),
).text();

test("fixture: keeper's parser consumes agentwrap's real launch stdout → ok", () => {
  expect(parseAgentwrapStdout(AGENTWRAP_FIXTURE_STDOUT)).toEqual({ ok: true });
});

test("fixture: the real line carries schema_version === AGENTWRAP_SCHEMA_VERSION and the top-level bind points", () => {
  const obj = JSON.parse(AGENTWRAP_FIXTURE_STDOUT.trim()) as Record<
    string,
    unknown
  >;
  // The version keeper validates against.
  expect(obj.schema_version).toBe(AGENTWRAP_SCHEMA_VERSION);
  // The stable top-level bind points keeper documents (discarded at runtime —
  // binding is hook-based — but their PRESENCE is the contract).
  expect(typeof obj.session).toBe("string");
  expect(typeof obj.windowId).toBe("string");
  expect(typeof obj.paneId).toBe("string");
});

test("fixture-fed agentwrapLaunch: exit 0 + real stdout → ok (full launch→parse→map path)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeAgentwrapSpawnStub(
    LAP,
    { stdout: AGENTWRAP_FIXTURE_STDOUT, exitCode: 0 },
    records,
  );
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: { prompt: "/plan:work fn-1-x.1", claudeName: "work::fn-1-x.1" },
    spawn,
  });
  expect(res).toEqual({ ok: true });
});

test("AGENTWRAP_TMUX_EXIT mirrors agentwrap's landed TMUX_EXIT taxonomy (1/2/3/4) and maps to the right outcome class", () => {
  // The exit-code numbers MUST match agentwrap's `TMUX_EXIT`
  // (src/tmux-launch.ts): INTERNAL=1, BAD_ARGS=2, NOOP=3, RETRYABLE=4.
  expect(AGENTWRAP_TMUX_EXIT.INTERNAL).toBe(1);
  expect(AGENTWRAP_TMUX_EXIT.BAD_ARGS).toBe(2);
  expect(AGENTWRAP_TMUX_EXIT.NOOP).toBe(3);
  expect(AGENTWRAP_TMUX_EXIT.RETRYABLE).toBe(4);
  // …and the central map routes each to its outcome class: only RETRYABLE(4)
  // is transient; INTERNAL/BAD_ARGS/NOOP are permanent (no retryable).
  const ok: LaunchResult = { ok: true };
  expect(mapAgentwrapExit(AGENTWRAP_TMUX_EXIT.RETRYABLE, ok)).toMatchObject({
    ok: false,
    retryable: true,
  });
  for (const code of [
    AGENTWRAP_TMUX_EXIT.INTERNAL,
    AGENTWRAP_TMUX_EXIT.BAD_ARGS,
    AGENTWRAP_TMUX_EXIT.NOOP,
  ]) {
    const res = mapAgentwrapExit(code, ok);
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.retryable).toBeUndefined();
    }
  }
});

// --- mapAgentwrapExit (the ONE central exit map, table-driven) ---

test("mapAgentwrapExit: 0 + valid parse → ok", () => {
  expect(mapAgentwrapExit(0, { ok: true })).toEqual({ ok: true });
});

test("mapAgentwrapExit: 0 + bad parse → PERMANENT (unconfirmed launch, never retry)", () => {
  const res = mapAgentwrapExit(0, { ok: false, error: "no json" });
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.retryable).toBeUndefined();
  }
});

test("mapAgentwrapExit: exit-code → outcome class table (1/2/3 permanent, 4 transient, unknown permanent)", () => {
  const ok: LaunchResult = { ok: true };
  // 4 RETRYABLE → transient.
  const four = mapAgentwrapExit(4, ok);
  expect(four).toMatchObject({ ok: false, retryable: true });
  // 3 NOOP, 1 INTERNAL, 2 BAD_ARGS, and an unknown code → permanent (no retryable).
  for (const code of [1, 2, 3, 99]) {
    const res = mapAgentwrapExit(code, ok);
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.retryable).toBeUndefined();
    }
  }
});

// --- agentwrapLaunch (launch→parse→exit-map→outcome) ---

test("agentwrapLaunch: exit 0 + valid JSON → ok; spawns the agentwrap argv with worker cwd on the spawn", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeAgentwrapSpawnStub(
    LAP,
    { stdout: AGENTWRAP_OK_LINE, exitCode: 0 },
    records,
  );
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: {
      prompt: "/plan:work fn-1-x.1",
      claudeName: "work::fn-1-x.1",
      model: "sonnet",
      effort: "max",
    },
    spawn,
  });
  expect(res).toEqual({ ok: true });
  // The launch spawned the folded `keeper agent` launcher (bun + keeper.ts +
  // "agent" prefix), into the managed session, with the worker cwd set on the
  // spawn (the launcher has no cwd flag).
  expect(records[0]?.cmd.slice(0, LAP.length)).toEqual([...LAP]);
  expect(records[0]?.cmd).toContain("--x-tmux");
  expect(records[0]?.cmd).toContain("autopilot"); // the managed session
  expect(records[0]?.cwd).toBe("/repo");
});

test("agentwrapLaunch: exit 4 RETRYABLE → transient ({ ok:false, retryable:true })", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeAgentwrapSpawnStub(LAP, { exitCode: 4 }, records);
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: { prompt: "p" },
    spawn,
  });
  expect(res).toMatchObject({ ok: false, retryable: true });
});

test("agentwrapLaunch: exit 3 NOOP → permanent (no retryable)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeAgentwrapSpawnStub(LAP, { exitCode: 3 }, records);
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: { prompt: "p" },
    spawn,
  });
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.retryable).toBeUndefined();
  }
});

test("agentwrapLaunch: exit 2 BAD_ARGS → permanent (keeper built a bad argv)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeAgentwrapSpawnStub(LAP, { exitCode: 2 }, records);
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: { prompt: "p" },
    spawn,
  });
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.retryable).toBeUndefined();
  }
});

test("agentwrapLaunch: exit 0 but schema_version:2 stdout → permanent (unconfirmed)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeAgentwrapSpawnStub(
    LAP,
    { stdout: `${JSON.stringify({ schema_version: 2 })}\n`, exitCode: 0 },
    records,
  );
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: { prompt: "p" },
    spawn,
  });
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.retryable).toBeUndefined();
  }
});

test("agentwrapLaunch: exit 0 but empty stdout → permanent (INTERNAL, unconfirmed)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeAgentwrapSpawnStub(
    LAP,
    { stdout: "", exitCode: 0 },
    records,
  );
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: { prompt: "p" },
    spawn,
  });
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.retryable).toBeUndefined();
  }
});

test("agentwrapLaunch: timeout-kill (runCapture null) → transient", async () => {
  // A spawn whose `exited` never resolves forces the kill-timeout path; a tiny
  // captureTimeoutMs pins it without a real wait.
  const spawn: SpawnFn = (_cmd, _options) => ({
    exited: new Promise<number>(() => {}), // never resolves
    stdout: new Response("").body,
    stderr: new Response("").body,
    kill: () => {},
  });
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: { prompt: "p" },
    spawn,
    captureTimeoutMs: 5,
  });
  expect(res).toMatchObject({ ok: false, retryable: true });
});

test("agentwrapLaunch: ENOENT (bad launcher) → transient, loud (noteLine warned)", async () => {
  const warnings: string[] = [];
  // A spawn that throws models ENOENT (missing bun / keeper.ts).
  const spawn: SpawnFn = () => {
    throw new Error("ENOENT");
  };
  const res = await agentwrapLaunch({
    noteLine: (l) => warnings.push(l),
    launcherArgvPrefix: ["/nope/bun", "/nope/keeper.ts", "agent"],
    session: MANAGED_EXEC_SESSION,
    cwd: "/repo",
    label: "work::fn-1-x.1",
    spec: { prompt: "p" },
    spawn,
  });
  expect(res).toMatchObject({ ok: false, retryable: true });
  // Loud, not silent — the bad launcher is named in a warn line.
  expect(warnings.some((w) => w.includes("/nope/keeper.ts"))).toBe(true);
});

test("agentwrapLaunch: a per-call session targets that session, not the managed default", async () => {
  // Manual `keeper dispatch` passes a per-call session (the resolved foreground /
  // current session) rather than the hardcoded managed one.
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeAgentwrapSpawnStub(
    LAP,
    { stdout: AGENTWRAP_OK_LINE, exitCode: 0 },
    records,
  );
  const res = await agentwrapLaunch({
    noteLine: () => {},
    launcherArgvPrefix: LAP,
    session: "work",
    cwd: "/proj",
    label: "session=work",
    spec: { prompt: "/plan:work fn-1-x.1", claudeName: "work::fn-1-x.1" },
    spawn,
  });
  expect(res).toEqual({ ok: true });
  expect(records[0]?.cmd.slice(0, LAP.length)).toEqual([...LAP]);
  // Per-call session targeted, not the managed default.
  expect(records[0]?.cmd).toContain("work");
  expect(records[0]?.cmd).toContain("KEEPER_TMUX_SESSION=work");
});

// ---------------------------------------------------------------------------
// classifyCloseKind — the crash-restore discriminator stamped by both Killed
// producer sites via a shared main-side tmux liveness probe (fn-817 task .1).
// Injected canned `list-panes -a` output; no real fork.
// ---------------------------------------------------------------------------

/** Build a `SyncProbeFn` returning canned `list-panes -a` output, recording the
 *  argv it was called with so the test can assert the sweep argv + locale env. */
function makeSyncProbe(canned: {
  success?: boolean;
  exitCode?: number;
  stdout?: string | null;
}): { probe: SyncProbeFn; calls: string[][] } {
  const calls: string[][] = [];
  const probe: SyncProbeFn = (args) => {
    calls.push([...args]);
    return {
      success: canned.success ?? true,
      exitCode: canned.exitCode ?? 0,
      stdout:
        canned.stdout === null ? null : { toString: () => canned.stdout ?? "" },
    };
  };
  return { probe, calls };
}

test("classifyCloseKind: non-zero exit (no tmux server) → server_gone", () => {
  const { probe, calls } = makeSyncProbe({ success: false, exitCode: 1 });
  expect(classifyCloseKind("%5", { spawnSync: probe })).toBe("server_gone");
  // ONE list-panes -a sweep answers both server-liveness and pane-presence.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual(buildTmuxListPanesArgs());
});

test("classifyCloseKind: success=false (timed-out spawn) → server_gone", () => {
  const { probe } = makeSyncProbe({ success: false, exitCode: 0 });
  expect(classifyCloseKind("%5", { spawnSync: probe })).toBe("server_gone");
});

test("classifyCloseKind: server alive, pane still listed (dead pane) → pid_died", () => {
  const { probe } = makeSyncProbe({
    stdout: "%4\t@1\twin-a\n%5\t@2\twin-b\n%6\t@3\twin-c\n",
  });
  expect(classifyCloseKind("%5", { spawnSync: probe })).toBe("pid_died");
});

test("classifyCloseKind: server alive, pane gone → window_gone_server_alive", () => {
  const { probe } = makeSyncProbe({
    stdout: "%4\t@1\twin-a\n%6\t@3\twin-c\n",
  });
  expect(classifyCloseKind("%5", { spawnSync: probe })).toBe(
    "window_gone_server_alive",
  );
});

test("classifyCloseKind: probe throws (tmux binary missing) → unknown", () => {
  const probe: SyncProbeFn = () => {
    throw new Error("ENOENT");
  };
  expect(classifyCloseKind("%5", { spawnSync: probe })).toBe("unknown");
});

test("classifyCloseKind: server alive but no recorded pane (null/empty) → unknown", () => {
  const { probe } = makeSyncProbe({ stdout: "%4\t@1\twin-a\n" });
  expect(classifyCloseKind(null, { spawnSync: probe })).toBe("unknown");
  expect(classifyCloseKind("", { spawnSync: probe })).toBe("unknown");
});

test("classifyCloseKind: pane match is leading-field exact, not a substring spoof", () => {
  // A window name containing the literal pane text must NOT read as present —
  // only the FIRST tab-delimited field counts. Otherwise a crash-kill whose
  // pane is truly gone would misclassify as pid_died and never be a clean
  // user-close, or worse a user-close would masquerade as a live pane.
  const { probe } = makeSyncProbe({
    stdout: "%4\t@1\tnamed %5 in the title\n",
  });
  expect(classifyCloseKind("%5", { spawnSync: probe })).toBe(
    "window_gone_server_alive",
  );
});

test("classifyCloseKind: null stdout on a zero exit → no panes, pane absent → window_gone_server_alive", () => {
  const { probe } = makeSyncProbe({ stdout: null });
  expect(classifyCloseKind("%5", { spawnSync: probe })).toBe(
    "window_gone_server_alive",
  );
});
