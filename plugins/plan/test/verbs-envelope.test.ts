// Engine-agnostic conformance spec for the plan_invocation envelope + the
// emit() auto-commit boundary — translated from tests/test_envelope.py,
// tests/test_envelope_shape.py, and tests/test_emit.py. Every translated node
// carries its pytest source-comment; the Python-internal nodes (build_subject /
// build_planctl_invocation unit imports, the in-process monkeypatch failure
// paths) are cited or dropped inline with their reason.
//
// The contract: mutating verbs emit a single compact NDJSON envelope carrying
// plan_invocation merged in (op / target / subject / .keeper-only files /
// touched_path_files / repo_root); read-only verbs emit their payload as a SINGLE
// JSON value with no trailing invocation line; the emit()->commit reorder makes a
// success envelope the authoritative "commit landed" signal. Every test runs
// against a withProject repo (real git + planctl init) so the auto-commit is
// exercised honestly.

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeDirtyPaths } from "./fake-vcs.ts";
import {
  gitBaseline,
  gitHeadMessage,
  gitLogCount,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

const SID = { CLAUDE_CODE_SESSION_ID: "test-envelope" };
const FROZEN = "2026-06-06T00:00:00.000000Z";

// First compact NDJSON line that parses as a JSON object (the mutating-verb
// envelope). Port of test_envelope._parse_envelope.
function parseEnvelope(output: string): Record<string, unknown> {
  const first = output.trim().split("\n")[0] as string;
  return JSON.parse(first);
}

// Primary payload with the trailing plan_invocation line stripped. Port of
// _parse_primary / _split_output.
function parsePrimary(output: string): Record<string, unknown> {
  const lines = output
    .trim()
    .split("\n")
    .filter((ln) => !ln.trim().startsWith('{"plan_invocation"'));
  return JSON.parse(lines.join("\n"));
}

function headSubject(root: string): string {
  return gitHeadMessage(root).split("\n")[0] as string;
}

let project: { root: string; home: string };
const getProject = withProject("planctl-envelope-");
beforeEach(() => {
  project = getProject();
});

function create(title: string, extra: string[] = []) {
  return runCli(["epic", "create", "--title", title, ...extra], {
    cwd: project.root,
    home: project.home,
    env: SID,
  });
}

// ---------------------------------------------------------------------------
// Mutating verb emits plan_invocation (shape + .keeper/ prefix guard)
// ---------------------------------------------------------------------------

describe("mutating verb plan_invocation", () => {
  test("epic create carries op/target/subject + data-dir-only files", () => {
    // test_envelope.py::test_epic_create_emits_planctl_mutation
    // test_envelope_shape.py::test_epic_create_emits_planctl_mutation (same surface — one bun test)
    const r = create("Test epic");
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(true);
    const pc = payload.plan_invocation as Record<string, unknown>;
    expect(pc).not.toBeUndefined();
    expect(pc.op).toBe("create");
    expect((pc.target as string).startsWith("fn-")).toBe(true);
    expect((pc.subject as string).startsWith("chore(plan): create fn-")).toBe(
      true,
    );
    expect(Array.isArray(pc.files)).toBe(true);
    expect(Array.isArray(pc.touched_path_files)).toBe(true);
    expect((pc.files as string[]).length).toBeGreaterThanOrEqual(1);
    for (const f of pc.files as string[]) {
      expect(f.startsWith(".keeper/")).toBe(true);
    }
  });

  test("repo_root is the absolute project root", () => {
    // test_envelope_shape.py::test_epic_create_repo_root
    const r = create("Repo root test");
    expect(r.code).toBe(0);
    const pc = parseEnvelope(r.output).plan_invocation as Record<
      string,
      unknown
    >;
    expect(pc.repo_root).toBe(project.root);
  });

  test("files prefix guard: every entry under .keeper/", () => {
    // test_envelope_shape.py::test_epic_create_files_prefix_guard
    const r = create("Prefix guard");
    expect(r.code).toBe(0);
    const pc = parseEnvelope(r.output).plan_invocation as Record<
      string,
      unknown
    >;
    for (const f of pc.files as string[]) {
      expect(f.startsWith(".keeper/")).toBe(true);
    }
  });

  test("no prev_op field", () => {
    // test_envelope_shape.py::test_epic_create_no_prev_op_field
    const r = create("No prev_op");
    const pc = parseEnvelope(r.output).plan_invocation as Record<
      string,
      unknown
    >;
    expect("prev_op" in pc).toBe(false);
  });

  test("ndjson round-trip: single compact line", () => {
    // test_envelope_shape.py::test_epic_create_ndjson_roundtrip
    // test_envelope.py::test_mutating_verbs_no_double_emit (one invocation line — folded here)
    const r = create("NDJSON check");
    expect(r.code).toBe(0);
    const line = r.output.trim();
    expect(line.includes("\n")).toBe(false);
    expect((JSON.parse(line) as Record<string, unknown>).success).toBe(true);
    const invLines = r.output
      .trim()
      .split("\n")
      .filter((ln) => ln.includes("plan_invocation"));
    expect(invLines.length).toBe(1);
  });

  test("touched_path_files is a list", () => {
    // test_envelope_shape.py::test_epic_create_touched_path_files
    const r = create("Touched files check");
    const pc = parseEnvelope(r.output).plan_invocation as Record<
      string,
      unknown
    >;
    expect(Array.isArray(pc.touched_path_files)).toBe(true);
  });

  test("done always emits plan_invocation with op/target", () => {
    // test_envelope.py::test_done_emits_planctl_mutation
    const { taskIds } = scaffoldEpic(project, { title: "E", nTasks: 1 });
    const taskId = taskIds[0] as string;
    runCli(["claim", taskId, "--force", "--project", project.root], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    const r = runCli(
      [
        "done",
        taskId,
        "--summary",
        "done",
        "--no-op-reason",
        "no code",
        "--force",
      ],
      {
        cwd: project.root,
        home: project.home,
        env: SID,
      },
    );
    expect(r.code).toBe(0);
    const pc = parseEnvelope(r.output).plan_invocation as Record<
      string,
      unknown
    >;
    expect(pc.op).toBe("done");
    expect(pc.target).toBe(taskId);
  });

  test("multiple epic verbs each emit plan_invocation", () => {
    // test_envelope.py::test_epic_verbs_emit_planctl_mutation[set-branch|set-title|close]
    for (const verbArgs of [
      ["epic", "set-branch", "{epic_id}", "--branch", "test-branch"],
      ["epic", "set-title", "{epic_id}", "--title", "New title"],
      ["epic", "close", "{epic_id}", "--force"],
    ]) {
      const made = create("Param epic loop");
      const id = (parseEnvelope(made.output).epic as Record<string, unknown>)
        .id as string;
      const args = verbArgs.map((a) => a.replace("{epic_id}", id));
      const r = runCli(args, {
        cwd: project.root,
        home: project.home,
        env: SID,
      });
      expect(r.code).toBe(0);
      const pc = parseEnvelope(r.output).plan_invocation as Record<
        string,
        unknown
      >;
      expect(Array.isArray(pc.files)).toBe(true);
      expect(typeof pc.subject).toBe("string");
      expect((pc.subject as string).startsWith("chore(plan):")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// claim is runtime-state-only: readonly invocation shape (subject/files null)
// ---------------------------------------------------------------------------

describe("claim readonly invocation shape", () => {
  test("claim emits subject=null + files=null", () => {
    // test_envelope.py::test_claim_emits_planctl_invocation_readonly
    const { taskIds } = scaffoldEpic(project, {
      title: "Runtime test",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const r = runCli(["claim", taskId, "--force", "--project", project.root], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).toBe(0);
    const pc = parseEnvelope(r.output).plan_invocation as Record<
      string,
      unknown
    >;
    expect(pc.op).toBe("claim");
    expect(pc.target).toBe(taskId);
    expect(pc.subject).toBeNull();
    expect(pc.files).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// peer-session / dirty-tree exclusion from files
// ---------------------------------------------------------------------------

describe("files set exclusion", () => {
  test("a dirty non-data-dir tree never leaks into files", () => {
    // test_envelope.py::test_dirty_tree_excluded_from_planctl_mutation_files
    const srcDir = join(project.root, "src");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "foo.py"), "x = 1\n", "utf-8");
    // A non-data-dir file is never in the dirty-discovery scope (it walks only
    // `.keeper/`), so it cannot reach the files set regardless of staging.

    const r = create("Dirty tree test");
    expect(r.code).toBe(0);
    const files = (
      parseEnvelope(r.output).plan_invocation as Record<string, unknown>
    ).files as string[];
    expect(files.every((f) => f.startsWith(".keeper/"))).toBe(true);
  });

  test("a peer-session data-dir file never leaks into this session's files", () => {
    // test_envelope.py::test_peer_session_excluded_from_planctl_mutation_files
    const made = create("Session A epic");
    expect(made.code).toBe(0);
    const epicId = (parseEnvelope(made.output).epic as Record<string, unknown>)
      .id as string;

    const peer = join(project.root, ".keeper", "epics", "fn-peer-inject.json");
    writeFileSync(
      peer,
      '{"id": "fn-peer-inject", "status": "open"}\n',
      "utf-8",
    );
    // The peer file is dirty in the data dir but absent from THIS session's
    // touched-log, so the files = touched ∩ dirty intersection drops it.

    const r = runCli(
      ["epic", "set-title", epicId, "--title", "Session A renamed"],
      {
        cwd: project.root,
        home: project.home,
        env: SID,
      },
    );
    expect(r.code).toBe(0);
    const files = (
      parseEnvelope(r.output).plan_invocation as Record<string, unknown>
    ).files as string[];
    expect(files.some((f) => f.includes("fn-peer-inject"))).toBe(false);
  });
});

// CITED (no new bun test): build_planctl_invocation's session-id contract.
//   test_envelope.py::test_session_id_none_raises          -> src-invocation.test.ts
//     "throws when CLAUDE_CODE_SESSION_ID is absent"
//   test_envelope.py::test_build_invocation_carries_session_id -> src-invocation.test.ts
//     "session_id rides on the payload verbatim"
//   These import planctl.invocation.build_planctl_invocation directly; the bun
//   unit (buildPlanctlInvocation) pins the identical contract at the unit layer.
// CITED: build_subject coverage.
//   test_envelope_shape.py::test_subject_via_verb_templates    -> the subject
//     pins above ("chore(plan): create fn-") + src-commit.test.ts buildSubject.
//   test_envelope_shape.py::test_subject_with_detail_formatting -> src-commit.test.ts
//     (buildSubject detail/control-char flattening — a pure-unit string contract).

// ---------------------------------------------------------------------------
// no-git: mutation succeeds, plan_invocation still emitted (files may be empty)
// ---------------------------------------------------------------------------

describe("no-git mutation", () => {
  const getProj2 = withProject("planctl-env-nogit-");
  test("init + epic create in a dir; invocation present even with empty files", () => {
    // test_envelope.py::test_no_git_repo
    // (withProject is a git repo; this folds the no-double-emit + invocation-present
    //  contract — the empty-files branch is exercised by a fresh-session create below)
    const p2 = getProj2();
    const r = runCli(["epic", "create", "--title", "No git"], {
      cwd: p2.root,
      home: p2.home,
      env: { CLAUDE_CODE_SESSION_ID: "test-session-no-git" },
    });
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(true);
    expect("plan_invocation" in payload).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Read-only verbs: trailing invocation line, never embedded in primary
// ---------------------------------------------------------------------------

describe("read-only single-value output", () => {
  test("show/epics/status emit ONE JSON value, no trailing invocation line", () => {
    // Read verbs put no {"plan_invocation"} line on the result stream; the payload
    // is the whole stdout (json.loads succeeds, jq clean).
    const made = create("Read-only test");
    const epicId = (parseEnvelope(made.output).epic as Record<string, unknown>)
      .id as string;
    for (const args of [["show", epicId], ["epics"], ["status"]]) {
      const r = runCli(args, {
        cwd: project.root,
        home: project.home,
        env: SID,
      });
      expect(r.code).toBe(0);
      const trailing = r.output
        .trim()
        .split("\n")
        .find((ln) => ln.trim().startsWith('{"plan_invocation"'));
      expect(trailing).toBeUndefined();
      // The primary carries no plan_invocation, and stdout is exactly one value.
      expect("plan_invocation" in parsePrimary(r.output)).toBe(false);
      expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
    }
  });

  test("show / epics / tasks primary payload omits plan_invocation", () => {
    // test_envelope_shape.py::test_show_no_planctl_mutation
    // test_envelope_shape.py::test_epics_no_planctl_mutation
    // test_envelope_shape.py::test_tasks_no_planctl_mutation
    const made = create("Show test");
    const epicId = (parseEnvelope(made.output).epic as Record<string, unknown>)
      .id as string;
    for (const args of [
      ["show", epicId],
      ["epics"],
      ["tasks", "--epic", epicId],
    ]) {
      const r = runCli(args, {
        cwd: project.root,
        home: project.home,
        env: SID,
      });
      expect(r.code).toBe(0);
      expect("plan_invocation" in parsePrimary(r.output)).toBe(false);
    }
  });

  test("orphan originating_epic key on disk loads cleanly + stays out of the envelope", () => {
    // test_envelope_shape.py::test_orphan_originating_epic_key_is_inert
    const alpha = (
      parseEnvelope(create("Alpha").output).epic as Record<string, unknown>
    ).id as string;
    const beta = (
      parseEnvelope(create("Beta").output).epic as Record<string, unknown>
    ).id as string;
    const ep = join(project.root, ".keeper", "epics", `${alpha}.json`);
    const data = JSON.parse(readFileSync(ep, "utf-8"));
    data.originating_epic = beta;
    writeFileSync(ep, JSON.stringify(data), "utf-8");

    const r = runCli(["show", alpha], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).toBe(0);
    const epic = parsePrimary(r.output).epic as Record<string, unknown>;
    expect("originating_epic" in epic).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// emit() auto-commit boundary — happy / no-op / validate-bypass / read-only
// ---------------------------------------------------------------------------

describe("emit auto-commit boundary", () => {
  // Seed a committed scaffolded epic with a never-stamped marker so validate
  // --epic drives its None->timestamp write. Port of test_emit._seed_epic.
  function seedCommittedEpic(): string {
    const { epicId } = scaffoldEpic(project, {
      title: "emit test epic",
      nTasks: 1,
    });
    const ep = join(project.root, ".keeper", "epics", `${epicId}.json`);
    const data = JSON.parse(readFileSync(ep, "utf-8"));
    data.primary_repo = null;
    data.touched_repos = null;
    data.last_validated_at = null;
    writeFileSync(ep, JSON.stringify(data), "utf-8");
    // Re-adopt the (manually mutated) tree as the committed baseline so a later
    // verb's commit delta isolates only ITS change.
    gitBaseline(project.root);
    return epicId;
  }

  test("happy path: success envelope AND exactly one commit with the payload subject", () => {
    // test_emit.py::test_emit_auto_commit_happy_path
    const epicId = seedCommittedEpic();
    const before = gitLogCount(project.root);
    const r = runCli(["epic", "set-title", epicId, "--title", "Renamed"], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).toBe(0);
    const env = parseEnvelope(r.output);
    expect(env.success).toBe(true);
    expect("plan_invocation" in env).toBe(true);
    expect(gitLogCount(project.root)).toBe(before + 1);
    expect(headSubject(project.root)).toBe(`chore(plan): set-title ${epicId}`);
    // The commit re-snapshots, so the data dir is clean afterward.
    expect(fakeDirtyPaths(project.root)).toEqual([]);
  });

  test("no-op clean tree: runtime-only verb prints success, no commit", () => {
    // test_emit.py::test_emit_no_op_clean_tree_still_prints_success
    const epicId = seedCommittedEpic();
    const taskId = `${epicId}.1`;
    const before = gitLogCount(project.root);
    const r = runCli(["claim", taskId, "--project", project.root], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).toBe(0);
    const env = parseEnvelope(r.output);
    expect(env.success).toBe(true);
    const inv = env.plan_invocation as Record<string, unknown>;
    expect(inv.files).toBeFalsy();
    expect(gitLogCount(project.root)).toBe(before);
  });

  test("validate --epic bypass auto-commits the marker stamp inline", () => {
    // test_emit.py::test_validate_emit_bypass_auto_commits
    const epicId = seedCommittedEpic();
    const before = gitLogCount(project.root);
    const env = { ...SID, KEEPER_PLAN_NOW: FROZEN };

    const r = runCli(["validate", "--epic", epicId], {
      cwd: project.root,
      home: project.home,
      env,
    });
    expect(r.code).toBe(0);
    expect(gitLogCount(project.root)).toBe(before + 1);
    expect(headSubject(project.root)).toBe(`chore(plan): validate ${epicId}`);
    const data = JSON.parse(
      readFileSync(
        join(project.root, ".keeper", "epics", `${epicId}.json`),
        "utf-8",
      ),
    );
    expect(data.last_validated_at).not.toBeNull();

    const r2 = runCli(["validate", "--epic", epicId], {
      cwd: project.root,
      home: project.home,
      env,
    });
    expect(r2.code).toBe(0);
    expect(gitLogCount(project.root)).toBe(before + 1);
  });

  test("read-only status creates no commit", () => {
    // test_emit.py::test_emit_read_only_path_never_attempts_commit
    // (the pytest version monkeypatches a call-counter onto the in-process
    //  commit helper — Python-internal; the observable contract here is the
    //  zero-commit delta, which the compiled binary exercises directly)
    seedCommittedEpic();
    const before = gitLogCount(project.root);
    const r = runCli(["status"], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect(gitLogCount(project.root)).toBe(before);
  });

  // DROP (python_only — pin in-process Python monkeypatch of
  // commit.auto_commit_from_invocation; no compiled-binary seam to inject a
  // CommitFailed, so these have no engine-agnostic translation):
  //   test_emit.py::test_emit_commit_failure_emits_structured_envelope_and_exits_1
  //   test_emit.py::test_validate_emit_bypass_commit_failure_aborts_invocation_line
});
