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
 *  - The keeper agent launch (keeper's sole launch transport) —
 *    `buildKeeperAgentLaunchArgv` (byte-pinned contract invocation),
 *    `parseKeeperAgentStdout` (line-scan, schema_version check,
 *    empty/non-JSON/missing-field), `mapKeeperAgentExit` (the central
 *    0/1/2/3/4 + timeout exit-map), and `keeperAgentLaunch`
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
  buildGenerationId,
  buildKeeperAgentLaunchArgv,
  buildTmuxHasSessionArgs,
  buildTmuxKillWindowArgs,
  buildTmuxListPanesArgs,
  buildTmuxNewSessionArgs,
  buildTmuxRenameWindowArgs,
  buildTmuxSelectPaneArgs,
  buildTmuxSelectWindowArgs,
  buildTmuxServerGenerationArgs,
  classifyCloseKind,
  classifyProcessIdentity,
  compareCanonicalGeneration,
  createTmuxPaneOps,
  DEFAULT_EXEC_BACKEND,
  execBackendEnvMeta,
  isDefaultTmuxEnvValue,
  KEEPER_AGENT_SCHEMA_VERSION,
  KEEPER_AGENT_TMUX_EXIT,
  keeperAgentLaunch,
  type LaunchResult,
  localeDefaultedEnv,
  MANAGED_EXEC_SESSION,
  mapKeeperAgentExit,
  parseGenerationId,
  parseKeeperAgentStdout,
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

test("isDefaultTmuxEnvValue accepts only the default tmux socket", () => {
  expect(isDefaultTmuxEnvValue("/private/tmp/tmux-501/default,123,0")).toBe(
    true,
  );
  expect(isDefaultTmuxEnvValue("/private/tmp/tmux-501/jobsearch,123,0")).toBe(
    false,
  );
  expect(isDefaultTmuxEnvValue("")).toBe(false);
  expect(isDefaultTmuxEnvValue(undefined)).toBe(false);
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

test("buildTmuxNewSessionArgs: detached mint sets session cwd and injects KEEPER_TMUX_SESSION", () => {
  expect(buildTmuxNewSessionArgs("autopilot", "/home/tester")).toEqual([
    "tmux",
    "new-session",
    "-d",
    "-s",
    "autopilot",
    "-c",
    "/home/tester",
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
    "#{pid}:#{start_time}\t#{pane_id}\t#{window_id}\t#{pane_current_command}\t#{pane_dead}\t#{session_name}\t#{window_name}",
  ]);
});

test("buildTmuxServerGenerationArgs: display-message -p of the server generation", () => {
  expect(buildTmuxServerGenerationArgs()).toEqual([
    "tmux",
    "display-message",
    "-p",
    "#{pid}:#{start_time}",
  ]);
});

// ---------------------------------------------------------------------------
// Generation identity — the SOLE builder + parser. buildGenerationId mints only
// the CURRENT pid:start_time form; parseGenerationId ALSO reads the legacy
// bare-pid form so the read-time canonicalizer can alias it.
// ---------------------------------------------------------------------------

test("buildGenerationId mints the canonical pid:start_time and trims whitespace", () => {
  expect(buildGenerationId("4242:777")).toBe("4242:777");
  expect(buildGenerationId("  777:888\n")).toBe("777:888");
});

test("buildGenerationId NEVER mints a bare pid (a bare form is legacy-read only)", () => {
  // The current probe always carries start_time; a bare pid means a degraded
  // probe, so the builder emits nothing rather than fork a new format.
  expect(buildGenerationId("123")).toBeNull();
});

test("buildGenerationId rejects every degraded / malformed probe line", () => {
  for (const raw of [
    "",
    "  ",
    "0:1",
    "1:0",
    "-1:1",
    "12.5:1",
    "0x1f:1",
    "abc",
    "12 34",
    "1:2:3",
    "123:",
    ":456",
  ]) {
    expect(buildGenerationId(raw)).toBeNull();
  }
});

test("parseGenerationId splits the full form and the legacy bare-pid form", () => {
  expect(parseGenerationId("4242:777")).toEqual({
    pid: "4242",
    startTime: "777",
  });
  // Bare pid is accepted as a legacy read (startTime null) — the alias source.
  expect(parseGenerationId("21705")).toEqual({ pid: "21705", startTime: null });
  expect(parseGenerationId("  9:9 ")).toEqual({ pid: "9", startTime: "9" });
});

test("canonical generation comparison refuses legacy/malformed cleanup authority", () => {
  expect(compareCanonicalGeneration("123:456", "123:456")).toBe("match");
  expect(compareCanonicalGeneration("123:456", "123:457")).toBe("mismatch");
  expect(compareCanonicalGeneration("123", "123:456")).toBe("unknown");
  expect(compareCanonicalGeneration("bad", "123:456")).toBe("unknown");
});

test("process identity separates a recycled pid from a gone process", () => {
  expect(
    classifyProcessIdentity(42, "start-a", {
      isPidAlive: () => true,
      readStartTime: () => "start-b",
    }),
  ).toBe("recycled");
  expect(
    classifyProcessIdentity(42, "start-a", {
      isPidAlive: () => false,
      readStartTime: () => {
        throw new Error("must not read a dead pid");
      },
    }),
  ).toBe("dead");
});

test("parseGenerationId rejects non-positive-integer fields and >2 segments", () => {
  for (const raw of ["", "0", "1:0", "a:1", "1:b", "1:2:3", "1.5"]) {
    expect(parseGenerationId(raw)).toBeNull();
  }
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

test("fn-1200 buildTmuxKillWindowArgs: pane metadata is never shell-interpolated — it rides as ONE argv element verbatim", () => {
  // The slot reaper kills a provably-dead occupant's pane by its server-global
  // `%N` id, which tmux mints and is metachar-free by construction. This pins the
  // safety contract regardless: even an adversarial id carrying shell
  // metacharacters survives as a SINGLE argv element (no `sh -c`, no interpolation,
  // no split), so pane metadata can never escape into a shell.
  const hostile = "%7; rm -rf / #$(touch pwned) `id` &";
  const argv = buildTmuxKillWindowArgs(hostile);
  expect(argv).toEqual(["tmux", "kill-window", "-t", hostile]);
  // The whole payload is exactly one argv element — no shell ever sees it.
  expect(argv[3]).toBe(hostile);
  expect(argv).toHaveLength(4);
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

test("createTmuxPaneOps.listPanes: parses (tmuxGenerationId, paneId, windowId, currentCommand, paneDead, sessionName, windowName) from one -a sweep", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:list-panes": {
        stdout:
          "900:1700000000\t%1\t@1\tclaude\t0\tautopilot\twork::fn-1-x.2\n900:1700000000\t%2\t@2\tzsh\t1\tmisc\tplain shell\n",
        exitCode: 0,
      },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.listPanes();
  expect(calls[0]).toEqual(buildTmuxListPanesArgs());
  expect(got).toEqual([
    {
      tmuxGenerationId: "900:1700000000",
      paneId: "%1",
      windowId: "@1",
      currentCommand: "claude",
      paneDead: "0",
      sessionName: "autopilot",
      windowName: "work::fn-1-x.2",
    },
    {
      tmuxGenerationId: "900:1700000000",
      paneId: "%2",
      windowId: "@2",
      currentCommand: "zsh",
      paneDead: "1",
      sessionName: "misc",
      windowName: "plain shell",
    },
  ]);
});

test("createTmuxPaneOps.listPanes: a tab inside a window name stays in windowName (final split)", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:list-panes": {
        // window name itself contains a tab, a colon, and unicode; the six
        // leading fixed fields (generation/pane/window/command/dead/session) are
        // taken off the first six tabs, so a name-internal tab never bleeds into
        // them.
        stdout: "900:1700000000\t%7\t@7\tzsh\t0\tsess\tweird:\tname é\n",
        exitCode: 0,
      },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.listPanes();
  expect(got).toEqual([
    {
      tmuxGenerationId: "900:1700000000",
      paneId: "%7",
      windowId: "@7",
      currentCommand: "zsh",
      paneDead: "0",
      sessionName: "sess",
      windowName: "weird:\tname é",
    },
  ]);
});

test("createTmuxPaneOps.listPanes: drops malformed lines (too few tabs / empty ids), keeps the rest", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:list-panes": {
        // line 1 has no tab; line 2 has only 5 tabs (too few for the six fixed
        // fields); line 3 is 6-tab but has an empty pane id; line 4 is
        // well-formed (and a name may be empty — valid).
        stdout:
          "garbage\n900:1\t%2\t@2\tsh\t0\tsess\n900:1\t\t@3\tsh\t0\tsess\tname\n900:1\t%4\t@4\tsh\t0\tsess\t\n",
        exitCode: 0,
      },
    },
    calls,
  );
  const ops = createTmuxPaneOps({ noteLine: () => {}, spawn });
  const got = await ops.listPanes();
  expect(got).toEqual([
    {
      tmuxGenerationId: "900:1",
      paneId: "%4",
      windowId: "@4",
      currentCommand: "sh",
      paneDead: "0",
      sessionName: "sess",
      windowName: "",
    },
  ]);
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
// keeper agent launch (keeper's sole launch transport) — buildKeeperAgentLaunchArgv
// (byte-pinned), parse, exit-map, and the keeperAgentLaunch
// launch→parse→exit-map→outcome path.
// ---------------------------------------------------------------------------

/**
 * A canned `schema_version:1` keeper agent success line — the cross-repo contract
 * keeper parses. Byte-pinned (with `\n`) so the JSON-parse path is exercised on
 * the real one-line shape keeper agent emits, not a hand-trimmed approximation.
 * Task .4 adds the cross-repo fixture pin; this is the in-test canned form.
 */
const KEEPER_AGENT_OK_LINE = `${JSON.stringify({
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
function makeKeeperAgentSpawnStub(
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
// "agent"]`. Supersedes the standalone `keeper agent` binary path — the launcher
// folded into `keeper agent`.
const LAP = ["/abs/bin/bun", "/abs/cli/keeper.ts", "agent"] as const;

test("buildKeeperAgentLaunchArgv: exact landed-contract invocation (byte-pinned)", () => {
  expect(
    buildKeeperAgentLaunchArgv({
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
    // Serial launch ALWAYS carries an empty lane entry so a stale tmux
    // session-env KEEPER_PLAN_WORKTREE can never be inherited.
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE=",
    // ...and an empty branch entry (the durable-marker sibling), same reason.
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE_BRANCH=",
    // A prompt launch ALWAYS carries the EMPTY identity carrier (the 4th env
    // entry) — a fresh launch never inherits a stale KEEPER_JOB_ID from a reused
    // session env and folds onto someone else's row.
    "--x-tmux-env",
    "KEEPER_JOB_ID=",
    // ...and an empty escalation-role entry (the 5th always-present carrier), so a
    // stale KEEPER_ESCALATION_ROLE can never be inherited by a non-escalation launch.
    "--x-tmux-env",
    "KEEPER_ESCALATION_ROLE=",
    // Dispatched-cell carriers (ADR 0047) — the 6th/7th/8th always-present env,
    // EMPTY on an unconstrained launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_MODEL=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_TIER=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCH_CONSTRAINT=",
    // Wrapped-cell guard carriers (task .1) — the 9th/10th always-present env,
    // EMPTY on a native / non-work launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_WRAPPED_CELL=",
    "--x-tmux-env",
    "KEEPER_WRAPPED_ENVELOPE=",
    "--x-tmux-env",
    "KEEPER_HANDOFF_ENVELOPE=",
    // Keeper-owned worker permission posture (mirrors the pair path); rides every
    // launch, right after the worktree env block and before model/effort/name.
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
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

test("buildKeeperAgentLaunchArgv: a pluginDir emits --plugin-dir right after --name (byte-pinned)", () => {
  expect(
    buildKeeperAgentLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "autopilot",
      prompt: "/plan:work fn-1-x.1",
      claudeName: "work::fn-1-x.1",
      model: "sonnet",
      effort: "max",
      pluginDir: "/abs/keeper/plugins/plan/workers/opus-max",
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
    "KEEPER_PLAN_WORKTREE=",
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE_BRANCH=",
    "--x-tmux-env",
    "KEEPER_JOB_ID=",
    // ...and an empty escalation-role entry (the 5th always-present carrier), so a
    // stale KEEPER_ESCALATION_ROLE can never be inherited by a non-escalation launch.
    "--x-tmux-env",
    "KEEPER_ESCALATION_ROLE=",
    // Dispatched-cell carriers (ADR 0047) — the 6th/7th/8th always-present env,
    // EMPTY on an unconstrained launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_MODEL=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_TIER=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCH_CONSTRAINT=",
    // Wrapped-cell guard carriers (task .1) — the 9th/10th always-present env,
    // EMPTY on a native / non-work launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_WRAPPED_CELL=",
    "--x-tmux-env",
    "KEEPER_WRAPPED_ENVELOPE=",
    "--x-tmux-env",
    "KEEPER_HANDOFF_ENVELOPE=",
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "--model",
    "sonnet",
    "--effort",
    "max",
    "--x-no-confirm",
    "--name",
    "work::fn-1-x.1",
    // The cell flag slots AFTER `--name` so the dispatch-key peel is unaffected.
    "--plugin-dir",
    "/abs/keeper/plugins/plan/workers/opus-max",
    "/plan:work fn-1-x.1",
  ]);
});

test("buildKeeperAgentLaunchArgv: an empty pluginDir emits no --plugin-dir", () => {
  const argv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    session: "autopilot",
    prompt: "/plan:work fn-1-x.1",
    claudeName: "work::fn-1-x.1",
    pluginDir: "",
    noConfirm: true,
  });
  expect(argv).not.toContain("--plugin-dir");
});

test("buildKeeperAgentLaunchArgv: omits absent model/effort/name and the no-confirm flag", () => {
  expect(
    buildKeeperAgentLaunchArgv({
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
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE=",
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE_BRANCH=",
    "--x-tmux-env",
    "KEEPER_JOB_ID=",
    // ...and an empty escalation-role entry (the 5th always-present carrier), so a
    // stale KEEPER_ESCALATION_ROLE can never be inherited by a non-escalation launch.
    "--x-tmux-env",
    "KEEPER_ESCALATION_ROLE=",
    // Dispatched-cell carriers (ADR 0047) — the 6th/7th/8th always-present env,
    // EMPTY on an unconstrained launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_MODEL=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_TIER=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCH_CONSTRAINT=",
    // Wrapped-cell guard carriers (task .1) — the 9th/10th always-present env,
    // EMPTY on a native / non-work launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_WRAPPED_CELL=",
    "--x-tmux-env",
    "KEEPER_WRAPPED_ENVELOPE=",
    "--x-tmux-env",
    "KEEPER_HANDOFF_ENVELOPE=",
    // Permission posture rides even the minimal launch (no model/effort/name).
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "do a thing",
  ]);
});

test("buildKeeperAgentLaunchArgv: resume mode emits --resume <target> and NO trailing prompt (byte-pinned)", () => {
  expect(
    buildKeeperAgentLaunchArgv({
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
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE=",
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE_BRANCH=",
    // Resume mode with NO jobId still carries the identity slot, EMPTY — the value
    // is present only when the caller threads the original job id (pinned below).
    "--x-tmux-env",
    "KEEPER_JOB_ID=",
    // ...and an empty escalation-role entry (the 5th always-present carrier), so a
    // stale KEEPER_ESCALATION_ROLE can never be inherited by a non-escalation launch.
    "--x-tmux-env",
    "KEEPER_ESCALATION_ROLE=",
    // Dispatched-cell carriers (ADR 0047) — the 6th/7th/8th always-present env,
    // EMPTY on an unconstrained launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_MODEL=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_TIER=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCH_CONSTRAINT=",
    // Wrapped-cell guard carriers (task .1) — the 9th/10th always-present env,
    // EMPTY on a native / non-work launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_WRAPPED_CELL=",
    "--x-tmux-env",
    "KEEPER_WRAPPED_ENVELOPE=",
    "--x-tmux-env",
    "KEEPER_HANDOFF_ENVELOPE=",
    // Resume is just as human-less as a fresh launch — the posture rides it too.
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "--x-no-confirm",
    "--resume",
    "planner-session",
  ]);
});

test("buildKeeperAgentLaunchArgv: an empty resumeTarget falls back to prompt mode", () => {
  // A degenerate empty target must NOT emit `--resume ""` (a quoting/UX hazard);
  // it falls through to the trailing prompt positional.
  expect(
    buildKeeperAgentLaunchArgv({
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
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE=",
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE_BRANCH=",
    "--x-tmux-env",
    "KEEPER_JOB_ID=",
    // ...and an empty escalation-role entry (the 5th always-present carrier), so a
    // stale KEEPER_ESCALATION_ROLE can never be inherited by a non-escalation launch.
    "--x-tmux-env",
    "KEEPER_ESCALATION_ROLE=",
    // Dispatched-cell carriers (ADR 0047) — the 6th/7th/8th always-present env,
    // EMPTY on an unconstrained launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_MODEL=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_TIER=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCH_CONSTRAINT=",
    // Wrapped-cell guard carriers (task .1) — the 9th/10th always-present env,
    // EMPTY on a native / non-work launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_WRAPPED_CELL=",
    "--x-tmux-env",
    "KEEPER_WRAPPED_ENVELOPE=",
    "--x-tmux-env",
    "KEEPER_HANDOFF_ENVELOPE=",
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "fallback prompt",
  ]);
});

test("buildKeeperAgentLaunchArgv: Pi resume emits `--session <t>`", () => {
  const pi = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    session: "s",
    prompt: "",
    resumeTarget: "pi-42",
    harness: "pi",
    noConfirm: true,
  });
  expect(pi.slice(-2)).toEqual(["--session", "pi-42"]);
  expect(pi[LAP.length]).toBe("pi");
  expect(pi).not.toContain("--dangerously-skip-permissions");
});

test("buildKeeperAgentLaunchArgv: an explicit claude harness is byte-identical to the default", () => {
  const base = {
    launcherArgvPrefix: LAP,
    session: "agentbus",
    prompt: "",
    resumeTarget: "planner-session",
    noConfirm: true,
  };
  expect(buildKeeperAgentLaunchArgv({ ...base, harness: "claude" })).toEqual(
    buildKeeperAgentLaunchArgv(base),
  );
});

test("buildKeeperAgentLaunchArgv: a resume launch with a jobId carries KEEPER_JOB_ID=<id> as the 4th env carrier", () => {
  // The identity carrier the revived non-claude harness folds onto its existing
  // row from — distinct from the harness-native resume target in the tail.
  const argv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    session: "s",
    prompt: "",
    resumeTarget: "d98a2d54-native",
    jobId: "45f94c4d-orig",
    harness: "pi",
    noConfirm: true,
  });
  // Exactly one identity carrier, valued with the ORIGINAL job id.
  const idEntries = argv.filter((a) => a.startsWith("KEEPER_JOB_ID="));
  expect(idEntries).toEqual(["KEEPER_JOB_ID=45f94c4d-orig"]);
  // It is the FOURTH repeated env entry (after session/lane/branch), each preceded
  // by its own `--x-tmux-env`.
  const idx = argv.indexOf("KEEPER_JOB_ID=45f94c4d-orig");
  expect(argv[idx - 1]).toBe("--x-tmux-env");
  // Eleven repeated env carriers: session/lane/branch/job-id/escalation-role +
  // three dispatched-cell carriers + two wrapped-cell carriers + the always-empty
  // handoff-envelope stale-overwrite carrier.
  expect(argv.filter((a) => a === "--x-tmux-env")).toHaveLength(11);
  // Identity (job id) and the resume key (native target) stay DISTINCT.
  expect(argv.slice(-2)).toEqual(["--session", "d98a2d54-native"]);
  expect(idEntries[0]).not.toContain("d98a2d54-native");
});

test("buildKeeperAgentLaunchArgv: a PROMPT launch emits the EMPTY overwrite even when a jobId is passed (stale-identity guard)", () => {
  // A fresh prompted launch must NEVER carry an identity — the empty overwrite
  // clears any stale KEEPER_JOB_ID a prior resume left in a reused session env.
  const argv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    session: "autopilot",
    prompt: "/plan:work fn-1-x.1",
    jobId: "should-not-leak",
    noConfirm: true,
  });
  const idEntries = argv.filter((a) => a.startsWith("KEEPER_JOB_ID="));
  expect(idEntries).toEqual(["KEEPER_JOB_ID="]);
  expect(argv.join(" ")).not.toContain("should-not-leak");
});

