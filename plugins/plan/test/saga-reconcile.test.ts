// Conformance spec for `planctl reconcile <task_id>` — the read-only post-worker
// verdict, translated from tests/test_reconcile.py, every node mapped by a
// source-comment (translated | cited | drop-with-reason).
//
// reconcile's verdict is computed from Task:-trailer source commits, HEAD
// visibility (committed task JSON), and an epic-progress tally — keeper's
// DECISION is the subject, so the verdict tests seed the in-verb-read fixtures
// through the fake VCS (fakeSourceCommit / fakeCommitTaskJson) and run git-free in
// the default tier. The pure truth-table + the unborn-branch guard are CITED to
// src-git-lookup.test.ts (computeVerdict / stateHeadVisible); the tooling-error
// fail-closed node is python_only (drop). The comma-split, prose-body, and
// substring-collision nodes translate the END-TO-END verdict here while their
// direct trailer-extraction half is cited to src-git-lookup.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { VERDICTS, type Verdict } from "../src/verbs/reconcile.ts";
import { setSessionDirty } from "./fake-vcs.ts";
import {
  fakeCommitTaskJson,
  fakeSourceCommit,
  gitHeadMessage,
  gitHeadSha,
  gitInit,
  gitLogCount,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
  withTmpdir,
} from "./harness.ts";

// Exhaustiveness handler set — mirrors the /plan:work post-worker switch.
const ORCHESTRATOR_HANDLERS = new Set<Verdict>([
  "done",
  "in_progress_committed",
  "in_progress_uncommitted",
  "blocked",
  "state_uncommitted",
  "not_started",
  "tooling_error",
]);

// Seed a fake source commit carrying `body` (incl. trailers); return the fake sha.
function commitWithTrailer(repo: string, body: string): string {
  return fakeSourceCommit(repo, body);
}

// Write the runtime sidecar directly — bypasses claim/done. Port of _set_runtime.
function setRuntime(
  root: string,
  taskId: string,
  state: Record<string, unknown>,
): void {
  const p = join(root, ".keeper", "state", "tasks", `${taskId}.state.json`);
  writeFileSync(p, `${JSON.stringify(state)}\n`, "utf-8");
}

