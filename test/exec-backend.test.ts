/**
 * Pure-function + argv-construction tests for `src/exec-backend.ts`.
 *
 * Coverage:
 *  - Pure builders (`buildZellijNewTabArgs`, `buildZellijCloseTabArgs`,
 *    `buildZellijClosePaneArgs`, `buildZellijListSessionsArgs`,
 *    `buildZellijListTabsArgs`, `buildZellijListPanesAllJsonArgs`,
 *    `buildZellijAttachBgArgs`) produce the zellij CLI shape the live
 *    spec calls for.
 *  - `createZellijBackend.launch` returns `{ ok }` (no pane id),
 *    threads `--name` through, and keeps the fresh-mint default tab as
 *    a keepalive anchor (never reaped).
 *  - `resolveExecBackend` returns a zellij backend; tolerates undefined
 *    session via `DEFAULT_ZELLIJ_SESSION`.
 *
 * No filesystem or process side effects: every spawn is a stub that
 * returns canned stdout/stderr/exit-code via in-memory streams.
 */

import { expect, test } from "bun:test";
import { isCompletionReapCandidate } from "../src/autopilot-worker";
import {
  buildZellijAttachBgArgs,
  buildZellijClosePaneArgs,
  buildZellijCloseTabArgs,
  buildZellijFocusPaneArgs,
  buildZellijListPanesAllJsonArgs,
  buildZellijListSessionsArgs,
  buildZellijListTabsArgs,
  buildZellijNewTabArgs,
  closePaneIdForReap,
  collectPanesFromListJson,
  createZellijBackend,
  DEFAULT_EXEC_BACKEND,
  DEFAULT_ZELLIJ_SESSION,
  dispatchKeyForPane,
  execBackendEnvMeta,
  findPaneById,
  firstTabIdFromListTabs,
  parseListPanesJson,
  resolveExecBackend,
  type SpawnFn,
  type ZellijPane,
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
  // Two callers share this builder (epic fn-678): the fresh-mint
  // orphan default-tab reap inside ensureSession, and
  // ExecBackend.closeByTabId (the autopilot reap pass).
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
  // The session-agnostic `resolveTabForPane` needs `-a` (all panes
  // across all tabs, not just the active tab) AND `-j` (JSON output
  // so we can filter on `id` without text parsing).
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
    "--forget",
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
  // --cwd was threaded through; argv landed after `--`. The managed
  // launch path is unnamed (epic fn-711) — `name` feeds logs/dedup
  // only, never the zellij tab label.
  expect(calls[1]).toContain("--cwd");
  expect(calls[1]).toContain("/tmp/proj");
  expect(calls[1]).not.toContain("--name");
  expect(calls[1]).not.toContain("work::fn-1-x.1");
  const dashDashIdx = calls[1]?.indexOf("--") ?? -1;
  expect(dashDashIdx).toBeGreaterThan(0);
  expect(calls[1]?.slice(dashDashIdx + 1)).toEqual([
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    "echo hi",
  ]);
  // No list-panes call during launch — the only consumers of
  // list-panes are the session-agnostic `resolveTabForPane` (fn-668
  // backend tab resolver) and `findPaneById` parse tests.
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

test("createZellijBackend.launch: stale memo — session dies, new-tab fails 'not found' → re-mint + retry succeeds", async () => {
  // Regression: the session-ensure memo caches liveness for the worker's
  // whole life. If the session dies after the first launch (zellij exits
  // a session when its last tab closes, or a reboot/kill drops it), a
  // stale memo wedged EVERY future dispatch — `new-tab` hit a corpse and
  // returned "Session '<name>' not found" forever. The fix invalidates
  // the memo on that signature and re-mints once.
  const calls: string[][] = [];
  const notes: string[] = [];
  // alive=false after the first successful launch simulates the session
  // dying out from under the daemon; attach -b brings it back.
  let alive = true;
  let firstLaunchDone = false;
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string, exitCode = 0, stderr = "") => ({
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response(stderr).body,
    });
    if (cmd[1] === "list-sessions") {
      return reply(alive ? "autopilot\n" : "dash\n");
    }
    if (cmd[1] === "attach") {
      alive = true; // attach -b --forget fresh-mints the session
      return reply("");
    }
    if (cmd[1] === "--session" && cmd[4] === "new-tab") {
      if (!alive) {
        return reply(
          "",
          1,
          "Session 'autopilot' not found. The following sessions are active:\ndash",
        );
      }
      const r = reply("9\n");
      firstLaunchDone = true;
      return r;
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  // First launch: session listed → straight to new-tab, succeeds.
  const first = await backend.launch(["sh"], "work::a", "/abs");
  expect(first).toEqual({ ok: true });
  expect(firstLaunchDone).toBe(true);
  // Session dies. Second launch's new-tab fails "not found" → re-mint.
  alive = false;
  const second = await backend.launch(["sh"], "work::b", "/abs");
  expect(second).toEqual({ ok: true });
  // The recovery ran attach -b --forget to re-mint the vanished
  // session — the mid-life retry path rides the same argv builder,
  // so `--forget` lands here too (fn-675). A future regression that
  // drops it on the retry path would surface as a missing assertion.
  const attachCalls = calls.filter((c) => c[1] === "attach");
  expect(attachCalls.length).toBeGreaterThan(0);
  for (const c of attachCalls) {
    expect(c).toEqual(["zellij", "attach", "-b", "--forget", "autopilot"]);
  }
  expect(notes.some((s) => s.includes("vanished"))).toBe(true);
  // Three new-tab spawns total: one for work::a, plus the failed one
  // + the retry for work::b. The tab is unnamed now (epic fn-711), so
  // the new-tab argv no longer carries `work::b` to filter on; count
  // the total instead.
  const newTabs = calls.filter((c) => c[4] === "new-tab");
  expect(newTabs.length).toBe(3);
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

test("createZellijBackend.launch: session missing → attach -b --forget, then poll, then new-tab", async () => {
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
  // Mint argv must carry `--forget` so a stale/EXITED corpse is
  // fresh-rebuilt rather than resurrected (fn-675).
  expect(
    calls.some(
      (c) =>
        c[1] === "attach" &&
        c[2] === "-b" &&
        c[3] === "--forget" &&
        c[4] === "autopilot",
    ),
  ).toBe(true);
  // The new-tab action call comes after at least one re-poll.
  const actionIdx = calls.findIndex(
    (c) => c[1] === "--session" && c[4] === "new-tab",
  );
  expect(actionIdx).toBeGreaterThan(1);
});

test("createZellijBackend.launch: session-mint attach -b --forget carries color env (TERM/COLORTERM)", async () => {
  // The zellij server inherits the mint spawn's env, and every pane it
  // launches inherits the server's. keeperd's LaunchAgent env strips
  // TERM/COLORTERM, so the mint spawn MUST inject color-capable defaults
  // or every worker pane renders monochrome. Capture the options bag on
  // the `attach -b` call and assert the color vars are present.
  const notes: string[] = [];
  let attachEnv: Record<string, string> | undefined;
  let attachArgv: string[] | undefined;
  let listCalls = 0;
  const spawn: SpawnFn = (cmd, options) => {
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
      attachEnv = options.env;
      attachArgv = [...cmd];
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
  await backend.launch(["/bin/zsh", "-c", "echo hi"], "work::fn-1-x.1", "/abs");
  expect(attachEnv).toBeDefined();
  expect(attachEnv?.TERM).toBe(process.env.TERM ?? "xterm-256color");
  expect(attachEnv?.COLORTERM).toBe(process.env.COLORTERM ?? "truecolor");
  // PATH is spread through so the server can still resolve binaries.
  expect(attachEnv?.PATH).toBe(process.env.PATH);
  // Mint argv carries `--forget` (fn-675) alongside the color env.
  expect(attachArgv).toEqual([
    "zellij",
    "attach",
    "-b",
    "--forget",
    "autopilot",
  ]);
});

test("createZellijBackend: control commands (list-sessions/new-tab) carry NO env override", async () => {
  // Only the mint spawn opts into a custom env; every other control
  // command inherits process.env (options.env stays undefined) so we
  // don't churn the env surface on the hot path.
  const envByKey: Record<string, Record<string, string> | undefined> = {};
  let listCalls = 0;
  const spawn: SpawnFn = (cmd, options) => {
    const key = `${cmd[1]}${cmd[4] != null ? `:${cmd[4]}` : ""}`;
    envByKey[key] = options.env;
    if (cmd[1] === "list-sessions") {
      listCalls++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(listCalls === 1 ? "" : "autopilot\n").body,
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
    noteLine: () => {},
    session: "autopilot",
    spawn,
  });
  await backend.launch(["/bin/zsh", "-c", "echo hi"], "work::fn-1-x.1", "/abs");
  expect(envByKey["list-sessions"]).toBeUndefined();
  expect(envByKey["--session:new-tab"]).toBeUndefined();
});

test("createZellijBackend.launch: session listed but EXITED → attach -b --forget (fresh-mint), then new-tab", async () => {
  // Regression: a dead session lingers in `list-sessions` branded
  // `(EXITED - attach to resurrect)`. It is NOT a live server — a
  // `new-tab` against it exits non-zero ("There is no active
  // session!"). ensureSession must treat the corpse as not-listed and
  // route to `attach -b --forget`, which FORGETS the saved/serialized
  // session and mints fresh (rather than resurrecting the degraded
  // `session-layout.kdl` cache that produced fn-675's bar-less mint).
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
      // First probe: the session is present but EXITED. After
      // `attach -b --forget` fresh-mints it, the re-poll shows it live.
      return reply(
        listCalls === 1
          ? "autopilot [Created 3h 51m ago] (EXITED - attach to resurrect)\n"
          : "autopilot [Created 0s ago]\n",
      );
    }
    if (cmd[1] === "attach" && cmd[2] === "-b") return reply("");
    if (cmd[1] === "--session" && cmd[4] === "list-tabs")
      return reply("TAB_ID  POSITION  NAME\n0  0  Tab #1\n");
    if (cmd[1] === "--session" && cmd[4] === "new-tab") return reply("12\n");
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  const res = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "approve::fn-661-x",
    "/abs/dir",
  );
  expect(res).toEqual({ ok: true });
  // The EXITED line did NOT short-circuit ensureSession —
  // `attach -b --forget` fired to fresh-mint, and new-tab landed after
  // a re-poll. The argv asserts `--forget` is present so a future
  // regression that drops it would surface here as a fresh-mint
  // failure (the corpse would otherwise resurrect bar-less).
  const attachCall = calls.find(
    (c) => c[1] === "attach" && c[2] === "-b" && c[4] === "autopilot",
  );
  expect(attachCall).toEqual([
    "zellij",
    "attach",
    "-b",
    "--forget",
    "autopilot",
  ]);
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

test("createZellijBackend.launch: fresh mint KEEPS the default Tab #1 as a keepalive anchor (never close-tab-by-id)", async () => {
  // The fresh-mint default `Tab #1` is deliberately retained, NOT reaped.
  // It carries no `(work|approve|close)::<id>` dispatch key, so the
  // fn-727 completion-reap never touches it; its persistence stops the
  // session from collapsing to zero tabs (which exits it) once every
  // agent tab is completion-reaped. The pre-fix behavior reaped it, which
  // let the autopilot session die + re-mint in a loop.
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
  // No close-tab-by-id is ever issued — the anchor tab survives.
  expect(calls.some((c) => c[4] === "close-tab-by-id")).toBe(false);
  // A second launch (session now memoized) also never closes a tab.
  calls.length = 0;
  await backend.launch(["sh"], "work::fn-2-y.1", "/abs");
  expect(calls.some((c) => c[4] === "close-tab-by-id")).toBe(false);
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

// ---------------------------------------------------------------------------
// execBackendEnvMeta — env-var names per backend type (T3 hook seam)
// ---------------------------------------------------------------------------

test("execBackendEnvMeta: defaults to DEFAULT_EXEC_BACKEND, returns ZELLIJ_SESSION_NAME/ZELLIJ_PANE_ID", () => {
  const meta = execBackendEnvMeta();
  expect(meta.backendType).toBe(DEFAULT_EXEC_BACKEND);
  expect(meta.sessionIdEnvVar).toBe("ZELLIJ_SESSION_NAME");
  expect(meta.paneIdEnvVar).toBe("ZELLIJ_PANE_ID");
});

test("execBackendEnvMeta: explicit 'zellij' matches the default", () => {
  const meta = execBackendEnvMeta("zellij");
  expect(meta.backendType).toBe("zellij");
  expect(meta.sessionIdEnvVar).toBe("ZELLIJ_SESSION_NAME");
  expect(meta.paneIdEnvVar).toBe("ZELLIJ_PANE_ID");
});

// ---------------------------------------------------------------------------
// findPaneById — match list-panes numeric id against env string pane id
// ---------------------------------------------------------------------------

test("findPaneById: matches numeric pane id against string env value (the type-coercion hazard)", () => {
  // zellij ships `id` as a bare number (`11`); the env's
  // `ZELLIJ_PANE_ID` is always a string (`"11"`). The finder
  // string-coerces both sides so the join lands.
  const payload = [
    { id: 11, tab_id: 3, tab_name: "agent", tab_position: 2, is_plugin: false },
  ];
  const got = findPaneById(payload, "11");
  expect(got.found).toBe("single");
  if (got.found === "single") {
    expect(got.pane.id).toBe("11");
    expect(got.pane.tab_id).toBe(3);
    expect(got.pane.tab_name).toBe("agent");
    expect(got.pane.tab_position).toBe(2);
  }
});

test("findPaneById: numeric env value (defensive) is coerced via String()", () => {
  // The seam contract is `string`, but a sloppy caller could feed in a
  // number; we coerce both sides so the comparison still lands.
  const payload = [{ id: 7, tab_id: 0, tab_name: "x", is_plugin: false }];
  // biome-ignore lint/suspicious/noExplicitAny: deliberate sloppy caller
  const got = findPaneById(payload, 7 as any);
  expect(got.found).toBe("single");
});

test("findPaneById: zero matches → 'none' (pane already gone)", () => {
  const payload = [{ id: 11, tab_name: "x", is_plugin: false }];
  expect(findPaneById(payload, "999").found).toBe("none");
});

test("findPaneById: multiple matches → 'multiple' with count (shouldn't happen, surface it)", () => {
  const payload = [
    { id: 11, tab_name: "a", is_plugin: false },
    { id: "11", tab_name: "b", is_plugin: false },
  ];
  const got = findPaneById(payload, "11");
  expect(got.found).toBe("multiple");
  if (got.found === "multiple") {
    expect(got.count).toBe(2);
  }
});

test("findPaneById: skips is_plugin=true panes (plugin id namespace is unrelated)", () => {
  const payload = [
    { id: 11, tab_name: "real", is_plugin: false, tab_id: 4 },
    { id: 11, tab_name: "plugin", is_plugin: true, tab_id: 99 },
  ];
  const got = findPaneById(payload, "11");
  expect(got.found).toBe("single");
  if (got.found === "single") {
    expect(got.pane.tab_id).toBe(4);
    expect(got.pane.tab_name).toBe("real");
  }
});

test("findPaneById: object-map shape (tab name → panes), tab_name pulled from key", () => {
  const payload = {
    agent: [{ id: 11, tab_id: 1, tab_position: 0, is_plugin: false }],
    other: [{ id: 12, tab_id: 2, tab_position: 1, is_plugin: false }],
  };
  const got = findPaneById(payload, "12");
  expect(got.found).toBe("single");
  if (got.found === "single") {
    expect(got.pane.tab_name).toBe("other");
    expect(got.pane.tab_id).toBe(2);
    expect(got.pane.tab_position).toBe(1);
  }
});

test("findPaneById: garbage payload (null / non-object) → none", () => {
  expect(findPaneById(null, "11").found).toBe("none");
  expect(findPaneById("string", "11").found).toBe("none");
  expect(findPaneById(42, "11").found).toBe("none");
});

/**
 * Construct a backend with a known `session` to assert that the
 * session-agnostic ops ignore it and use the per-call session instead.
 */
function createFocusBackend(spawn: SpawnFn, session: string) {
  return createZellijBackend({ noteLine: () => {}, session, spawn });
}

// ---------------------------------------------------------------------------
// buildZellijFocusPaneArgs — pure builder for `action focus-pane-id <id>`
// ---------------------------------------------------------------------------

test("buildZellijFocusPaneArgs: well-formed argv with --session + bare numeric pane id", () => {
  expect(buildZellijFocusPaneArgs("autopilot", "11")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "focus-pane-id",
    "11",
  ]);
});

// ---------------------------------------------------------------------------
// ExecBackend.focusPane — session-agnostic, on-interface. Exit 0 → ok;
// ENOENT / non-zero exit → { ok: false, error }; never throws.
// ---------------------------------------------------------------------------

test("ExecBackend.focusPane: exit 0 → { ok: true }, spawns focus-pane-id with the per-call session", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    { "zellij:--session": { stdout: "", exitCode: 0 } },
    calls,
  );
  const got = await createFocusBackend(spawn, "construction-default").focusPane(
    "per-call-session",
    "42",
  );
  expect(got).toEqual({ ok: true });
  // The spawn used the PER-CALL session, not the construction session,
  // proving the session-agnostic contract.
  expect(calls[0]).toEqual(buildZellijFocusPaneArgs("per-call-session", "42"));
});

test("ExecBackend.focusPane: non-zero exit → { ok: false, error } carrying the exit code", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:--session": {
        stdout: "",
        stderr: "pane not found",
        exitCode: 2,
      },
    },
    calls,
  );
  const got = await createFocusBackend(spawn, "autopilot").focusPane(
    "autopilot",
    "99",
  );
  expect(got.ok).toBe(false);
  if (got.ok === false) {
    expect(got.error).toContain("exited 2");
    expect(got.error).toContain("pane not found");
  }
});

