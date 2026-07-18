// Engine-agnostic conformance spec for the four read-only verbs: state-path /
// detect / status / epics. Each pins the byte-exact primary envelope as a SINGLE
// top-level JSON value (no trailing plan_invocation line), the schema_version
// asymmetry (detect 0, status 1), the --format human surface, and the
// missing-project error. Each test seeds via the CLI-free seedState builder +
// chdir, so only the verb-under-test crosses the dispatch boundary.
//
// Discipline: toStrictEqual for object ports; byte-exact envelopes pinned as
// string literals against the resolved tmp root; `split()` asserts no trailer.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { SCHEMA_VERSION } from "../src/models.ts";
import { LocalFileStateStore, serializeStateJson } from "../src/store.ts";
import { runCli, seedState, withTmpdir } from "./harness.ts";

// Split CLI stdout into [primary, trailer]. Read/inspection verbs now emit a
// single JSON value, so a well-formed run has NO trailing {"plan_invocation": ...}
// compact line and `trailer` is null — the helper is how each test pins that
// absence. The trailing newline is preserved on the primary block.
function split(output: string): [string, string | null] {
  const lines = output.split(/(?<=\n)/);
  let trailer: string | null = null;
  if (
    lines.length > 0 &&
    (lines[lines.length - 1] as string)
      .trimStart()
      .startsWith('{"plan_invocation"')
  ) {
    trailer = (lines.pop() as string).replace(/\n$/, "");
  }
  return [lines.join(""), trailer];
}

// Port of _seed_empty_project: a bare .keeper/ skeleton (no epics/tasks).
function seedEmptyProject(root: string): void {
  const planctlDir = join(root, ".keeper");
  for (const sub of ["epics", "specs", "tasks", "state"]) {
    mkdirSync(join(planctlDir, sub), { recursive: true });
  }
  writeFileSync(
    join(planctlDir, "meta.json"),
    serializeStateJson({ schema_version: SCHEMA_VERSION }),
    "utf-8",
  );
}

// Port of _seed_mixed: fn-1-cafe (non-ASCII title, 3 tasks: todo/in_progress/
// done) + fn-zzz-weird (unparseable id sorts last, 0 tasks).
function seedMixed(root: string): void {
  seedState(root, { epicId: "fn-1-cafe", title: "Café résumé ☕", nTasks: 3 });
  const store = new LocalFileStateStore(join(root, ".keeper", "state"));
  store.saveRuntime("fn-1-cafe.2", {
    status: "in_progress",
    assignee: "test@example.com",
  });
  store.saveRuntime("fn-1-cafe.3", {
    status: "done",
    assignee: "test@example.com",
  });
  seedState(root, { epicId: "fn-zzz-weird", title: "Weird", nTasks: 0 });
}

let root: string;
const getTmp = withTmpdir("planctl-ro-");
beforeEach(() => {
  root = getTmp();
});

// ---------------------------------------------------------------------------
// state-path
// ---------------------------------------------------------------------------

describe("state-path", () => {
  test("envelope + byte-exact trailer", () => {
    // test_readonly_verbs.py::test_state_path_envelope
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["state-path"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      `{\n  "success": true,\n  "state_dir": "${root}/.keeper/state"\n}\n`,
    );
    expect(trailer).toBeNull();
  });

  test("missing project errors (exit 1)", () => {
    // test_readonly_verbs.py::test_state_path_missing_project_errors
    const r = runCli(["state-path"], { cwd: root });
    expect(r.code).toBe(1);
    const [primary] = split(r.stdout);
    expect(primary).toBe(
      '{\n  "success": false,\n' +
        '  "error": "No plan project found. Run \'keeper plan init\' first."\n}\n',
    );
  });
});

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

