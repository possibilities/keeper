/**
 * Pure-function + argv-construction tests for `src/exec-backend.ts`.
 *
 * Coverage:
 *  - Pure builders (`buildZellijNewTabArgs`, `buildZellijCloseTabArgs`,
 *    `buildZellijListSessionsArgs`, `buildZellijListTabsArgs`,
 *    `buildZellijAttachBgArgs`) produce the zellij CLI shape the live
 *    spec calls for.
 *  - `createZellijBackend.launch` returns `{ ok }` (no pane id),
 *    threads `--name` through, and keeps the fresh-mint default tab as
 *    a keepalive anchor (never reaped).
 *  - `resolveExecBackend` returns a zellij backend; tolerates undefined
 *    session via `MANAGED_EXEC_SESSION`.
 *
 * No filesystem or process side effects: every spawn is a stub that
 * returns canned stdout/stderr/exit-code via in-memory streams.
 */

import { expect, test } from "bun:test";
import {
  buildTmuxHasSessionArgs,
  buildTmuxNewSessionArgs,
  buildTmuxNewWindowArgs,
  buildTmuxSelectPaneArgs,
  buildTmuxSelectWindowArgs,
  buildZellijAttachBgArgs,
  buildZellijCloseTabArgs,
  buildZellijFocusPaneArgs,
  buildZellijListSessionsArgs,
  buildZellijListTabsArgs,
  buildZellijNewTabArgs,
  createTmuxBackend,
  createZellijBackend,
  DEFAULT_EXEC_BACKEND,
  execBackendEnvMeta,
  firstTabIdFromListTabs,
  MANAGED_EXEC_SESSION,
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
      kill: () => {},
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

test("buildZellijListTabsArgs: well-formed", () => {
  expect(buildZellijListTabsArgs("autopilot")).toEqual([
    "zellij",
    "--session",
    "autopilot",
    "action",
    "list-tabs",
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
      kill: () => {},
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
  // No list-panes call during launch.
  expect(calls.some((c) => c[4] === "list-panes")).toBe(false);
});

test("createZellijBackend.launch: a never-resolving new-tab is killed at the timeout and degrades to { ok: false } (fn-765)", async () => {
  // A wedged `zellij action` (server hang) would freeze proc.exited
  // forever — and the reconciler with it, no fatalExit. runCapture must
  // race a kill-timeout: on expiry it kills the child and returns null,
  // which launch folds into the sticky { ok: false } envelope. We shrink
  // the timeout via captureTimeoutMs so the test doesn't wait the real 5s.
  const calls: string[][] = [];
  const notes: string[] = [];
  let newTabKilled = false;
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    // list-sessions resolves immediately (session is live); the new-tab
    // never resolves, modelling a hung zellij IPC.
    if (cmd[1] === "list-sessions") {
      return {
        exited: Promise.resolve(0),
        stdout: new Response("autopilot\n").body,
        stderr: new Response("").body,
        kill: () => {},
      };
    }
    return {
      // Never resolves — the wedge.
      exited: new Promise<number>(() => {}),
      stdout: new Response("").body,
      stderr: new Response("").body,
      kill: () => {
        newTabKilled = true;
      },
    };
  };
  const backend = createZellijBackend({
    noteLine: (s) => notes.push(s),
    session: "autopilot",
    spawn,
    captureTimeoutMs: 20,
  });
  const res = await backend.launch(
    ["/bin/zsh", "-c", "echo hi"],
    "work::fn-1-x.1",
    "/tmp/proj",
  );
  // runCapture timed out → null → the ENOENT-shaped { ok: false } envelope.
  expect(res.ok).toBe(false);
  // The hung child was force-killed (no leaked zombie).
  expect(newTabKilled).toBe(true);
  // A timeout warn was emitted for observability.
  expect(notes.some((n) => n.includes("exceeded 20ms"))).toBe(true);
});

test("createZellijBackend.launch: non-zero new-tab exit → { ok: false, error }", async () => {
  const notes: string[] = [];
  const spawn: SpawnFn = (cmd, _options) => {
    const reply = (stdout: string, exitCode = 0) => ({
      exited: Promise.resolve(exitCode),
      stdout: new Response(stdout).body,
      stderr: new Response("").body,
      kill: () => {},
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
      kill: () => {},
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
      kill: () => {},
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
        kill: () => {},
      };
    }
    if (cmd[1] === "attach" && cmd[2] === "-b") {
      return {
        exited: Promise.resolve(0),
        stdout: new Response("").body,
        stderr: new Response("").body,
        kill: () => {},
      };
    }
    if (cmd[1] === "--session" && cmd[4] === "list-tabs") {
      // Fresh-mint default tab capture.
      return {
        exited: Promise.resolve(0),
        stdout: new Response("TAB_ID  POSITION  NAME\n0  0  Tab #1\n").body,
        stderr: new Response("").body,
        kill: () => {},
      };
    }
    if (cmd[1] === "--session" && cmd[4] === "new-tab") {
      return {
        exited: Promise.resolve(0),
        stdout: new Response("12\n").body,
        stderr: new Response("").body,
        kill: () => {},
      };
    }
    return {
      exited: Promise.resolve(0),
      stdout: new Response("").body,
      stderr: new Response("").body,
      kill: () => {},
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
        kill: () => {},
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
      kill: () => {},
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
        kill: () => {},
      };
    }
    return {
      exited: Promise.resolve(0),
      stdout: new Response("").body,
      stderr: new Response("").body,
      kill: () => {},
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
      kill: () => {},
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
      kill: () => {},
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
        stdout: `${MANAGED_EXEC_SESSION}\n`,
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
  expect(actionCall?.[2]).toBe(MANAGED_EXEC_SESSION);
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
      kill: () => {},
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
      kill: () => {},
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
      kill: () => {},
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
      kill: () => {},
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
      kill: () => {},
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
      kill: () => {},
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

// ===========================================================================
// tmux backend
// ===========================================================================

// ---------------------------------------------------------------------------
// execBackendEnvMeta — tmux arm
// ---------------------------------------------------------------------------

test("execBackendEnvMeta: 'tmux' returns KEEPER_TMUX_SESSION / TMUX_PANE", () => {
  const meta = execBackendEnvMeta("tmux");
  expect(meta.backendType).toBe("tmux");
  expect(meta.sessionIdEnvVar).toBe("KEEPER_TMUX_SESSION");
  expect(meta.paneIdEnvVar).toBe("TMUX_PANE");
});

test("execBackendEnvMeta: unknown backend keeps its label but falls back to zellij env vars", () => {
  const meta = execBackendEnvMeta("wezterm");
  expect(meta.backendType).toBe("wezterm");
  expect(meta.sessionIdEnvVar).toBe("ZELLIJ_SESSION_NAME");
  expect(meta.paneIdEnvVar).toBe("ZELLIJ_PANE_ID");
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

test("buildTmuxNewWindowArgs: trailing-colon session target, -e injection, -P -F pane id, chained `;` set-option, no -n when unnamed", () => {
  const got = buildTmuxNewWindowArgs("autopilot", "/Users/mike/code/keeper", [
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    "echo hi",
  ]);
  expect(got).toEqual([
    "tmux",
    "new-window",
    "-t",
    "autopilot:",
    "-c",
    "/Users/mike/code/keeper",
    "-e",
    "KEEPER_TMUX_SESSION=autopilot",
    "-P",
    "-F",
    "#{pane_id}",
    "--",
    "/bin/zsh",
    "-l",
    "-i",
    "-c",
    "echo hi",
    ";",
    "set-option",
    "-p",
    "remain-on-exit",
    "on",
  ]);
  // The `;` is a SEPARATE argv element (tmux command separator), not a
  // shell-joined string — the chained set-option holds the dead pane.
  expect(got.filter((a) => a === ";")).toHaveLength(1);
  // No window name when unnamed (managed-launch contract).
  expect(got).not.toContain("-n");
});

test("buildTmuxNewWindowArgs: inserts -n <name> before -P when provided (restore seam)", () => {
  const got = buildTmuxNewWindowArgs(
    "restored",
    "/abs",
    ["sh"],
    "work::fn-1-x.1",
  );
  const nameIdx = got.indexOf("-n");
  const pIdx = got.indexOf("-P");
  expect(nameIdx).toBeGreaterThan(-1);
  expect(got[nameIdx + 1]).toBe("work::fn-1-x.1");
  // -n lands before the -P -F print spec and the -- argv boundary.
  expect(nameIdx).toBeLessThan(pIdx);
});

test("buildTmuxNewWindowArgs: omits -n for empty/absent name", () => {
  expect(buildTmuxNewWindowArgs("s", "/abs", ["sh"], "")).not.toContain("-n");
  expect(buildTmuxNewWindowArgs("s", "/abs", ["sh"])).not.toContain("-n");
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

// ---------------------------------------------------------------------------
// createTmuxBackend.launch — get-or-create + chained new-window
// ---------------------------------------------------------------------------

test("createTmuxBackend.launch: live session (has-session exit 0) → new-window only, no mint, unnamed window", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:has-session": { exitCode: 0 },
      "tmux:new-window": { stdout: "%3\n", exitCode: 0 },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const res = await backend.launch(
    ["/bin/zsh", "-l", "-i", "-c", "echo hi"],
    "work::fn-1-x.1",
    "/abs/dir",
  );
  expect(res).toEqual({ ok: true });
  // has-session probe fired against the managed session, then new-window.
  expect(calls[0]).toEqual(buildTmuxHasSessionArgs(MANAGED_EXEC_SESSION));
  const win = calls.find((c) => c[1] === "new-window");
  expect(win?.[3]).toBe(`${MANAGED_EXEC_SESSION}:`);
  // No mint — the live session was respected.
  expect(calls.some((c) => c[1] === "new-session")).toBe(false);
  // Managed window stays UNNAMED — `name` is the dedup key only.
  expect(win).not.toContain("-n");
});

test("createTmuxBackend.launch: absent session (has-session non-zero) → new-session mint then new-window", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:has-session": { exitCode: 1 },
      "tmux:new-session": { exitCode: 0 },
      "tmux:new-window": { stdout: "%1\n", exitCode: 0 },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const res = await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(res).toEqual({ ok: true });
  // Order: has-session (absent) → new-session mint → new-window.
  expect(calls[0]?.[1]).toBe("has-session");
  expect(calls[1]).toEqual(buildTmuxNewSessionArgs(MANAGED_EXEC_SESSION));
  expect(calls[2]?.[1]).toBe("new-window");
});

test("createTmuxBackend.launch: new-session mint carries color env (TERM/COLORTERM); has-session/new-window do not", async () => {
  const calls: string[][] = [];
  const envByCall: Array<Record<string, string> | undefined> = [];
  const spawn: SpawnFn = (cmd, options) => {
    calls.push([...cmd]);
    envByCall.push(options.env);
    const exitCode = cmd[1] === "has-session" ? 1 : 0;
    return {
      exited: Promise.resolve(exitCode),
      stdout: new Response(cmd[1] === "new-window" ? "%1\n" : "").body,
      stderr: new Response("").body,
      kill: () => {},
    };
  };
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  const mintIdx = calls.findIndex((c) => c[1] === "new-session");
  expect(mintIdx).toBeGreaterThan(-1);
  const mintEnv = envByCall[mintIdx];
  expect(mintEnv?.TERM).toBeDefined();
  expect(mintEnv?.COLORTERM).toBeDefined();
  // Control commands carry NO env override (Bun inherits process.env).
  const hasIdx = calls.findIndex((c) => c[1] === "has-session");
  const winIdx = calls.findIndex((c) => c[1] === "new-window");
  expect(envByCall[hasIdx]).toBeUndefined();
  expect(envByCall[winIdx]).toBeUndefined();
});

test("createTmuxBackend.launch: non-zero new-window exit → { ok: false, error }", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:has-session": { exitCode: 0 },
      "tmux:new-window": { stderr: "no such session", exitCode: 1 },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const res = await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("exited non-zero");
  }
});

test("createTmuxBackend.launch: session-gone new-window stderr → exactly one new-window, NO re-ensure/retry (inverse of zellij)", async () => {
  // The tmux backend deliberately omits zellij's session-gone
  // memo-invalidate-and-retry arm: a per-call `has-session` probe is cheap,
  // so `launchInto` runs `ensureSessionFor` → `new-window` exactly ONCE and
  // surfaces `{ ok: false }` on a session-gone failure rather than re-minting
  // and retrying. This pins that non-retry contract.
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      // Probe says live, so no mint fires; the window then dies session-gone.
      "tmux:has-session": { exitCode: 0 },
      "tmux:new-window": { stderr: "can't find session: x", exitCode: 1 },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const res = await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(res.ok).toBe(false);
  // Exactly one new-window spawn — no second attempt.
  const windows = calls.filter((c) => c[1] === "new-window");
  expect(windows.length).toBe(1);
  // Exactly one has-session probe — no re-ensure after the failure.
  const probes = calls.filter((c) => c[1] === "has-session");
  expect(probes.length).toBe(1);
  // No mint at all on this path (probe said live), and certainly no second one.
  expect(calls.some((c) => c[1] === "new-session")).toBe(false);
});

test("createTmuxBackend.launch: ENOENT (binary missing) → { ok: false, error }, never throws", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const res = await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(res.ok).toBe(false);
  if (res.ok === false) {
    expect(res.error).toContain("failed");
  }
});

// ---------------------------------------------------------------------------
// createTmuxBackend.focusPane — id-based select-window then select-pane
// ---------------------------------------------------------------------------

test("createTmuxBackend.focusPane: exit 0 → select-window then select-pane against the pane id, { ok: true }", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:select-window": { exitCode: 0 },
      "tmux:select-pane": { exitCode: 0 },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.focusPane("any-session", "%7");
  expect(got).toEqual({ ok: true });
  // Both ops target the server-global pane id, never the session name.
  expect(calls[0]).toEqual(buildTmuxSelectWindowArgs("%7"));
  expect(calls[1]).toEqual(buildTmuxSelectPaneArgs("%7"));
});

test("createTmuxBackend.focusPane: select-window non-zero → { ok: false }, select-pane never runs", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:select-window": { stderr: "can't find pane", exitCode: 1 },
      "tmux:select-pane": { exitCode: 0 },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.focusPane("s", "%99");
  expect(got.ok).toBe(false);
  if (got.ok === false) {
    expect(got.error).toContain("exited 1");
    expect(got.error).toContain("can't find pane");
  }
  // select-pane is gated on a successful select-window.
  expect(calls.some((c) => c[1] === "select-pane")).toBe(false);
});

test("createTmuxBackend.focusPane: ENOENT throw → { ok: false }, never throws back", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.focusPane("s", "%1");
  expect(got.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// createTmuxBackend.ensureLaunched — per-call session, restore -n seam
// ---------------------------------------------------------------------------

test("createTmuxBackend.ensureLaunched: live per-call session → new-window with -e KEEPER_TMUX_SESSION=<target>, omits -n when absent", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:has-session": { exitCode: 0 },
      "tmux:new-window": { stdout: "%4\n", exitCode: 0 },
    },
    calls,
  );
  const backend = createTmuxBackend({
    noteLine: () => {},
    session: "autopilot",
    spawn,
  });
  const res = await backend.ensureLaunched("human-session", ["sh"], "/proj");
  expect(res).toEqual({ ok: true });
  // has-session probed the PER-CALL session, not the construction default.
  expect(calls[0]).toEqual(buildTmuxHasSessionArgs("human-session"));
  const win = calls.find((c) => c[1] === "new-window");
  expect(win?.[3]).toBe("human-session:");
  // -e carries the per-call session name for the hook's session stamp.
  const eIdx = win?.indexOf("-e") ?? -1;
  expect(win?.[eIdx + 1]).toBe("KEEPER_TMUX_SESSION=human-session");
  // No mint (live), no -n (unnamed restore).
  expect(calls.some((c) => c[1] === "new-session")).toBe(false);
  expect(win).not.toContain("-n");
});

test("createTmuxBackend.ensureLaunched: absent per-call session mints then new-window with -n <name>", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:has-session": { exitCode: 1 },
      "tmux:new-session": { exitCode: 0 },
      "tmux:new-window": { stdout: "%2\n", exitCode: 0 },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const res = await backend.ensureLaunched(
    "restored",
    ["sh"],
    "/abs",
    "work::fn-9-y.2",
  );
  expect(res).toEqual({ ok: true });
  // mint targets the per-call session.
  expect(calls.find((c) => c[1] === "new-session")).toEqual(
    buildTmuxNewSessionArgs("restored"),
  );
  const win = calls.find((c) => c[1] === "new-window");
  const nameIdx = win?.indexOf("-n") ?? -1;
  expect(nameIdx).toBeGreaterThan(-1);
  expect(win?.[nameIdx + 1]).toBe("work::fn-9-y.2");
});

// ---------------------------------------------------------------------------
// resolveExecBackend — backendType switch
// ---------------------------------------------------------------------------

test("resolveExecBackend: backendType 'tmux' routes through the tmux factory", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:has-session": { exitCode: 0 },
      "tmux:new-window": { stdout: "%1\n", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend({
    noteLine: () => {},
    backendType: "tmux",
    spawn,
  });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  // A tmux backend issues `tmux has-session`, never a zellij command.
  expect(calls[0]?.[0]).toBe("tmux");
  expect(calls.some((c) => c[0] === "zellij")).toBe(false);
});

test("resolveExecBackend: absent backendType defaults to zellij", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": { stdout: `${MANAGED_EXEC_SESSION}\n` },
      "zellij:--session": { exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend({ noteLine: () => {}, spawn });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(calls[0]?.[0]).toBe("zellij");
  expect(calls.some((c) => c[0] === "tmux")).toBe(false);
});

test("resolveExecBackend: unknown backendType falls through to zellij", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "zellij:list-sessions": { stdout: `${MANAGED_EXEC_SESSION}\n` },
      "zellij:--session": { exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend({
    noteLine: () => {},
    backendType: "wezterm",
    spawn,
  });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(calls[0]?.[0]).toBe("zellij");
});