test("ExecBackend.focusPane: ENOENT spawn throw → { ok: false, error }, NEVER throws back", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const got = await createFocusBackend(spawn, "autopilot").focusPane(
    "autopilot",
    "11",
  );
  expect(got.ok).toBe(false);
  if (got.ok === false) {
    expect(got.error).toContain("ENOENT");
  }
});

// ---------------------------------------------------------------------------
// ZellijBackendDeps.session is optional — constructing with just
// { noteLine } lets a session-agnostic-only consumer (e.g. cli/jobs.ts'
// `v` focus key) skip the construction-session entirely.
// ---------------------------------------------------------------------------

test("createZellijBackend: omitting session is allowed (session-agnostic-only consumer)", async () => {
  // Just exercising that this compiles + constructs without throwing —
  // the focus call uses the per-call session, so the absent
  // construction default is never read.
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    { "zellij:--session": { stdout: "", exitCode: 0 } },
    calls,
  );
  const backend = createZellijBackend({ noteLine: () => {}, spawn });
  const got = await backend.focusPane("any", "1");
  expect(got).toEqual({ ok: true });
});

// ---------------------------------------------------------------------------
// ExecBackend.ensureLaunched — session-agnostic get-or-create + launch.
// Mirrors `launch`'s mint + orphan-reap + session-gone-retry resiliences
// but parameterized by the per-call session, no shared memo.
// ---------------------------------------------------------------------------

