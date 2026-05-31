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
  buildZellijClosePaneArgs,
  buildZellijCloseTabArgs,
  buildZellijListPanesArgs,
  buildZellijListSessionsArgs,
  buildZellijListTabsArgs,
  buildZellijNewTabArgs,
  buildZellijQueryTabNamesArgs,
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

test("buildZellijCloseTabArgs: routes through close-tab-by-id <id> (orphan-default-tab reap only)", () => {
  // close-tab-by-id is kept ONLY for the fresh-mint orphan default
  // tab reap path. The agent-pane auto-close uses
  // buildZellijClosePaneArgs instead (fn-654.2 surgical close).
  expect(buildZellijCloseTabArgs("autopilot", "7")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "close-tab-by-id",
    "7",
  ]);
});

test("buildZellijClosePaneArgs: routes through close-pane -p <paneId> (surgical agent-pane reap)", () => {
  // fn-654.2 surgical agent-pane close. close-pane -p is pane-scoped
  // by construction (per zellij-server/src/screen.rs:2518-2523 — a
  // tab auto-closes only when it has zero selectable tiled panes
  // left), so a sibling tiled pane the human added to the same tab
  // survives the auto-reap.
  expect(buildZellijClosePaneArgs("autopilot", "terminal_5")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "close-pane",
    "-p",
    "terminal_5",
  ]);
});

