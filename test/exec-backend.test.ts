/**
 * Pure-function + argv-construction tests for `src/exec-backend.ts`.
 *
 * Coverage:
 *  - Pure builders (`buildZellijNewTabArgs`, `buildZellijCloseTabArgs`,
 *    `buildZellijClosePaneArgs`, `buildZellijListSessionsArgs`,
 *    `buildZellijListTabsArgs`, `buildZellijListPanesAllJsonArgs`,
 *    `buildZellijAttachBgArgs`) produce the zellij CLI shape the live
 *    spec calls for.
 *  - `findPaneByTabName` parses both observed JSON shapes (flat array
 *    of panes; object map keyed by tab name) and reports single/none/
 *    multiple cleanly. The exact-match guard rejects the
 *    `work::fn-6` vs `work::fn-60` substring hazard.
 *  - `createZellijBackend.launch` returns `{ ok }` (no pane id),
 *    threads `--name` through, and reaps the fresh-mint orphan tab.
 *  - `createZellijBackend.closeByName` resolves the pane via
 *    `list-panes -a -j` and feeds the right id to `close-pane -p`;
 *    zero/multiple/unparseable-JSON cases degrade to noteLine + no-op.
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
  buildZellijListPanesAllJsonArgs,
  buildZellijListSessionsArgs,
  buildZellijListTabsArgs,
  buildZellijNewTabArgs,
  createZellijBackend,
  DEFAULT_EXEC_BACKEND,
  DEFAULT_ZELLIJ_SESSION,
  findPaneByTabName,
  firstTabIdFromListTabs,
  parseListPanesJson,
  resolveExecBackend,
  type SpawnFn,
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
  // tab reap path. The agent-pane reap uses buildZellijClosePaneArgs
  // instead, driven by list-panes -a -j name-resolution.
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
  // Closing the pane SIGHUPs the agent process and (since the dedup
  // invariant guarantees one pane per named tab) zellij auto-closes
  // the now-empty tab in the same shot.
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

test("buildZellijListTabsArgs / buildZellijListPanesAllJsonArgs: well-formed", () => {
  expect(buildZellijListTabsArgs("autopilot")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "list-tabs",
  ]);
  // The reconciler's closeByName needs `-a` (all panes across all tabs,
  // not just the active tab) AND `-j` (JSON output so we can filter on
  // tab_name without text parsing).
  expect(buildZellijListPanesAllJsonArgs("autopilot")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "list-panes",
    "-a",
    "-j",
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
// list-panes -a -j parsing
// ---------------------------------------------------------------------------

test("parseListPanesJson: returns parsed JSON, null on empty/unparseable", () => {
  expect(parseListPanesJson(`[{"id":"terminal_1","tab_name":"x"}]`)).toEqual([
    { id: "terminal_1", tab_name: "x" },
  ]);
  expect(parseListPanesJson("")).toBeNull();
  expect(parseListPanesJson("   \n  ")).toBeNull();
  expect(parseListPanesJson("not json")).toBeNull();
});

test("findPaneByTabName: flat-array shape, exact match returns the single pane", () => {
  const payload = [
    {
      id: "terminal_1",
      tab_name: "work::fn-1-x.1",
      tab_id: 0,
      terminal_command: "/bin/zsh -l ...",
      exited: false,
    },
    {
      id: "terminal_2",
      tab_name: "close::fn-2-y",
      tab_id: 1,
      terminal_command: null,
    },
  ];
  const got = findPaneByTabName(payload, "close::fn-2-y");
  expect(got.found).toBe("single");
  if (got.found === "single") {
    expect(got.pane.id).toBe("terminal_2");
    expect(got.pane.tab_name).toBe("close::fn-2-y");
    expect(got.pane.tab_id).toBe(1);
    expect(got.pane.terminal_command).toBeNull();
  }
});

test("findPaneByTabName: object-map shape (tab name → panes), match via key fallback", () => {
  // Alternative observed zellij JSON: top-level object keyed by tab name.
  // findPaneByTabName falls back to the key when the pane object lacks
  // a tab_name field.
  const payload = {
    "work::fn-1-x.1": [{ id: "terminal_3" }],
    "close::fn-2-y": [{ id: "terminal_4" }],
  };
  const got = findPaneByTabName(payload, "close::fn-2-y");
  expect(got.found).toBe("single");
  if (got.found === "single") {
    expect(got.pane.id).toBe("terminal_4");
    expect(got.pane.tab_name).toBe("close::fn-2-y");
  }
});

test("findPaneByTabName: never substring-matches (work::fn-6 vs work::fn-60-x.1)", () => {
  const payload = [{ id: "terminal_1", tab_name: "work::fn-60-x.1" }];
  // The exact-match guard is the load-bearing hazard avoidance — a
  // substring match would let `work::fn-6` spuriously reap
  // `work::fn-60-x.1`'s pane.
  expect(findPaneByTabName(payload, "work::fn-6").found).toBe("none");
  // Exact match still works.
  expect(findPaneByTabName(payload, "work::fn-60-x.1").found).toBe("single");
});

test("findPaneByTabName: zero matches → 'none' (tab already gone)", () => {
  const payload = [{ id: "terminal_1", tab_name: "other" }];
  expect(findPaneByTabName(payload, "missing").found).toBe("none");
});

test("findPaneByTabName: multiple matches → 'multiple' with count (dedup invariant violated)", () => {
  // The dedup invariant upstream guarantees one live tab per
  // verb::id name. If list-panes reports two, something has gone
  // wrong — refuse to guess which one to close.
  const payload = [
    { id: "terminal_1", tab_name: "dup" },
    { id: "terminal_2", tab_name: "dup" },
  ];
  const got = findPaneByTabName(payload, "dup");
  expect(got.found).toBe("multiple");
  if (got.found === "multiple") {
    expect(got.count).toBe(2);
  }
});

test("findPaneByTabName: numeric id is normalized to terminal_<n>", () => {
  // Defensive: if zellij ships id as a bare number, normalize so the
  // close-pane -p call gets the expected string shape.
  const payload = [{ id: 7, tab_name: "work::fn-1-x.1" }];
  const got = findPaneByTabName(payload, "work::fn-1-x.1");
  expect(got.found).toBe("single");
  if (got.found === "single") {
    expect(got.pane.id).toBe("terminal_7");
  }
});

test("findPaneByTabName: garbage payload (null / non-object) → none", () => {
  expect(findPaneByTabName(null, "x").found).toBe("none");
  expect(findPaneByTabName("string", "x").found).toBe("none");
  expect(findPaneByTabName(42, "x").found).toBe("none");
});

// ---------------------------------------------------------------------------
// Zellij backend behavior (injected spawn — no real zellij)
// ---------------------------------------------------------------------------

test("createZellijBackend.launch: session already listed → new-tab; returns { ok: true } (no pane id)", async () => {
  // The new launch shape is stateless from autopilot's side: a plain
  // success envelope, no captured surface ref. The reconciler
  // correlates dispatches via the --name baked into argv + the
  // resulting SessionStart hook event in the jobs projection.
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
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const res = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "work::fn-1-x.1",
    "/tmp/proj",
  );
  expect(res).toEqual({ ok: true });
  // Order: list-sessions (steady-state probe) → new-tab. No list-panes
  // capture on launch any more.
  expect(calls[0]?.[1]).toBe("list-sessions");
  expect(calls[1]?.slice(0, 5)).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "new-tab",
  ]);
  // --cwd and --name were threaded through; argv landed after `--`.
  expect(calls[1]).toContain("--cwd");
  expect(calls[1]).toContain("/tmp/proj");
  expect(calls[1]).toContain("--name");
  expect(calls[1]).toContain("work::fn-1-x.1");
  const dashDashIdx = calls[1]?.indexOf("--") ?? -1;
  expect(dashDashIdx).toBeGreaterThan(0);
  expect(calls[1]?.slice(dashDashIdx + 1)).toEqual([
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    "echo hi",
  ]);
  // No list-panes call during launch — that's a closeByName-only verb now.
  expect(calls.some((c) => c[4] === "list-panes")).toBe(false);
});

test("createZellijBackend.launch: non-zero new-tab exit → { ok: false, error }", async () => {
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    const reply = (stdout: string, exitCode = 0) => ({
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    if (cmd[1] === "list-sessions") return reply("autopilot\n");
    if (cmd[1] === "--session" && cmd[4] === "new-tab") return reply("", 1);
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const res = await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("exited non-zero");
  }
});

test("createZellijBackend.launch: ENOENT (binary missing) → { ok: false, error }", async () => {
  const notes: string[] = [];
  // A spawn that throws synchronously (Bun.spawn surfaces ENOENT this way
  // in some Bun versions). The backend's runCapture catches it and
  // returns null, which launch reports as ENOENT failure.
  const spawn: SpawnFn = (cmd, _options) => {
    if (cmd[1] === "--session" && cmd[4] === "new-tab") {
      throw new Error("spawn ENOENT");
    }
    return {
      exited: Promise.resolve(0),
      stdout: new Response("autopilot\n").body,
      stderr: new Response("").body,
    };
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const res = await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("ENOENT");
  }
});

test("createZellijBackend.launch: session missing → attach -b, then poll, then new-tab", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  // First list-sessions: empty. attach -b returns 0. Second list-
  // sessions: now lists the session. new-tab returns 0; launch reports
  // { ok: true } (no pane id capture in the new shape).
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
  const res = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "work::fn-1-x.1",
    "/abs/dir",
  );
  expect(res).toEqual({ ok: true });
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
      "zellij:--session": { stdout: "", exitCode: 0 },
    },
    calls,
  );
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  await backend.launch(["sh"], "work::a", "/abs");
  await backend.launch(["sh"], "work::b", "/abs");
  // Exactly ONE list-sessions call total across both launches —
  // session-ensure is memoized after the first.
  const listCount = calls.filter((c) => c[1] === "list-sessions").length;
  expect(listCount).toBe(1);
});

test("createZellijBackend.launch: fresh mint reaps the orphan default tab via close-tab-by-id after the agent tab lands", async () => {
  // The orphan-default-tab reap KEEPS `close-tab-by-id` — it
  // deliberately closes a known-empty default tab created at mint
  // time, no risk of nuking a shared tab. The agent-pane reap path
  // is name-driven (closeByName → list-panes -a -j → close-pane -p).
  const calls: string[][] = [];
  const notes: string[] = [];
  let listCalls = 0;
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
  const res = await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(res).toEqual({ ok: true });
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
  await backend.launch(["sh"], "work::fn-2-y.1", "/abs");
  expect(calls.some((c) => c[4] === "close-tab-by-id")).toBe(false);
});

// ---------------------------------------------------------------------------
// closeByName
// ---------------------------------------------------------------------------

test("createZellijBackend.closeByName: single match → close-pane -p <id> with the resolved pane id", async () => {
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
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      // Two panes; only one matches by tab_name.
      return reply(
        JSON.stringify([
          {
            id: "terminal_3",
            tab_name: "work::fn-2-y.1",
            tab_id: 0,
            terminal_command: "/bin/zsh -l ...",
            exited: false,
          },
          {
            id: "terminal_7",
            tab_name: "work::fn-1-x.1",
            tab_id: 1,
            terminal_command: "/bin/zsh -l ...",
            exited: false,
          },
        ]),
      );
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  await backend.closeByName("work::fn-1-x.1");
  // Sequence: ensureSession (list-sessions) → list-panes -a -j →
  // close-pane -p terminal_7.
  expect(calls.some((c) => c[1] === "list-sessions")).toBe(true);
  const listPanes = calls.find((c) => c[4] === "list-panes");
  expect(listPanes).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "list-panes",
    "-a",
    "-j",
  ]);
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

test("createZellijBackend.closeByName: zero matches (tab already gone) → noteLine, no close-pane spawn", async () => {
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
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply(JSON.stringify([{ id: "terminal_1", tab_name: "other" }]));
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  await backend.closeByName("work::fn-1-x.1");
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
  expect(notes.some((s) => s.includes("no pane with tab_name"))).toBe(true);
});

test("createZellijBackend.closeByName: multiple matches (dedup violated) → noteLine warn, no close-pane spawn", async () => {
  // Defensive: dedup upstream guarantees one tab per verb::id name,
  // but if zellij returns two we refuse to guess which one is the
  // "right" one — leave both open, surface the anomaly via noteLine.
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
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply(
        JSON.stringify([
          { id: "terminal_1", tab_name: "dup" },
          { id: "terminal_2", tab_name: "dup" },
        ]),
      );
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  await backend.closeByName("dup");
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
  expect(
    notes.some((s) => s.includes("2 panes match") && s.includes("dedup")),
  ).toBe(true);
});

test("createZellijBackend.closeByName: unparseable JSON → noteLine warn, no close-pane spawn", async () => {
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
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply("not json at all");
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  await backend.closeByName("work::fn-1-x.1");
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
  expect(notes.some((s) => s.includes("unparseable JSON"))).toBe(true);
});

test("createZellijBackend.closeByName: list-panes non-zero exit → noteLine warn, no close-pane spawn", async () => {
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string, exitCode = 0) => ({
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    if (cmd[1] === "list-sessions") return reply("autopilot\n");
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply("", 1);
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  await backend.closeByName("work::fn-1-x.1");
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
  expect(notes.some((s) => s.includes("exited non-zero"))).toBe(true);
});

test("createZellijBackend.closeByName: never substring-matches a near-miss tab name", async () => {
  // Hazard scenario: the human (or a sibling reconciler bug) created
  // `work::fn-60-x.1` and `closeByName("work::fn-6")` must NOT reap it.
  // The exact-match guard in findPaneByTabName is the load-bearing line.
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
    if (cmd[1] === "--session" && cmd[4] === "list-panes") {
      return reply(
        JSON.stringify([{ id: "terminal_4", tab_name: "work::fn-60-x.1" }]),
      );
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  await backend.closeByName("work::fn-6");
  // No close-pane fires — the near-miss is treated as "tab already gone".
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
  expect(notes.some((s) => s.includes("no pane with tab_name"))).toBe(true);
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
      "zellij:--session": { stdout: "", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
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
      "zellij:--session": { stdout: "", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend({
    noteLine: () => {},
    session: "custom",
    spawn,
  });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  const actionCall = calls.find((c) => c[3] === "action");
  expect(actionCall?.[2]).toBe("custom");
});

test("DEFAULT_EXEC_BACKEND is 'zellij'", () => {
  expect(DEFAULT_EXEC_BACKEND).toBe("zellij");
});
