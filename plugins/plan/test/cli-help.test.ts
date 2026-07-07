// Leaf-help conformance for the pure-data plan descriptor (ADR 0008). Defect 3:
// a top-level plan verb (`show`, `ready`, `cat`, …) with `--help` used to print
// the whole GROUP help because the command table carried no per-verb metadata.
// Now the descriptor drives one shared leaf-help renderer for BOTH top-level and
// subgroup verbs, and the CLI's own parser validates against the descriptor.
//
// These pin: the descriptor's top-level + subgroup verb set matches a HAND-WRITTEN
// expected list (an independent source of truth, never re-derived from the module
// under test); every descriptor verb with `--help` renders verb-specific leaf help
// (Usage naming the verb) and exits 0 without running the verb body (no JSON
// envelope on stdout); and the parser recognizes exactly the descriptor's command
// set (a descriptor name never no-such-commands, a bogus name always does).

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";

import {
  isSubgroup,
  PLAN_COMMANDS,
  planCommand,
  SUBGROUP_NAMES,
} from "../src/descriptor.ts";
import { runCli } from "./harness.ts";

// Independent source of truth: the full dispatchable verb set, hand-transcribed
// from the cli.ts dispatch switch + the subgroup runner tables — NOT read back
// from the descriptor the code under test exposes.
const EXPECTED_TOP_LEVEL = [
  "assign-cells",
  "audit",
  "block",
  "cat",
  "claim",
  "close-finalize",
  "close-preflight",
  "detect",
  "done",
  "epic",
  "epics",
  "epic-question",
  "find-task-commit",
  "followup",
  "gist",
  "init",
  "list",
  "mv-repo",
  "ready",
  "reconcile",
  "refine-apply",
  "refine-context",
  "resolve-task",
  "scaffold",
  "selection-audit-brief",
  "selection-brief",
  "selection-review",
  "selection-review-submit",
  "show",
  "state-path",
  "status",
  "task",
  "tasks",
  "unblock",
  "validate",
  "verdict",
  "worker",
];

const EXPECTED_SUBCOMMANDS: Record<string, string[]> = {
  audit: ["submit"],
  epic: [
    "add-dep",
    "add-deps",
    "close",
    "create",
    "invalidate",
    "rm",
    "rm-dep",
    "set-branch",
    "set-primary-repo",
    "set-title",
    "set-touched-repos",
  ],
  followup: ["submit"],
  task: ["reset", "set-acceptance", "set-description", "set-target-repo"],
  verdict: ["submit"],
  worker: ["resume"],
};

describe("plan descriptor covers the full dispatchable verb set", () => {
  test("top-level command names match the hand-written expected list, in order", () => {
    expect(PLAN_COMMANDS.map((c) => c.name)).toEqual(EXPECTED_TOP_LEVEL);
  });

  test("subgroup names match the hand-written expected set", () => {
    expect([...SUBGROUP_NAMES].sort()).toEqual(
      Object.keys(EXPECTED_SUBCOMMANDS).sort(),
    );
  });

  test("each subgroup's subcommand names match the expected list, in order", () => {
    for (const [group, subs] of Object.entries(EXPECTED_SUBCOMMANDS)) {
      const desc = planCommand(group);
      expect(desc?.subcommands?.map((s) => s.name)).toEqual(subs);
      expect(isSubgroup(group)).toBe(true);
    }
  });

  test("a plain leaf reports no subcommands", () => {
    expect(isSubgroup("show")).toBe(false);
    expect(planCommand("show")?.subcommands).toBeUndefined();
  });
});

describe("every descriptor verb renders verb-specific leaf help, no body", () => {
  const CWD = tmpdir();

  // A leaf-help render carries no JSON envelope; the verb body — the only thing
  // that would emit `{...}` — never runs.
  function assertLeafHelp(argv: string[], usageTail: string): void {
    const r = runCli([...argv, "--help"], { cwd: CWD });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Usage: keeper plan ${usageTail}`);
    expect(r.stdout).toContain("Options:");
    // No verb body ran: leaf help emits zero JSON roots (no `{` at all).
    expect(r.stdout).not.toContain("{");
    expect(r.stdout).not.toContain("plan_invocation");
  }

  for (const name of EXPECTED_TOP_LEVEL) {
    if (SUBGROUP_NAMES.has(name)) {
      // A subgroup's own `--help` is group help; its leaves are covered below.
      for (const sub of EXPECTED_SUBCOMMANDS[name] ?? []) {
        test(`keeper plan ${name} ${sub} --help renders leaf help`, () => {
          assertLeafHelp([name, sub], `${name} ${sub}`);
        });
      }
    } else {
      test(`keeper plan ${name} --help renders leaf help`, () => {
        assertLeafHelp([name], name);
      });
    }
  }
});

describe("the parser validates the command set against the descriptor", () => {
  const CWD = tmpdir();

  test("every descriptor top-level verb is a known command (never no-such-command)", () => {
    for (const name of EXPECTED_TOP_LEVEL) {
      const r = runCli([name, "--help"], { cwd: CWD });
      expect(r.stderr).not.toContain("No such command");
      expect(r.code).toBe(0);
    }
  });

  test("a bogus top-level verb no-such-commands (exit 2)", () => {
    const r = runCli(["frobnicate"], { cwd: CWD });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Error: No such command 'frobnicate'.");
  });

  test("a bogus verb with --help still no-such-commands (exit 2)", () => {
    const r = runCli(["frobnicate", "--help"], { cwd: CWD });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Error: No such command 'frobnicate'.");
  });
});

describe("keeper plan --agent-help serves the operator runbook purely", () => {
  const CWD = tmpdir();

  test("--agent-help exits 0 with the runbook and no verb body", () => {
    const r = runCli(["--agent-help"], { cwd: CWD });
    expect(r.code).toBe(0);
    // Content assertion (catches an empty stub): names its primary verb form.
    expect(r.stdout).toContain("operator runbook");
    expect(r.stdout).toContain("keeper plan status");
    // No verb body ran: zero JSON roots, no auto-commit provenance.
    expect(r.stdout).not.toContain("{");
    expect(r.stdout).not.toContain("plan_invocation");
  });
});