test("buildKeeperAgentLaunchArgv: a worktree-mode launch emits a 2nd --x-tmux-env KEEPER_PLAN_WORKTREE (byte-pinned)", () => {
  expect(
    buildKeeperAgentLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "autopilot",
      prompt: "/plan:work fn-1-x.1",
      claudeName: "work::fn-1-x.1",
      model: "sonnet",
      effort: "max",
      worktreePath: "/private/var/wt/repo--keeper-epic-fn-1-x",
      worktreeBranch: "keeper/epic/fn-1-x",
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
    // The 3rd repeated env entry — the durable lane-branch marker.
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE_BRANCH=keeper/epic/fn-1-x",
    "--x-tmux-env",
    "KEEPER_JOB_ID=",
    // The 5th carrier — empty here (a work launch, not an escalation).
    "--x-tmux-env",
    "KEEPER_ESCALATION_ROLE=",
    // Dispatched-cell carriers (ADR 0047) — the 6th/7th/8th always-present env,
    // EMPTY on an unconstrained launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_MODEL=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_TIER=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCH_CONSTRAINT=",
    // Wrapped-cell guard carriers (task .1) — the 9th/10th always-present env,
    // EMPTY on a native / non-work launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_WRAPPED_CELL=",
    "--x-tmux-env",
    "KEEPER_WRAPPED_ENVELOPE=",
    "--x-tmux-env",
    "KEEPER_HANDOFF_ENVELOPE=",
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
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

test("buildKeeperAgentLaunchArgv: a worktree-mode RESUME re-injects KEEPER_PLAN_WORKTREE before --resume (byte-pinned)", () => {
  // A resumed worktree worker must NOT re-resolve to the main checkout, so the
  // lane env rides resume mode too — emitted before the `--resume` tail.
  expect(
    buildKeeperAgentLaunchArgv({
      launcherArgvPrefix: LAP,
      session: "autopilot",
      prompt: "", // unused in resume mode
      resumeTarget: "work::fn-1-x.1",
      worktreePath: "/private/var/wt/repo--keeper-epic-fn-1-x",
      worktreeBranch: "keeper/epic/fn-1-x--fn-1-x.2",
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
    "--x-tmux-env",
    "KEEPER_PLAN_WORKTREE_BRANCH=keeper/epic/fn-1-x--fn-1-x.2",
    "--x-tmux-env",
    "KEEPER_JOB_ID=",
    // The 5th carrier — empty here (a worktree resume, not an escalation).
    "--x-tmux-env",
    "KEEPER_ESCALATION_ROLE=",
    // Dispatched-cell carriers (ADR 0047) — the 6th/7th/8th always-present env,
    // EMPTY on an unconstrained launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_MODEL=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCHED_TIER=",
    "--x-tmux-env",
    "KEEPER_PLAN_DISPATCH_CONSTRAINT=",
    // Wrapped-cell guard carriers (task .1) — the 9th/10th always-present env,
    // EMPTY on a native / non-work launch (byte-inert).
    "--x-tmux-env",
    "KEEPER_WRAPPED_CELL=",
    "--x-tmux-env",
    "KEEPER_WRAPPED_ENVELOPE=",
    "--x-tmux-env",
    "KEEPER_HANDOFF_ENVELOPE=",
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "--x-no-confirm",
    "--resume",
    "work::fn-1-x.1",
  ]);
});

test("buildKeeperAgentLaunchArgv: serial (empty/absent worktreePath) ALWAYS emits one empty KEEPER_PLAN_WORKTREE entry — so a stale tmux session-env lane can never leak in", () => {
  const base = {
    launcherArgvPrefix: LAP,
    session: "autopilot",
    prompt: "/plan:work fn-1-x.1",
    claudeName: "work::fn-1-x.1",
    model: "sonnet",
    effort: "max",
    noConfirm: true,
  } as const;
  // An explicit empty worktreePath / worktreeBranch is byte-identical to
  // omitting it: both emit the single empty entry that OVERWRITES any stale
  // `-e` session value.
  const absent = buildKeeperAgentLaunchArgv(base);
  expect(
    buildKeeperAgentLaunchArgv({
      ...base,
      worktreePath: "",
      worktreeBranch: "",
    }),
  ).toEqual(absent);
  const laneEntries = absent.filter((a) =>
    a.startsWith("KEEPER_PLAN_WORKTREE="),
  );
  expect(laneEntries).toEqual(["KEEPER_PLAN_WORKTREE="]);
  // The branch sibling is ALSO always-emitted-empty in serial — the stale-leak
  // guard applies to the durable marker exactly as it does to the lane path.
  const branchEntries = absent.filter((a) =>
    a.startsWith("KEEPER_PLAN_WORKTREE_BRANCH="),
  );
  expect(branchEntries).toEqual(["KEEPER_PLAN_WORKTREE_BRANCH="]);
  // ...and the escalation-role carrier is the 5th always-emitted-empty sibling,
  // so a non-escalation launch reusing a tmux session cannot inherit a stale role.
  const roleEntries = absent.filter((a) =>
    a.startsWith("KEEPER_ESCALATION_ROLE="),
  );
  expect(roleEntries).toEqual(["KEEPER_ESCALATION_ROLE="]);
});

test("buildKeeperAgentLaunchArgv: an escalation launch carries the verb in KEEPER_ESCALATION_ROLE, still one entry (byte-pinned)", () => {
  const argv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    session: "autopilot",
    prompt: "/plan:unblock fn-1-x.3",
    claudeName: "unblock::fn-1-x.3",
    escalationRole: "unblock",
    noConfirm: true,
  });
  // Exactly one role entry, carrying the escalation verb — emitted right after the
  // job-identity carrier and before the permission posture.
  const roleEntries = argv.filter((a) =>
    a.startsWith("KEEPER_ESCALATION_ROLE="),
  );
  expect(roleEntries).toEqual(["KEEPER_ESCALATION_ROLE=unblock"]);
  const branchIdx = argv.indexOf("KEEPER_PLAN_WORKTREE_BRANCH=");
  expect(argv[branchIdx + 1]).toBe("--x-tmux-env");
  expect(argv[branchIdx + 2]).toBe("KEEPER_JOB_ID=");
  expect(argv[branchIdx + 3]).toBe("--x-tmux-env");
  expect(argv[branchIdx + 4]).toBe("KEEPER_ESCALATION_ROLE=unblock");
  // Then the three always-present dispatched-cell carriers (ADR 0047), EMPTY on a
  // non-work escalation launch, before the permission posture.
  expect(argv[branchIdx + 5]).toBe("--x-tmux-env");
  expect(argv[branchIdx + 6]).toBe("KEEPER_PLAN_DISPATCHED_MODEL=");
  expect(argv[branchIdx + 7]).toBe("--x-tmux-env");
  expect(argv[branchIdx + 8]).toBe("KEEPER_PLAN_DISPATCHED_TIER=");
  expect(argv[branchIdx + 9]).toBe("--x-tmux-env");
  expect(argv[branchIdx + 10]).toBe("KEEPER_PLAN_DISPATCH_CONSTRAINT=");
  // Then the two always-present wrapped-cell guard carriers (task .1), EMPTY on a
  // non-work escalation launch, before the permission posture.
  expect(argv[branchIdx + 11]).toBe("--x-tmux-env");
  expect(argv[branchIdx + 12]).toBe("KEEPER_WRAPPED_CELL=");
  expect(argv[branchIdx + 13]).toBe("--x-tmux-env");
  expect(argv[branchIdx + 14]).toBe("KEEPER_WRAPPED_ENVELOPE=");
  // Then the always-present handoff carrier clears any stale capture destination.
  expect(argv[branchIdx + 15]).toBe("--x-tmux-env");
  expect(argv[branchIdx + 16]).toBe("KEEPER_HANDOFF_ENVELOPE=");
  expect(argv[branchIdx + 17]).toBe("--permission-mode");
});

test("buildKeeperAgentLaunchArgv: a constrained work launch carries the dispatched cell + constraint (ADR 0047)", () => {
  const argv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    session: "autopilot",
    prompt: "/plan:work fn-1-x.1",
    claudeName: "work::fn-1-x.1",
    model: "sonnet",
    effort: "max",
    pluginDir: "/abs/keeper/plugins/plan/workers/gpt-5.6-sol-max",
    dispatchedModel: "gpt-5.6-sol",
    dispatchedTier: "max",
    dispatchConstraint: "gpt",
    noConfirm: true,
  });
  // Exactly one of each carrier, valued with the translated cell + the pin.
  expect(
    argv.filter((a) => a.startsWith("KEEPER_PLAN_DISPATCHED_MODEL=")),
  ).toEqual(["KEEPER_PLAN_DISPATCHED_MODEL=gpt-5.6-sol"]);
  expect(
    argv.filter((a) => a.startsWith("KEEPER_PLAN_DISPATCHED_TIER=")),
  ).toEqual(["KEEPER_PLAN_DISPATCHED_TIER=max"]);
  expect(
    argv.filter((a) => a.startsWith("KEEPER_PLAN_DISPATCH_CONSTRAINT=")),
  ).toEqual(["KEEPER_PLAN_DISPATCH_CONSTRAINT=gpt"]);
  // Each is preceded by its own `--x-tmux-env`.
  const modelIdx = argv.indexOf("KEEPER_PLAN_DISPATCHED_MODEL=gpt-5.6-sol");
  expect(argv[modelIdx - 1]).toBe("--x-tmux-env");
});

