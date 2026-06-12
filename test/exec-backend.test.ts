/**
 * Pure-function + argv-construction tests for `src/exec-backend.ts`.
 *
 * Coverage:
 *  - Pure tmux argv builders (`buildTmuxHasSessionArgs`,
 *    `buildTmuxNewSessionArgs`, `buildTmuxNewWindowArgs`,
 *    `buildTmuxSelectWindowArgs`, `buildTmuxSelectPaneArgs`) produce the tmux
 *    CLI shape the live spec calls for.
 *  - `createTmuxBackend` — `launch` get-or-create + chained `new-window`,
 *    `focusPane` id-based select-window+select-pane, `ensureLaunched` per-call
 *    session + restore `-n` seam, the timeout-kill degrade, and ENOENT/non-zero
 *    failure envelopes.
 *  - `resolveExecBackend` returns the tmux backend for EVERY tag (tmux, unknown,
 *    legacy `zellij`, absent) and tolerates an undefined session via
 *    `MANAGED_EXEC_SESSION`.
 *  - `execBackendEnvMeta` returns the tmux env-var names, including the
 *    fall-through for unknown backends.
 *
 * No filesystem or process side effects: every spawn is a stub that returns
 * canned stdout/stderr/exit-code via in-memory streams.
 */

import { expect, test } from "bun:test";
import {
  buildTmuxHasSessionArgs,
  buildTmuxListPanesArgs,
  buildTmuxNewSessionArgs,
  buildTmuxNewWindowArgs,
  buildTmuxRenameWindowArgs,
  buildTmuxSelectPaneArgs,
  buildTmuxSelectWindowArgs,
  createTmuxBackend,
  DEFAULT_EXEC_BACKEND,
  execBackendEnvMeta,
  MANAGED_EXEC_SESSION,
  resolveExecBackend,
  type SpawnFn,
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
});

test("execBackendEnvMeta: 'tmux' returns KEEPER_TMUX_SESSION / TMUX_PANE", () => {
  const meta = execBackendEnvMeta("tmux");
  expect(meta.backendType).toBe("tmux");
  expect(meta.sessionIdEnvVar).toBe("KEEPER_TMUX_SESSION");
  expect(meta.paneIdEnvVar).toBe("TMUX_PANE");
});

