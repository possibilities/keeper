// Engine-agnostic conformance spec for the four read-only verbs — translated
// from tests/test_readonly_verbs.py, every node mapped by a source-comment.
// state-path / detect / status / epics: byte-exact primary envelope + the
// trailing planctl_invocation NDJSON line, the schema_version asymmetry
// (detect 0, status 1), --format yaml/human surfaces, and the missing-project
// error. Each test seeds via the CLI-free seedState builder (the harness port)
// + chdir, so only the verb-under-test crosses the compiled-binary boundary.
//
// Discipline: toStrictEqual for object ports; the byte-exact envelopes pinned
// as string literals against the resolved tmp root; the trailer rebuilt with
// the same compact-JSON byte order the binary emits.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { SCHEMA_VERSION } from "../src/models.ts";
import { LocalFileStateStore, serializeStateJson } from "../src/store.ts";
import { runCli, seedState, withTmpdir } from "./harness.ts";

// Split CLI stdout into [primary, trailer] — the read-only decorator appends a
// trailing {"planctl_invocation": ...} compact NDJSON line. Port of the pytest
// _split: the trailing newline is preserved on the primary block. (per-file
// helper — the harness exposes no split; conftest._split is module-local too.)
function split(output: string): [string, string | null] {
  const lines = output.split(/(?<=\n)/);
  let trailer: string | null = null;
  if (
    lines.length > 0 &&
    (lines[lines.length - 1] as string)
      .trimStart()
      .startsWith('{"planctl_invocation"')
  ) {
    trailer = (lines.pop() as string).replace(/\n$/, "");
  }
  return [lines.join(""), trailer];
}

// Byte-exact compact trailer for a read-only verb. Port of _expected_trailer:
// the whole {"planctl_invocation": {...}} serialized with compact separators,
// target null for verbs with no positional id, repo_root == state_repo == root.
function expectedTrailer(op: string, root: string): string {
  return JSON.stringify({
    planctl_invocation: {
      files: null,
      op,
      target: null,
      subject: null,
      touched_path_files: [],
      repo_root: root,
      state_repo: root,
    },
  });
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
    expect(trailer).toBe(expectedTrailer("state-path", root));
  });

  test("missing project errors (exit 1)", () => {
    // test_readonly_verbs.py::test_state_path_missing_project_errors
    const r = runCli(["state-path"], { cwd: root });
    expect(r.code).toBe(1);
    const [primary] = split(r.stdout);
    expect(primary).toBe(
      '{\n  "success": false,\n' +
        '  "error": "No planctl project found. Run \'planctl init\' first."\n}\n',
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
    expect(trailer).toBe(expectedTrailer("detect", root));
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
    expect(trailer).toBe(expectedTrailer("detect", root));
  });

  test("found-false: bare {found:false} then resolver error + exit 1", () => {
    // test_readonly_verbs.py::test_detect_found_false
    const r = runCli(["detect"], { cwd: root });
    expect(r.code).toBe(1);
    expect(
      r.stdout.startsWith('{\n  "success": true,\n  "found": false\n}\n'),
    ).toBe(true);
    expect(r.stdout).not.toContain('"planctl_invocation"');
    expect(r.stdout).toContain(
      "{\n" +
        '  "success": false,\n' +
        '  "error": "No planctl project found. Run \'planctl init\' first."\n' +
        "}\n",
    );
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
    expect(trailer).toBe(expectedTrailer("status", root));
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
    expect(trailer).toBe(expectedTrailer("status", root));
  });

  test("--format yaml block style", () => {
    // test_readonly_verbs.py::test_status_yaml
    seedMixed(root);
    const name = basename(root);
    const r = runCli(["--format", "yaml", "status"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "success: true\n" +
        "project:\n" +
        `  name: ${name}\n` +
        `  path: ${root}\n` +
        "  schema_version: 1\n" +
        "epics:\n  total: 2\n  open: 2\n  done: 0\n" +
        "tasks:\n  total: 3\n  todo: 1\n  in_progress: 1\n  done: 1\n  blocked: 0\n",
    );
    expect(trailer).toBe(expectedTrailer("status", root));
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
        '  "error": "No planctl project found. Run \'planctl init\' first."\n}\n',
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
    const r = runCli(["epics"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "{\n" +
        '  "success": true,\n' +
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
        '        "done": 0,\n        "blocked": 0\n      }\n    }\n  ]\n}\n',
    );
    expect(trailer).toBe(expectedTrailer("epics", root));
  });

  test("empty project json", () => {
    // test_readonly_verbs.py::test_epics_empty_project_json
    seedEmptyProject(root);
    const r = runCli(["epics"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe('{\n  "success": true,\n  "epics": []\n}\n');
    expect(trailer).toBe(expectedTrailer("epics", root));
  });

  test("--format yaml", () => {
    // test_readonly_verbs.py::test_epics_yaml
    seedMixed(root);
    const r = runCli(["--format", "yaml", "epics"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "success: true\n" +
        "epics:\n" +
        "- id: fn-1-cafe\n" +
        "  title: Café résumé ☕\n" +
        "  status: open\n" +
        "  branch_name: main\n" +
        "  task_summary:\n" +
        "    total: 3\n    todo: 1\n    in_progress: 1\n    done: 1\n    blocked: 0\n" +
        "- id: fn-zzz-weird\n" +
        "  title: Weird\n" +
        "  status: open\n" +
        "  branch_name: main\n" +
        "  task_summary:\n" +
        "    total: 0\n    todo: 0\n    in_progress: 0\n    done: 0\n    blocked: 0\n",
    );
    expect(trailer).toBe(expectedTrailer("epics", root));
  });

  test("--format human table renderer with non-ASCII title", () => {
    // test_readonly_verbs.py::test_epics_human
    seedMixed(root);
    const r = runCli(["--format", "human", "epics"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.stdout);
    expect(primary).toBe(
      "fn-1-cafe  Café résumé ☕  [open]  3 tasks (1 todo, 1 in_progress, 1 done)\n" +
        "fn-zzz-weird  Weird  [open]  0 tasks\n",
    );
    expect(trailer).toBe(expectedTrailer("epics", root));
  });

  test("missing project errors (exit 1)", () => {
    // test_readonly_verbs.py::test_epics_missing_project_errors
    const r = runCli(["epics"], { cwd: root });
    expect(r.code).toBe(1);
    expect(split(r.stdout)[0]).toBe(
      '{\n  "success": false,\n' +
        '  "error": "No planctl project found. Run \'planctl init\' first."\n}\n',
    );
  });
});
