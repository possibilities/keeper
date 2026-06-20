// Conformance spec for `planctl find-task-commit <task_id>` — translated from
// tests/test_find_task_commit.py, every node mapped by a source-comment
// (translated | cited | drop-with-reason). The verb wraps the shared
// commit_lookup native trailer scan and emits the flat keeper-compatible
// envelope {success, commits:[{sha,repo}]}: a real Task:-trailer commit groups
// by repo, a clean miss is an empty success (exit 0), a prose false-match is
// dropped by the trailer post-filter, and the typed input/resolution errors
// (BAD_TASK_ID / TASK_NOT_FOUND / NOT_A_PROJECT / AMBIGUOUS_TASK_ID) ride the
// error envelope.
//
// Real Task:-trailer commits ARE the subject, so the trailer-scan tests ride
// the PLANCTL_RUN_SLOW gate (test.skipIf(!SLOW_ENABLED)) under real git. Roots
// discovery is driven through setRoots; the colliding-id tests stand up two real
// projects under one root. The all-repos-broken node is a python_only injection
// (drop) whose AllReposBrokenError -> COMMIT_LOOKUP_FAILED mapping is unit-owned
// by src-git-lookup.test.ts.

import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  firstJsonPayload,
  gitInit,
  parseCliOutput,
  runCli,
  SLOW_ENABLED,
  scaffoldEpic,
  scaffoldPlanYaml,
  setRoots,
  withProject,
  withTmpdir,
} from "./harness.ts";

// Land an empty commit carrying `body` in `repo`; return the full %H. Workers
// land source commits with a plain `git commit` ending in a Task: trailer.
function seedCommit(repo: string, taskId: string, body?: string): string {
  const msg = body ?? `feat: work\n\nTask: ${taskId}\n`;
  const c = Bun.spawnSync(["git", "commit", "--allow-empty", "-F", "-"], {
    cwd: repo,
    stdin: Buffer.from(msg),
  });
  if ((c.exitCode ?? -1) !== 0) {
    throw new Error(`seed commit failed: ${c.stderr.toString()}`);
  }
  const rev = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo });
  return rev.stdout.toString().trim();
}

// The error code off an error envelope.
function errCode(out: string): unknown {
  return (parseCliOutput(out).error as Record<string, unknown>).code;
}

// ---------------------------------------------------------------------------
// Single-task happy path + flatten order + clean miss + prose drop (real git).
// ---------------------------------------------------------------------------

