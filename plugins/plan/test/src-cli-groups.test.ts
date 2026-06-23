// Nested-group dispatch tests for src/cli.ts + src/subgroup.ts, exercised
// in-process via the harness's runCli (main(argv) dispatch). Covers: top-level
// help lists the epic/task subgroups; `<group> --help` renders click's
// group-help shape (Usage + description + Options + Commands + the short_help
// wrapping); an unknown subcommand exits 2 with the group usage; the leaf names
// are listed. The group-help rendering is identical in-process and from the
// compiled binary, so this needs no spawn and no `bun run build`.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import { runCli } from "./harness.ts";

function run(args: string[], cwd: string) {
  return runCli(args, { cwd });
}

describe("top-level --help lists subgroups", () => {
  test("epic and task appear in the Commands section", () => {
    const r = run(["--help"], tmpdir());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Commands:");
    expect(r.stdout).toMatch(/^ {2}epic\b/m);
    expect(r.stdout).toMatch(/^ {2}task\b/m);
  });
});

describe("epic group help", () => {
  test("--help: Usage + description + Options + Commands, exit 0", () => {
    const r = run(["epic", "--help"], tmpdir());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "Usage: keeper plan epic [OPTIONS] COMMAND [ARGS]...",
    );
    expect(r.stdout).toContain("Manage epics.");
    expect(r.stdout).toContain("--format [json|human]");
    expect(r.stdout).toContain("Commands:");
    // In-wave leaves are listed.
    for (const sub of [
      "add-dep",
      "add-deps",
      "invalidate",
      "queue-jump",
      "set-touched-repos",
    ]) {
      expect(r.stdout).toMatch(new RegExp(`^  ${sub}\\b`, "m"));
    }
  });

  test("long short_help wraps with continuation indented to the help column", () => {
    const r = run(["epic", "--help"], tmpdir());
    // add-deps short_help wraps; the continuation "edge)." is indented.
    expect(r.stdout).toContain(
      "Batch-wire N epic-level dependency edges (idempotent per",
    );
    expect(r.stdout).toMatch(/\n {21}edge\)\./);
  });

  test("no subcommand prints group help (exit 0)", () => {
    const r = run(["epic"], tmpdir());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "Usage: keeper plan epic [OPTIONS] COMMAND [ARGS]...",
    );
  });

  test("unknown subcommand: group usage + try-help on stderr, exit 2", () => {
    const r = run(["epic", "frobnicate"], tmpdir());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "Usage: keeper plan epic [OPTIONS] COMMAND [ARGS]...",
    );
    expect(r.stderr).toContain("Try 'keeper plan epic --help' for help.");
    expect(r.stderr).toContain("Error: No such command 'frobnicate'.");
  });
});

describe("task group help", () => {
  test("--help lists the in-wave task leaves, exit 0", () => {
    const r = run(["task", "--help"], tmpdir());
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      "Usage: keeper plan task [OPTIONS] COMMAND [ARGS]...",
    );
    expect(r.stdout).toContain("Manage tasks.");
    for (const sub of [
      "reset",
      "set-acceptance",
      "set-description",
      "set-target-repo",
      "set-tier",
    ]) {
      expect(r.stdout).toMatch(new RegExp(`^  ${sub}\\b`, "m"));
    }
  });

  test("unknown task subcommand exits 2", () => {
    const r = run(["task", "bogus"], tmpdir());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Error: No such command 'bogus'.");
  });
});

describe("unknown top-level group", () => {
  test("config -> exit 2 (no such command)", () => {
    const r = run(["config", "show"], tmpdir());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Error: No such command 'config'.");
  });
});