test("ExecBackend.ensureLaunched: pre-existing live session → new-tab (no attach, no orphan reap), omits --name when absent", async () => {
  // The restore path passes no tab name — buildZellijNewTabArgs omits
  // `--name` entirely so the restored agent looks identical to a
  // human-opened tab. And a session that's already live MUST NOT be
  // `--forget`'d (the EXITED gate inside `zellijSessionListed` is what
  // guarantees this); no `attach` spawn fires.
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string) => ({
      exited: Promise.resolve(0),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    if (cmd[1] === "list-sessions") return reply("other-session\n");
    if (cmd[1] === "--session" && cmd[4] === "new-tab") return reply("");
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  const res = await backend.ensureLaunched(
    "other-session",
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "/tmp/proj",
  );
  expect(res).toEqual({ ok: true });
  // Order: list-sessions (already live → skip attach) → new-tab.
  expect(calls[0]?.[1]).toBe("list-sessions");
  const newTab = calls.find((c) => c[1] === "--session" && c[4] === "new-tab");
  expect(newTab).toBeDefined();
  // The PER-CALL session is on the wire, not the construction default.
  expect(newTab?.[2]).toBe("other-session");
  // No --name flag — buildZellijNewTabArgs omits it when undefined.
  expect(newTab).not.toContain("--name");
  // No attach spawn — the pre-existing live session was respected.
  expect(calls.some((c) => c[1] === "attach")).toBe(false);
  // No orphan reap — only mints leave a default tab to clean up.
  expect(calls.some((c) => c[4] === "close-tab-by-id")).toBe(false);
});

test("ExecBackend.ensureLaunched: absent session → attach -b --forget, poll, new-tab, KEEPS the default Tab #1 anchor", async () => {
  // Full mint path: list-sessions empty → attach -b --forget mints →
  // poll shows it live → new-tab lands. The fresh-mint default Tab #1 is
  // retained as the session's keepalive anchor (matching `launch`), NOT
  // reaped — so no close-tab-by-id is issued.
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
      return reply(listCalls === 1 ? "" : "restored\n");
    }
    if (cmd[1] === "attach") return reply("");
    if (cmd[1] === "--session" && cmd[4] === "new-tab") return reply("");
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    // Construction-session is irrelevant — ensureLaunched targets the
    // per-call session. We pick a different name on purpose.
    session: "autopilot",
    spawn,
  });
  const res = await backend.ensureLaunched(
    "restored",
    ["/bin/zsh", "-c", "echo hi"],
    "/abs/dir",
  );
  expect(res).toEqual({ ok: true });
  // Mint argv MUST carry --forget for fn-675 (don't resurrect a
  // degraded session-layout.kdl cache) and must target the per-call
  // session.
  const attachCall = calls.find((c) => c[1] === "attach");
  expect(attachCall).toEqual([
    "zellij",
    "attach",
    "-b",
    "--forget",
    "restored",
  ]);
  // new-tab fires AFTER the mint + poll cycle (so its index is past
  // the first list-sessions probe).
  const newTabIdx = calls.findIndex(
    (c) => c[1] === "--session" && c[4] === "new-tab" && c[2] === "restored",
  );
  expect(newTabIdx).toBeGreaterThan(1);
  // Anchor retained: no close-tab-by-id is ever issued against the
  // freshly-minted session.
  expect(calls.some((c) => c[4] === "close-tab-by-id")).toBe(false);
});