describe("detect", () => {
  test("found-true reads name/path/schema_version", () => {
    // test_readonly_verbs.py::test_detect_found_true
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const name = basename(root);
    const r = runCli(["detect"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "{\n" +
        '  "success": true,\n' +
        '  "found": true,\n' +
        '  "project": {\n' +
        `    "name": "${name}",\n` +
        `    "path": "${root}",\n` +
        `    "schema_version": ${SCHEMA_VERSION}\n` +
        "  }\n" +
        "}\n",
    );
    expect(trailer).toBeNull();
  });

  test("schema_version default 0 when meta.json absent", () => {
    // test_readonly_verbs.py::test_detect_schema_version_default_zero
    mkdirSync(join(root, ".keeper"), { recursive: true });
    const name = basename(root);
    const r = runCli(["detect"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "{\n" +
        '  "success": true,\n' +
        '  "found": true,\n' +
        '  "project": {\n' +
        `    "name": "${name}",\n` +
        `    "path": "${root}",\n` +
        '    "schema_version": 0\n' +
        "  }\n" +
        "}\n",
    );
    expect(trailer).toBeNull();
  });

  test("found-false: single {success:false, found:false, error} value + exit 1", () => {
    // A non-plan dir emits ONE JSON value carrying the found flag AND the
    // missing-project error, exiting 1 so the `detect || init` idiom survives.
    const r = runCli(["detect"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      "{\n" +
        '  "success": false,\n' +
        '  "found": false,\n' +
        '  "error": "No plan project found. Run \'keeper plan init\' first."\n' +
        "}\n",
    );
    expect(r.stdout).not.toContain('"plan_invocation"');
    // Exactly one top-level JSON value (json.loads would succeed, jq clean).
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("status", () => {
  test("counts json across the mixed fixture", () => {
    // test_readonly_verbs.py::test_status_counts_json
    seedMixed(root);
    const name = basename(root);
    const r = runCli(["status"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "{\n" +
        '  "success": true,\n' +
        '  "project": {\n' +
        `    "name": "${name}",\n` +
        `    "path": "${root}",\n` +
        '    "schema_version": 1\n' +
        "  },\n" +
        '  "epics": {\n    "total": 2,\n    "open": 2,\n    "done": 0\n  },\n' +
        '  "tasks": {\n    "total": 3,\n    "todo": 1,\n    "in_progress": 1,\n' +
        '    "done": 1,\n    "blocked": 0\n  }\n}\n',
    );
    expect(trailer).toBeNull();
  });

  test("empty project zero counts", () => {
    // test_readonly_verbs.py::test_status_empty_project_zero_counts
    seedEmptyProject(root);
    const name = basename(root);
    const r = runCli(["status"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "{\n" +
        '  "success": true,\n' +
        '  "project": {\n' +
        `    "name": "${name}",\n` +
        `    "path": "${root}",\n` +
        '    "schema_version": 1\n' +
        "  },\n" +
        '  "epics": {\n    "total": 0,\n    "open": 0,\n    "done": 0\n  },\n' +
        '  "tasks": {\n    "total": 0,\n    "todo": 0,\n    "in_progress": 0,\n' +
        '    "done": 0,\n    "blocked": 0\n  }\n}\n',
    );
    expect(trailer).toBeNull();
  });

  test("--format human falls back to JSON bytes", () => {
    // test_readonly_verbs.py::test_status_human_falls_back_to_json
    seedMixed(root);
    const human = runCli(["--format", "human", "status"], { cwd: root });
    const js = runCli(["status"], { cwd: root });
    expect(human.code).toBe(0);
    expect(js.code).toBe(0);
    expect(split(human.stdout)[0]).toBe(split(js.stdout)[0]);
  });

  test("missing project errors (exit 1)", () => {
    // test_readonly_verbs.py::test_status_missing_project_errors
    const r = runCli(["status"], { cwd: root });
    expect(r.code).toBe(1);
    expect(split(r.stdout)[0]).toBe(
      '{\n  "success": false,\n' +
        '  "error": "No plan project found. Run \'keeper plan init\' first."\n}\n',
    );
  });
});

// ---------------------------------------------------------------------------
// epics
// ---------------------------------------------------------------------------

describe("epics", () => {
  test("ordering json + non-ASCII title byte-for-byte", () => {
    // test_readonly_verbs.py::test_epics_ordering_json
    seedMixed(root);
    const name = basename(root);
    const r = runCli(["epics"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "{\n" +
        '  "success": true,\n' +
        '  "project": {\n' +
        `    "name": "${name}",\n` +
        `    "path": "${root}"\n` +
        "  },\n" +
        '  "epics": [\n' +
        "    {\n" +
        '      "id": "fn-1-cafe",\n' +
        '      "title": "Café résumé ☕",\n' +
        '      "status": "open",\n' +
        '      "branch_name": "main",\n' +
        '      "task_summary": {\n' +
        '        "total": 3,\n        "todo": 1,\n        "in_progress": 1,\n' +
        '        "done": 1,\n        "blocked": 0\n      }\n    },\n' +
        "    {\n" +
        '      "id": "fn-zzz-weird",\n' +
        '      "title": "Weird",\n' +
        '      "status": "open",\n' +
        '      "branch_name": "main",\n' +
        '      "task_summary": {\n' +
        '        "total": 0,\n        "todo": 0,\n        "in_progress": 0,\n' +
        '        "done": 0,\n        "blocked": 0\n      }\n    }\n  ],\n' +
        '  "total": 2,\n  "returned": 2,\n  "truncated": false,\n' +
        '  "hint": null\n}\n',
    );
    expect(trailer).toBeNull();
  });

  test("empty project json", () => {
    // test_readonly_verbs.py::test_epics_empty_project_json
    seedEmptyProject(root);
    const name = basename(root);
    const r = runCli(["epics"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "{\n" +
        '  "success": true,\n' +
        '  "project": {\n' +
        `    "name": "${name}",\n` +
        `    "path": "${root}"\n` +
        "  },\n" +
        '  "epics": [],\n' +
        '  "total": 0,\n  "returned": 0,\n  "truncated": false,\n' +
        '  "hint": null\n}\n',
    );
    expect(trailer).toBeNull();
  });

  test("--format human table renderer with non-ASCII title", () => {
    // test_readonly_verbs.py::test_epics_human
    seedMixed(root);
    const name = basename(root);
    const r = runCli(["--format", "human", "epics"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      `Project: ${name} (${root})\n` +
        "fn-1-cafe  Café résumé ☕  [open]  3 tasks (1 todo, 1 in_progress, 1 done)\n" +
        "fn-zzz-weird  Weird  [open]  0 tasks\n",
    );
    expect(trailer).toBeNull();
  });

  test("missing project errors (exit 1)", () => {
    // test_readonly_verbs.py::test_epics_missing_project_errors
    const r = runCli(["epics"], { cwd: root });
    expect(r.code).toBe(1);
    expect(split(r.stdout)[0]).toBe(
      '{\n  "success": false,\n' +
        '  "error": "No plan project found. Run \'keeper plan init\' first."\n}\n',
    );
  });
});

// ---------------------------------------------------------------------------
// audit gate-check — joins the single-JSON-root conformance suite. The verb's
// own behavioral coverage (hash parity, status clamping, the git-unavailable
// fail-closed path) lives in saga-audit-gate-check.test.ts; this pins ONLY the
// envelope-shape contract every read-only verb in this file shares: a single
// top-level JSON value with no trailing `{"plan_invocation": ...}` document.
// ---------------------------------------------------------------------------

describe("audit gate-check", () => {
  test("single top-level JSON root, no trailer, for a task with no finding", () => {
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1, primaryRepo: root });
    const r = runCli(["audit", "gate-check", "fn-1-cafe.1"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(trailer).toBeNull();
    // compactJson prints the whole envelope as ONE line — a second root would
    // make the trimmed body diverge from its own first line.
    const trimmed = primary.trim();
    expect(trimmed).toBe(trimmed.split("\n")[0]);
    const parsed = JSON.parse(trimmed);
    expect(parsed).toStrictEqual({
      success: true,
      exists: false,
      covers_current_commits: false,
      status: null,
      finding_ref: parsed.finding_ref,
      plan_invocation: parsed.plan_invocation,
    });
    expect(typeof parsed.finding_ref).toBe("string");
    expect(parsed.finding_ref).toContain("fn-1-cafe.1.json");
  });

  test("no owning project resolves (exit 1)", () => {
    const r = runCli(["audit", "gate-check", "fn-1-cafe.1"], { cwd: root });
    expect(r.code).toBe(1);
    const [primary, trailer] = split(r.stdout);
    expect(trailer).toBeNull();
    const error = JSON.parse(primary).error as Record<string, unknown>;
    expect(error.code).toBe("TASK_NOT_FOUND");
  });
});
