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
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildParseOptions,
  NATIVE_COMMANDS,
  nativeDescriptor,
  parseOptions,
} from "../cli/descriptor";
import {
  checkRaceGuard,
  main as dispatchMain,
  type LaunchFn,
  type QueryFn,
  resolvePlanCwd,
  resolveSession,
} from "../cli/dispatch";
import {
  buildHelpIndex,
  buildKeeperCli,
  type DispatchDeps,
  dispatch,
  EXIT_CODES,
  isSubcommand,
  SUBCOMMAND_META,
  SUBCOMMANDS,
  type Subcommand,
  USAGE,
} from "../cli/keeper";
import type { LaunchResult, LaunchSpec } from "../src/exec-backend";
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
      status: mkHandler("status"),
      query: mkHandler("query"),
      watch: mkHandler("watch"),
      await: mkHandler("await"),
      "commit-work": mkHandler("commit-work"),
      baseline: mkHandler("baseline"),
      "setup-tmux": mkHandler("setup-tmux"),
      tabs: mkHandler("tabs"),
      "session-state": mkHandler("session-state"),
      "show-session-files": mkHandler("show-session-files"),
      "search-history": mkHandler("search-history"),
      "find-file-history": mkHandler("find-file-history"),
      "show-session-events": mkHandler("show-session-events"),
      "show-job": mkHandler("show-job"),
      "session-summary": mkHandler("session-summary"),
      "escalation-brief": mkHandler("escalation-brief"),
      plan: mkHandler("plan"),
      prompt: mkHandler("prompt"),
      dispatch: mkHandler("dispatch"),
      handoff: mkHandler("handoff"),
      agent: mkHandler("agent"),
      reclaim: mkHandler("reclaim"),
      bus: mkHandler("bus"),
      "statusline-sink": mkHandler("statusline-sink"),
      completions: mkHandler("completions"),
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
    expect(isSubcommand("status")).toBe(true);
    expect(isSubcommand("query")).toBe(true);
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
    expect(isSubcommand("prompt")).toBe(true);
    expect(isSubcommand("bus")).toBe(true);
    expect(isSubcommand("bogus")).toBe(false);
    expect(isSubcommand("")).toBe(false);
  });

  test("dispatch is a registered subcommand routed to its handler", async () => {
    const h = makeHarness();
    expect(isSubcommand("dispatch")).toBe(true);
    await dispatch(["dispatch", "work::fn-1-x.2"], h.deps);
    expect(h.calls).toEqual([{ sub: "dispatch", argv: ["work::fn-1-x.2"] }]);
  });

  test("tabs is a registered two-level subcommand routed to its handler", async () => {
    const h = makeHarness();
    expect(isSubcommand("tabs")).toBe(true);
    await dispatch(["tabs", "restore", "--apply"], h.deps);
    expect(h.calls).toEqual([{ sub: "tabs", argv: ["restore", "--apply"] }]);
    // The verb list is published for the machine-readable command index.
    expect(SUBCOMMAND_META.tabs.verbs).toEqual(["list", "restore", "dump"]);
  });

  test("--help --json emits the machine-readable command index, exit 0", async () => {
    const h = makeHarness();
    let caught: unknown;
    try {
      await dispatch(["--help", "--json"], h.deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExitError);
    expect((caught as ExitError).code).toBe(0);
    expect(h.stderr).toEqual([]);
    expect(h.calls).toEqual([]);
    const parsed = JSON.parse(h.stdout.join("")) as ReturnType<
      typeof buildHelpIndex
    >;
    // Flat introspection shape — NOT wrapped in the one-shot envelope, so a
    // direct `jq '.subcommands'` reads the array (per the epic quick command).
    expect(Array.isArray(parsed.subcommands)).toBe(true);
    expect(parsed.subcommands.map((s) => s.name)).toEqual([...SUBCOMMANDS]);
    expect(parsed.exit_codes).toEqual(EXIT_CODES);
  });

  test("plain --help stays human USAGE even with no --json", async () => {
    const h = makeHarness();
    try {
      await dispatch(["--help"], h.deps);
    } catch {
      /* swallow ExitError */
    }
    expect(h.stdout.join("")).toBe(USAGE);
  });
});