test("ExecBackend.ensureLaunched: session-gone new-tab stderr → re-ensure + retry once succeeds", async () => {
  // Mid-call resilience: session was live on the probe but the
  // new-tab spawn hits "Session 'X' not found" (or "no active
  // session"). The method re-runs the get-or-create (which mints
  // via attach -b --forget) and retries new-tab exactly once. The
  // re-ensure is its OWN cycle — no closure memo to invalidate.
  const calls: string[][] = [];
  const notes: string[] = [];
  // Liveness flips: first probe says alive, first new-tab fails
  // session-gone, second probe says dead → mint → re-probe shows
  // alive → retry new-tab succeeds.
  let listCalls = 0;
  let newTabCalls = 0;
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string, exitCode = 0, stderr = "") => ({
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response(stderr).body,
    });
    if (cmd[1] === "list-sessions") {
      listCalls++;
      // 1st probe (pre-launch): listed live. 2nd probe (re-ensure
      // after session-gone): empty (forcing the mint). 3rd probe
      // (re-ensure poll after attach): live again.
      if (listCalls === 1) return reply("restored\n");
      if (listCalls === 2) return reply("");
      return reply("restored\n");
    }
    if (cmd[1] === "attach") return reply("");
    if (cmd[1] === "--session" && cmd[4] === "list-tabs") {
      return reply("TAB_ID  POSITION  NAME\n0  0  Tab #1\n");
    }
    if (cmd[1] === "--session" && cmd[4] === "new-tab") {
      newTabCalls++;
      if (newTabCalls === 1) {
        return reply(
          "",
          1,
          "Session 'restored' not found. The following sessions are active:\nother",
        );
      }
      return reply("");
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  const res = await backend.ensureLaunched(
    "restored",
    ["/bin/zsh", "-c", "echo hi"],
    "/abs",
  );
  expect(res).toEqual({ ok: true });
  // The session-gone path fired exactly one attach -b --forget
  // against the per-call session (the re-ensure mint).
  const attachCalls = calls.filter((c) => c[1] === "attach");
  expect(attachCalls.length).toBe(1);
  expect(attachCalls[0]).toEqual([
    "zellij",
    "attach",
    "-b",
    "--forget",
    "restored",
  ]);
  // Exactly two new-tab spawns: the failed one and the retry.
  const newTabs = calls.filter(
    (c) => c[1] === "--session" && c[4] === "new-tab",
  );
  expect(newTabs.length).toBe(2);
  // Diagnostic noteLine fired so a human reading the sidecar sees
  // why the retry happened.
  expect(notes.some((s) => s.includes("vanished mid-ensureLaunched"))).toBe(
    true,
  );
});