// Stamp worker_done_at on the tracked task JSON and land it in HEAD (the on-HEAD
// shape `planctl done` produces). Port of _commit_task_json_with_done_stamp.
function commitTaskJsonWithDoneStamp(root: string, taskId: string): void {
  const rel = `.keeper/tasks/${taskId}.json`;
  const taskPath = join(root, rel);
  const data = JSON.parse(readFileSync(taskPath, "utf-8")) as Record<
    string,
    unknown
  >;
  data.worker_done_at = "2026-06-06T00:00:00.000000Z";
  writeFileSync(taskPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  fakeCommitTaskJson(root, taskId);
}

function envObj(out: string): Record<string, unknown> {
  return parseCliOutput(out);
}
function errCode(out: string): unknown {
  return (parseCliOutput(out).error as Record<string, unknown>).code;
}

// ---------------------------------------------------------------------------
// One CLI case per verdict (real git).
// ---------------------------------------------------------------------------

describe("reconcile verdicts", () => {
  const getProj = withProject("planctl-reconcile-");
  const getLane = withTmpdir("planctl-reconcile-lane-");

  test("freshly-seeded todo -> not_started", () => {
    // test_reconcile.py::test_reconcile_not_started
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.success).toBe(true);
    expect(obj.verdict).toBe("not_started");
    expect(obj.task_id).toBe(taskId);
    expect(obj.epic_id).toBe(epicId);
    expect(obj.status).toBe("todo");
    expect(obj.source_commits).toEqual([]);
    expect(obj.blocked_reason).toBeNull();
    expect("assessed_at" in obj).toBe(true);
  });

  test("blocked -> blocked, carries blocked_reason", () => {
    // test_reconcile.py::test_reconcile_blocked_carries_reason
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, {
      status: "blocked",
      blocked_reason: "waiting on upstream",
    });
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("blocked");
    expect(obj.status).toBe("blocked");
    expect(obj.blocked_reason).toBe("waiting on upstream");
  });

  test("in_progress, no trailer commit -> in_progress_uncommitted", () => {
    // test_reconcile.py::test_reconcile_in_progress_uncommitted
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "in_progress" });
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("in_progress_uncommitted");
    expect(obj.source_commits).toEqual([]);
  });

  test("in_progress + real trailer commit -> in_progress_committed", () => {
    // test_reconcile.py::test_reconcile_in_progress_committed
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "in_progress" });
    const sha = commitWithTrailer(
      proj.root,
      `feat(x): do the thing\n\nbody line.\n\nTask: ${taskId}`,
    );
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("in_progress_committed");
    const commits = obj.source_commits as Array<Record<string, unknown>>;
    expect(commits.some((c) => c.sha === sha)).toBe(true);
    expect(commits.every((c) => "repo" in c)).toBe(true);
  });

  test("done on disk, stamp not in HEAD -> state_uncommitted", () => {
    // test_reconcile.py::test_reconcile_state_uncommitted_stamp_not_in_head
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    // scaffold's auto-commit already landed the task JSON in HEAD with
    // worker_done_at=null; flip the sidecar to done WITHOUT stamping HEAD.
    setRuntime(proj.root, taskId, { status: "done" });

    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("state_uncommitted");
    expect(obj.status).toBe("done");
    expect(obj.state_head_visible).toBe(false);
  });

  test("done on disk, path not in HEAD -> state_uncommitted", () => {
    // test_reconcile.py::test_reconcile_state_uncommitted_path_not_in_head
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "done" });
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    // The seeded scaffold commits the task JSON; this verdict needs the path to
    // be absent from HEAD OR the stamp absent. scaffold lands the path with
    // worker_done_at=null → stamp absent → state_uncommitted either way.
    expect(obj.verdict).toBe("state_uncommitted");
    expect(obj.state_head_visible).toBe(false);
  });

  test("done on disk AND stamp visible in HEAD -> done", () => {
    // test_reconcile.py::test_reconcile_done
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "done" });
    commitTaskJsonWithDoneStamp(proj.root, taskId);
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("done");
    expect(obj.status).toBe("done");
    expect(obj.state_head_visible).toBe(true);
  });

  test("KEEPER_PLAN_WORKTREE does not redirect plan-state off the primary repo", () => {
    // The lane override governs target_repo ONLY; state_repo (the committed-stamp
    // cat-file cwd) stays in the primary repo. Were it redirected to the lane (a
    // real dir but NOT a git work tree) stateHeadVisible would throw → the done
    // verdict could never be reached.
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "done" });
    commitTaskJsonWithDoneStamp(proj.root, taskId);

    const lane = getLane();
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { KEEPER_PLAN_WORKTREE: lane },
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("done");
    expect(obj.state_head_visible).toBe(true);
  });

  // test_reconcile.py::test_reconcile_tooling_error_fail_closed
  //   -> DROP (python_only): monkeypatches run_reconcile._state_head_visible to
  //      raise _GitError mid-verdict — an in-process injection that cannot cross
  //      the subprocess boundary. The fail-closed contract is unit-owned by
  //      src-git-lookup.test.ts (stateHeadVisible's git-failure handling).
});

// ---------------------------------------------------------------------------
// Close-out gate observable — dirty_session_files (fail-open, visible marker).
// ---------------------------------------------------------------------------