describe("cli/keeper command index", () => {
  test("covers every subcommand with a non-empty summary", () => {
    const index = buildHelpIndex();
    // Catches a future statusline-sink-class gap: a new subcommand cannot land
    // without a summary (the Record type) and this asserts it is non-empty.
    for (const name of SUBCOMMANDS) {
      const entry = index.subcommands.find((s) => s.name === name);
      expect(entry).toBeDefined();
      expect((entry as { summary: string }).summary.length).toBeGreaterThan(0);
    }
  });

  test("two-level subcommands enumerate their verb names", () => {
    const index = buildHelpIndex();
    const byName = new Map(index.subcommands.map((s) => [s.name, s]));
    for (const name of [
      "plan",
      "prompt",
      "agent",
      "bus",
      "autopilot",
      "tabs",
    ] as const) {
      const verbs = byName.get(name)?.verbs;
      expect(Array.isArray(verbs)).toBe(true);
      expect((verbs ?? []).length).toBeGreaterThan(0);
    }
    // A leaf (non-two-level) subcommand omits verbs entirely.
    expect(byName.get("status")?.verbs).toBeUndefined();
  });

  test("marks exactly the --agent-help-bearing subcommands", () => {
    const index = buildHelpIndex();
    const flagged = index.subcommands
      .filter((s) => s.agent_help)
      .map((s) => String(s.name))
      .sort();
    expect(flagged).toEqual(
      ["autopilot", "commit-work", "dispatch", "handoff", "reclaim"].sort(),
    );
    // The metadata source of truth agrees with the projected index.
    for (const s of index.subcommands) {
      expect(s.agent_help).toBe(
        SUBCOMMAND_META[s.name as Subcommand].agentHelp === true,
      );
    }
  });

  test("publishes the shared exit-code taxonomy", () => {
    const index = buildHelpIndex();
    // 0–5 are the common core + await-owned range; 6–8 are the tabs-restore
    // refuse / zero-candidate / partial-failure codes.
    for (const code of ["0", "1", "2", "3", "4", "5", "6", "7", "8"]) {
      expect(index.exit_codes[code]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// cli/keeper Clerc proxy — dispatch now routes every known subcommand through a
// Clerc-backed proxy command whose `ignore` hook stops parsing at the command
// path, so the leaf handler receives the EXACT residual argv. These assert the
// proxy never parses/normalizes a leaf's flags or verbs (the Risks regression:
// residual beginning with both flags and positionals, `--`, and the leaf-owned
// plan/prompt verb pass-throughs).
// ---------------------------------------------------------------------------
describe("cli/keeper Clerc proxy routing", () => {
  test("forwards a residual that begins with a flag AND has positionals verbatim", async () => {
    const h = makeHarness();
    await dispatch(["query", "--collection", "epics", "pos1", "pos2"], h.deps);
    expect(h.calls).toEqual([
      { sub: "query", argv: ["--collection", "epics", "pos1", "pos2"] },
    ]);
  });

  test("forwards a residual that begins with a positional then a flag verbatim", async () => {
    const h = makeHarness();
    await dispatch(["dispatch", "work::fn-1-x.2", "--force"], h.deps);
    expect(h.calls).toEqual([
      { sub: "dispatch", argv: ["work::fn-1-x.2", "--force"] },
    ]);
  });

  test("a `--` in the residual is preserved untouched (never consumed by the proxy)", async () => {
    const h = makeHarness();
    await dispatch(["agent", "claude", "--", "--model", "opus"], h.deps);
    expect(h.calls).toEqual([
      { sub: "agent", argv: ["claude", "--", "--model", "opus"] },
    ]);
  });

  test("plan verb + flags + positionals ride in the residual — the verb is NOT stripped", async () => {
    const h = makeHarness();
    await dispatch(["plan", "done", "fn-1-x.2", "--summary", "did it"], h.deps);
    // The `plan` proxy hands its leaf the whole residual, verb token first — the
    // framework never validates or reorders the plan sub-CLI's args.
    expect(h.calls).toEqual([
      { sub: "plan", argv: ["done", "fn-1-x.2", "--summary", "did it"] },
    ]);
  });

  test("prompt verb pass-through: leaf owns its verb + flags", async () => {
    const h = makeHarness();
    await dispatch(["prompt", "render", "--json", "-x", "y"], h.deps);
    expect(h.calls).toEqual([
      { sub: "prompt", argv: ["render", "--json", "-x", "y"] },
    ]);
  });

  test("buildKeeperCli registers exactly the public subcommands as proxy commands", () => {
    const h = makeHarness();
    const cli = buildKeeperCli(h.deps);
    const registered = new Set(cli._commands.keys());
    for (const name of SUBCOMMANDS) {
      expect(registered.has(name)).toBe(true);
    }
    // No stray commands beyond the public surface (aliases would show here).
    expect(registered.size).toBe(SUBCOMMANDS.length);
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
    const res = await resolvePlanCwd(q, "work", "fn-1-foo.2", () => true);
    // A work row now also carries the task's {model, tier} cell axes (null when
    // the task file names neither) for the launcher's worker-cell resolution.
    expect(res).toEqual({
      ok: true,
      cwd: "/task/repo",
      model: null,
      tier: null,
    });
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
    const res = await resolvePlanCwd(q, "work", "fn-1-foo.2", () => true);
    expect(res).toEqual({
      ok: true,
      cwd: "/epic/dir",
      model: null,
      tier: null,
    });
  });

  test("close: runs in the epic lane worktree when one is registered", async () => {
    const q = stubQuery({
      epics: [{ epic_id: "fn-1-foo", project_dir: "/epic/dir", tasks: [] }],
    });
    const res = await resolvePlanCwd(
      q,
      "close",
      "fn-1-foo",
      () => true,
      () => Promise.resolve("/epic/dir/.worktrees/fn-1-foo"),
    );
    expect(res).toEqual({ ok: true, cwd: "/epic/dir/.worktrees/fn-1-foo" });
  });

  test("close: no lane worktree → falls back to project_dir with a warning", async () => {
    const q = stubQuery({
      epics: [{ epic_id: "fn-1-foo", project_dir: "/epic/dir", tasks: [] }],
    });
    const res = await resolvePlanCwd(
      q,
      "close",
      "fn-1-foo",
      () => true,
      () => Promise.resolve(null),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cwd).toBe("/epic/dir");
      expect(res.warning).toContain("no epic lane worktree for 'fn-1-foo'");
    }
  });

  test("close: lane resolved but missing on disk → falls back to project_dir with a warning", async () => {
    const q = stubQuery({
      epics: [{ epic_id: "fn-1-foo", project_dir: "/epic/dir", tasks: [] }],
    });
    // Lane path resolves but does not exist; project_dir does.
    const res = await resolvePlanCwd(
      q,
      "close",
      "fn-1-foo",
      (d) => d === "/epic/dir",
      () => Promise.resolve("/epic/dir/.worktrees/gone"),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.cwd).toBe("/epic/dir");
      expect(res.warning).toContain("no epic lane worktree");
    }
  });

  test("work: resolved cwd missing on disk → cwd-missing miss (not a silent launch)", async () => {
    const q = stubQuery({
      epics: [
        {
          epic_id: "fn-1-foo",
          project_dir: "/epic/dir",
          tasks: [{ task_id: "fn-1-foo.2", target_repo: "/renamed-away" }],
        },
      ],
    });
    const res = await resolvePlanCwd(q, "work", "fn-1-foo.2", () => false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("cwd-missing: /renamed-away");
  });

  test("close: resolved cwd missing on disk → cwd-missing miss", async () => {
    const q = stubQuery({
      epics: [{ epic_id: "fn-1-foo", project_dir: "/renamed-away", tasks: [] }],
    });
    const res = await resolvePlanCwd(q, "close", "fn-1-foo", () => false);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("cwd-missing: /renamed-away");
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

  test("autopilot unpaused (paused=0) → refuses, pause-first before the --force suffix", async () => {
    const q = stubQuery({ autopilot_state: [{ id: 1, paused: 0 }] });
    const tripped = await checkRaceGuard(q, "work", "fn-1-x.2");
    expect(tripped).toContain("autopilot is unpaused");
    expect(tripped).toContain("pause it first");
    // --force is the caller's suffix, never inside the reason itself.
    expect(tripped).not.toContain("--force");
  });

  test("working job for the key → refuses, naming the running worker", async () => {
    const q = stubQuery({
      autopilot_state: paused,
      jobs: [{ plan_verb: "work", plan_ref: "fn-1-x.2", state: "working" }],
    });
    const tripped = await checkRaceGuard(q, "work", "fn-1-x.2");
    expect(tripped).toContain("a live worker for work::fn-1-x.2 is running");
    expect(tripped).toContain("let it finish");
  });

  test("stopped job for the key → refuses, naming warm-resume + reclaim before --force", async () => {
    const q = stubQuery({
      autopilot_state: paused,
      jobs: [{ plan_verb: "close", plan_ref: "fn-1-x", state: "stopped" }],
    });
    const tripped = await checkRaceGuard(q, "close", "fn-1-x");
    expect(tripped).toContain(
      "a stopped worker for close::fn-1-x still holds the slot",
    );
    expect(tripped).toContain("warm-resume");
    expect(tripped).toContain("reclaim");
    // Recovery is named ahead of --force; the caller owns the --force suffix.
    expect(tripped).not.toContain("--force");
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

  test("work fallback + attach hint when outside tmux", () => {
    const r = resolveSession({ sessionFlag: undefined, env: {} });
    expect(r).toEqual({ session: "work", attachHint: true });
  });

  test("inside tmux but probe fails → work, NO attach hint", () => {
    const r = resolveSession({
      sessionFlag: undefined,
      env: { TMUX: "/tmp/tmux" },
      probeCurrentSession: () => null,
    });
    expect(r).toEqual({ session: "work", attachHint: false });
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

// ---------------------------------------------------------------------------
// cli/dispatch main() — end-to-end integration over the orchestration: the
// arg-fault exit-2 branches, the free-form prompt-file/validate paths, and the
// dry-run / launch-result branches. `main()` writes to process.{stdout,stderr}
// and calls process.exit() directly, so `runMain` patches those globals around
// the call (exit → throws a tagged ExitError so the never-return branches stop
// the function), captures the streams, and restores in a finally. The launch
// seam is injected via MainDeps so the launch-path tests run with a fake backend
// — no real tmux. The query seam is likewise injected for plan-form coverage.
// ---------------------------------------------------------------------------

interface MainRun {
  /** Captured exit code (undefined if main returned without exiting). */
  code: number | undefined;
  stdout: string;
  stderr: string;
}

/** Drive `dispatchMain(argv, deps)` with process.{exit,stdout,stderr} captured. */
async function runMain(
  argv: string[],
  deps?: {
    query?: QueryFn;
    launch?: LaunchFn;
    promptPrefix?: string;
    dirExists?: (dir: string) => boolean;
    resolveLaneDir?: (
      projectDir: string,
      epicId: string,
    ) => Promise<string | null>;
  },
): Promise<MainRun> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const realExit = process.exit.bind(process);
  let code: number | undefined;
  process.stdout.write = ((s: string | Uint8Array) => {
    out.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string | Uint8Array) => {
    err.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new ExitError(code);
  }) as typeof process.exit;
  try {
    await dispatchMain(argv, deps ?? {});
  } catch (e) {
    if (!(e instanceof ExitError)) throw e;
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.exit = realExit;
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** A LaunchFn recording its call (including the structured `spec` the keeper agent
 *  backend consumes) and returning a canned result. */
function fakeLaunch(result: LaunchResult): {
  fn: LaunchFn;
  calls: Array<{
    session: string;
    argv: string[];
    cwd: string;
    name?: string;
    spec?: LaunchSpec;
  }>;
} {
  const calls: Array<{
    session: string;
    argv: string[];
    cwd: string;
    name?: string;
    spec?: LaunchSpec;
  }> = [];
  const fn: LaunchFn = (session, argv, cwd, name, spec) => {
    calls.push({ session, argv, cwd, name, spec });
    return Promise.resolve(result);
  };
  return { fn, calls };
}

describe("cli/dispatch main() arg-fault branches (exit 2)", () => {
  test("positional + --prompt together → exit 2, modes mutually exclusive", async () => {
    const r = await runMain(["work::fn-1-x.2", "--prompt", "hi"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mutually exclusive");
  });

  test("neither a positional nor a prompt → exit 2, nothing to dispatch", async () => {
    const r = await runMain([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("nothing to dispatch");
  });

  test("--prompt + --prompt-file together → exit 2", async () => {
    const r = await runMain([
      "--prompt",
      "hi",
      "--prompt-file",
      "/tmp/x",
      "--name",
      "n",
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "--prompt and --prompt-file are mutually exclusive",
    );
  });

  test("more than one positional → exit 2", async () => {
    const r = await runMain(["work::fn-1-x.2", "close::fn-2-y"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("exactly one");
  });
});

describe("cli/dispatch main() free-form prompt-file / validate", () => {
  test("--prompt-file read failure → die (exit 1)", async () => {
    const r = await runMain([
      "--prompt-file",
      "/no/such/dispatch/prompt/file",
      "--name",
      "n",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot read --prompt-file");
  });

  test("validatePromptBytes rejection through main → exit 2", async () => {
    // A NUL byte trips validatePromptBytes; it must surface as an arg fault.
    const r = await runMain(["--prompt", "bad\0prompt", "--name", "n"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("NUL byte");
  });
});

describe("cli/dispatch main() dry-run / launch-result branches", () => {
  test("--dry-run prints the resolved plan and exits 0, launching nothing", async () => {
    const launch = fakeLaunch({ ok: true });
    const r = await runMain(
      [
        "--prompt",
        "hello",
        "--name",
        "manual",
        "--session",
        "scratch",
        "--cwd",
        "/work/dir",
        "--dry-run",
      ],
      { launch: launch.fn },
    );
    expect(r.code).toBe(0);
    expect(launch.calls).toEqual([]);
    expect(r.stdout).toContain("session:     scratch");
    expect(r.stdout).toContain("cwd:         /work/dir");
    // Free form has no keeper label — no `name:`/`key:` line; the forwarded
    // `--name` is visible in the argv instead.
    expect(r.stdout).not.toContain("name:");
    expect(r.stdout).not.toContain("key:");
    expect(r.stdout).toContain("prompt-from: --prompt");
    expect(r.stdout).toContain('"--name","manual"');
    expect(r.stdout).toContain("argv:");
  });

  test("successful launch → invokes the backend and reports dispatched", async () => {
    const launch = fakeLaunch({ ok: true });
    const r = await runMain(
      ["--prompt", "go", "--name", "manual", "--session", "scratch"],
      { launch: launch.fn },
    );
    expect(r.code).toBeUndefined();
    expect(launch.calls).toHaveLength(1);
    expect(launch.calls[0]?.session).toBe("scratch");
    // `--name` is forwarded verbatim to claude…
    expect(launch.calls[0]?.argv).toContain("--name");
    const ni = launch.calls[0]?.argv.indexOf("--name") ?? -1;
    expect(launch.calls[0]?.argv[ni + 1]).toBe("manual");
    // …but it is NOT reused as the keeper label or the tmux window name.
    expect(launch.calls[0]?.name).toBe("");
    expect(r.stdout).toContain("dispatched --prompt → session scratch");
    expect(r.stdout).not.toContain("dispatched manual");
  });

  test("free form with NO --name: launches with no claude --name in the argv", async () => {
    const launch = fakeLaunch({ ok: true });
    const r = await runMain(["--prompt", "go", "--session", "scratch"], {
      launch: launch.fn,
    });
    // No arg fault — free form no longer requires --name.
    expect(r.code).toBeUndefined();
    expect(launch.calls).toHaveLength(1);
    expect(launch.calls[0]?.argv).not.toContain("--name");
    expect(launch.calls[0]?.name).toBe("");
    expect(r.stdout).toContain("dispatched --prompt → session scratch");
  });

  test("free form --prompt-file: label/status keys off the file, not --name", async () => {
    const launch = fakeLaunch({ ok: true });
    const tmp = `${tmpdir()}/dispatch-pf-${Date.now()}.txt`;
    writeFileSync(tmp, "from a file");
    try {
      const r = await runMain(
        ["--prompt-file", tmp, "--name", "manual", "--session", "scratch"],
        { launch: launch.fn },
      );
      expect(r.code).toBeUndefined();
      const ni = launch.calls[0]?.argv.indexOf("--name") ?? -1;
      expect(launch.calls[0]?.argv[ni + 1]).toBe("manual");
      expect(r.stdout).toContain(`dispatched file ${tmp} → session scratch`);
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  test("failed launch (result.ok === false) → die (exit 1)", async () => {
    const launch = fakeLaunch({ ok: false, error: "tmux is dead" });
    const r = await runMain(
      ["--prompt", "go", "--name", "manual", "--session", "scratch"],
      { launch: launch.fn },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("launch failed: tmux is dead");
  });

  test("free-form prompt is prefixed with the configured dispatch_prompt_prefix", async () => {
    // With a prefix configured, a free-form prompt launches as `<prefix> <prompt>`.
    const launch = fakeLaunch({ ok: true });
    const r = await runMain(
      ["--prompt", "hello", "--name", "manual", "--session", "scratch"],
      { launch: launch.fn, promptPrefix: "/hack" },
    );
    expect(r.code).toBeUndefined();
    expect(launch.calls).toHaveLength(1);
    // The prefixed prompt rides in the launch argv.
    expect(launch.calls[0]?.argv.join(" ")).toContain("/hack hello");
  });

  test("free-form dry-run reflects the prefixed prompt in argv", async () => {
    const launch = fakeLaunch({ ok: true });
    const r = await runMain(
      [
        "--prompt",
        "hello",
        "--name",
        "manual",
        "--session",
        "scratch",
        "--dry-run",
      ],
      { launch: launch.fn, promptPrefix: "/hack" },
    );
    expect(r.code).toBe(0);
    expect(launch.calls).toEqual([]);
    expect(r.stdout).toContain("/hack hello");
  });

  test("--no-prefix bypasses the configured prefix for a single invocation", async () => {
    const launch = fakeLaunch({ ok: true });
    const r = await runMain(
      [
        "--prompt",
        "hello",
        "--name",
        "manual",
        "--session",
        "scratch",
        "--no-prefix",
      ],
      { launch: launch.fn, promptPrefix: "/hack" },
    );
    expect(r.code).toBeUndefined();
    expect(launch.calls).toHaveLength(1);
    expect(launch.calls[0]?.argv.join(" ")).not.toContain("/hack");
    expect(launch.calls[0]?.argv.join(" ")).toContain("hello");
  });

  test("plan-form prompt is NEVER prefixed even when a prefix is configured", async () => {
    // The plan-form prompt comes from defaultPlanPrompt and must be untouched.
    const launch = fakeLaunch({ ok: true });
    const query: QueryFn = (collection) =>
      Promise.resolve(
        collection === "epics"
          ? [
              {
                epic_id: "fn-1-foo",
                project_dir: "/epic/dir",
                tasks: [{ task_id: "fn-1-foo.2", target_repo: "/task/repo" }],
              },
            ]
          : [],
      );
    const r = await runMain(
      ["work::fn-1-foo.2", "--session", "scratch", "--force", "--dry-run"],
      {
        query,
        launch: launch.fn,
        promptPrefix: "/hack",
        dirExists: () => true,
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("/hack");
  });

  test("plan-form dry-run resolves cwd via the injected query seam", async () => {
    const launch = fakeLaunch({ ok: true });
    const query: QueryFn = (collection) =>
      Promise.resolve(
        collection === "epics"
          ? [
              {
                epic_id: "fn-1-foo",
                project_dir: "/epic/dir",
                tasks: [{ task_id: "fn-1-foo.2", target_repo: "/task/repo" }],
              },
            ]
          : [],
      );
    const r = await runMain(
      ["work::fn-1-foo.2", "--session", "scratch", "--force", "--dry-run"],
      { query, launch: launch.fn, dirExists: () => true },
    );
    expect(r.code).toBe(0);
    expect(launch.calls).toEqual([]);
    expect(r.stdout).toContain("cwd:         /task/repo");
    expect(r.stdout).toContain("key:         work::fn-1-foo.2");
    expect(r.stdout).toContain("prompt-from: plan");
  });

  test("threads a structured spec to the launch seam (keeper agent backend consumes it)", async () => {
    // The keeper agent backend ignores the pre-wrapped argv and builds its own
    // invocation from `spec`; manual dispatch MUST pass it. Free form: prompt +
    // the forwarded model/effort, no claudeName.
    const launch = fakeLaunch({ ok: true });
    const r = await runMain(
      [
        "--prompt",
        "go",
        "--session",
        "scratch",
        "--model",
        "opus",
        "--effort",
        "high",
      ],
      // promptPrefix:"" neutralizes any machine-local dispatch_prompt_prefix so
      // the spec.prompt assertion is deterministic.
      { launch: launch.fn, promptPrefix: "" },
    );
    expect(r.code).toBeUndefined();
    expect(launch.calls).toHaveLength(1);
    expect(launch.calls[0]?.spec).toEqual({
      prompt: "go",
      model: "opus",
      effort: "high",
    });
  });

  test("plan-form threads the verb::id claudeName into the launch spec", async () => {
    const launch = fakeLaunch({ ok: true });
    const query: QueryFn = (collection) =>
      Promise.resolve(
        collection === "epics"
          ? [
              {
                epic_id: "fn-1-foo",
                project_dir: "/epic/dir",
                tasks: [{ task_id: "fn-1-foo.2", target_repo: "/task/repo" }],
              },
            ]
          : [],
      );
    const r = await runMain(
      ["work::fn-1-foo.2", "--session", "scratch", "--force"],
      { query, launch: launch.fn, dirExists: () => true },
    );
    expect(r.code).toBeUndefined();
    expect(launch.calls[0]?.spec?.claudeName).toBe("work::fn-1-foo.2");
  });

  test("plan-form dispatch into a renamed-away cwd exits non-zero with cwd-missing", async () => {
    const launch = fakeLaunch({ ok: true });
    const query: QueryFn = (collection) =>
      Promise.resolve(
        collection === "epics"
          ? [
              {
                epic_id: "fn-1-foo",
                project_dir: "/epic/dir",
                tasks: [
                  { task_id: "fn-1-foo.2", target_repo: "/renamed-away" },
                ],
              },
            ]
          : [],
      );
    const r = await runMain(
      ["work::fn-1-foo.2", "--session", "scratch", "--force"],
      { query, launch: launch.fn, dirExists: () => false },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cwd-missing: /renamed-away");
    expect(launch.calls).toEqual([]);
  });

  test("plan-form close:: runs the closer in the epic lane dir (dry-run)", async () => {
    const launch = fakeLaunch({ ok: true });
    const query: QueryFn = (collection) =>
      Promise.resolve(
        collection === "epics"
          ? [{ epic_id: "fn-2-y", project_dir: "/epic/dir", tasks: [] }]
          : [],
      );
    const r = await runMain(
      ["close::fn-2-y", "--session", "scratch", "--force", "--dry-run"],
      {
        query,
        launch: launch.fn,
        dirExists: () => true,
        resolveLaneDir: () => Promise.resolve("/epic/dir/.worktrees/fn-2-y"),
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("/epic/dir/.worktrees/fn-2-y");
    expect(r.stdout).toContain("key:         close::fn-2-y");
  });

  test("plan-form close:: with no lane warns and runs in project_dir (dry-run)", async () => {
    const launch = fakeLaunch({ ok: true });
    const query: QueryFn = (collection) =>
      Promise.resolve(
        collection === "epics"
          ? [{ epic_id: "fn-2-y", project_dir: "/epic/dir", tasks: [] }]
          : [],
      );
    const r = await runMain(
      ["close::fn-2-y", "--session", "scratch", "--force", "--dry-run"],
      {
        query,
        launch: launch.fn,
        dirExists: () => true,
        resolveLaneDir: () => Promise.resolve(null),
      },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("cwd:         /epic/dir");
    expect(r.stderr).toContain("no epic lane worktree for 'fn-2-y'");
  });
});

// cli/dispatch launch transport — the manual CLI launches DIRECTLY through the
// folded `keeper agent` launcher (keeper's sole launch transport). With NO
// injected launch seam, `main()` resolves the real launcher path from
// `resolveKeeperAgentPath()`, builds the `[bun, keeper.ts, "agent"]` prefix, and
// spawns `bun <keeper.ts> agent claude …`. A stub keeper-agent entry (a recording
// .ts script bun runs) proves the launch fires and carries the round-1 contract
// flags. A stale `exec_backend:` key in config is silently ignored (the toggle is
// gone). KEEPER_CONFIG + KEEPER_AGENT_PATH sandbox the resolve.
// ---------------------------------------------------------------------------
describe("cli/dispatch launches via the keeper agent transport", () => {
  /** Build a tmp dir holding a recording keeper-agent stub (a .ts entry `bun`
   *  runs) that appends its argv to `argv.log` and emits the schema_version:1
   *  launch JSON, plus a config.yaml (optionally carrying a stale `exec_backend:`
   *  to prove it is ignored). Returns the paths plus a reader for the recorded
   *  argv lines. */
  function setupBackendSandbox(staleExecBackend?: string): {
    configPath: string;
    stubPath: string;
    readArgvLog: () => string;
    cleanup: () => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-backend-"));
    const argvLog = join(dir, "argv.log");
    // The stub stands in for `cli/keeper.ts`; the dispatch path spawns it as
    // `bun <stub> agent claude …`, so it records `process.argv.slice(2)` (the
    // `agent claude …` tail) and emits one line of schema_version:1 JSON, exit 0.
    const stubPath = join(dir, "keeper-agent-stub.ts");
    writeFileSync(
      stubPath,
      `import { appendFileSync } from "node:fs";\n` +
        `appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(" ") + "\\n");\n` +
        `process.stdout.write('{"schema_version":1,"session":"scratch","windowId":"@9","paneId":"%9"}\\n');\n` +
        `process.exit(0);\n`,
    );
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      staleExecBackend !== undefined
        ? `exec_backend: ${staleExecBackend}\n`
        : "",
    );
    return {
      configPath,
      stubPath,
      readArgvLog: () =>
        existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "",
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  /** Run `dispatchMain` with the env pointed at the sandbox, env restored after. */
  async function runWithBackendEnv(
    argv: string[],
    s: { configPath: string; stubPath: string },
  ): Promise<MainRun> {
    const prevConfig = process.env.KEEPER_CONFIG;
    const prevPath = process.env.KEEPER_AGENT_PATH;
    process.env.KEEPER_CONFIG = s.configPath;
    process.env.KEEPER_AGENT_PATH = s.stubPath;
    try {
      // No `launch` dep → main resolves the real launcher path + launches.
      return await runMain(argv, {});
    } finally {
      if (prevConfig === undefined) delete process.env.KEEPER_CONFIG;
      else process.env.KEEPER_CONFIG = prevConfig;
      if (prevPath === undefined) delete process.env.KEEPER_AGENT_PATH;
      else process.env.KEEPER_AGENT_PATH = prevPath;
    }
  }

  test("manual dispatch launches via `keeper agent` with the contract flags", async () => {
    const s = setupBackendSandbox();
    try {
      const r = await runWithBackendEnv(
        ["--prompt", "hello keeper agent", "--session", "scratch"],
        s,
      );
      // The stub exited 0 → launched; dispatch reports success.
      expect(r.code).toBeUndefined();
      const recorded = s.readArgvLog();
      // The launch argv reached the launcher — the `agent` token prefixes it,
      // then the round-1 contract flags.
      expect(recorded).toContain("agent claude --x-tmux");
      expect(recorded).toContain("--x-tmux-session scratch");
      expect(recorded).toContain("--x-tmux-env KEEPER_TMUX_SESSION=scratch");
      // The structured prompt rides as the final positional.
      expect(recorded).toContain("hello keeper agent");
    } finally {
      s.cleanup();
    }
  });

  test("a stale exec_backend: key in config is ignored — `keeper agent` still launches", async () => {
    // The exec_backend toggle is gone; a leftover key must not change behavior.
    const s = setupBackendSandbox("tmux");
    try {
      const r = await runWithBackendEnv(
        ["--prompt", "hello keeper agent", "--session", "scratch"],
        s,
      );
      expect(r.code).toBeUndefined();
      // `keeper agent` still fired despite `exec_backend: tmux` in config.
      expect(s.readArgvLog()).toContain("agent claude --x-tmux");
    } finally {
      s.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// cli/descriptor — the pure-data descriptor tree (ADR 0008) is the single
// source of truth `keeper --help --json`, USAGE, completions, and every derived
// leaf's parseArgs read from. These pin: the module stays dependency-free; the
// name tuple matches the descriptor order; parseArgs options are genuinely
// derived (asserted against a HAND-WRITTEN expected — an independent source of
// truth, never re-derived from the descriptor by the code under test); the JSON
// index mirrors the descriptor recursively; USAGE hides internal commands the
// index still carries.
// ---------------------------------------------------------------------------
describe("cli/descriptor purity + derivation", () => {
  test("descriptor.ts is dependency-free (imports nothing)", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "cli", "descriptor.ts"),
      "utf8",
    );
    // Strip block + line comments (the module's prose names `import` in its
    // header) before scanning for real import statements.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // ANY `import … from` / bare `import "…"` / dynamic `import(` is a
    // dependency; the descriptor must have zero — it is pure data + types.
    expect(code).not.toMatch(/\bimport\b[\s\S]*?\bfrom\b/);
    expect(code).not.toMatch(/\bimport\s*['"(]/);
  });

  test("SUBCOMMANDS tuple matches the descriptor order exactly", () => {
    // The one hand-maintained list (names, for the literal `Subcommand` union)
    // is pinned to the descriptor so a divergence is a hard fail, not drift.
    expect(NATIVE_COMMANDS.map((c) => c.name)).toEqual([...SUBCOMMANDS]);
  });

  test("buildParseOptions carries type/short/multiple/default, drops summary", () => {
    // Hand-written expected: the mapping is behavior-critical, so it is asserted
    // literally rather than by round-tripping the same builder.
    expect(
      buildParseOptions([
        { name: "help", type: "boolean", short: "h", summary: "drop me" },
        { name: "filter", type: "string", multiple: true },
        { name: "snapshot", type: "boolean", default: false },
        { name: "sock", type: "string" },
      ]),
    ).toEqual({
      help: { type: "boolean", short: "h" },
      filter: { type: "string", multiple: true },
      snapshot: { type: "boolean", default: false },
      sock: { type: "string" },
    });
  });

  test("parseOptions('baseline') reproduces the leaf's flag surface", () => {
    // Independent source of truth: the baseline leaf's flag surface under the
    // shared duration grammar (`-ms` spellings retired), hand-transcribed here.
    expect(parseOptions("baseline")).toEqual({
      help: { type: "boolean", short: "h" },
      repo: { type: "string" },
      wait: { type: "boolean" },
      timeout: { type: "string" },
      "poll-interval": { type: "string" },
    });
  });

  test("parseOptions('board') preserves the viewer defaults", () => {
    expect(parseOptions("board")).toEqual({
      sock: { type: "string" },
      snapshot: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    });
  });

  test("parseOptions('query') preserves the repeatable filter + format grammar", () => {
    // Independent source of truth: the query leaf's flag surface under the
    // converged `--format` grammar (`--json` retained as its documented alias),
    // hand-transcribed here rather than re-derived from the descriptor.
    expect(parseOptions("query")).toEqual({
      help: { type: "boolean", short: "h" },
      format: { type: "string" },
      json: { type: "boolean" },
      filter: { type: "string", multiple: true },
      sock: { type: "string" },
    });
  });

  test("parseOptions('tabs', 'restore') derives the per-verb surface", () => {
    expect(parseOptions("tabs", "restore")).toEqual({
      apply: { type: "boolean", default: false },
      generation: { type: "string" },
      session: { type: "string" },
      "allow-empty": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      db: { type: "string" },
    });
  });

  test("parseOptions throws on an unknown command/verb (a wiring bug)", () => {
    expect(() => parseOptions("nope")).toThrow(/unknown native command/);
    expect(() => parseOptions("tabs", "nope")).toThrow(/unknown verb/);
  });

  test("nativeDescriptor resolves a top-level command, undefined otherwise", () => {
    expect(nativeDescriptor("baseline")?.name).toBe("baseline");
    expect(nativeDescriptor("nope")).toBeUndefined();
  });
});

describe("keeper --help --json recursive descriptor tree", () => {
  test("index nodes mirror the descriptor's per-command metadata", () => {
    const index = buildHelpIndex();
    // Every descriptor command projects to an index node in the same order.
    expect(index.subcommands.map((s) => s.name)).toEqual(
      NATIVE_COMMANDS.map((c) => c.name),
    );
    for (const cmd of NATIVE_COMMANDS) {
      const node = index.subcommands.find((s) => s.name === cmd.name);
      expect(node).toBeDefined();
      const n = node as NonNullable<typeof node>;
      expect(n.visibility).toBe(cmd.visibility);
      expect(n.mutates).toBe(cmd.mutates);
      expect(n.requires_daemon).toBe(cmd.requires_daemon);
      expect(n.requires_tty).toBe(cmd.requires_tty);
      expect(n.agent_help).toBe(cmd.agent_help === true);
      // Flags round-trip name+type from the descriptor.
      expect(n.flags.map((f) => f.name)).toEqual(cmd.flags.map((f) => f.name));
    }
  });

  test("carries a self-describing schema note", () => {
    expect(buildHelpIndex().schema.length).toBeGreaterThan(0);
  });

  test("indexes exit 124 (panel wait re-issue) in the shared taxonomy", () => {
    expect(buildHelpIndex().exit_codes["124"]?.length ?? 0).toBeGreaterThan(0);
  });

  test("baseline node declares its format_modes, flags, and exit codes", () => {
    const baseline = buildHelpIndex().subcommands.find(
      (s) => s.name === "baseline",
    );
    expect(baseline?.format_modes).toEqual(["json"]);
    expect(baseline?.flags.map((f) => f.name)).toEqual([
      "help",
      "repo",
      "wait",
      "timeout",
      "poll-interval",
    ]);
    expect(baseline?.exit_codes?.["3"]?.length ?? 0).toBeGreaterThan(0);
  });

  test("tabs node carries its verbs recursively with per-verb flags", () => {
    const tabs = buildHelpIndex().subcommands.find((s) => s.name === "tabs");
    expect(tabs?.verbs?.map((v) => v.name)).toEqual([
      "list",
      "restore",
      "dump",
    ]);
    const restore = tabs?.verbs?.find((v) => v.name === "restore");
    expect(restore?.flags.map((f) => f.name)).toContain("apply");
  });
});

describe("USAGE hides internal commands the JSON index still carries", () => {
  test("statusline-sink is visibility:internal, omitted from USAGE, present in --help --json", () => {
    // Omitted from the human USAGE block…
    expect(USAGE).not.toContain("statusline-sink");
    // …but present in the machine index, tagged internal.
    const node = buildHelpIndex().subcommands.find(
      (s) => s.name === "statusline-sink",
    );
    expect(node).toBeDefined();
    expect(node?.visibility).toBe("internal");
  });

  test("every PUBLIC descriptor command appears in USAGE", () => {
    for (const cmd of NATIVE_COMMANDS) {
      if (cmd.visibility === "internal") continue;
      expect(USAGE).toContain(cmd.name);
    }
  });

  test("every descriptor command name dispatches to its handler", async () => {
    // The dispatchable native surface is exactly the descriptor tree's names.
    for (const cmd of NATIVE_COMMANDS) {
      const h = makeHarness();
      await dispatch([cmd.name], h.deps);
      expect(h.calls).toEqual([{ sub: cmd.name as Subcommand, argv: [] }]);
    }
  });
});