test("buildZellijListTabsArgs / buildZellijListPanesArgs: well-formed", () => {
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

test("createZellijBackend.launch: session already listed → new-tab then list-panes; returns pane id (terminal_<n>), not tab id", async () => {
  // launch always resolves the pane id via list-panes and returns it
  // instead of the tab id, so the autopilot caller can feed it to
  // `close-pane -p`
  // for the surgical reap.
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string) => ({
      exited: Promise.resolve(0),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    if (cmd[1] === "list-sessions")
      return reply("autopilot [Created 5s ago]\n");
    if (cmd[1] === "--session" && cmd[4] === "new-tab") return reply("7\n");
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply(
        "PANE_ID  TYPE  TITLE\nterminal_0  terminal  Pane #1\nterminal_2  terminal  /bin/zsh ...\n",
      );
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const paneId = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "row-1",
    "/tmp/proj",
  );
  // The launch returns the pane id (newest terminal_<n>), NOT the
  // tab id "7" — load-bearing for the surgical close-pane path.
  expect(paneId).toBe("terminal_2");
  // Order: list-sessions (the steady-state probe), then new-tab.
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
  // list-panes always runs so the pane id is captured for the close path.
  expect(calls.some((c) => c[4] === "list-panes")).toBe(true);
});

test("createZellijBackend.launch: returns null when no terminal pane parses (never the tab id)", async () => {
  // Acceptance: `launch` returns the pane id; returns `null` on
  // pane-parse failure (never the tab id). A tab id fed to
  // `close-pane -p` cannot act and would leave a parked un-closeable
  // pane, so returning null falls through the existing
  // `closeWindow(undefined → no-op)` contract.
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
    if (cmd[1] === "--session" && cmd[4] === "new-tab") return reply("7\n");
    // list-panes shows no terminal pane (only a plugin) →
    // newestTerminalPaneId returns null → launch returns null.
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply(
        "PANE_ID  TYPE  TITLE\nplugin_0  plugin  zellij:status-bar\n",
      );
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const paneId = await backend.launch(
    ["/bin/zsh", "-c", "echo hi"],
    "row-1",
    "/abs",
  );
  expect(paneId).toBeNull();
  // The warn-line landed so the lifecycle sidecar shows the skip
  // reason (a forensics-friendly trail; not load-bearing for behavior).
  expect(
    notes.some((s) => s.includes("list-panes returned no terminal pane")),
  ).toBe(true);
});

test("createZellijBackend.launch: session missing → attach -b, then poll, then new-tab", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  // First list-sessions: empty. attach -b returns 0. Second list-
  // sessions: now lists the session. new-tab returns the tab id;
  // list-panes returns the just-created pane (which is what launch
  // returns — fn-654.2).
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
    if (cmd[1] === "--session" && cmd[4] === "list-tabs") {
      // Fresh-mint default tab capture.
      return {
        exited: Promise.resolve(0),
        stdout: new Response("TAB_ID  POSITION  NAME\n0  0  Tab #1\n").body,
        stderr: new Response("").body,
      };
    }
    if (cmd[1] === "--session" && cmd[4] === "new-tab") {
      return {
        exited: Promise.resolve(0),
        stdout: new Response("12\n").body,
        stderr: new Response("").body,
      };
    }
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return {
        exited: Promise.resolve(0),
        stdout: new Response(
          "PANE_ID  TYPE  TITLE\nterminal_5  terminal  /bin/zsh ...\n",
        ).body,
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
  const paneId = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "row-1",
    "/abs/dir",
  );
  // launch returns the pane id (terminal_5), not the tab id (12).
  expect(paneId).toBe("terminal_5");
  // We saw at minimum: list, attach, list, action. (More list polls
  // are tolerated since timing varies; we assert the orderable shape.)
  expect(calls[0]?.[1]).toBe("list-sessions");
  expect(
    calls.some(
      (c) => c[1] === "attach" && c[2] === "-b" && c[3] === "autopilot",
    ),
  ).toBe(true);
  // The new-tab action call comes after at least one re-poll.
  const actionIdx = calls.findIndex(
    (c) => c[1] === "--session" && c[4] === "new-tab",
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

test("createZellijBackend.launch: fresh mint reaps the orphan default tab via close-tab-by-id after the agent tab lands", async () => {
  // The orphan-default-tab reap KEEPS `close-tab-by-id` — it
  // deliberately closes a known-empty default tab created at mint
  // time, no risk of nuking a shared tab. The agent-pane auto-close
  // path is the one that moved to `close-pane -p` (fn-654.2).
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
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply(
        "PANE_ID  TYPE  TITLE\nterminal_3  terminal  /bin/zsh ...\n",
      );
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const paneId = await backend.launch(["sh"], "row-1", "/abs");
  // launch now returns the pane id, not the tab id.
  expect(paneId).toBe("terminal_3");
  // The orphaned default tab (id 0, captured from list-tabs at mint) is
  // closed via close-tab-by-id AFTER the agent tab exists. The orphan
  // reap intentionally uses the tab-level builder (the default tab is
  // known-empty) — only the agent-pane close moved to close-pane.
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

test("createZellijBackend.launch: resolves the newest terminal pane id for the close path and returns it; never renames the pane", async () => {
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
  const paneId = await backend.launch(["sh"], "row-1", "/abs", {
    tabName: "work::fn-1-x.1",
  });
  // launch returns the pane id (newest terminal_<n>), not the tab id "3".
  expect(paneId).toBe("terminal_4");
  // new-tab carried the tab name (the close-time token).
  const newTab = calls.find((c) => c[4] === "new-tab");
  expect(newTab).toContain("--name");
  expect(newTab).toContain("work::fn-1-x.1");
  // list-panes always runs — it captures the load-bearing pane id.
  expect(calls.some((c) => c[4] === "list-panes")).toBe(true);
  // panes are never decorated: no rename-pane call is ever issued.
  expect(calls.some((c) => c[4] === "rename-pane")).toBe(false);
});

test("createZellijBackend.close: fires close-pane -p <paneId> when token tabName is live", async () => {
  // fn-654.2: close now fires close-pane (surgical pane reap, leaves
  // sibling tiled panes alone), guarded by a name-exact tab-live
  // probe on the launch-time tabName token. When the named tab IS
  // live (token matches → same server lifetime), the pane close
  // fires.
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
    if (cmd[1] === "--session" && cmd[4] === "query-tab-names") {
      // The launch-time tabName is live — close should fire.
      return reply("work::fn-1-x.1\nclose::fn-2-y\n");
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  backend.close("terminal_7", "work::fn-1-x.1");
  // close is fire-and-forget; the async probe runs on the microtask
  // queue. Yield until the close-pane spawn lands or we time out.
  for (let i = 0; i < 50; i++) {
    if (calls.some((c) => c[4] === "close-pane")) {
      break;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  // Sequence: ensureSession's list-sessions → query-tab-names (token
  // check) → close-pane -p terminal_7.
  expect(calls.some((c) => c[1] === "list-sessions")).toBe(true);
  expect(calls.some((c) => c[4] === "query-tab-names")).toBe(true);
  const closePane = calls.find((c) => c[4] === "close-pane");
  expect(closePane).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "close-pane",
    "-p",
    "terminal_7",
  ]);
});

test("createZellijBackend.close: token mismatch (tab name not live, e.g. server restarted) → skipped, no close-pane", async () => {
  // Acceptance: auto-close fires close-pane -p ONLY when the token
  // matches the live server; mismatched token rows are skipped. A
  // server restart between launch and close blows away the named
  // tab (and recycles the pane-id counter); the token probe returns
  // false and the close is silently skipped — never reaps a recycled
  // pane id that now belongs to a different live pane.
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
    if (cmd[1] === "--session" && cmd[4] === "query-tab-names") {
      // Tab "work::fn-1-x.1" is NOT in the listed tab names — server
      // restarted, the launch-time tab is gone. Token mismatch.
      return reply("close::fn-99-other\n");
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  backend.close("terminal_7", "work::fn-1-x.1");
  // Wait long enough for the probe to land + the would-be close to
  // either fire or definitively NOT fire.
  for (let i = 0; i < 50; i++) {
    if (calls.some((c) => c[4] === "query-tab-names")) {
      break;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  // Extra yield so a (forbidden) close-pane spawn would have time to land.
  await new Promise((r) => setTimeout(r, 5));
  expect(calls.some((c) => c[4] === "query-tab-names")).toBe(true);
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
  // The skip is noted to the lifecycle sidecar so a post-mortem can
  // see why the auto-close didn't fire.
  expect(notes.some((s) => s.includes("token mismatch"))).toBe(true);
});

test("createZellijBackend.close: missing tabName token (pre-fn-654.2 dispatch.log row) → skipped, no probe, no close-pane", async () => {
  // Acceptance: a missing-token row is skipped (never reaped). Pre-
  // upgrade `kind:"window"` rows didn't carry tabName; the backend
  // recognizes the missing token and exits early — no probe, no
  // close. Fail-safe direction.
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
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
  // No tabName argument (or undefined / empty string) → skip.
  backend.close("terminal_7");
  backend.close("terminal_8", undefined);
  backend.close("terminal_9", "");
  await new Promise((r) => setTimeout(r, 5));
  expect(calls.length).toBe(0);
  expect(notes.filter((s) => s.includes("missing tabName token")).length).toBe(
    3,
  );
});

test("createZellijBackend.close: pre-upgrade tab-id-shaped windowId (bare number, not terminal_<n>) → skipped, no probe, no close-pane", async () => {
  // Acceptance: pre-upgrade dispatch.log rows carry tab-id-shaped
  // windowIds (bare numeric strings like "7") from the old
  // close-tab-by-id regime. Feeding a tab id to close-pane -p is
  // guaranteed to no-op AND leaves a parked tab regardless, so the
  // backend skips on shape — never even probes.
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
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
  // "7" is the bare-numeric tab-id shape from pre-fn-654.2 rows.
  backend.close("7", "work::fn-1-x.1");
  await new Promise((r) => setTimeout(r, 5));
  expect(calls.length).toBe(0);
  expect(
    notes.some((s) => s.includes("pre-upgrade tab-id-shaped windowId")),
  ).toBe(true);
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