test("buildKeeperAgentLaunchArgv: a wrapped-cell work launch carries the marker cell + envelope (task .1)", () => {
  const argv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    session: "autopilot",
    prompt: "/plan:work fn-1-x.1",
    claudeName: "work::fn-1-x.1",
    model: "sonnet",
    effort: "max",
    pluginDir: "/abs/keeper/plugins/plan/workers/gpt-5.6-sol-max",
    wrappedCell: "gpt-5.6-sol::max",
    wrappedEnvelope: "/repo/.keeper/state/wrapped-envelopes/fn-1-x.1.json",
    noConfirm: true,
  });
  // Exactly one of each carrier, valued with the effective cell + the envelope path.
  expect(argv.filter((a) => a.startsWith("KEEPER_WRAPPED_CELL="))).toEqual([
    "KEEPER_WRAPPED_CELL=gpt-5.6-sol::max",
  ]);
  expect(argv.filter((a) => a.startsWith("KEEPER_WRAPPED_ENVELOPE="))).toEqual([
    "KEEPER_WRAPPED_ENVELOPE=/repo/.keeper/state/wrapped-envelopes/fn-1-x.1.json",
  ]);
  // Each is preceded by its own `--x-tmux-env`, and both sit AFTER the dispatched-
  // cell carriers, BEFORE the claude permission posture.
  const cellIdx = argv.indexOf("KEEPER_WRAPPED_CELL=gpt-5.6-sol::max");
  expect(argv[cellIdx - 1]).toBe("--x-tmux-env");
  expect(argv.indexOf("KEEPER_PLAN_DISPATCH_CONSTRAINT=")).toBeLessThan(
    cellIdx,
  );
  expect(cellIdx).toBeLessThan(argv.indexOf("--permission-mode"));
});