test("ExecBackend.ensureLaunched: ENOENT (binary missing) → { ok: false, error }, never throws", async () => {
  // A spawn that throws on the new-tab call simulates a missing
  // zellij binary. runCapture catches and returns null; ensureLaunched
  // surfaces a typed failure envelope. The pre-launch list-sessions
  // probe also returns null (the noteLine path inside ensureSessionFor
  // warns), then new-tab fails the same way.
  const notes: string[] = [];
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  const res = await backend.ensureLaunched(
    "restored",
    ["/bin/zsh", "-c", "echo hi"],
    "/abs",
  );
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("ENOENT");
  }
});

test("ExecBackend.ensureLaunched: non-zero new-tab exit (not session-gone) → { ok: false, error }, no retry", async () => {
  // Any non-zero new-tab exit whose stderr does NOT look like
  // session-gone is a real launch failure — surface it as-is, no
  // mint, no retry.
  const calls: string[][] = [];
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string, exitCode = 0, stderr = "") => ({
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response(stderr).body,
    });
    if (cmd[1] === "list-sessions") return reply("restored\n");
    if (cmd[1] === "--session" && cmd[4] === "new-tab") {
      return reply("", 7, "permission denied or something else");
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    spawn,
  });
  const res = await backend.ensureLaunched("restored", ["sh"], "/abs");
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("exited non-zero");
    expect(res.error).toContain("7");
  }
  // No re-mint, exactly one new-tab spawn, no attach.
  expect(calls.filter((c) => c[1] === "attach").length).toBe(0);
  expect(
    calls.filter((c) => c[1] === "--session" && c[4] === "new-tab").length,
  ).toBe(1);
});

test("ExecBackend.ensureLaunched: shares no state with managed-session memo (separate launches into different sessions)", async () => {
  // The managed `launch` path uses the construction-time `session`
  // and a memoized `sessionReady` + one-shot `pendingOrphanTabId`.
  // `ensureLaunched` MUST NOT consume that memo or clobber the
  // orphan slot — otherwise a restore-time call into a non-managed
  // session would either short-circuit the ensure (wrong session
  // listed) or steal the managed path's orphan reap. We exercise
  // both methods back-to-back against different sessions and assert
  // each ran its OWN list-sessions probe + mint cycle.
  const calls: string[][] = [];
  const notes: string[] = [];
  // Both sessions appear in different list-sessions outputs depending
  // on which one each probe is asking about. We can't disambiguate
  // by argv (the probe is just `zellij list-sessions`), so we serve
  // a different listing per probe by counting calls.
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
      // Probe 1 (launch managed): autopilot is live. Probe 2
      // (ensureLaunched into "restored"): only autopilot is live, so
      // "restored" is absent → mint. Probe 3+ (poll for restored):
      // both live.
      if (listCalls === 1) return reply("autopilot\n");
      if (listCalls === 2) return reply("autopilot\n");
      return reply("autopilot\nrestored\n");
    }
    if (cmd[1] === "attach") return reply("");
    if (cmd[1] === "--session" && cmd[4] === "list-tabs") {
      return reply("TAB_ID  POSITION  NAME\n0  0  Tab #1\n");
    }
    return reply("");
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
  });
  // Managed launch first — primes the sessionReady memo for "autopilot".
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  // Now ensureLaunched into a DIFFERENT session. It must NOT see the
  // memo as "session already ensured" — it must run its own probe,
  // see "restored" missing, attach, poll, new-tab.
  await backend.ensureLaunched(
    "restored",
    ["/bin/zsh", "-c", "echo hi"],
    "/abs",
  );
  // Two list-sessions: one for managed launch (probe 1), at least
  // one more for ensureLaunched (probe 2 + post-attach poll).
  expect(
    calls.filter((c) => c[1] === "list-sessions").length,
  ).toBeGreaterThanOrEqual(2);
  // The attach for "restored" fired — proving ensureLaunched ran its
  // own mint and did NOT short-circuit on the managed memo.
  const restoredAttach = calls.find(
    (c) => c[1] === "attach" && c[4] === "restored",
  );
  expect(restoredAttach).toEqual([
    "zellij",
    "attach",
    "-b",
    "--forget",
    "restored",
  ]);
  // The fresh-mint default tab on "restored" is kept as a keepalive
  // anchor — no close-tab-by-id is issued against either session.
  expect(calls.some((c) => c[4] === "close-tab-by-id")).toBe(false);
});

