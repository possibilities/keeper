// Engine-agnostic conformance spec for the read-surface query verbs —
// translated from tests/test_query_verbs.py, every node mapped by a
// source-comment. show / cat / list / ready / tasks / resolve-task /
// refine-context / validate (read + --epic stamp machine). Every fixture is the
// CLI-free seedState builder + chdir; the golden corpus (list_human.txt /
// integrity_errors.txt) lives under test/fixtures/golden and IS the spec.
//
// Discipline: byte-exact goldens for the human/validate renders; the primary
// envelope parsed out of the trailer via a raw-decode scan (resolve-task merges
// the invocation into its payload, so "skip the sole-key planctl_invocation
// object, return the first object with any other key"). Multi-project roots
// tests write the roots config under a stable per-test HOME (the setRoots port).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atomicWriteJson,
  LocalFileStateStore,
  loadJson,
} from "../src/store.ts";
import { runCli, seedState, setRoots, withTmpdir } from "./harness.ts";

const GOLDEN = join(import.meta.dir, "fixtures", "golden");
const FROZEN = "2026-06-06T00:00:00.000000Z";

function golden(name: string): string {
  return readFileSync(join(GOLDEN, name), "utf-8");
}

// Split into [primary, trailer]. Port of _split: the trailing compact
// planctl_invocation NDJSON line, primary newline preserved.
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

// First JSON object that is NOT the sole-key planctl_invocation trailer. Port of
// _primary_envelope: a raw-decode scan tolerating pretty multi-line JSON and
// resolve-task's merged-invocation shape.
function primaryEnvelope(output: string): Record<string, unknown> {
  let i = 0;
  while (i < output.length) {
    if (output[i] !== "{") {
      i += 1;
      continue;
    }
    const slice = output.slice(i);
    const obj = tryDecodePrefix(slice);
    if (obj === null) {
      i += 1;
      continue;
    }
    const keys = Object.keys(obj.value);
    if (!(keys.length === 1 && keys[0] === "planctl_invocation")) {
      return obj.value;
    }
    i += obj.end;
  }
  throw new Error(`no primary JSON envelope in output:\n${output}`);
}

// Trailing planctl_invocation object (parsed) or null. Port of _trailer_obj:
// scan every JSON object, return the last carrying the key (resolve-task rides
// the invocation on the same physical line as the envelope).
function trailerObj(output: string): Record<string, unknown> | null {
  let i = 0;
  let found: Record<string, unknown> | null = null;
  while (i < output.length) {
    if (output[i] !== "{") {
      i += 1;
      continue;
    }
    const obj = tryDecodePrefix(output.slice(i));
    if (obj === null) {
      i += 1;
      continue;
    }
    if ("planctl_invocation" in obj.value) {
      found = obj.value.planctl_invocation as Record<string, unknown>;
    }
    i += obj.end;
  }
  return found;
}

// Decode the longest JSON-object prefix of *text*. Mirrors json.JSONDecoder.
// raw_decode: try successively shorter prefixes ending at a brace. Returns the
// parsed value + the consumed length, or null.
function tryDecodePrefix(
  text: string,
): { value: Record<string, unknown>; end: number } | null {
  for (let end = text.length; end > 0; end--) {
    if (text[end - 1] !== "}") {
      continue;
    }
    try {
      const value = JSON.parse(text.slice(0, end));
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { value: value as Record<string, unknown>, end };
      }
    } catch {
      // keep shrinking
    }
  }
  return null;
}

function store(root: string): LocalFileStateStore {
  return new LocalFileStateStore(join(root, ".keeper", "state"));
}

// ---------------------------------------------------------------------------
// Shared seeds (ports of _seed_show_corpus / _seed_list_corpus /
// _seed_invalid_corpus).
// ---------------------------------------------------------------------------