test("execBackendEnvMeta: unknown backend keeps its label but falls back to tmux env vars", () => {
  const meta = execBackendEnvMeta("wezterm");
  expect(meta.backendType).toBe("wezterm");
  expect(meta.sessionIdEnvVar).toBe("KEEPER_TMUX_SESSION");
  expect(meta.paneIdEnvVar).toBe("TMUX_PANE");
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

test("buildTmuxListPanesArgs: -a sweep, tab-delimited format with window_name last", () => {
  expect(buildTmuxListPanesArgs()).toEqual([
    "tmux",
    "list-panes",
    "-a",
    "-F",
    "#{pane_id}\t#{window_id}\t#{window_name}",
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

test("createTmuxBackend.launch: a never-resolving new-window is killed at the timeout and degrades to { ok: false }", async () => {
  // A wedged `tmux` subprocess (server hang) would freeze proc.exited forever —
  // and the reconciler with it, no fatalExit. runCapture must race a
  // kill-timeout: on expiry it kills the child and returns null, which launch
  // folds into the sticky { ok: false } envelope. We shrink the timeout via
  // captureTimeoutMs so the test doesn't wait the real 5s.
  const calls: string[][] = [];
  const notes: string[] = [];
  let windowKilled = false;
  const spawn: SpawnFn = (cmd, _options) => {
    calls.push([...cmd]);
    // has-session resolves immediately (session is live); the new-window never
    // resolves, modelling a hung tmux IPC.
    if (cmd[1] === "has-session") {
      return {
        exited: Promise.resolve(0),
        stdout: new Response("").body,
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
        windowKilled = true;
      },
    };
  };
  const backend = createTmuxBackend({
    noteLine: (s) => notes.push(s),
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
  expect(windowKilled).toBe(true);
  // A timeout warn was emitted for observability.
  expect(notes.some((n) => n.includes("exceeded 20ms"))).toBe(true);
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

test("createTmuxBackend.launch: session-gone new-window stderr → exactly one new-window, NO re-ensure/retry", async () => {
  // The tmux backend runs `ensureSessionFor` → `new-window` exactly ONCE per
  // op: a per-call `has-session` probe is cheap, so a session-gone failure
  // surfaces `{ ok: false }` rather than re-minting and retrying. This pins
  // that non-retry contract.
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
// createTmuxBackend.listPanes — server-wide sweep, tab-safe parse, null degrade
// ---------------------------------------------------------------------------

test("createTmuxBackend.listPanes: parses (paneId, windowId, windowName) from one -a sweep", async () => {
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
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.listPanes();
  expect(calls[0]).toEqual(buildTmuxListPanesArgs());
  expect(got).toEqual([
    { paneId: "%1", windowId: "@1", windowName: "work::fn-1-x.2" },
    { paneId: "%2", windowId: "@2", windowName: "plain shell" },
  ]);
});

test("createTmuxBackend.listPanes: a tab inside a window name stays in windowName (2-split limit)", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:list-panes": {
        // window name itself contains a tab, a colon, and unicode.
        stdout: "%7\t@7\tweird:\tname \u00e9\n",
        exitCode: 0,
      },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.listPanes();
  expect(got).toEqual([
    { paneId: "%7", windowId: "@7", windowName: "weird:\tname \u00e9" },
  ]);
});

test("createTmuxBackend.listPanes: drops malformed lines (missing tabs / empty ids), keeps the rest", async () => {
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
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.listPanes();
  expect(got).toEqual([{ paneId: "%4", windowId: "@4", windowName: "" }]);
});

test("createTmuxBackend.listPanes: non-zero exit (no server) → null", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    { "tmux:list-panes": { stderr: "no server running", exitCode: 1 } },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  expect(await backend.listPanes()).toBeNull();
});

test("createTmuxBackend.listPanes: ENOENT (binary missing) → null, never throws", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  expect(await backend.listPanes()).toBeNull();
});

// ---------------------------------------------------------------------------
// createTmuxBackend.renameWindow — @N target, `--` guard, TOCTOU no-op, ENOENT
// ---------------------------------------------------------------------------

test("createTmuxBackend.renameWindow: exit 0 → { ok: true }, argv targets @N and carries `--`", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub({ "tmux:rename-window": { exitCode: 0 } }, calls);
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.renameWindow("@5", "fn-2-y.1");
  expect(got).toEqual({ ok: true });
  expect(calls[0]).toEqual(buildTmuxRenameWindowArgs("@5", "fn-2-y.1"));
});

test("createTmuxBackend.renameWindow: TOCTOU 'can't find window' non-zero → { ok: false }, silent (no noteLine)", async () => {
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
  const backend = createTmuxBackend({
    noteLine: (l) => notes.push(l),
    spawn,
  });
  const got = await backend.renameWindow("@5", "gone");
  expect(got.ok).toBe(false);
  if (got.ok === false) {
    expect(got.error).toContain("exited 1");
    expect(got.error).toContain("can't find window");
  }
  // A self-healing race must not spam the sidecar.
  expect(notes).toHaveLength(0);
});

test("createTmuxBackend.renameWindow: ENOENT (binary missing) → { ok: false }, never throws", async () => {
  const spawn: SpawnFn = () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.renameWindow("@1", "x");
  expect(got.ok).toBe(false);
});

test("createTmuxBackend: omitting session is allowed (session-agnostic-only consumer)", async () => {
  // Construct with just { noteLine } so a session-agnostic-only consumer (e.g.
  // cli/jobs.ts' `v` focus key) skips the construction-session entirely; the
  // focus call uses the per-call pane id, so the absent default is never read.
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:select-window": { exitCode: 0 },
      "tmux:select-pane": { exitCode: 0 },
    },
    calls,
  );
  const backend = createTmuxBackend({ noteLine: () => {}, spawn });
  const got = await backend.focusPane("any", "%1");
  expect(got).toEqual({ ok: true });
});

// ---------------------------------------------------------------------------
// resolveExecBackend — tmux is the sole backend, so EVERY tag resolves to it
// and an unrecognized/legacy tag NEVER throws.
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
});

test("resolveExecBackend: absent backendType resolves to tmux", async () => {
  const calls: string[][] = [];
  const spawn = makeSpawnStub(
    {
      "tmux:has-session": { exitCode: 0 },
      "tmux:new-window": { stdout: "%1\n", exitCode: 0 },
    },
    calls,
  );
  const backend = resolveExecBackend({ noteLine: () => {}, spawn });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(calls[0]?.[0]).toBe("tmux");
});

test("resolveExecBackend: legacy 'zellij' tag falls through to tmux (never throws)", async () => {
  // Historical job rows carry `backend_exec_type='zellij'`. The collapsed
  // resolver MUST fall through to the tmux backend rather than throw — a throw
  // here would crash focus routing for every legacy-tagged row.
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
    backendType: "zellij",
    spawn,
  });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(calls[0]?.[0]).toBe("tmux");
});

test("resolveExecBackend: unknown/garbage backendType falls through to tmux", async () => {
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
    backendType: "wezterm",
    spawn,
  });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  expect(calls[0]?.[0]).toBe("tmux");
});

test("resolveExecBackend: threads an explicit session through to the tmux factory", async () => {
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
    session: "custom-session",
    spawn,
  });
  await backend.launch(["sh"], "work::fn-1-x.1", "/abs");
  // The construction session is on the has-session probe.
  expect(calls[0]).toEqual(buildTmuxHasSessionArgs("custom-session"));
});