test("ExecBackend.ensureLaunched: empty `name` string still omits --name (defensive)", async () => {
  // Spec calls for unnamed tabs; the API accepts an optional `name`
  // but the restore caller may pass an empty string. The argv
  // builder already collapses both undefined and "" to no flag —
  // this test pins the contract end-to-end so a regression that
  // forwards an empty `--name ""` would surface here.
  const calls: string[][] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string) => ({
      exited: Promise.resolve(0),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
    });
    if (cmd[1] === "list-sessions") return reply("restored\n");
    return reply("");
  };
  const backend = createZellijBackend({ noteLine: () => {}, spawn });
  await backend.ensureLaunched("restored", ["sh"], "/abs", "");
  const newTab = calls.find((c) => c[1] === "--session" && c[4] === "new-tab");
  expect(newTab).toBeDefined();
  expect(newTab).not.toContain("--name");
});

// ---------------------------------------------------------------------------
// fn-724 reap primitives: collectPanesFromListJson / dispatchKeyForPane /
// closePaneIdForReap / ExecBackend.reapSurfaces
// ---------------------------------------------------------------------------

test("collectPanesFromListJson: lifts every terminal pane, skips plugins, array shape", () => {
  // zellij 0.44.3 ships a top-level array; plugin panes carry ids in an
  // unrelated namespace and must be skipped.
  const payload = parseListPanesJson(
    JSON.stringify([
      { id: 0, tab_name: "Tab #1", is_plugin: true },
      { id: 3, tab_name: "Tab #4", exited: false, terminal_command: "claude" },
      { id: 5, tab_name: "Tab #4", exited: true, terminal_command: null },
    ]),
  );
  const panes = collectPanesFromListJson(payload);
  expect(panes.map((p) => p.id)).toEqual(["3", "5"]);
  expect(panes[0]?.tab_name).toBe("Tab #4");
  expect(panes[0]?.exited).toBe(false);
  expect(panes[1]?.exited).toBe(true);
  expect(panes[1]?.terminal_command).toBeNull();
});

test("collectPanesFromListJson: object-of-arrays shape lifts tab name from key, empty → []", () => {
  const payload = parseListPanesJson(
    JSON.stringify({ "Tab #2": [{ id: 9, terminal_command: "sh" }] }),
  );
  const panes = collectPanesFromListJson(payload);
  expect(panes).toHaveLength(1);
  expect(panes[0]?.id).toBe("9");
  expect(panes[0]?.tab_name).toBe("Tab #2");
  // null / non-object payloads → []
  expect(collectPanesFromListJson(null)).toEqual([]);
  expect(collectPanesFromListJson(parseListPanesJson(""))).toEqual([]);
  expect(collectPanesFromListJson(42)).toEqual([]);
});

test("dispatchKeyForPane: lifts verb::id from terminal_command (fn-711 unnamed tab)", () => {
  // Post-fn-711 the TAB is unnamed (`Tab #N`); the verb::id lives only in
  // the `claude --name verb::id` arg inside terminal_command.
  const pane: ZellijPane = {
    id: "3",
    tab_name: "Tab #4",
    exited: false,
    terminal_command:
      "/bin/zsh -l -i -c cd /repo && claude --model sonnet --name work::fn-724-x.2 --plugin-dir /p '/plan:work fn-724-x.2'",
  };
  expect(dispatchKeyForPane(pane)).toBe("work::fn-724-x.2");
});

test("dispatchKeyForPane: tab_name takes precedence; work/close verbs match; none → null", () => {
  // A named-tab launch path (future / restore) still matches via tab_name.
  // fn-756: the verb whitelist is `work|close` (approve dropped).
  expect(
    dispatchKeyForPane({
      id: "1",
      tab_name: "work::fn-1-foo.3",
      terminal_command: "claude --name close::other.1",
    }),
  ).toBe("work::fn-1-foo.3");
  // close:: verb
  expect(
    dispatchKeyForPane({
      id: "2",
      tab_name: "Tab #1",
      terminal_command: "claude --name close::fn-2-bar.1 '/plan:close ...'",
    }),
  ).toBe("close::fn-2-bar.1");
  // No verb-prefixed token anywhere → null (a human's ad-hoc pane).
  expect(
    dispatchKeyForPane({
      id: "7",
      tab_name: "Tab #9",
      terminal_command: "/bin/zsh -l -i",
    }),
  ).toBeNull();
  // Missing terminal_command, plain tab → null.
  expect(dispatchKeyForPane({ id: "8", tab_name: "Tab #3" })).toBeNull();
});