function seedShowCorpus(root: string): void {
  seedState(root, { epicId: "fn-1-cafe", title: "Cafe", nTasks: 2 });
  store(root).saveRuntime("fn-1-cafe.1", {
    status: "in_progress",
    assignee: "test@example.com",
    claimed_at: "2026-06-06T00:00:00.000000Z",
  });
  seedState(root, { epicId: "fn-2-zeta", title: "Zeta", nTasks: 0 });
}

function seedListCorpus(root: string): void {
  seedState(root, { epicId: "fn-1-cafe", title: "Café résumé ☕", nTasks: 3 });
  seedState(root, { epicId: "fn-2-zeta", title: "Zeta", nTasks: 2 });
  const s = store(root);
  s.saveRuntime("fn-1-cafe.2", {
    status: "in_progress",
    assignee: "test@example.com",
  });
  s.saveRuntime("fn-1-cafe.3", {
    status: "done",
    assignee: "test@example.com",
  });
  s.saveRuntime("fn-2-zeta.1", {
    status: "in_progress",
    assignee: "test@example.com",
  });
}

function seedInvalidCorpus(root: string): void {
  seedState(root, {
    epicId: "fn-1-cafe",
    title: "Cafe",
    nTasks: 2,
    taskDeps: { 1: [9, 2], 2: [1] },
  });
  const ep = join(root, ".keeper", "epics", "fn-1-cafe.json");
  const def = loadJson(ep);
  def.depends_on_epics = ["fn-99-ghost"];
  atomicWriteJson(ep, def);
}

let root: string;
const getTmp = withTmpdir("planctl-query-");
beforeEach(() => {
  root = getTmp();
});