test("buildKeeperAgentLaunchArgv: a handoff envelope carrier follows the wrapped pair", () => {
  const argv = buildKeeperAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    session: "work",
    prompt: "autonomous brief",
    handoffEnvelope: "/durable/handoffs/h-1.json",
    noConfirm: true,
  });
  const envelopeIdx = argv.indexOf(
    "KEEPER_HANDOFF_ENVELOPE=/durable/handoffs/h-1.json",
  );
  expect(argv[envelopeIdx - 1]).toBe("--x-tmux-env");
  expect(argv.indexOf("KEEPER_WRAPPED_ENVELOPE=")).toBeLessThan(envelopeIdx);
  expect(envelopeIdx).toBeLessThan(argv.indexOf("--permission-mode"));
});

test("buildKeeperAgentLaunchArgv: exact attempt metadata is emitted for Claude and Pi", () => {
  const base = {
    launcherArgvPrefix: ["/bun", "/keeper.ts", "agent"],
    session: "work",
    prompt: "/plan:work fn-1-x.1",
    noConfirm: true,
    dispatchAttemptId: 42,
  } as const;
  const claude = buildKeeperAgentLaunchArgv(base);
  expect(
    claude.filter((arg) => arg.startsWith("KEEPER_DISPATCH_ATTEMPT_ID=")),
  ).toEqual(["KEEPER_DISPATCH_ATTEMPT_ID=42"]);
  const pi = buildKeeperAgentLaunchArgv({ ...base, harness: "pi" });
  expect(
    pi.filter((arg) => arg.startsWith("KEEPER_DISPATCH_ATTEMPT_ID=")),
  ).toEqual(["KEEPER_DISPATCH_ATTEMPT_ID=42"]);
});

