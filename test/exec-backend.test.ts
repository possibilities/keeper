/**
 * Pure-function + argv-construction tests for `src/exec-backend.ts`.
 *
 * Coverage:
 *  - `buildZellijNewTabArgs` / `buildZellijCloseTabArgs` /
 *    `buildZellijListSessionsArgs` / `buildZellijAttachBgArgs`
 *    produce the zellij CLI shape the live spec calls for.
 *  - `createZellijBackend` routes through an INJECTED spawn fn — no
 *    real `zellij` process is ever launched.
 *  - `resolveExecBackend` returns a zellij backend; tolerates undefined
 *    session via `DEFAULT_ZELLIJ_SESSION`.
 *
 * No filesystem or process side effects: every spawn is a stub that
 * returns canned stdout/stderr/exit-code via in-memory streams.
 */

import { expect, test } from "bun:test";
import {
  buildZellijAttachBgArgs,
  buildZellijCloseTabArgs,
  buildZellijListPanesArgs,
  buildZellijListSessionsArgs,
  buildZellijListTabsArgs,
  buildZellijNewTabArgs,
  buildZellijQueryTabNamesArgs,
  buildZellijRenamePaneArgs,
  createZellijBackend,
  DEFAULT_EXEC_BACKEND,
  DEFAULT_ZELLIJ_SESSION,
  firstTabIdFromListTabs,
  newestTerminalPaneId,
  resolveExecBackend,
  type SpawnFn,
  tabNameListed,
} from "../src/exec-backend";

