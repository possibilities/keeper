/**
 * Pure-function + argv-construction tests for `src/exec-backend.ts`.
 *
 * Coverage:
 *  - `buildGhosttyLaunchArgs` / `buildGhosttyCloseArgs` produce the
 *    osascript shape the live Ghostty path used pre-fn-650 (so the
 *    backend extraction is verbatim).
 *  - `buildZellijNewTabArgs` / `buildZellijCloseTabArgs` /
 *    `buildZellijListSessionsArgs` / `buildZellijAttachBgArgs`
 *    produce the zellij CLI shape the live spec calls for.
 *  - `createGhosttyBackend` + `createZellijBackend` route through an
 *    INJECTED spawn fn — no real `osascript` or `zellij` process is
 *    ever launched.
 *  - `resolveExecBackend` picks ghostty/zellij by name, defaults to
 *    zellij, falls back to zellij on an unknown name with a noteLine.
 *
 * No filesystem or process side effects: every spawn is a stub that
 * returns canned stdout/stderr/exit-code via in-memory streams.
 */

import { expect, test } from "bun:test";
import {
  buildGhosttyCloseArgs,
  buildGhosttyLaunchArgs,
  buildZellijAttachBgArgs,
  buildZellijCloseTabArgs,
  buildZellijListSessionsArgs,
  buildZellijNewTabArgs,
  createGhosttyBackend,
  createZellijBackend,
  DEFAULT_EXEC_BACKEND,
  DEFAULT_ZELLIJ_SESSION,
  resolveExecBackend,
  type SpawnFn,
} from "../src/exec-backend";