test("buildKeeperAgentLaunchArgv: empty harness remains Claude; unregistered harnesses are rejected", () => {
  const base = {
    launcherArgvPrefix: LAP,
    session: "agentbus",
    prompt: "",
    resumeTarget: "session-1",
    noConfirm: true,
  } as const;
  expect(buildKeeperAgentLaunchArgv({ ...base, harness: "" })).toEqual(
    buildKeeperAgentLaunchArgv(base),
  );
  expect(() =>
    buildKeeperAgentLaunchArgv({ ...base, harness: "codex" }),
  ).toThrow("unknown harness 'codex'");
  expect(() =>
    buildKeeperAgentLaunchArgv({ ...base, harness: "hermes" }),
  ).toThrow("unknown harness 'hermes'");
});

test("buildKeeperAgentLaunchArgv: every worker launch carries keeper-owned permission posture (skip-permissions + acceptEdits, mirroring the pair path)", () => {
  // The load-bearing severance: a worker is a detached automated session with no
  // human to answer a prompt, so keeper OWNS its permission posture rather than
  // leaning on any host auto-approve hook. Both flags ride, in the pair-path
  // order (`--permission-mode acceptEdits` then `--dangerously-skip-permissions`).
  const posture = [
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
  ];
  const containsPosture = (argv: readonly string[]): boolean => {
    for (let i = 0; i + posture.length <= argv.length; i++) {
      if (posture.every((tok, j) => argv[i + j] === tok)) return true;
    }
    return false;
  };
  // Prompt mode.
  expect(
    containsPosture(
      buildKeeperAgentLaunchArgv({
        launcherArgvPrefix: LAP,
        session: "autopilot",
        prompt: "/plan:work fn-1-x.1",
        claudeName: "work::fn-1-x.1",
        model: "sonnet",
        effort: "max",
        noConfirm: true,
      }),
    ),
  ).toBe(true);
  // Resume mode — a resumed worker is just as human-less, so it rides too.
  expect(
    containsPosture(
      buildKeeperAgentLaunchArgv({
        launcherArgvPrefix: LAP,
        session: "agentbus",
        prompt: "",
        resumeTarget: "planner-session",
        noConfirm: true,
      }),
    ),
  ).toBe(true);
});