test("closePaneIdForReap: prefixes a bare numeric id, idempotent on terminal_<n>", () => {
  expect(closePaneIdForReap("3")).toBe("terminal_3");
  expect(closePaneIdForReap("terminal_5")).toBe("terminal_5");
});

/**
 * Build a spawn stub for the reap path: `list-panes -a -j` returns the
 * canned JSON, `close-pane -p <id>` returns the canned exit (default 0).
 * Records every spawn into `calls`.
 */
function makeReapSpawnStub(
  listPanesJson: string,
  closeExitById: Record<string, number>,
  calls: string[][],
  opts: { listExit?: number } = {},
): SpawnFn {
  return (cmd, _options) => {
    calls.push([...cmd]);
    const reply = (stdout: string, exitCode = 0, stderr = "") => ({
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response(stderr).body,
    });
    if (cmd[4] === "list-panes") {
      return reply(listPanesJson, opts.listExit ?? 0);
    }
    if (cmd[4] === "close-pane") {
      const closeId = cmd[6] ?? "";
      const ex = closeExitById[closeId] ?? 0;
      return reply("", ex, ex === 0 ? "" : "pane gone");
    }
    return reply("");
  };
}

test("reapSurfaces: closes ONLY predicate-selected panes via close-pane -p terminal_<id>", async () => {
  const calls: string[][] = [];
  // Two worker surfaces (work::A, work::B) and one human pane.
  const json = JSON.stringify([
    {
      id: 3,
      tab_name: "Tab #4",
      exited: true,
      terminal_command: "claude --name work::A",
    },
    {
      id: 5,
      tab_name: "Tab #5",
      exited: false,
      terminal_command: "claude --name work::B",
    },
    { id: 9, tab_name: "Tab #6", terminal_command: "/bin/zsh -l -i" },
  ]);
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn: makeReapSpawnStub(json, {}, calls),
  });
  // Predicate selects only work::A (the OPEN-pending intersect the
  // autopilot worker applies; here modeled as a name-set membership).
  const open = new Set(["work::A"]);
  const result = await backend.reapSurfaces((pane) => {
    const key = dispatchKeyForPane(pane);
    return key != null && open.has(key);
  });
  expect(result.examined).toBe(3);
  expect(result.reaped).toBe(1);
  expect(result.failed).toBe(0);
  expect(result.skippedNoSnapshot).toBe(false);
  // Exactly one close-pane, targeting terminal_3 (the bare id 3 → prefixed).
  const closes = calls.filter((c) => c[4] === "close-pane");
  expect(closes).toHaveLength(1);
  expect(closes[0]).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "close-pane",
    "-p",
    "terminal_3",
  ]);
});

test("reapSurfaces: LIVE-worker guard — a pane whose row discharged is NEVER closed", async () => {
  // Safety pin (highest blast radius): work::B's pending row already
  // discharged on SessionStart (NOT in the open set), so even though its
  // pane is live in list-panes, the predicate excludes it. Only work::A
  // (still open) is reaped — never the live worker.
  const calls: string[][] = [];
  const json = JSON.stringify([
    { id: 3, tab_name: "Tab #4", terminal_command: "claude --name work::A" },
    { id: 5, tab_name: "Tab #5", terminal_command: "claude --name work::B" },
  ]);
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn: makeReapSpawnStub(json, {}, calls),
  });
  const open = new Set(["work::A"]); // work::B discharged → live worker
  const result = await backend.reapSurfaces((pane) => {
    const key = dispatchKeyForPane(pane);
    return key != null && open.has(key);
  });
  expect(result.reaped).toBe(1);
  const closes = calls.filter((c) => c[4] === "close-pane");
  expect(closes).toHaveLength(1);
  expect(closes[0]?.[6]).toBe("terminal_3");
  // work::B (terminal_5) was NEVER closed.
  expect(closes.some((c) => c[6] === "terminal_5")).toBe(false);
});

test("reapSurfaces: empty/unparseable list-panes → skippedNoSnapshot, no close, no throw", async () => {
  for (const out of ["", "   \n ", "not json"]) {
    const calls: string[][] = [];
    const backend = createZellijBackend({
      noteLine: () => {},
      session: "autopilot",
      spawn: makeReapSpawnStub(out, {}, calls),
    });
    const result = await backend.reapSurfaces(() => true);
    expect(result.skippedNoSnapshot).toBe(true);
    expect(result.reaped).toBe(0);
    expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
  }
});

test("reapSurfaces: non-zero list-panes exit → skippedNoSnapshot (no guess)", async () => {
  const calls: string[][] = [];
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn: makeReapSpawnStub("[]", {}, calls, { listExit: 1 }),
  });
  const result = await backend.reapSurfaces(() => true);
  expect(result.skippedNoSnapshot).toBe(true);
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
});

test("reapSurfaces: per-pane close failure logs + continues, never throws", async () => {
  const notes: string[] = [];
  const calls: string[][] = [];
  const json = JSON.stringify([
    { id: 3, tab_name: "Tab #4", terminal_command: "claude --name work::A" },
    { id: 5, tab_name: "Tab #5", terminal_command: "claude --name work::B" },
  ]);
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    // terminal_3 close fails (exit 1); terminal_5 succeeds.
    spawn: makeReapSpawnStub(json, { terminal_3: 1 }, calls),
  });
  const result = await backend.reapSurfaces(() => true);
  // Did not throw; partitioned into one failed + one reaped.
  expect(result.examined).toBe(2);
  expect(result.failed).toBe(1);
  expect(result.reaped).toBe(1);
  // Both closes were attempted (the failure did not abort the loop).
  const closes = calls.filter((c) => c[4] === "close-pane");
  expect(closes.map((c) => c[6]).sort()).toEqual(["terminal_3", "terminal_5"]);
  // A warn line was emitted for the failed close.
  expect(
    notes.some((n) => n.includes("terminal_3") && n.includes("failed")),
  ).toBe(true);
});