describe("find-task-commit trailer scan", () => {
  const getProj = withProject("planctl-ftc-");

  test.skipIf(!SLOW_ENABLED)(
    "happy path: real Task: trailer -> flat commits:[{sha,repo}]",
    () => {
      // test_find_task_commit.py::test_find_task_commit_happy_path
      const proj = getProj();
      const { taskIds } = scaffoldEpic(proj, { title: "FTC epic", nTasks: 1 });
      const taskId = taskIds[0] as string;
      const sha = seedCommit(proj.root, taskId);

      const r = runCli(["find-task-commit", taskId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      const obj = parseCliOutput(r.output);
      expect(obj.success).toBe(true);
      const commits = obj.commits as Array<Record<string, unknown>>;
      expect(commits).toEqual([{ sha, repo: realpathSync(proj.root) }]);
      expect(new Set(Object.keys(commits[0] as object))).toEqual(
        new Set(["sha", "repo"]),
      );
      expect((commits[0]?.sha as string).length).toBe(40);
      expect((commits[0]?.repo as string).startsWith("/")).toBe(true);
    },
  );

  test.skipIf(!SLOW_ENABLED)(
    "two trailer commits for one task flatten newest-first",
    () => {
      // test_find_task_commit.py::test_find_task_commit_flatten_order
      const proj = getProj();
      const { taskIds } = scaffoldEpic(proj, { title: "FTC epic", nTasks: 1 });
      const taskId = taskIds[0] as string;
      const older = seedCommit(proj.root, taskId);
      const newer = seedCommit(proj.root, taskId);

      const r = runCli(["find-task-commit", taskId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      const repo = realpathSync(proj.root);
      expect(parseCliOutput(r.output).commits as unknown[]).toEqual([
        { sha: newer, repo },
        { sha: older, repo },
      ]);
    },
  );

  test.skipIf(!SLOW_ENABLED)(
    "clean miss -> commits:[], success, exit 0",
    () => {
      // test_find_task_commit.py::test_find_task_commit_clean_miss_empty_success
      const proj = getProj();
      const { taskIds } = scaffoldEpic(proj, { title: "FTC epic", nTasks: 1 });
      const taskId = taskIds[0] as string;
      const r = runCli(["find-task-commit", taskId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      const obj = parseCliOutput(r.output);
      expect(obj.success).toBe(true);
      expect(obj.commits).toEqual([]);
    },
  );

  test.skipIf(!SLOW_ENABLED)(
    "prose Task: mention dropped by the trailer post-filter",
    () => {
      // test_find_task_commit.py::test_find_task_commit_prose_false_match_dropped
      const proj = getProj();
      const { taskIds } = scaffoldEpic(proj, { title: "FTC epic", nTasks: 1 });
      const taskId = taskIds[0] as string;
      seedCommit(
        proj.root,
        taskId,
        `chore: note\n\nfixes the Task: ${taskId} issue in prose\n`,
      );
      const r = runCli(["find-task-commit", taskId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      expect(parseCliOutput(r.output).commits).toEqual([]);
    },
  );

  // test_find_task_commit.py::test_find_task_commit_all_repos_broken
  //   -> DROP (python_only): monkeypatches planctl.store.load_json in-process to
  //      inject an all-broken touched_repos — cannot cross the subprocess
  //      boundary. The AllReposBrokenError -> COMMIT_LOOKUP_FAILED mapping is
  //      unit-owned by src-git-lookup.test.ts
  //      "every repo missing/non-git → AllReposBrokenError".
});

// ---------------------------------------------------------------------------
// Typed input / resolution errors.
// ---------------------------------------------------------------------------

describe("find-task-commit typed errors", () => {
  const getProj = withProject("planctl-ftc-err-");

  test("malformed id -> BAD_TASK_ID, exit 1", () => {
    // test_find_task_commit.py::test_find_task_commit_bad_id
    const proj = getProj();
    const r = runCli(
      ["find-task-commit", "not-a-task-id", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
    expect(errCode(r.output)).toBe("BAD_TASK_ID");
  });

  test("epic id (no .M) -> BAD_TASK_ID", () => {
    // test_find_task_commit.py::test_find_task_commit_epic_id_is_bad_task_id
    const proj = getProj();
    const r = runCli(["find-task-commit", "fn-1-foo", "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("BAD_TASK_ID");
  });

  test("well-formed id, no matching project -> TASK_NOT_FOUND", () => {
    // test_find_task_commit.py::test_find_task_commit_not_found
    const proj = getProj();
    const r = runCli(
      ["find-task-commit", "fn-9999-no-task.1", "--project", proj.root],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("TASK_NOT_FOUND");
  });

  test("--project at a non-project dir -> NOT_A_PROJECT", () => {
    // test_find_task_commit.py::test_find_task_commit_project_not_a_project
    const proj = getProj();
    const notProj = join(proj.root, "not-a-planctl-proj");
    mkdirSync(notProj, { recursive: true });
    const r = runCli(["find-task-commit", "fn-1-foo.1", "--project", notProj], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(errCode(r.output)).toBe("NOT_A_PROJECT");
  });
});

// ---------------------------------------------------------------------------
// --project resolution across a two-project collision (roots discovery).
// ---------------------------------------------------------------------------

describe("find-task-commit --project disambiguation", () => {
  const getRoot = withTmpdir("planctl-ftc-root-");
  const getHome = withTmpdir("planctl-ftc-home-");

  // Stand up two sibling projects under one root, both holding the SAME task id
  // (proj_b's epic+task JSON copied from proj_a, carrying proj_a's resolved
  // primary_repo). Returns {projA, projB, taskId}. Mirrors the pytest helper.
  function twoProjectsSameTask(): {
    projA: string;
    projB: string;
    taskId: string;
  } {
    const root = getRoot();
    const home = getHome();
    const projA = join(root, "proj-a");
    const projB = join(root, "proj-b");
    for (const p of [projA, projB]) {
      mkdirSync(p, { recursive: true });
      gitInit(p);
      const init = runCli(["init"], { cwd: p, home });
      if (init.code !== 0) {
        throw new Error(`init failed in ${p}:\n${init.output}`);
      }
    }
    const planPath = join(projA, "_seed_plan.yaml");
    writeFileSync(
      planPath,
      scaffoldPlanYaml({ title: "A", nTasks: 1 }),
      "utf-8",
    );
    const sc = runCli(["scaffold", "--file", planPath], {
      cwd: projA,
      home,
    });
    if (sc.code !== 0) {
      throw new Error(`scaffold failed:\n${sc.output}`);
    }
    const payload = firstJsonPayload(sc.output);
    const taskId = (payload.task_ids as string[])[0] as string;
    const epicId = payload.epic_id as string;
    // Copy alpha's epic + task JSON into beta so the id collides.
    for (const [sub, name] of [
      ["epics", `${epicId}.json`],
      ["tasks", `${taskId}.json`],
    ] as const) {
      const src = join(projA, ".keeper", sub, name);
      const dst = join(projB, ".keeper", sub, name);
      if (existsSync(src)) {
        mkdirSync(join(dst, ".."), { recursive: true });
        copyFileSync(src, dst);
      }
    }
    setRoots(home, [root]);
    return { projA, projB, taskId };
  }

  test.skipIf(!SLOW_ENABLED)(
    "same id in two projects -> AMBIGUOUS_TASK_ID",
    () => {
      // test_find_task_commit.py::test_find_task_commit_ambiguous
      const { projA, projB, taskId } = twoProjectsSameTask();
      const home = getHome();
      const r = runCli(["find-task-commit", taskId], { cwd: getRoot(), home });
      expect(r.code).not.toBe(0);
      expect(errCode(r.output)).toBe("AMBIGUOUS_TASK_ID");
      const candidates = (
        (parseCliOutput(r.output).error as Record<string, unknown>)
          .details as Record<string, unknown>
      ).candidates as string[];
      expect(candidates.length).toBe(2);
      expect(candidates).toContain(projA);
      expect(candidates).toContain(projB);
    },
  );

  test.skipIf(!SLOW_ENABLED)(
    "--project disambiguates to the seeded commit",
    () => {
      // test_find_task_commit.py::test_find_task_commit_project_disambiguates
      const { projA, projB, taskId } = twoProjectsSameTask();
      const home = getHome();
      const sha = seedCommit(projA, taskId);
      const expected = [{ sha, repo: realpathSync(projA) }];

      const ra = runCli(["find-task-commit", taskId, "--project", projA], {
        cwd: getRoot(),
        home,
      });
      expect(ra.code).toBe(0);
      expect(parseCliOutput(ra.output).commits).toEqual(expected);

      const rb = runCli(["find-task-commit", taskId, "--project", projB], {
        cwd: getRoot(),
        home,
      });
      expect(rb.code).toBe(0);
      expect(parseCliOutput(rb.output).commits).toEqual(expected);
    },
  );
});

// ---------------------------------------------------------------------------
// Read-only contract + readonly invocation footer.
// ---------------------------------------------------------------------------

describe("find-task-commit read-only contract", () => {
  const getProj = withProject("planctl-ftc-ro-");

  test.skipIf(!SLOW_ENABLED)(
    "read-only: HEAD unchanged, no find-task-commit subject",
    () => {
      // test_find_task_commit.py::test_find_task_commit_lands_no_commit
      const proj = getProj();
      const { taskIds } = scaffoldEpic(proj, { title: "FTC epic", nTasks: 1 });
      const taskId = taskIds[0] as string;
      seedCommit(proj.root, taskId);

      const head = () =>
        Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: proj.root })
          .stdout.toString()
          .trim();
      const before = head();
      const r = runCli(["find-task-commit", taskId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      expect(head()).toBe(before);
      const log = Bun.spawnSync(["git", "log", "-5", "--pretty=%s"], {
        cwd: proj.root,
      }).stdout.toString();
      expect(log.includes("find-task-commit")).toBe(false);
    },
  );

  test("envelope carries readonly plan_invocation footer", () => {
    // test_find_task_commit.py::test_find_task_commit_envelope_carries_readonly_invocation
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "FTC epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const r = runCli(["find-task-commit", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    // find-task-commit emits ONE compact line carrying both the payload and the
    // inline plan_invocation footer.
    const inv = parseCliOutput(r.output).plan_invocation as Record<
      string,
      unknown
    >;
    expect(inv).toBeDefined();
    expect(inv.op).toBe("find-task-commit");
    expect(inv.subject).toBeNull();
    expect(inv.files).toBeNull();
  });
});