// --- parseKeeperAgentStdout ---

test("parseKeeperAgentStdout: a schema_version:1 line → ok", () => {
  expect(parseKeeperAgentStdout(KEEPER_AGENT_OK_LINE)).toEqual({ ok: true });
});

test("parseKeeperAgentStdout: tolerates a banner line before the JSON line", () => {
  expect(
    parseKeeperAgentStdout(`some startup banner\n${KEEPER_AGENT_OK_LINE}`),
  ).toEqual({ ok: true });
});

test("parseKeeperAgentStdout: schema_version:2 → permanent fail (contract drift)", () => {
  const line = `${JSON.stringify({ schema_version: 2, session: "autopilot" })}\n`;
  const res = parseKeeperAgentStdout(line);
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("schema_version");
  }
});

test("parseKeeperAgentStdout: empty stdout → INTERNAL fail", () => {
  const res = parseKeeperAgentStdout("");
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("no parseable schema_version");
  }
});

test("parseKeeperAgentStdout: non-JSON noise only → INTERNAL fail", () => {
  const res = parseKeeperAgentStdout("not json\nstill not json\n");
  expect(res.ok).toBe(false);
});

test("parseKeeperAgentStdout: a JSON object without schema_version → INTERNAL fail naming the missing field", () => {
  const res = parseKeeperAgentStdout(`${JSON.stringify({ session: "x" })}\n`);
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("no schema_version");
  }
});

