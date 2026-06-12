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
  type DispatchDeps,
  dispatch,
  isSubcommand,
  SUBCOMMANDS,
  type Subcommand,
  USAGE,
} from "../cli/keeper";

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
      "session-state": mkHandler("session-state"),
      "show-session-files": mkHandler("show-session-files"),
      "search-history": mkHandler("search-history"),
      "find-file-history": mkHandler("find-file-history"),
      "show-session-events": mkHandler("show-session-events"),
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
    expect(isSubcommand("session-state")).toBe(true);
    expect(isSubcommand("show-session-files")).toBe(true);
    expect(isSubcommand("search-history")).toBe(true);
    expect(isSubcommand("find-file-history")).toBe(true);
    expect(isSubcommand("show-session-events")).toBe(true);
    expect(isSubcommand("bogus")).toBe(false);
    expect(isSubcommand("")).toBe(false);
  });
});
