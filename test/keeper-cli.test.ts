/**
 * Dispatch tests for `cli/keeper.ts`. Exercises the four top-level cases
 * (bare / unknown / `--help` / `--version`) plus the happy-path routing
 * to each subcommand. Uses injected stub handlers + captured sinks so the
 * test never spawns a renderer — per the spec's "assert via the
 * dispatcher's argv parsing, not by spawning a renderer."
 *
 * The exit shim throws a tagged `ExitError` because `dispatch()` is typed
 * to never-return on the top-level cases; a thrower lets the test assert
 * the exit code without process.exit() actually firing under bun:test.
 */

import { describe, expect, test } from "bun:test";
import {
  checkRaceGuard,
  type QueryFn,
  resolvePlanCwd,
  resolveSession,
} from "../cli/dispatch";
import {
  type DispatchDeps,
  dispatch,
  isSubcommand,
  SUBCOMMANDS,
  type Subcommand,
  USAGE,
} from "../cli/keeper";
import type { Row } from "../src/protocol";

class ExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

interface Harness {
  stdout: string[];
  stderr: string[];
  calls: Array<{ sub: Subcommand; argv: string[] }>;
  deps: DispatchDeps;
}

function makeHarness(): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: Array<{ sub: Subcommand; argv: string[] }> = [];
  const mkHandler =
    (sub: Subcommand) =>
    (argv: string[]): void => {
      calls.push({ sub, argv });
    };
  const deps: DispatchDeps = {
    handlers: {
      board: mkHandler("board"),
      jobs: mkHandler("jobs"),
      git: mkHandler("git"),
      usage: mkHandler("usage"),
      autopilot: mkHandler("autopilot"),
      builds: mkHandler("builds"),
      dash: mkHandler("dash"),
      await: mkHandler("await"),
      "commit-work": mkHandler("commit-work"),
      "setup-tmux": mkHandler("setup-tmux"),
      "session-state": mkHandler("session-state"),
      "show-session-files": mkHandler("show-session-files"),
      "search-history": mkHandler("search-history"),
      "find-file-history": mkHandler("find-file-history"),
      "show-session-events": mkHandler("show-session-events"),
      "show-job": mkHandler("show-job"),
      plan: mkHandler("plan"),
      dispatch: mkHandler("dispatch"),
      reclaim: mkHandler("reclaim"),
    },
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
    exit: (code) => {
      throw new ExitError(code);
    },
    version: "9.9.9",
  };
  return { stdout, stderr, calls, deps };
}