test("KEEPER_AGENT_SCHEMA_VERSION is pinned at 1 (cross-repo contract)", () => {
  expect(KEEPER_AGENT_SCHEMA_VERSION).toBe(1);
});

// --- cross-repo drift guard: byte-pinned keeper agent stdout fixture ---

/**
 * The JSON shape + exit-code taxonomy is a cross-repo contract with NO shared
 * module (keeper agent `src/main.ts` `tmuxMetadata` / `tmux-launch.ts` `TMUX_EXIT`
 * on one side, keeper `parseKeeperAgentStdout` / `KEEPER_AGENT_TMUX_EXIT` on the
 * other). `test/fixtures/keeper-agent-launch-stdout.json` is ONE line of real
 * `keeper agent claude --x-tmux --x-tmux-detached …` stdout
 * (captured from the binary, not hand-authored), so these tests fail loudly the
 * moment keeper agent's emitted shape or keeper's parser drifts apart. Recapture
 * the fixture from real output when the contract is intentionally bumped.
 */
const KEEPER_AGENT_FIXTURE_STDOUT = await Bun.file(
  new URL("./fixtures/keeper-agent-launch-stdout.jsonl", import.meta.url),
).text();

test("fixture: keeper's parser consumes keeper agent's real launch stdout → ok", () => {
  expect(parseKeeperAgentStdout(KEEPER_AGENT_FIXTURE_STDOUT)).toEqual({
    ok: true,
  });
});

test("fixture: the real line carries schema_version === KEEPER_AGENT_SCHEMA_VERSION and the top-level bind points", () => {
  const obj = JSON.parse(KEEPER_AGENT_FIXTURE_STDOUT.trim()) as Record<
    string,
    unknown
  >;
  // The version keeper validates against.
  expect(obj.schema_version).toBe(KEEPER_AGENT_SCHEMA_VERSION);
  // The stable top-level bind points keeper documents (discarded at runtime —
  // binding is hook-based — but their PRESENCE is the contract).
  expect(typeof obj.session).toBe("string");
  expect(typeof obj.windowId).toBe("string");
  expect(typeof obj.paneId).toBe("string");
});

test("fixture-fed keeperAgentLaunch: exit 0 + real stdout → ok (full launch→parse→map path)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeKeeperAgentSpawnStub(
    LAP,
    { stdout: KEEPER_AGENT_FIXTURE_STDOUT, exitCode: 0 },
    records,
  );
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: an unregistered harness fails before spawn", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const warnings: string[] = [];
  const spawn = makeKeeperAgentSpawnStub(
    LAP,
    { stdout: KEEPER_AGENT_FIXTURE_STDOUT, exitCode: 0 },
    records,
  );
  const res = await keeperAgentLaunch({
    noteLine: (line) => warnings.push(line),
    launcherArgvPrefix: LAP,
    session: "agentbus",
    cwd: "/repo",
    label: "retired resume",
    spec: { prompt: "", resumeTarget: "old-session", harness: "codex" },
    spawn,
  });
  expect(res).toEqual({
    ok: false,
    error:
      "keeper agent launch rejected for retired resume: unknown harness 'codex'",
  });
  expect(records).toEqual([]);
  expect(warnings.join("\n")).toContain("unknown harness 'codex'");
});