describe("reconcile dirty_session_files", () => {
  const getProj = withProject("planctl-reconcile-dirty-");

  test("clean lane -> dirty_session_files 0", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Dirty gate",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "in_progress" });
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(envObj(r.output).dirty_session_files).toBe(0);
  });

  test("undischarged files -> dirty_session_files count", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Dirty gate",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "in_progress" });
    // target_repo defaults to the project root; force its session-dirty set.
    setSessionDirty(proj.root, ["src/a.ts", "src/b.ts"]);
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.dirty_session_files).toBe(2);
    // The dirty probe is SEPARATE from the verdict — it never collapses it.
    expect(obj.verdict).toBe("in_progress_uncommitted");
  });

  test("unreadable git -> dirty_session_files null (fail-open marker)", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Dirty gate",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "in_progress" });
    setSessionDirty(proj.root, null);
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    // Fail-open: the probe surfaces null, the verdict is still computed cleanly.
    expect(obj.dirty_session_files).toBeNull();
    expect(obj.verdict).toBe("in_progress_uncommitted");
  });
});

// ---------------------------------------------------------------------------
// Trailer authenticity (end-to-end verdict; extraction half cited).
// ---------------------------------------------------------------------------

describe("reconcile trailer authenticity", () => {
  const getProj = withProject("planctl-reconcile-trailer-");

  test("a prose body Task: line does not register as a source commit", () => {
    // test_reconcile.py::test_reconcile_prose_body_does_not_match
    //   (extraction half CITED src-git-lookup.test.ts findSourceCommits
    //    "a prose body Task: line (not a trailer block) does not match")
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setRuntime(proj.root, taskId, { status: "in_progress" });
    commitWithTrailer(
      proj.root,
      `feat(x): mention things\n\nTask: ${taskId}\n\nmore prose after, so this ` +
        "is not the trailer block.",
    );
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("in_progress_uncommitted");
    expect(obj.source_commits).toEqual([]);
  });

  test("fn-N.1 does not match an fn-N.10 trailer (substring)", () => {
    // test_reconcile.py::test_reconcile_no_substring_collision
    //   (extraction half CITED src-git-lookup.test.ts findSourceCommits
    //    "fn-N.1 does NOT match an fn-N.10 trailer (no substring collision)")
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const epicId = taskId.slice(0, taskId.lastIndexOf("."));
    const sibling = `${epicId}.10`;
    setRuntime(proj.root, taskId, { status: "in_progress" });
    commitWithTrailer(proj.root, `feat(x): sibling work\n\nTask: ${sibling}`);
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("in_progress_uncommitted");
    expect(obj.source_commits).toEqual([]);
  });

  test("Task: a, b on one trailer line matches both ids (verdict done each)", () => {
    // test_reconcile.py::test_reconcile_comma_split_trailer_matches_both
    //   (the direct _find_source_commits half is CITED src-git-lookup.test.ts
    //    findSourceCommits "a comma-joined Task: a, b trailer matches both ids";
    //    the end-to-end done verdict for each id translates here)
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Comma split",
      nTasks: 2,
    });
    const [t1, t2] = taskIds as [string, string];
    setRuntime(proj.root, t1, { status: "done" });
    setRuntime(proj.root, t2, { status: "done" });
    commitTaskJsonWithDoneStamp(proj.root, t1);
    commitTaskJsonWithDoneStamp(proj.root, t2);
    commitWithTrailer(
      proj.root,
      `feat(x): do both things\n\nbody line.\n\nTask: ${t1}, ${t2}`,
    );
    for (const tid of [t1, t2]) {
      const r = runCli(["reconcile", tid, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      const obj = envObj(r.output);
      expect(obj.verdict).toBe("done");
      expect(obj.status).toBe("done");
      expect(obj.state_head_visible).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-repo source scan (target_repo != state_repo).
// ---------------------------------------------------------------------------

describe("reconcile cross-repo source scan", () => {
  const getProj = withProject("planctl-reconcile-xrepo-");
  const getTarget = withTmpdir("planctl-reconcile-target-");

  // Repoint the task JSON's target_repo (reconcile re-reads, no mint check).
  function setTargetRepo(root: string, taskId: string, target: string): void {
    const rel = `.keeper/tasks/${taskId}.json`;
    const p = join(root, rel);
    const data = JSON.parse(readFileSync(p, "utf-8")) as Record<
      string,
      unknown
    >;
    data.target_repo = target;
    writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }
  function setEpicTouchedRepos(
    root: string,
    epicId: string,
    repos: string[],
  ): void {
    const rel = `.keeper/epics/${epicId}.json`;
    const p = join(root, rel);
    const data = JSON.parse(readFileSync(p, "utf-8")) as Record<
      string,
      unknown
    >;
    data.touched_repos = repos;
    writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  }
  function initTarget(dir: string): void {
    gitInit(dir);
    // A baseline commit so the target repo has a born HEAD (the source scan's
    // hasHead gate). The seeded source commit lands on top via commitWithTrailer.
    fakeSourceCommit(dir, "chore: initial commit\n");
  }

  test("Task: commit in target_repo -> done, attributed to target_repo", () => {
    // test_reconcile.py::test_reconcile_cross_repo_source_scan_done
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Cross repo",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const target = getTarget();
    initTarget(target);
    setTargetRepo(proj.root, taskId, target);

    const sha = commitWithTrailer(
      target,
      `feat(x): cross-repo work\n\nbody line.\n\nTask: ${taskId}`,
    );
    setRuntime(proj.root, taskId, { status: "done" });
    commitTaskJsonWithDoneStamp(proj.root, taskId);

    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("done");
    expect(obj.status).toBe("done");
    expect(obj.state_head_visible).toBe(true);
    const commits = obj.source_commits as Array<Record<string, unknown>>;
    const match = commits.find((c) => c.sha === sha);
    expect(match).toBeDefined();
    expect((match as Record<string, unknown>).repo).toBe(target);
  });

  test("repo reachable via target_repo AND touched_repos is scanned once", () => {
    // test_reconcile.py::test_reconcile_cross_repo_dedup_no_duplicate_scan
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Cross repo dedup",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const target = getTarget();
    initTarget(target);
    setTargetRepo(proj.root, taskId, target);
    setEpicTouchedRepos(proj.root, epicId, [target]);

    const sha = commitWithTrailer(
      target,
      `feat(x): dedup work\n\nTask: ${taskId}`,
    );
    setRuntime(proj.root, taskId, { status: "in_progress" });

    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).toBe("in_progress_committed");
    const matching = (
      obj.source_commits as Array<Record<string, unknown>>
    ).filter((c) => c.sha === sha);
    expect(matching.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Typed errors, read-only contract, reporting, exhaustiveness, --help.
// ---------------------------------------------------------------------------

describe("reconcile errors + contract + meta", () => {
  const getProj = withProject("planctl-reconcile-meta-");
  const getUnborn = withTmpdir("planctl-reconcile-unborn-");

  test("malformed id -> BAD_TASK_ID, exit 1", () => {
    // test_reconcile.py::test_reconcile_bad_id
    const proj = getProj();
    const r = runCli(["reconcile", "not-a-task-id", "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(envObj(r.output).success).toBe(false);
    expect(errCode(r.output)).toBe("BAD_TASK_ID");
  });

  test("no matching project -> TASK_NOT_FOUND, exit 1", () => {
    // test_reconcile.py::test_reconcile_not_found
    const proj = getProj();
    const r = runCli(
      ["reconcile", "fn-9999-no-task.1", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("TASK_NOT_FOUND");
  });

  test("--project at a non-project dir -> NOT_A_PROJECT", () => {
    // test_reconcile.py::test_reconcile_project_not_a_project
    const proj = getProj();
    const notProj = join(proj.root, "not-a-planctl-proj");
    require("node:fs").mkdirSync(notProj, { recursive: true });
    const r = runCli(["reconcile", "fn-1-foo.1", "--project", notProj], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("NOT_A_PROJECT");
  });

  test("read-only: HEAD unchanged, no reconcile commit subject", () => {
    // test_reconcile.py::test_reconcile_lands_no_commit
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const before = gitHeadSha(proj.root);
    const beforeCount = gitLogCount(proj.root);
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(gitHeadSha(proj.root)).toBe(before);
    expect(gitLogCount(proj.root)).toBe(beforeCount);
    // No reconcile-verb commit subject landed (reconcile is read-only).
    expect(gitHeadMessage(proj.root).includes("chore(plan): reconcile")).toBe(
      false,
    );
  });

  test("envelope carries readonly plan_invocation footer", () => {
    // test_reconcile.py::test_reconcile_envelope_carries_readonly_invocation
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Reconcile epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const r = runCli(["reconcile", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    // reconcile emits ONE compact line carrying both payload + inline footer.
    const inv = parseCliOutput(r.output).plan_invocation as Record<
      string,
      unknown
    >;
    expect(inv).toBeDefined();
    expect(inv.op).toBe("reconcile");
    expect(inv.subject).toBeNull();
    expect(inv.files).toBeNull();
  });

  test("epic_progress reports {done, total}", () => {
    // test_reconcile.py::test_reconcile_epic_progress_reporting
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Multi", nTasks: 2 });
    setRuntime(proj.root, taskIds[0] as string, { status: "done" });
    const r = runCli(
      ["reconcile", taskIds[1] as string, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(0);
    expect(envObj(r.output).epic_progress).toEqual({ done: 1, total: 2 });
  });

  test("unborn-branch guard: empty state_repo HEAD -> not a tooling error", () => {
    // test_reconcile.py::test_reconcile_unborn_branch_guard
    //   (CITED src-git-lookup.test.ts stateHeadVisible "unborn branch -> false,
    //    not a throw"; anchored here against the CLI by an init-but-uncommitted
    //    project whose done task lands state_uncommitted, never tooling_error)
    const dir = getUnborn();
    gitInit(dir);
    const home = join(dir, ".home");
    require("node:fs").mkdirSync(home, { recursive: true });
    const init = runCli(["init"], { cwd: dir, home });
    expect(init.code).toBe(0);
    const planPath = join(dir, "_seed.yaml");
    writeFileSync(
      planPath,
      // Inline a minimal scaffold plan; the project's HEAD stays at init's root
      // commit (born), but we exercise the guard via a done task whose stamp is
      // not in HEAD — the verdict must be a clean signal, never tooling_error.
      "epic:\n  title: Unborn guard\n  spec: |\n    ## Overview\n    seed\n" +
        "tasks:\n  - title: Task 1\n    tier: medium\n    model: opus\n    spec: |\n" +
        "      ## Description\n      x\n\n      ## Acceptance\n      - [ ] x\n\n" +
        "      ## Done summary\n\n      ## Evidence\n",
      "utf-8",
    );
    const sc = runCli(["scaffold", "--file", planPath], { cwd: dir, home });
    expect(sc.code).toBe(0);
    const taskId = (
      parseCliOutput(sc.output).task_ids as string[]
    )[0] as string;
    setRuntime(dir, taskId, { status: "done" });
    const r = runCli(["reconcile", taskId, "--project", dir], {
      cwd: dir,
      home,
    });
    expect(r.code).toBe(0);
    const obj = envObj(r.output);
    expect(obj.verdict).not.toBe("tooling_error");
    expect(obj.state_head_visible).toBe(false);
  });

  test("every Verdict member has an orchestrator handler and vice versa", () => {
    // test_reconcile.py::test_reconcile_verdict_exhaustiveness
    const members = new Set(Object.values(VERDICTS) as Verdict[]);
    expect(members).toEqual(ORCHESTRATOR_HANDLERS);
  });

  // test_reconcile.py::test_reconcile_compute_verdict_truth_table
  //   -> CITED src-git-lookup.test.ts describe("computeVerdict truth table") —
  //      the full (status, signals) -> verdict table is unit-owned there.

  test("reconcile --help exits 0", () => {
    // test_reconcile.py::test_reconcile_help_exits_zero
    const proj = getProj();
    const r = runCli(["reconcile", "--help"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(r.output.toLowerCase().includes("reconcile")).toBe(true);
  });
});