// A fresh realpath'd tmp root for the multi-project / roots-scan tests, with its
// own dedicated HOME (cleaned per test). Mirrors the conftest set_roots HOME.
function multiRoot(): { rootDir: string; home: string } {
  const rootDir = realpathSync(
    mkdtempSync(join(tmpdir(), "planctl-query-root-")),
  );
  const home = realpathSync(mkdtempSync(join(tmpdir(), "planctl-query-home-")));
  multiCleanup.push(rootDir, home);
  return { rootDir, home };
}
let multiCleanup: string[] = [];
beforeEach(() => {
  multiCleanup = [];
});
// teardown via withTmpdir's afterEach ordering: register an explicit cleanup.
afterEach(() => {
  for (const d of multiCleanup) {
    rmSync(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

describe("show", () => {
  test("task merged runtime", () => {
    // test_query_verbs.py::test_show_task_merged_runtime
    seedShowCorpus(root);
    const r = runCli(["show", "fn-1-cafe.1"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(env.success).toBe(true);
    expect(env.type).toBe("task");
    const t = env.task as Record<string, unknown>;
    expect(t.id).toBe("fn-1-cafe.1");
    expect(t.epic).toBe("fn-1-cafe");
    expect(t.status).toBe("in_progress");
    expect(t.assignee).toBe("test@example.com");
    expect(t.spec_path).toBe("specs/fn-1-cafe.1.md");
    expect(t.tier).toBe("medium");
    expect(t.priority).toBeNull();
    expect(t.depends_on).toEqual([]);
  });

  test("epic task_summary", () => {
    // test_query_verbs.py::test_show_epic_task_summary
    seedShowCorpus(root);
    const r = runCli(["show", "fn-1-cafe"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(env.type).toBe("epic");
    const e = env.epic as Record<string, unknown>;
    expect(e.id).toBe("fn-1-cafe");
    expect(e.status).toBe("open");
    expect(e.spec_path).toBe("specs/fn-1-cafe.md");
    expect(e.task_summary).toStrictEqual({
      total: 2,
      todo: 1,
      in_progress: 1,
      done: 0,
      blocked: 0,
    });
  });

  test("trailer carries target", () => {
    // test_query_verbs.py::test_show_trailer_carries_target
    seedShowCorpus(root);
    const r = runCli(["show", "fn-1-cafe.1"], { cwd: root });
    const trailer = trailerObj(r.output);
    expect(trailer).not.toBeNull();
    expect((trailer as Record<string, unknown>).op).toBe("show");
    expect((trailer as Record<string, unknown>).target).toBe("fn-1-cafe.1");
    expect((trailer as Record<string, unknown>).files).toBeNull();
    expect((trailer as Record<string, unknown>).repo_root).toBe(root);
    expect((trailer as Record<string, unknown>).state_repo).toBe(root);
  });

  test("task not found errors", () => {
    // test_query_verbs.py::test_show_task_not_found_errors
    seedShowCorpus(root);
    const r = runCli(["show", "fn-1-cafe.99"], { cwd: root });
    expect(r.code).toBe(1);
    const env = primaryEnvelope(r.output);
    expect(env.success).toBe(false);
    expect(env.error as string).toContain("Task not found");
  });

  test("invalid id errors", () => {
    // test_query_verbs.py::test_show_invalid_id_errors
    seedShowCorpus(root);
    const r = runCli(["show", "not-an-id"], { cwd: root });
    expect(r.code).toBe(1);
    const env = primaryEnvelope(r.output);
    expect(env.success).toBe(false);
    expect(env.error as string).toContain("Invalid ID format");
  });
});

// ---------------------------------------------------------------------------
// cat (format-free, no trailer)
// ---------------------------------------------------------------------------

describe("cat", () => {
  test("raw markdown, no trailer", () => {
    // test_query_verbs.py::test_cat_raw_markdown_no_trailer
    seedState(root, {
      epicId: "fn-1-cafe",
      epicSpec: "## Overview\nbody\n",
      nTasks: 1,
    });
    const r = runCli(["cat", "fn-1-cafe"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.output).toBe("## Overview\nbody\n");
    expect(r.output).not.toContain('"planctl_invocation"');
  });

  test("--format flag ignored (same raw bytes)", () => {
    // test_query_verbs.py::test_cat_format_flag_ignored
    seedState(root, {
      epicId: "fn-1-cafe",
      epicSpec: "## Overview\nbody\n",
      nTasks: 1,
    });
    const plain = runCli(["cat", "fn-1-cafe"], { cwd: root });
    const yaml = runCli(["--format", "yaml", "cat", "fn-1-cafe"], {
      cwd: root,
    });
    expect(plain.code).toBe(0);
    expect(yaml.code).toBe(0);
    expect(plain.output).toBe("## Overview\nbody\n");
    expect(yaml.output).toBe("## Overview\nbody\n");
  });

  test("task spec", () => {
    // test_query_verbs.py::test_cat_task_spec
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["cat", "fn-1-cafe.1"], { cwd: root });
    expect(r.code).toBe(0);
    expect(r.output.startsWith("## Description\n")).toBe(true);
    expect(r.output).toContain("## Acceptance");
  });

  test("missing spec errors to stderr with the resolved path", () => {
    // test_query_verbs.py::test_cat_missing_spec_errors_to_stderr
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["cat", "fn-1-cafe.9"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.output).toContain("Spec not found");
    expect(r.output).toContain(
      join(root, ".keeper", "specs", "fn-1-cafe.9.md"),
    );
    expect(r.output).not.toContain('"planctl_invocation"');
  });

  test("invalid id errors", () => {
    // test_query_verbs.py::test_cat_invalid_id_errors
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["cat", "garbage"], { cwd: root });
    expect(r.code).toBe(1);
    expect(r.output).toContain("Invalid ID format");
  });
});

// ---------------------------------------------------------------------------
// list (golden-pinned human renderer)
// ---------------------------------------------------------------------------

describe("list", () => {
  test("human render byte-pinned against the golden", () => {
    // test_query_verbs.py::test_list_human_golden
    seedListCorpus(root);
    const r = runCli(["--format", "human", "list"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.output);
    expect(primary).toBe(golden("list_human.txt"));
    expect(trailer).not.toBeNull();
    expect(trailer as string).toContain('"op":"list"');
    expect(trailer as string).toContain('"target":null');
  });

  test("json ordering + merged status", () => {
    // test_query_verbs.py::test_list_json_ordering
    seedListCorpus(root);
    const r = runCli(["list"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    const epics = env.epics as Array<Record<string, unknown>>;
    expect(epics.map((e) => e.id)).toEqual(["fn-1-cafe", "fn-2-zeta"]);
    const cafe = epics[0] as Record<string, unknown>;
    const tasks = cafe.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual([
      "fn-1-cafe.1",
      "fn-1-cafe.2",
      "fn-1-cafe.3",
    ]);
    expect(tasks.map((t) => t.status)).toEqual(["todo", "in_progress", "done"]);
  });
});

// ---------------------------------------------------------------------------
// ready (met / unmet dep classification)
// ---------------------------------------------------------------------------

describe("ready", () => {
  test("ready / blocked / in_progress classification", () => {
    // test_query_verbs.py::test_ready_classifies_ready_blocked_in_progress
    seedState(root, {
      epicId: "fn-1-cafe",
      nTasks: 3,
      taskDeps: { 2: [1], 3: [] },
    });
    store(root).saveRuntime("fn-1-cafe.3", {
      status: "in_progress",
      assignee: "test@example.com",
    });
    const r = runCli(["ready", "--epic", "fn-1-cafe"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(
      (env.ready as Array<Record<string, unknown>>).map((t) => t.id),
    ).toEqual(["fn-1-cafe.1"]);
    expect(
      (env.in_progress as Array<Record<string, unknown>>).map((t) => t.id),
    ).toEqual(["fn-1-cafe.3"]);
    const blocked = env.blocked as Array<Record<string, unknown>>;
    expect(blocked.map((t) => t.id)).toEqual(["fn-1-cafe.2"]);
    expect(blocked[0]?.blocked_by).toEqual(["fn-1-cafe.1"]);
  });

  test("met dep promotes to ready", () => {
    // test_query_verbs.py::test_ready_met_dep_promotes_to_ready
    seedState(root, { epicId: "fn-1-cafe", nTasks: 2, taskDeps: { 2: [1] } });
    store(root).saveRuntime("fn-1-cafe.1", {
      status: "done",
      assignee: "test@example.com",
    });
    const r = runCli(["ready", "--epic", "fn-1-cafe"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(
      (env.ready as Array<Record<string, unknown>>).map((t) => t.id),
    ).toEqual(["fn-1-cafe.2"]);
    expect(env.blocked).toEqual([]);
  });

  test("epic not found errors", () => {
    // test_query_verbs.py::test_ready_epic_not_found_errors
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["ready", "--epic", "fn-9-nope"], { cwd: root });
    expect(r.code).toBe(1);
    const env = primaryEnvelope(r.output);
    expect(env.success).toBe(false);
    expect(env.error as string).toContain("Epic not found");
  });
});

// ---------------------------------------------------------------------------
// tasks (filters + sort)
// ---------------------------------------------------------------------------

describe("tasks", () => {
  test("status filter", () => {
    // test_query_verbs.py::test_tasks_status_filter
    seedState(root, { epicId: "fn-1-cafe", nTasks: 3 });
    store(root).saveRuntime("fn-1-cafe.2", {
      status: "in_progress",
      assignee: "test@example.com",
    });
    const r = runCli(["tasks", "--status", "in_progress"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(
      (env.tasks as Array<Record<string, unknown>>).map((t) => t.id),
    ).toEqual(["fn-1-cafe.2"]);
  });

  test("epic filter", () => {
    // test_query_verbs.py::test_tasks_epic_filter
    seedState(root, { epicId: "fn-1-cafe", nTasks: 2 });
    seedState(root, { epicId: "fn-2-zeta", nTasks: 1 });
    const r = runCli(["tasks", "--epic", "fn-2-zeta"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(
      (env.tasks as Array<Record<string, unknown>>).map((t) => t.id),
    ).toEqual(["fn-2-zeta.1"]);
  });

  test("sort: unparseable epic id sorts last", () => {
    // test_query_verbs.py::test_tasks_sort_unparseable_id_last
    seedState(root, { epicId: "fn-2-zeta", nTasks: 1 });
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    seedState(root, { epicId: "fn-zzz-weird", nTasks: 1 });
    const r = runCli(["tasks"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(
      (env.tasks as Array<Record<string, unknown>>).map((t) => t.id),
    ).toEqual(["fn-1-cafe.1", "fn-2-zeta.1", "fn-zzz-weird.1"]);
  });

  test("no positional id -> trailer target null", () => {
    // test_query_verbs.py::test_tasks_no_trailer_target
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["tasks"], { cwd: root });
    const trailer = trailerObj(r.output);
    expect(trailer).not.toBeNull();
    expect((trailer as Record<string, unknown>).op).toBe("tasks");
    expect((trailer as Record<string, unknown>).target).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolve-task (typed errors, null tier, target_repo fallback, multi-project)
// ---------------------------------------------------------------------------

describe("resolve-task", () => {
  test("null tier + 3-level target_repo fallback", () => {
    // test_query_verbs.py::test_resolve_task_null_tier_and_fallback
    const { rootDir, home } = multiRoot();
    const proj = realpathSync(mkdirAndReturn(join(rootDir, "proj")));
    seedState(proj, { epicId: "fn-1-cafe", nTasks: 1 });
    // Null the tier on disk to exercise the explicit-null surface.
    const tp = join(proj, ".keeper", "tasks", "fn-1-cafe.1.json");
    const td = loadJson(tp);
    td.tier = null;
    atomicWriteJson(tp, td);
    setRoots(home, [rootDir]);

    const r = runCli(["resolve-task", "fn-1-cafe.1"], { cwd: proj, home });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(env.success).toBe(true);
    expect(env.task_id).toBe("fn-1-cafe.1");
    expect(env.epic_id).toBe("fn-1-cafe");
    expect(env.tier).toBeNull();
    expect("tier" in env).toBe(true);
    expect(env.worker_agent).toBeNull();
    expect(env.status).toBe("todo");
    expect(env.project_path).toBe(proj);
    expect(env.target_repo).toBe(proj);
    expect(env.primary_repo).toBe(proj);
  });

  test("bad id", () => {
    // test_query_verbs.py::test_resolve_task_bad_id
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["resolve-task", "not-an-id"], { cwd: root });
    expect(r.code).toBe(1);
    const env = primaryEnvelope(r.output);
    expect(env.success).toBe(false);
    expect((env.error as Record<string, unknown>).code).toBe("BAD_TASK_ID");
  });

  test("--project on a non-planctl dir -> NOT_A_PROJECT", () => {
    // test_query_verbs.py::test_resolve_task_not_a_project
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const bare = realpathSync(
      mkdtempSync(join(tmpdir(), "planctl-query-bare-")),
    );
    multiCleanup.push(bare);
    const r = runCli(["resolve-task", "fn-1-cafe.1", "--project", bare], {
      cwd: root,
    });
    expect(r.code).toBe(1);
    expect(
      (primaryEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("NOT_A_PROJECT");
  });

  test("task not found via --project", () => {
    // test_query_verbs.py::test_resolve_task_not_found_via_project
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["resolve-task", "fn-1-cafe.9", "--project", root], {
      cwd: root,
    });
    expect(r.code).toBe(1);
    expect(
      (primaryEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("TASK_NOT_FOUND");
  });

  test("ambiguous across two projects under one root", () => {
    // test_query_verbs.py::test_resolve_task_ambiguous_multi_project
    const { rootDir, home } = multiRoot();
    const a = realpathSync(mkdirAndReturn(join(rootDir, "a")));
    const b = realpathSync(mkdirAndReturn(join(rootDir, "b")));
    seedState(a, { epicId: "fn-1-cafe", nTasks: 1 });
    seedState(b, { epicId: "fn-1-cafe", nTasks: 1 });
    setRoots(home, [rootDir]);

    const r = runCli(["resolve-task", "fn-1-cafe.1"], { cwd: rootDir, home });
    expect(r.code).toBe(1);
    const err = primaryEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("AMBIGUOUS_TASK_ID");
    const candidates = (err.details as Record<string, unknown>)
      .candidates as string[];
    expect([...candidates].sort()).toEqual([a, b].sort());
  });

  test("--project disambiguates a multi-project collision", () => {
    // test_query_verbs.py::test_resolve_task_project_disambiguates
    const { rootDir, home } = multiRoot();
    const a = realpathSync(mkdirAndReturn(join(rootDir, "a")));
    const b = realpathSync(mkdirAndReturn(join(rootDir, "b")));
    seedState(a, { epicId: "fn-1-cafe", nTasks: 1 });
    seedState(b, { epicId: "fn-1-cafe", nTasks: 1 });
    setRoots(home, [rootDir]);

    const r = runCli(["resolve-task", "fn-1-cafe.1", "--project", b], {
      cwd: rootDir,
      home,
    });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(env.success).toBe(true);
    expect(env.project_path).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// refine-context (read path)
// ---------------------------------------------------------------------------

describe("refine-context", () => {
  test("read envelope", () => {
    // test_query_verbs.py::test_refine_context_read_envelope
    seedState(root, {
      epicId: "fn-1-cafe",
      title: "Cafe",
      epicSpec: "## Overview\nepic body\n",
      nTasks: 2,
    });
    const r = runCli(["refine-context", "fn-1-cafe"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(env.epic_id).toBe("fn-1-cafe");
    expect(env.title).toBe("Cafe");
    expect(env.epic_spec_md).toBe("## Overview\nepic body\n");
    expect(env.last_validated_at).toBeNull();
    const tasks = env.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(["fn-1-cafe.1", "fn-1-cafe.2"]);
    expect((tasks[0]?.spec_md as string).startsWith("## Description\n")).toBe(
      true,
    );
  });

  test("empty spec string when absent", () => {
    // test_query_verbs.py::test_refine_context_empty_spec_string
    seedState(root, { epicId: "fn-1-cafe", nTasks: 0 });
    unlinkSync(join(root, ".keeper", "specs", "fn-1-cafe.md"));
    const r = runCli(["refine-context", "fn-1-cafe"], { cwd: root });
    expect(r.code).toBe(0);
    const env = primaryEnvelope(r.output);
    expect(env.epic_spec_md).toBe("");
    expect(env.tasks).toEqual([]);
  });

  test("bad id", () => {
    // test_query_verbs.py::test_refine_context_bad_id
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["refine-context", "fn-1-cafe.1"], { cwd: root });
    expect(r.code).toBe(1);
    expect(
      (primaryEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("BAD_EPIC_ID");
  });

  test("epic not found", () => {
    // test_query_verbs.py::test_refine_context_epic_not_found
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["refine-context", "fn-9-nope"], { cwd: root });
    expect(r.code).toBe(1);
    expect(
      (primaryEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("EPIC_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// validate (whole-project) — golden-pinned catalog, no trailer
// ---------------------------------------------------------------------------

describe("validate", () => {
  test("valid project", () => {
    // test_query_verbs.py::test_validate_valid_project
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const r = runCli(["validate"], { cwd: root });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.output);
    expect(JSON.parse(primary)).toStrictEqual({
      valid: true,
      errors: [],
      warnings: [],
    });
    expect(trailer).toBeNull();
  });

  test("invalid error catalog byte-pinned against the golden", () => {
    // test_query_verbs.py::test_validate_invalid_error_catalog_golden
    seedInvalidCorpus(root);
    const r = runCli(["validate"], { cwd: root });
    expect(r.code).toBe(1);
    const [primary, trailer] = split(r.output);
    expect(trailer).toBeNull();
    const env = JSON.parse(primary) as Record<string, unknown>;
    expect(env.valid).toBe(false);
    expect(env.warnings).toEqual([]);
    expect(env.errors).toEqual(
      golden("integrity_errors.txt").split("\n").filter(Boolean),
    );
  });

  test("touched_repos warning uses repr quoting around the path", () => {
    // test_query_verbs.py::test_validate_touched_repos_warning_repr_quoted
    const other = realpathSync(
      mkdtempSync(join(tmpdir(), "planctl-query-other-")),
    );
    multiCleanup.push(other);
    mkdirSync(join(other, ".git"), { recursive: true });
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1, primaryRepo: root });
    mkdirSync(join(root, ".git"), { recursive: true });
    const ep = join(root, ".keeper", "epics", "fn-1-cafe.json");
    const epicDef = loadJson(ep);
    epicDef.touched_repos = [root];
    atomicWriteJson(ep, epicDef);
    const tp = join(root, ".keeper", "tasks", "fn-1-cafe.1.json");
    const td = loadJson(tp);
    td.target_repo = other;
    atomicWriteJson(tp, td);

    const r = runCli(["validate"], { cwd: root });
    const [primary] = split(r.output);
    const env = JSON.parse(primary) as Record<string, unknown>;
    const warning =
      `Task fn-1-cafe.1: target_repo '${other}' is not in ` +
      "epic.touched_repos — this may indicate a misconfiguration";
    expect(env.warnings as string[]).toContain(warning);
  });
});

// ---------------------------------------------------------------------------
// validate --epic (stamp state-machine)
// ---------------------------------------------------------------------------

describe("validate --epic", () => {
  test("stamps on the None transition + emits a second compact invocation", () => {
    // test_query_verbs.py::test_validate_epic_stamps_on_none_transition
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const ep = join(root, ".keeper", "epics", "fn-1-cafe.json");
    expect(loadJson(ep).last_validated_at ?? null).toBeNull();

    const r = runCli(["validate", "--epic", "fn-1-cafe"], {
      cwd: root,
      env: { PLANCTL_NOW: FROZEN, CLAUDE_CODE_SESSION_ID: "test-query-verbs" },
    });
    expect(r.code).toBe(0);
    const [primary, trailer] = split(r.output);
    expect((JSON.parse(primary) as Record<string, unknown>).valid).toBe(true);
    expect(trailer).not.toBeNull();
    const inv = (JSON.parse(trailer as string) as Record<string, unknown>)
      .planctl_invocation as Record<string, unknown>;
    expect(inv.op).toBe("validate");
    expect(inv.target).toBe("fn-1-cafe");
    expect(loadJson(ep).last_validated_at).toBe(FROZEN);
  });

  test("already-stamped re-run is a pure no-op (no second invocation line)", () => {
    // test_query_verbs.py::test_validate_epic_already_stamped_is_noop
    seedState(root, { epicId: "fn-1-cafe", nTasks: 1 });
    const ep = join(root, ".keeper", "epics", "fn-1-cafe.json");
    const env = {
      PLANCTL_NOW: FROZEN,
      CLAUDE_CODE_SESSION_ID: "test-query-verbs",
    };

    const first = runCli(["validate", "--epic", "fn-1-cafe"], {
      cwd: root,
      env,
    });
    expect(first.code).toBe(0);
    const stamped = loadJson(ep).last_validated_at;
    expect(stamped).toBe(FROZEN);

    const second = runCli(["validate", "--epic", "fn-1-cafe"], {
      cwd: root,
      env,
    });
    expect(second.code).toBe(0);
    const [primary, trailer] = split(second.output);
    JSON.parse(primary);
    expect(trailer).toBeNull();
    expect(loadJson(ep).last_validated_at).toBe(stamped);
  });
});

// mkdir -p and return the path (the multi-project seed dirs).
function mkdirAndReturn(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