test("KEEPER_AGENT_TMUX_EXIT mirrors keeper agent's landed TMUX_EXIT taxonomy (1/2/3/4) and maps to the right outcome class", () => {
  // The exit-code numbers MUST match keeper agent's `TMUX_EXIT`
  // (src/tmux-launch.ts): INTERNAL=1, BAD_ARGS=2, NOOP=3, RETRYABLE=4.
  expect(KEEPER_AGENT_TMUX_EXIT.INTERNAL).toBe(1);
  expect(KEEPER_AGENT_TMUX_EXIT.BAD_ARGS).toBe(2);
  expect(KEEPER_AGENT_TMUX_EXIT.NOOP).toBe(3);
  expect(KEEPER_AGENT_TMUX_EXIT.RETRYABLE).toBe(4);
  // …and the central map routes each to its outcome class: only RETRYABLE(4)
  // is transient; INTERNAL/BAD_ARGS/NOOP are permanent (no retryable).
  const ok: LaunchResult = { ok: true };
  expect(
    mapKeeperAgentExit(KEEPER_AGENT_TMUX_EXIT.RETRYABLE, ok),
  ).toMatchObject({
    ok: false,
    retryable: true,
  });
  for (const code of [
    KEEPER_AGENT_TMUX_EXIT.INTERNAL,
    KEEPER_AGENT_TMUX_EXIT.BAD_ARGS,
    KEEPER_AGENT_TMUX_EXIT.NOOP,
  ]) {
    const res = mapKeeperAgentExit(code, ok);
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.retryable).toBeUndefined();
    }
  }
});

// --- mapKeeperAgentExit (the ONE central exit map, table-driven) ---

test("mapKeeperAgentExit: 0 + valid parse → ok", () => {
  expect(mapKeeperAgentExit(0, { ok: true })).toEqual({ ok: true });
});

test("mapKeeperAgentExit: 0 + bad parse → PERMANENT (unconfirmed launch, never retry)", () => {
  const res = mapKeeperAgentExit(0, { ok: false, error: "no json" });
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.retryable).toBeUndefined();
  }
});

test("mapKeeperAgentExit: exit-code → outcome class table (1/2/3 permanent, 4 transient, unknown permanent)", () => {
  const ok: LaunchResult = { ok: true };
  // 4 RETRYABLE → transient.
  const four = mapKeeperAgentExit(4, ok);
  expect(four).toMatchObject({ ok: false, retryable: true });
  // 3 NOOP, 1 INTERNAL, 2 BAD_ARGS, and an unknown code → permanent (no retryable).
  for (const code of [1, 2, 3, 99]) {
    const res = mapKeeperAgentExit(code, ok);
    expect(res.ok).toBe(false);
    if (res.ok === false) {
      expect(res.retryable).toBeUndefined();
    }
  }
});

// --- keeperAgentLaunch (launch→parse→exit-map→outcome) ---

test("keeperAgentLaunch: exit 0 + valid JSON → ok; spawns the keeper agent argv with worker cwd on the spawn", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeKeeperAgentSpawnStub(
    LAP,
    { stdout: KEEPER_AGENT_OK_LINE, exitCode: 0 },
    records,
  );
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: exit 4 RETRYABLE → transient ({ ok:false, retryable:true })", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeKeeperAgentSpawnStub(LAP, { exitCode: 4 }, records);
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: exit 3 NOOP → permanent (no retryable)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeKeeperAgentSpawnStub(LAP, { exitCode: 3 }, records);
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: exit 2 BAD_ARGS → permanent (keeper built a bad argv)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeKeeperAgentSpawnStub(LAP, { exitCode: 2 }, records);
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: exit 0 but schema_version:2 stdout → permanent (unconfirmed)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeKeeperAgentSpawnStub(
    LAP,
    { stdout: `${JSON.stringify({ schema_version: 2 })}\n`, exitCode: 0 },
    records,
  );
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: exit 0 but empty stdout → permanent (INTERNAL, unconfirmed)", async () => {
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeKeeperAgentSpawnStub(
    LAP,
    { stdout: "", exitCode: 0 },
    records,
  );
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: timeout-kill (runCapture null) → transient", async () => {
  // A spawn whose `exited` never resolves forces the kill-timeout path; a tiny
  // captureTimeoutMs pins it without a real wait.
  const spawn: SpawnFn = (_cmd, _options) => ({
    exited: new Promise<number>(() => {}), // never resolves
    stdout: new Response("").body,
    stderr: new Response("").body,
    kill: () => {},
  });
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: ENOENT (bad launcher) → transient, loud (noteLine warned)", async () => {
  const warnings: string[] = [];
  // A spawn that throws models ENOENT (missing bun / keeper.ts).
  const spawn: SpawnFn = () => {
    throw new Error("ENOENT");
  };
  const res = await keeperAgentLaunch({
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

test("keeperAgentLaunch: a per-call session targets that session, not the managed default", async () => {
  // Manual `keeper dispatch` passes a per-call session (the resolved foreground /
  // current session) rather than the hardcoded managed one.
  const records: Array<{ cmd: string[]; cwd?: string }> = [];
  const spawn = makeKeeperAgentSpawnStub(
    LAP,
    { stdout: KEEPER_AGENT_OK_LINE, exitCode: 0 },
    records,
  );
  const res = await keeperAgentLaunch({
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
    stdout:
      "900:1\t%4\t@1\twin-a\n900:1\t%5\t@2\twin-b\n900:1\t%6\t@3\twin-c\n",
  });
  expect(classifyCloseKind("%5", { spawnSync: probe })).toBe("pid_died");
});

test("classifyCloseKind: server alive, pane gone → window_gone_server_alive", () => {
  const { probe } = makeSyncProbe({
    stdout: "900:1\t%4\t@1\twin-a\n900:1\t%6\t@3\twin-c\n",
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
  const { probe } = makeSyncProbe({ stdout: "900:1\t%4\t@1\twin-a\n" });
  expect(classifyCloseKind(null, { spawnSync: probe })).toBe("unknown");
  expect(classifyCloseKind("", { spawnSync: probe })).toBe("unknown");
});

test("classifyCloseKind: pane match is exact, not a substring spoof", () => {
  // A window name containing the literal pane text must NOT read as present —
  // only the pane-id field counts. Otherwise a crash-kill whose pane is truly
  // gone would misclassify as pid_died and never be a clean user-close, or worse
  // a user-close would masquerade as a live pane.
  const { probe } = makeSyncProbe({
    stdout: "900:1\t%4\t@1\tnamed %5 in the title\n",
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