describe("cli/keeper dispatch", () => {
  test("bare invocation prints usage to stderr and exits 1", async () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      await dispatch([], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(1);
    expect(h.stderr.join("")).toBe(USAGE);
    expect(h.stdout).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("unknown subcommand prints usage to stderr and exits 1", async () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      await dispatch(["bogus", "--flag"], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(1);
    const err = h.stderr.join("");
    expect(err).toContain("unknown subcommand 'bogus'");
    expect(err).toContain(USAGE);
    expect(h.calls).toEqual([]);
  });

  test("--version prints version to stdout and exits 0", async () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      await dispatch(["--version"], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(0);
    expect(h.stdout.join("")).toBe("keeper 9.9.9\n");
    expect(h.stderr).toEqual([]);
  });

  test("-V is a --version alias", async () => {
    const h = makeHarness();
    try {
      await dispatch(["-V"], h.deps);
    } catch {
      // swallow ExitError
    }
    expect(h.stdout.join("")).toBe("keeper 9.9.9\n");
  });

  test("--help prints usage to stdout and exits 0", async () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      await dispatch(["--help"], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(0);
    expect(h.stdout.join("")).toBe(USAGE);
    expect(h.stderr).toEqual([]);
  });

  test("-h is a --help alias", async () => {
    const h = makeHarness();
    try {
      await dispatch(["-h"], h.deps);
    } catch {
      // swallow ExitError
    }
    expect(h.stdout.join("")).toBe(USAGE);
  });

  for (const sub of SUBCOMMANDS) {
    test(`routes 'keeper ${sub}' to its handler with empty residual argv`, async () => {
      const h = makeHarness();
      await dispatch([sub], h.deps);
      expect(h.calls).toEqual([{ sub, argv: [] }]);
      expect(h.stdout).toEqual([]);
      expect(h.stderr).toEqual([]);
    });

    test(`forwards residual argv to '${sub}' (including --help passthrough)`, async () => {
      const h = makeHarness();
      await dispatch([sub, "--help", "--sock", "/tmp/foo"], h.deps);
      expect(h.calls).toEqual([
        { sub, argv: ["--help", "--sock", "/tmp/foo"] },
      ]);
    });
  }

  test("isSubcommand narrows correctly", () => {
    expect(isSubcommand("board")).toBe(true);
    expect(isSubcommand("jobs")).toBe(true);
    expect(isSubcommand("git")).toBe(true);
    expect(isSubcommand("usage")).toBe(true);
    expect(isSubcommand("autopilot")).toBe(true);
    expect(isSubcommand("builds")).toBe(true);
    expect(isSubcommand("dash")).toBe(true);
    expect(isSubcommand("await")).toBe(true);
    expect(isSubcommand("commit-work")).toBe(true);
    expect(isSubcommand("setup-tmux")).toBe(true);
    expect(isSubcommand("session-state")).toBe(true);
    expect(isSubcommand("show-session-files")).toBe(true);
    expect(isSubcommand("search-history")).toBe(true);
    expect(isSubcommand("find-file-history")).toBe(true);
    expect(isSubcommand("show-session-events")).toBe(true);
    expect(isSubcommand("show-job")).toBe(true);
    expect(isSubcommand("plan")).toBe(true);
    expect(isSubcommand("bogus")).toBe(false);
    expect(isSubcommand("")).toBe(false);
  });

  test("dispatch is a registered subcommand routed to its handler", async () => {
    const h = makeHarness();
    expect(isSubcommand("dispatch")).toBe(true);
    await dispatch(["dispatch", "work::fn-1-x.2"], h.deps);
    expect(h.calls).toEqual([{ sub: "dispatch", argv: ["work::fn-1-x.2"] }]);
  });
});

// ---------------------------------------------------------------------------
// cli/dispatch — plan-form cwd resolution, race guard, session resolution.
// The handler's transport + tmux-probe seams are injected (a stub `QueryFn`
// and `probeCurrentSession`) so these assert pure decision logic with no
// socket, no daemon, no tmux spawn.
// ---------------------------------------------------------------------------

/** A `QueryFn` returning canned rows keyed by collection name. */
function stubQuery(byCollection: Record<string, Row[]>): QueryFn {
  return (collection) => Promise.resolve(byCollection[collection] ?? []);
}

describe("cli/dispatch resolvePlanCwd", () => {
  test("work: task target_repo wins over the epic project_dir", async () => {
    const q = stubQuery({
      epics: [
        {
          epic_id: "fn-1-foo",
          project_dir: "/epic/dir",
          tasks: [{ task_id: "fn-1-foo.2", target_repo: "/task/repo" }],
        },
      ],
    });
    const res = await resolvePlanCwd(q, "work", "fn-1-foo.2");
    expect(res).toEqual({ ok: true, cwd: "/task/repo" });
  });

  test("work: falls back to the epic project_dir when target_repo is empty/absent", async () => {
    const q = stubQuery({
      epics: [
        {
          epic_id: "fn-1-foo",
          project_dir: "/epic/dir",
          tasks: [{ task_id: "fn-1-foo.2", target_repo: "" }],
        },
      ],
    });
    const res = await resolvePlanCwd(q, "work", "fn-1-foo.2");
    expect(res).toEqual({ ok: true, cwd: "/epic/dir" });
  });

  test("close: resolves the epic project_dir", async () => {
    const q = stubQuery({
      epics: [{ epic_id: "fn-1-foo", project_dir: "/epic/dir", tasks: [] }],
    });
    const res = await resolvePlanCwd(q, "close", "fn-1-foo");
    expect(res).toEqual({ ok: true, cwd: "/epic/dir" });
  });

  test("unknown epic id → not-found miss (distinct from unreachable)", async () => {
    const res = await resolvePlanCwd(
      stubQuery({ epics: [] }),
      "work",
      "fn-9-x.1",
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("fn-9-x");
  });

  test("work: missing task under a known epic → not-found miss", async () => {
    const q = stubQuery({
      epics: [{ epic_id: "fn-1-foo", project_dir: "/epic/dir", tasks: [] }],
    });
    const res = await resolvePlanCwd(q, "work", "fn-1-foo.7");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("fn-1-foo.7");
  });

  test("empty resolved cwd (no target_repo, no project_dir) → clean miss", async () => {
    const q = stubQuery({
      epics: [
        {
          epic_id: "fn-1-foo",
          project_dir: "",
          tasks: [{ task_id: "fn-1-foo.2", target_repo: "" }],
        },
      ],
    });
    const res = await resolvePlanCwd(q, "work", "fn-1-foo.2");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("empty cwd");
  });

  test("daemon-unreachable (query throws) is distinguished from not-found", async () => {
    const q: QueryFn = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const res = await resolvePlanCwd(q, "close", "fn-1-foo");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("cannot reach daemon");
  });
});

describe("cli/dispatch checkRaceGuard", () => {
  const paused: Row[] = [{ id: 1, paused: 1 }];

  test("clear board → null (no condition tripped)", async () => {
    const q = stubQuery({ autopilot_state: paused });
    expect(await checkRaceGuard(q, "work", "fn-1-x.2")).toBeNull();
  });

  test("pending dispatch present → refuses, naming pending_dispatches", async () => {
    const q = stubQuery({
      pending_dispatches: [{ verb: "work", id: "fn-1-x.2" }],
      autopilot_state: paused,
    });
    const tripped = await checkRaceGuard(q, "work", "fn-1-x.2");
    expect(tripped).toContain("pending_dispatches");
  });

  test("autopilot unpaused (paused=0) → refuses, naming autopilot", async () => {
    const q = stubQuery({ autopilot_state: [{ id: 1, paused: 0 }] });
    const tripped = await checkRaceGuard(q, "work", "fn-1-x.2");
    expect(tripped).toContain("autopilot");
  });

  test("live working job for the key → refuses, naming the live job", async () => {
    const q = stubQuery({
      autopilot_state: paused,
      jobs: [{ plan_verb: "work", plan_ref: "fn-1-x.2", state: "working" }],
    });
    const tripped = await checkRaceGuard(q, "work", "fn-1-x.2");
    expect(tripped).toContain("live job");
  });

  test("a working job for a DIFFERENT key does not trip the guard", async () => {
    const q = stubQuery({
      autopilot_state: paused,
      jobs: [{ plan_verb: "work", plan_ref: "fn-9-other.1", state: "working" }],
    });
    expect(await checkRaceGuard(q, "work", "fn-1-x.2")).toBeNull();
  });

  test("a transient read failure is treated as clear (manual hatch not blocked)", async () => {
    const q: QueryFn = () => Promise.reject(new Error("daemon closed"));
    expect(await checkRaceGuard(q, "work", "fn-1-x.2")).toBeNull();
  });
});

describe("cli/dispatch resolveSession", () => {
  test("--session flag wins over every fallback", () => {
    const r = resolveSession({
      sessionFlag: "scratch",
      env: { KEEPER_TMUX_SESSION: "envsess", TMUX: "/tmp/tmux" },
      probeCurrentSession: () => "current",
    });
    expect(r).toEqual({ session: "scratch", attachHint: false });
  });

  test("$KEEPER_TMUX_SESSION wins when --session is absent", () => {
    const r = resolveSession({
      sessionFlag: undefined,
      env: { KEEPER_TMUX_SESSION: "envsess", TMUX: "/tmp/tmux" },
      probeCurrentSession: () => "current",
    });
    expect(r).toEqual({ session: "envsess", attachHint: false });
  });

  test("$TMUX-gated current session when no flag/env session", () => {
    const r = resolveSession({
      sessionFlag: undefined,
      env: { TMUX: "/tmp/tmux" },
      probeCurrentSession: () => "current",
    });
    expect(r).toEqual({ session: "current", attachHint: false });
  });

  test("foreground fallback + attach hint when outside tmux", () => {
    const r = resolveSession({ sessionFlag: undefined, env: {} });
    expect(r).toEqual({ session: "foreground", attachHint: true });
  });

  test("inside tmux but probe fails → foreground, NO attach hint", () => {
    const r = resolveSession({
      sessionFlag: undefined,
      env: { TMUX: "/tmp/tmux" },
      probeCurrentSession: () => null,
    });
    expect(r).toEqual({ session: "foreground", attachHint: false });
  });

  test("empty $KEEPER_TMUX_SESSION is skipped (falls through to tmux probe)", () => {
    const r = resolveSession({
      sessionFlag: undefined,
      env: { KEEPER_TMUX_SESSION: "", TMUX: "/tmp/tmux" },
      probeCurrentSession: () => "current",
    });
    expect(r).toEqual({ session: "current", attachHint: false });
  });
});
