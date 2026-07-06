// Nested-group dispatch tests for src/cli.ts + src/subgroup.ts, exercised
// in-process via the harness's runCli (main(argv) dispatch). Covers: top-level
// help lists the epic/task subgroups; `<group> --help` renders click's
// group-help shape (Usage + description + Options + Commands + the short_help
// wrapping); an unknown subcommand exits 2 with the group usage; the leaf names
// are listed. The group-help rendering is identical in-process and from the
// compiled binary, so this needs no spawn and no `bun run build`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli, seedState } from "./harness.ts";

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
    expect(r.stdout).toContain("--format [json|human|yaml]");
    expect(r.stdout).toContain("Commands:");
    // In-wave leaves are listed.
    for (const sub of [
      "add-dep",
      "add-deps",
      "invalidate",
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
    ]) {
      expect(r.stdout).toMatch(new RegExp(`^  ${sub}\\b`, "m"));
    }
    // set-tier was removed with the {model × effort} matrix — the tier + model
    // axes are chosen at plan/refine time, never via an incremental setter.
    expect(r.stdout).not.toContain("set-tier");
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

// ---------------------------------------------------------------------------
// Single-value conformance guard: every read/inspection verb prints exactly ONE
// top-level JSON root under --format json (json.loads succeeds, jq clean) and
// never leaks a standalone {"plan_invocation"} trailer onto the result stream
// under EITHER format. Root-counting via repeated JSON.parse over the buffer —
// pretty output spans many lines, so a line-count heuristic is WRONG. The error
// paths (found-false / missing-project / bad-id) are the double-emit-prone tails.
// ---------------------------------------------------------------------------

// Top-level JSON-object roots of a buffer: scan for `{`, decode the longest valid
// object prefix, advance past it, repeat. Text around objects (a human table)
// contributes zero roots.
function jsonRoots(text: string): Record<string, unknown>[] {
  const roots: Record<string, unknown>[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") {
      i += 1;
      continue;
    }
    let advanced = false;
    for (let end = text.length; end > i; end--) {
      if (text[end - 1] !== "}") {
        continue;
      }
      try {
        const v = JSON.parse(text.slice(i, end));
        if (v && typeof v === "object" && !Array.isArray(v)) {
          roots.push(v as Record<string, unknown>);
          i = end;
          advanced = true;
          break;
        }
      } catch {
        // shrink to the next candidate close brace
      }
    }
    if (!advanced) {
      i += 1;
    }
  }
  return roots;
}

// A standalone {"plan_invocation": ...} value is the exact double-emit bug: a
// second root on the stream. A merged-footer verb carries plan_invocation as ONE
// key among others inside its single envelope — not a sole-key trailer.
function hasBareTrailer(roots: Record<string, unknown>[]): boolean {
  return roots.some((v) => {
    const keys = Object.keys(v);
    return keys.length === 1 && keys[0] === "plan_invocation";
  });
}

// Assert `args` emits one JSON value (json format) and no bare trailer (both).
function assertSingleValue(args: string[], cwd: string): void {
  for (const fmt of ["json", "human"] as const) {
    const r = runCli(["--format", fmt, ...args], { cwd });
    const roots = jsonRoots(r.stdout);
    expect(hasBareTrailer(roots)).toBe(false);
    if (fmt === "json") {
      // Exactly one top-level JSON value — json.loads(stdout) would succeed.
      expect(roots.length).toBe(1);
    }
  }
}

describe("read verbs emit exactly one JSON value (single-value conformance)", () => {
  let seeded: string;
  let bare: string;
  const cleanup: string[] = [];
  beforeEach(() => {
    seeded = realpathSync(mkdtempSync(join(tmpdir(), "planctl-conf-seed-")));
    bare = realpathSync(mkdtempSync(join(tmpdir(), "planctl-conf-bare-")));
    cleanup.push(seeded, bare);
    seedState(seeded, { epicId: "fn-1-cafe", nTasks: 2 });
  });
  afterEach(() => {
    while (cleanup.length > 0) {
      rmSync(cleanup.pop() as string, { recursive: true, force: true });
    }
  });

  test("happy paths in a seeded project — one JSON value each, both formats", () => {
    for (const args of [
      ["state-path"],
      ["detect"],
      ["status"],
      ["epics"],
      ["list"],
      ["tasks"],
      ["tasks", "--epic", "fn-1-cafe"],
      ["show", "fn-1-cafe"],
      ["show", "fn-1-cafe.1"],
      ["ready", "--epic", "fn-1-cafe"],
      ["refine-context", "fn-1-cafe"],
      ["resolve-task", "fn-1-cafe.1"],
      ["validate"],
      ["init"],
    ]) {
      assertSingleValue(args, seeded);
    }
  });

  test("found-false / missing-project error paths stay single-value", () => {
    for (const args of [
      ["detect"],
      ["state-path"],
      ["status"],
      ["epics"],
      ["list"],
      ["tasks"],
    ]) {
      assertSingleValue(args, bare);
    }
  });

  test("bad-id error paths stay single-value", () => {
    for (const args of [
      ["show", "not-an-id"],
      ["show", "fn-1-cafe.99"],
      ["refine-context", "fn-1-cafe.1"],
      ["resolve-task", "not-an-id"],
    ]) {
      assertSingleValue(args, seeded);
    }
  });
});