/**
 * Build a `SpawnFn` stub that records every spawn into `calls` and
 * resolves with canned exit + stdout/stderr from a per-prefix table.
 * The table key matches the first argv element (e.g. `"osascript"`,
 * `"zellij"`, `"sh"`) — for zellij we need to vary by subcommand, so
 * the matching key is `"<cmd>:<arg2>"` (e.g. `"zellij:action"` vs
 * `"zellij:list-sessions"` vs `"zellij:attach"`).
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
    // Resolve table key: first try `cmd[0]:cmd[1]` (zellij subcommand
    // disambiguation), then bare `cmd[0]`.
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
    };
  };
}

// ---------------------------------------------------------------------------
// Pure-builder coverage
// ---------------------------------------------------------------------------

test("buildGhosttyLaunchArgs: wraps argv into osascript surface-config sequence", () => {
  const argv = [
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    "cd /tmp/proj && claude --name work::fn-1-x.1 '/plan:work fn-1-x.1'",
  ];
  const got = buildGhosttyLaunchArgs(argv);
  expect(got[0]).toBe("osascript");
  // Each AppleScript line is preceded by a -e flag.
  const eFlags = got.filter((s) => s === "-e");
  expect(eFlags.length).toBeGreaterThan(0);
  // The configured `tell application "Ghostty"` opener must be present.
  expect(got).toContain('tell application "Ghostty"');
  expect(got).toContain("set cfg to new surface configuration");
  expect(got).toContain("set w to new window with configuration cfg");
  expect(got).toContain("return id of w");
  expect(got).toContain("end tell");
  // The `command of cfg` line must contain the worker command body
  // (so the AppleScript wraps the argv into a single command string).
  const cmdSetLine = got.find((s) => s.startsWith("set command of cfg to "));
  expect(cmdSetLine).toBeDefined();
  expect(cmdSetLine).toContain("/plan:work fn-1-x.1");
  expect(cmdSetLine).toContain("/bin/zsh");
});

test("buildGhosttyCloseArgs: repeat-loop osascript form with -2741/-1708 gotcha preserved in source", () => {
  const got = buildGhosttyCloseArgs("tab-group-12345");
  expect(got[0]).toBe("osascript");
  expect(got).toContain('set wid to "tab-group-12345"');
  // The repeat-loop is the ONLY form that reaps a Ghostty surface; the
  // -2741/-1708 gotcha comments live in the module source.
  expect(got).toContain("repeat with w in every window");
  expect(got).toContain("if id of w is wid then");
  expect(got).toContain("close window w");
  expect(got).toContain('return "not-found"');
});

test("buildZellijNewTabArgs: emits --cwd <abs> -- <argv> after session+action selectors", () => {
  const got = buildZellijNewTabArgs("autopilot", "/Users/mike/code/keeper", [
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    "echo hi",
  ]);
  expect(got).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "new-tab",
    "--cwd",
    "/Users/mike/code/keeper",
    "--",
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    "echo hi",
  ]);
});

test("buildZellijCloseTabArgs: routes through close-tab-by-id <id>", () => {
  expect(buildZellijCloseTabArgs("autopilot", "7")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "close-tab-by-id",
    "7",
  ]);
});

test("buildZellijListSessionsArgs / buildZellijAttachBgArgs: well-formed", () => {
  expect(buildZellijListSessionsArgs()).toEqual(["zellij", "list-sessions"]);
  expect(buildZellijAttachBgArgs("autopilot")).toEqual([
    "zellij",
    "attach",
    "-b",
    "autopilot",
  ]);
});

// ---------------------------------------------------------------------------
// Ghostty backend behavior (injected spawn — no real osascript)
// ---------------------------------------------------------------------------

test("createGhosttyBackend.launch: captures windowId from osascript stdout", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn = makeSpawnStub(
    {
      osascript: { stdout: "tab-group-12345\n", exitCode: 0 },
      // The yabai sh -c step is fire-and-forget; stub it to a no-op
      // so the stub doesn't complain about an unmatched key.
      sh: { stdout: "", exitCode: 0 },
    },
    calls,
  );
  const backend = createGhosttyBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  const windowId = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "row-1",
    "/tmp/proj",
  );
  expect(windowId).toBe("tab-group-12345");
  // Two spawn calls: osascript first, then the yabai fire-and-forget.
  expect(calls[0]?.[0]).toBe("osascript");
  expect(calls[1]?.[0]).toBe("sh");
  // No stderr → no warn lines.
  expect(notes).toEqual([]);
});

test("createGhosttyBackend.launch: non-zero exit returns null and warns", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn = makeSpawnStub(
    {
      osascript: { stdout: "", stderr: "boom", exitCode: 1 },
      sh: { stdout: "" },
    },
    calls,
  );
  const backend = createGhosttyBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  const windowId = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "x"],
    "row-1",
    "/tmp/proj",
  );
  expect(windowId).toBeNull();
  // Both the stderr surface AND the exit-non-zero warn must land.
  expect(notes.some((s) => s.includes("stderr (row-1)"))).toBe(true);
  expect(notes.some((s) => s.includes("exited non-zero (1)"))).toBe(true);
});

test("createGhosttyBackend.close: spawns osascript with the repeat-loop close argv", () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn = makeSpawnStub(
    { osascript: { stdout: "", exitCode: 0 } },
    calls,
  );
  const backend = createGhosttyBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  backend.close("tab-group-42");
  expect(calls.length).toBe(1);
  expect(calls[0]?.[0]).toBe("osascript");
  expect(calls[0]).toContain('set wid to "tab-group-42"');
  expect(calls[0]).toContain("repeat with w in every window");
});

// ---------------------------------------------------------------------------
// Zellij backend behavior (injected spawn — no real zellij)
// ---------------------------------------------------------------------------

test("createZellijBackend.launch: session already listed → straight to new-tab; captures tab id", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": {
        stdout: "autopilot [Created 5s ago]\n",
        exitCode: 0,
      },
      // `action new-tab` lives under the `--session` switch, so the
      // table key matches `cmd[0]:cmd[1]` = `zellij:--session`.
      "zellij:--session": { stdout: "7\n", exitCode: 0 },
    },
    calls,
  );
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const tabId = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "row-1",
    "/tmp/proj",
  );
  expect(tabId).toBe("7");
  // Order: list-sessions (the steady-state probe), then new-tab.
  // No attach because the session was already listed.
  expect(calls[0]?.[1]).toBe("list-sessions");
  expect(calls[1]?.slice(0, 5)).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "new-tab",
  ]);
  // --cwd was threaded through; argv landed after `--`.
  expect(calls[1]).toContain("--cwd");
  expect(calls[1]).toContain("/tmp/proj");
  const dashDashIdx = calls[1]?.indexOf("--") ?? -1;
  expect(dashDashIdx).toBeGreaterThan(0);
  expect(calls[1]?.slice(dashDashIdx + 1)).toEqual([
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    "echo hi",
  ]);
});

test("createZellijBackend.launch: session missing → attach -b, then poll, then new-tab", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  // First list-sessions: empty. attach -b returns 0. Second list-
  // sessions: now lists the session. Subsequent action: tab id 12.
  let listCalls = 0;
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    if (cmd[1] === "list-sessions") {
      listCalls++;
      const body = listCalls === 1 ? "" : "autopilot\n";
      return {
        exited: Promise.resolve(0),
        stdout: new Response(body).body,
        stderr: new Response("").body,
      };
    }
    if (cmd[1] === "attach" && cmd[2] === "-b") {
      return {
        exited: Promise.resolve(0),
        stdout: new Response("").body,
        stderr: new Response("").body,
      };
    }
    if (cmd[1] === "--session") {
      // action new-tab
      return {
        exited: Promise.resolve(0),
        stdout: new Response("12\n").body,
        stderr: new Response("").body,
      };
    }
    return {
      exited: Promise.resolve(0),
      stdout: new Response("").body,
      stderr: new Response("").body,
    };
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const tabId = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "row-1",
    "/abs/dir",
  );
  expect(tabId).toBe("12");
  // We saw at minimum: list, attach, list, action. (More list polls
  // are tolerated since timing varies; we assert the orderable shape.)
  expect(calls[0]?.[1]).toBe("list-sessions");
  expect(
    calls.some(
      (c) => c[1] === "attach" && c[2] === "-b" && c[3] === "autopilot",
    ),
  ).toBe(true);
  // The action call comes after at least one re-poll.
  const actionIdx = calls.findIndex(
    (c) => c[1] === "--session" && c[3] === "action",
  );
  expect(actionIdx).toBeGreaterThan(1);
});

test("createZellijBackend.launch: session-ensure is memoized — second launch skips list/attach", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": {
        stdout: "autopilot\n",
        exitCode: 0,
      },
      "zellij:--session": { stdout: "1\n", exitCode: 0 },
    },
    calls,
  );
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  await backend.launch(["sh"], "row-1", "/abs");
  await backend.launch(["sh"], "row-2", "/abs");
  // Exactly ONE list-sessions call total across both launches —
  // session-ensure is memoized after the first.
  const listCount = calls.filter((c) => c[1] === "list-sessions").length;
  expect(listCount).toBe(1);
});

test("createZellijBackend.close: emits close-tab-by-id <id>", () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn = makeSpawnStub(
    { "zellij:--session": { stdout: "", exitCode: 0 } },
    calls,
  );
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  backend.close("7");
  expect(calls.length).toBe(1);
  expect(calls[0]).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "close-tab-by-id",
    "7",
  ]);
});

// ---------------------------------------------------------------------------
// resolveExecBackend — factory selection
// ---------------------------------------------------------------------------

test("resolveExecBackend: 'ghostty' returns the ghostty backend", () => {
  const notes: string[] = [];
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      osascript: { stdout: "tab-x", exitCode: 0 },
      sh: { stdout: "", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend("ghostty", {
    noteLine: (s) => notes.push(s),
    spawn,
  });
  // Smoke: a launch should spawn osascript first.
  void backend.launch(["sh"], "row", "/abs");
  expect(calls[0]?.[0]).toBe("osascript");
});

test("resolveExecBackend: 'zellij' returns the zellij backend with default session", async () => {
  const notes: string[] = [];
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": { stdout: "autopilot\n", exitCode: 0 },
      "zellij:--session": { stdout: "0\n", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend("zellij", {
    noteLine: (s) => notes.push(s),
    spawn,
  });
  await backend.launch(["sh"], "row", "/abs");
  // First spawn should be `zellij list-sessions`.
  expect(calls[0]?.[0]).toBe("zellij");
  expect(calls[0]?.[1]).toBe("list-sessions");
});

test("resolveExecBackend: undefined defaults to zellij", async () => {
  const notes: string[] = [];
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": {
        stdout: `${DEFAULT_ZELLIJ_SESSION}\n`,
        exitCode: 0,
      },
      "zellij:--session": { stdout: "0", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend(undefined, {
    noteLine: (s) => notes.push(s),
    spawn,
  });
  await backend.launch(["sh"], "row", "/abs");
  // The zellij branch fires first; default session name was threaded.
  expect(calls[0]?.[0]).toBe("zellij");
  // The action call carries the default session name.
  const actionCall = calls.find((c) => c[3] === "action");
  expect(actionCall?.[2]).toBe(DEFAULT_ZELLIJ_SESSION);
});

test("resolveExecBackend: unknown name falls back to zellij and warns", async () => {
  const notes: string[] = [];
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": { stdout: "autopilot\n", exitCode: 0 },
      "zellij:--session": { stdout: "0", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend("tmux", {
    noteLine: (s) => notes.push(s),
    spawn,
  });
  expect(notes.some((s) => s.includes('unknown exec_backend "tmux"'))).toBe(
    true,
  );
  // Confirm a zellij command (not osascript) actually fires.
  await backend.launch(["sh"], "row", "/abs");
  expect(calls[0]?.[0]).toBe("zellij");
});

test("DEFAULT_EXEC_BACKEND is 'zellij'", () => {
  expect(DEFAULT_EXEC_BACKEND).toBe("zellij");
});