/**
 * Build a `SpawnFn` stub that records every spawn into `calls` and
 * resolves with canned exit + stdout/stderr from a per-prefix table.
 * The table key matches the first argv element (e.g. `"zellij"`) — for
 * zellij we need to vary by subcommand, so the matching key is
 * `"<cmd>:<arg2>"` (e.g. `"zellij:action"` vs `"zellij:list-sessions"`
 * vs `"zellij:attach"`).
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

test("buildZellijNewTabArgs: inserts --name <name> before -- when provided", () => {
  const got = buildZellijNewTabArgs(
    "autopilot",
    "/abs",
    ["/bin/zsh", "-c", "echo hi"],
    "work::fn-1-x.1",
  );
  // --name lands between --cwd <dir> and the -- argv boundary.
  const nameIdx = got.indexOf("--name");
  const dashIdx = got.indexOf("--");
  expect(nameIdx).toBeGreaterThan(got.indexOf("/abs"));
  expect(got[nameIdx + 1]).toBe("work::fn-1-x.1");
  expect(nameIdx).toBeLessThan(dashIdx);
  expect(got.slice(dashIdx + 1)).toEqual(["/bin/zsh", "-c", "echo hi"]);
});

test("buildZellijNewTabArgs: omits --name entirely for empty/absent name", () => {
  expect(buildZellijNewTabArgs("s", "/abs", ["sh"], "")).not.toContain(
    "--name",
  );
  expect(buildZellijNewTabArgs("s", "/abs", ["sh"])).not.toContain("--name");
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

test("buildZellijListTabsArgs / buildZellijListPanesArgs / buildZellijRenamePaneArgs: well-formed", () => {
  expect(buildZellijListTabsArgs("autopilot")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "list-tabs",
  ]);
  expect(buildZellijListPanesArgs("autopilot")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "list-panes",
  ]);
  expect(
    buildZellijRenamePaneArgs("autopilot", "terminal_3", "Worker"),
  ).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "rename-pane",
    "-p",
    "terminal_3",
    "Worker",
  ]);
});

test("firstTabIdFromListTabs: skips header, returns first numeric tab id", () => {
  expect(
    firstTabIdFromListTabs(
      "TAB_ID  POSITION  NAME\n0  0  Tab #1\n1  1  agent\n",
    ),
  ).toBe("0");
  // Unparsable / empty → null (degrade to keeping the default tab).
  expect(firstTabIdFromListTabs("")).toBeNull();
  expect(firstTabIdFromListTabs("TAB_ID  POSITION  NAME\n")).toBeNull();
});

test("newestTerminalPaneId: picks highest terminal_<n>, ignores plugin/header", () => {
  const text =
    "PANE_ID  TYPE  TITLE\n" +
    "plugin_0  plugin  (.) - zellij:link\n" +
    "terminal_0  terminal  Pane #1\n" +
    "terminal_5  terminal  /bin/zsh -l -i -c ...\n";
  expect(newestTerminalPaneId(text)).toBe("terminal_5");
  expect(
    newestTerminalPaneId("PANE_ID  TYPE  TITLE\nplugin_0  plugin  x\n"),
  ).toBeNull();
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

test("buildZellijQueryTabNamesArgs: well-formed", () => {
  expect(buildZellijQueryTabNamesArgs("autopilot")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "query-tab-names",
  ]);
});

test("tabNameListed: exact-matches a tab name, never a substring", () => {
  const text = "work::fn-60-other.1\nclose::fn-12-x\napprove::fn-3-y.2\n";
  // Exact hit.
  expect(tabNameListed(text, "close::fn-12-x")).toBe(true);
  // Substring of a listed name must NOT match (the `work::fn-6` vs
  // `work::fn-60` hazard the gate exists to avoid).
  expect(tabNameListed(text, "work::fn-6")).toBe(false);
  // Absent name.
  expect(tabNameListed(text, "work::fn-99-z.1")).toBe(false);
  // Empty input.
  expect(tabNameListed("", "work::fn-1-x.1")).toBe(false);
  // ANSI-coded line still matches after strip.
  expect(tabNameListed("[1mwork::fn-1-x.1[0m\n", "work::fn-1-x.1")).toBe(true);
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

test("createZellijBackend.launch: fresh mint reaps the orphan default tab after the agent tab lands", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  let listCalls = 0;
  // Disambiguate action subcommands by cmd[4]; sessions missing first,
  // then listed so the mint branch fires.
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string) => ({
      exited: Promise.resolve(0),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    if (cmd[1] === "list-sessions") {
      listCalls++;
      return reply(listCalls === 1 ? "" : "autopilot\n");
    }
    if (cmd[1] === "attach") return reply("");
    if (cmd[1] === "--session" && cmd[4] === "list-tabs") {
      return reply("TAB_ID  POSITION  NAME\n0  0  Tab #1\n");
    }
    if (cmd[1] === "--session" && cmd[4] === "new-tab") return reply("9\n");
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const tabId = await backend.launch(["sh"], "row-1", "/abs");
  expect(tabId).toBe("9");
  // The orphaned default tab (id 0, captured from list-tabs at mint) is
  // closed AFTER the agent tab exists.
  const closeCall = calls.find(
    (c) => c[4] === "close-tab-by-id" && c[5] === "0",
  );
  expect(closeCall).toBeDefined();
  const newTabIdx = calls.findIndex((c) => c[4] === "new-tab");
  const closeIdx = calls.findIndex((c) => c[4] === "close-tab-by-id");
  expect(closeIdx).toBeGreaterThan(newTabIdx);
  // One-shot: a second launch (session now memoized) does NOT re-close.
  calls.length = 0;
  await backend.launch(["sh"], "row-2", "/abs");
  expect(calls.some((c) => c[4] === "close-tab-by-id")).toBe(false);
});

test("createZellijBackend.launch: paneName pins the agent pane via rename-pane on the newest terminal", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string) => ({
      exited: Promise.resolve(0),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    if (cmd[1] === "list-sessions") return reply("autopilot\n");
    if (cmd[1] === "--session" && cmd[4] === "new-tab") return reply("3\n");
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply(
        "PANE_ID  TYPE  TITLE\nterminal_0  terminal  Pane #1\nterminal_4  terminal  /bin/zsh ...\n",
      );
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const tabId = await backend.launch(["sh"], "row-1", "/abs", {
    tabName: "work::fn-1-x.1",
    paneName: "Worker",
  });
  expect(tabId).toBe("3");
  // new-tab carried the tab name.
  const newTab = calls.find((c) => c[4] === "new-tab");
  expect(newTab).toContain("--name");
  expect(newTab).toContain("work::fn-1-x.1");
  // rename-pane targeted the newest terminal pane with the role label.
  const rename = calls.find((c) => c[4] === "rename-pane");
  expect(rename).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "rename-pane",
    "-p",
    "terminal_4",
    "Worker",
  ]);
});

test("createZellijBackend.launch: no paneName → no rename-pane call", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": { stdout: "autopilot\n", exitCode: 0 },
      "zellij:--session": { stdout: "1\n", exitCode: 0 },
    },
    calls,
  );
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn,
  });
  await backend.launch(["sh"], "row-1", "/abs", { tabName: "work::x" });
  expect(calls.some((c) => c[4] === "rename-pane")).toBe(false);
  expect(calls.some((c) => c[4] === "list-panes")).toBe(false);
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

test("createZellijBackend.isSurfaceLive: true when an exact tab name is listed", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": { stdout: "autopilot\n", exitCode: 0 },
      "zellij:--session": {
        stdout: "work::fn-60-x.1\nclose::fn-12-y\n",
        exitCode: 0,
      },
    },
    calls,
  );
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn,
  });
  expect(await backend.isSurfaceLive("close::fn-12-y")).toBe(true);
  // The query-tab-names action was the probe.
  expect(calls.some((c) => c[4] === "query-tab-names")).toBe(true);
});

test("createZellijBackend.isSurfaceLive: false when the name is absent (substring near-miss does not match)", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": { stdout: "autopilot\n", exitCode: 0 },
      "zellij:--session": { stdout: "work::fn-60-x.1\n", exitCode: 0 },
    },
    calls,
  );
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn,
  });
  // `work::fn-6` is a substring of the listed `work::fn-60-x.1` but must
  // NOT be treated as live.
  expect(await backend.isSurfaceLive("work::fn-6")).toBe(false);
});

test("createZellijBackend.isSurfaceLive: fail-closed (true) on non-zero query exit", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  // list-sessions clean (ensureSession passes) but query-tab-names exits
  // non-zero → fail-closed `true` so a probe error suppresses a dispatch
  // rather than risking a double-spawn.
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string, exitCode = 0) => ({
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    if (cmd[1] === "list-sessions") return reply("autopilot\n");
    if (cmd[4] === "query-tab-names") return reply("", 1);
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  expect(await backend.isSurfaceLive("work::fn-1-x.1")).toBe(true);
  expect(notes.some((s) => s.includes("query-tab-names exited non-zero"))).toBe(
    true,
  );
});

// ---------------------------------------------------------------------------
// resolveExecBackend — thin zellij-only seam
// ---------------------------------------------------------------------------

test("resolveExecBackend: returns the zellij backend (default session)", async () => {
  const notes: string[] = [];
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": {
        stdout: `${DEFAULT_ZELLIJ_SESSION}\n`,
        exitCode: 0,
      },
      "zellij:--session": { stdout: "0\n", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  await backend.launch(["sh"], "row", "/abs");
  // First spawn is `zellij list-sessions`; default session name is threaded.
  expect(calls[0]?.[0]).toBe("zellij");
  expect(calls[0]?.[1]).toBe("list-sessions");
  const actionCall = calls.find((c) => c[3] === "action");
  expect(actionCall?.[2]).toBe(DEFAULT_ZELLIJ_SESSION);
});

test("resolveExecBackend: threads an explicit session through", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": { stdout: "custom\n", exitCode: 0 },
      "zellij:--session": { stdout: "0\n", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend({
    noteLine: () => {},
    session: "custom",
    spawn,
  });
  await backend.launch(["sh"], "row", "/abs");
  const actionCall = calls.find((c) => c[3] === "action");
  expect(actionCall?.[2]).toBe("custom");
});

test("DEFAULT_EXEC_BACKEND is 'zellij'", () => {
  expect(DEFAULT_EXEC_BACKEND).toBe("zellij");
});