test("reapSurfaces: list-panes ENOENT (spawn throws) → skippedNoSnapshot, no throw", async () => {
  const calls: string[][] = [];
  const spawn: SpawnFn = (cmd) => {
    calls.push([...cmd]);
    throw new Error("ENOENT: zellij missing");
  };
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn,
  });
  const result = await backend.reapSurfaces(() => true);
  expect(result.skippedNoSnapshot).toBe(true);
  expect(result.reaped).toBe(0);
});

// ---------------------------------------------------------------------------
// fn-727 — completion-reap pass: reapSurfaces driven by the REAL
// `isCompletionReapCandidate` predicate (the wiring the autopilot worker's
// `reapCompletionSurfaces` performs). The worker-scope early-return on
// flag-off / empty-set lives in the worker closure; here we exercise the
// predicate-through-reapSurfaces seam — the same shape the fn-724 pause
// reap tests use.
// ---------------------------------------------------------------------------

test("completion reap: a completed task reaps work::<id> (fn-756: no approve pane to pair)", async () => {
  const calls: string[][] = [];
  // Live session: the completed task's work pane, plus an unrelated worker on
  // a non-completed id and a human tab. fn-756: there is no `approve::` pane
  // any more, and even a stale one (id 2 below) is no longer name-matched, so
  // only the `work::<id>` pane reaps.
  const json = JSON.stringify([
    { id: 1, tab_name: "work::fn-1-foo.3", terminal_command: "claude" },
    {
      id: 2,
      tab_name: "Tab #2",
      terminal_command: "claude --name approve::fn-1-foo.3",
      exited: true,
    },
    { id: 3, tab_name: "work::fn-9-other.1", terminal_command: "claude" },
    { id: 4, tab_name: "Tab #4", terminal_command: "/bin/zsh -l -i" },
  ]);
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn: makeReapSpawnStub(json, {}, calls),
  });
  const completed = new Set(["fn-1-foo.3"]);
  const result = await backend.reapSurfaces((pane) =>
    isCompletionReapCandidate(completed, pane),
  );
  // Exactly the work pane for the completed id — the stale approve pane (id 2)
  // is no longer a dispatch key and is NOT reaped.
  expect(result.reaped).toBe(1);
  expect(result.failed).toBe(0);
  const closes = calls.filter((c) => c[4] === "close-pane").map((c) => c[6]);
  expect(closes.sort()).toEqual(["terminal_1"]);
  // The stale approve pane (terminal_2), the non-completed worker (terminal_3)
  // and the human tab (terminal_4) were NEVER touched.
  expect(closes.includes("terminal_2")).toBe(false);
  expect(closes.includes("terminal_3")).toBe(false);
  expect(closes.includes("terminal_4")).toBe(false);
});

test("completion reap: a completed close-row reaps close::<id> (fn-756: no approve pane to pair)", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify([
    { id: 1, tab_name: "close::fn-2-bar", terminal_command: "claude" },
    {
      id: 2,
      tab_name: "Tab #2",
      terminal_command: "claude --name approve::fn-2-bar",
    },
  ]);
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn: makeReapSpawnStub(json, {}, calls),
  });
  const completed = new Set(["fn-2-bar"]);
  const result = await backend.reapSurfaces((pane) =>
    isCompletionReapCandidate(completed, pane),
  );
  // Only the close pane — the stale approve pane is no longer name-matched.
  expect(result.reaped).toBe(1);
  const closes = calls.filter((c) => c[4] === "close-pane").map((c) => c[6]);
  expect(closes.sort()).toEqual(["terminal_1"]);
});

test("completion reap: pending / rejected / worker-ended-unapproved surfaces are NOT reaped", async () => {
  // None of these ids reached `{tag:"completed"}`, so the empty completed
  // set leaves every surface open — the human-inspection guarantee.
  const calls: string[][] = [];
  const json = JSON.stringify([
    { id: 1, tab_name: "work::fn-pending.1", terminal_command: "claude" },
    { id: 2, tab_name: "approve::fn-rejected.2", terminal_command: "claude" },
    { id: 3, tab_name: "work::fn-ended.3", terminal_command: "claude" },
  ]);
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn: makeReapSpawnStub(json, {}, calls),
  });
  const completed = new Set<string>(); // nothing approved-completed
  const result = await backend.reapSurfaces((pane) =>
    isCompletionReapCandidate(completed, pane),
  );
  expect(result.examined).toBe(3);
  expect(result.reaped).toBe(0);
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
});

test("completion reap: a predicate throw is contained by the worker's try/catch, not reapSurfaces", async () => {
  // `isCompletionReapCandidate` is pure and never throws, but if a
  // predicate DID throw, `reapSurfaces` propagates it (no per-pane catch in
  // its loop). The swallow point is the worker's `reapCompletionSurfaces`
  // try/catch — a throw there would otherwise bounce the daemon
  // (no-self-heal). This pins the seam: the backend propagates; the CALLER
  // contains. No close-pane fires before the throw.
  const calls: string[][] = [];
  const json = JSON.stringify([
    { id: 1, tab_name: "work::fn-1-foo.3", terminal_command: "claude" },
  ]);
  const backend = createZellijBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn: makeReapSpawnStub(json, {}, calls),
  });
  let threw = false;
  try {
    await backend.reapSurfaces(() => {
      throw new Error("predicate boom");
    });
  } catch {
    threw = true;
  }
  expect(threw).toBe(true); // backend propagates — caller's catch contains
  expect(calls.some((c) => c[4] === "close-pane")).toBe(false);
});
