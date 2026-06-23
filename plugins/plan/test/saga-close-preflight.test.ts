// Conformance spec for `planctl close-preflight <epic_id>` — the close-phase
// brief handoff, translated from tests/test_close_preflight.py, every node
// mapped by a source-comment (translated | cited | drop-with-reason).
//
// The verb assembles the audit brief (source commit groups, ordinal task list +
// done summaries, the canonical commit_set_hash), persists it commit-free under
// gitignored audits/<epic_id>/brief.json, and emits a content-blind envelope
// {primary_repo, tasks, all_done, brief_ref, commit_set_hash} — commit_groups
// prose lives ONLY in the brief. The verb-level tests drive the real binary in a
// withProject repo; the trailer-scan tests ride the KEEPER_PLAN_RUN_SLOW gate.
//
// The TestCommitLookup unit class targets the shared commit_lookup.findCommitGroups
// seam directly. Variants already pinned by src-git-lookup.test.ts are CITED;
// the variants it does not cover (is_task_id gate, multi-valued keys, sha dedup,
// touched_repos tri-state, first-seen order, one-broken-skip) translate here as
// direct findCommitGroups unit tests (a new file, not an extension of the
// citation target). The all-repos-broken verb path is python_only (drop).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { briefPath, computeCommitSetHash } from "../src/audit_artifacts.ts";
import { AllReposBrokenError, findCommitGroups } from "../src/commit_lookup.ts";
import {
  parseCliOutput,
  runCli,
  SLOW_ENABLED,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

function git(args: string[], cwd: string): string {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  if ((p.exitCode ?? -1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${p.stderr.toString()}`);
  }
  return p.stdout.toString().trim();
}

// Land an empty commit carrying `body`; return the full sha.
function seedCommit(repo: string, taskId: string, body?: string): string {
  const msg = body ?? `feat: work\n\nTask: ${taskId}\n`;
  const c = Bun.spawnSync(["git", "commit", "--allow-empty", "-F", "-"], {
    cwd: repo,
    stdin: Buffer.from(msg),
  });
  if ((c.exitCode ?? -1) !== 0) {
    throw new Error(`seed commit failed: ${c.stderr.toString()}`);
  }
  return git(["rev-parse", "HEAD"], repo);
}

// Scaffold an epic with N tasks, driving `statuses[i] === "done"` to done.
function makeEpic(
  proj: { root: string; home: string },
  statuses: string[],
): { epicId: string; taskIds: string[] } {
  const { epicId, taskIds } = scaffoldEpic(
    { root: proj.root, home: proj.home },
    { title: "Demo epic", nTasks: statuses.length },
  );
  statuses.forEach((status, i) => {
    if (status === "done") {
      const tid = taskIds[i] as string;
      const r = runCli(
        ["done", tid, "--summary", `summary for ${tid}`, "--force"],
        {
          cwd: proj.root,
          home: proj.home,
        },
      );
      if (r.code !== 0) {
        throw new Error(`done failed for ${tid}:\n${r.output}`);
      }
    }
  });
  return { epicId, taskIds };
}

function loadBrief(root: string, epicId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(briefPath(root, epicId), "utf-8"));
}

// ---------------------------------------------------------------------------
// Success envelope + brief shape.
// ---------------------------------------------------------------------------

describe("close-preflight success envelope + brief", () => {
  const getProj = withProject("planctl-cpf-");

  test("envelope is content-blind (handle + hash, no prose)", () => {
    // test_close_preflight.py::TestSuccessEnvelope::test_envelope_is_content_blind
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.all_done).toBe(true);
    expect(env.brief_ref).toBe(briefPath(proj.root, epicId));
    expect(typeof env.commit_set_hash).toBe("string");
    expect(env.commit_set_hash).toBeTruthy();
    const tasks = env.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    expect(tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect("snippet_context" in env).toBe(false);
    expect("commit_groups" in env).toBe(false);
  });

  test("envelope hash matches the brief's hash (canonical over groups)", () => {
    // test_close_preflight.py::TestSuccessEnvelope::test_envelope_hash_matches_brief
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    const brief = loadBrief(proj.root, epicId);
    expect(env.commit_set_hash).toBe(brief.commit_set_hash);
    expect(brief.commit_set_hash).toBe(
      computeCommitSetHash(brief.commit_groups as never),
    );
  });

  test("brief carries the full shape (schema, repo, tasks, done summaries)", () => {
    // test_close_preflight.py::TestBriefShape::test_brief_has_full_shape
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const brief = loadBrief(proj.root, epicId);
    expect(brief.schema_version).toBe(1);
    expect(brief.epic_id).toBe(epicId);
    expect(brief.primary_repo).toBe(realpathSync(proj.root));
    expect(brief.snippet_context).toBe("");
    expect(brief.commit_groups).toEqual([]);
    const tasks = brief.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    expect(tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect(tasks[0]?.done_summary).toBe(`summary for ${taskIds[0]}`);
    expect(tasks[1]?.done_summary).toBe(`summary for ${taskIds[1]}`);
  });

  test("brief carries per-task target_repo + epic touched_repos (the close-planner repo map)", () => {
    // The close-planner routes each follow-up task by these fields. Scaffold
    // resolves an omitted per-task target_repo to the epic primary, so a
    // single-repo source carries the realpath-normalized primary on every task
    // and touched_repos = [primary].
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const brief = loadBrief(proj.root, epicId);
    const primary = realpathSync(proj.root);
    expect(brief.touched_repos).toEqual([primary]);
    const tasks = brief.tasks as Array<Record<string, unknown>>;
    expect(tasks.map((t) => t.id)).toEqual(taskIds);
    for (const t of tasks) {
      expect("target_repo" in t).toBe(true);
      expect(t.target_repo).toBe(primary);
    }
  });

  test.skipIf(!SLOW_ENABLED)(
    "brief write is commit-free: HEAD unmoved, nothing tracked",
    () => {
      // test_close_preflight.py::TestBriefShape::test_brief_no_commit_lands
      const proj = getProj();
      const { epicId } = makeEpic(proj, ["done"]);
      const before = git(["rev-parse", "HEAD"], proj.root);
      const r = runCli(["close-preflight", epicId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      expect(git(["rev-parse", "HEAD"], proj.root)).toBe(before);
      const porcelain = Bun.spawnSync(["git", "status", "--porcelain"], {
        cwd: proj.root,
      }).stdout.toString();
      expect(porcelain.includes(".keeper/state/audits")).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// all_done false → TASKS_NOT_DONE; no brief written.
// ---------------------------------------------------------------------------

describe("close-preflight tasks-not-done", () => {
  const getProj = withProject("planctl-cpf-nd-");

  test("not all done -> TASKS_NOT_DONE naming the not_done set", () => {
    // test_close_preflight.py::TestTasksNotDone::test_not_all_done_is_typed_error
    const proj = getProj();
    const { epicId, taskIds } = makeEpic(proj, ["done", "todo"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(1);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(false);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("TASKS_NOT_DONE");
    expect((error.details as Record<string, unknown>).not_done).toEqual([
      taskIds[1],
    ]);
  });

  test("a not-ready epic leaves no stale brief on disk", () => {
    // test_close_preflight.py::TestTasksNotDone::test_not_done_writes_no_brief
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["todo"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(1);
    expect(existsSync(briefPath(proj.root, epicId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// commit_groups inside the brief (verb-level, real git).
// ---------------------------------------------------------------------------

describe("close-preflight commit_groups", () => {
  const getProj = withProject("planctl-cpf-cg-");

  test("no seeded commits -> empty commit set", () => {
    // test_close_preflight.py::TestCommitGroups::test_empty_commit_set
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    const r = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(loadBrief(proj.root, epicId).commit_groups).toEqual([]);
  });

  test.skipIf(!SLOW_ENABLED)(
    "native scan groups both tasks' real commits in primary",
    () => {
      // test_close_preflight.py::TestCommitGroups::test_groups_real_commits_in_primary_repo
      const proj = getProj();
      const { epicId, taskIds } = makeEpic(proj, ["done", "done"]);
      const sha0 = seedCommit(proj.root, taskIds[0] as string);
      const sha1 = seedCommit(proj.root, taskIds[1] as string);
      const r = runCli(["close-preflight", epicId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      const env = parseCliOutput(r.output);
      const brief = loadBrief(proj.root, epicId);
      const primary = realpathSync(proj.root);
      expect(brief.commit_groups).toEqual([
        { repo: primary, shas: [sha0, sha1] },
      ]);
      expect(env.commit_set_hash).toBe(
        computeCommitSetHash(brief.commit_groups as never),
      );
    },
  );

  test.skipIf(!SLOW_ENABLED)(
    "prose Task: mention dropped by the post-filter",
    () => {
      // test_close_preflight.py::TestCommitGroups::test_prose_false_match_is_dropped
      const proj = getProj();
      const { epicId, taskIds } = makeEpic(proj, ["done"]);
      seedCommit(
        proj.root,
        taskIds[0] as string,
        `chore: note\n\nfixes the Task: ${taskIds[0]} issue in prose\n`,
      );
      const r = runCli(["close-preflight", epicId, "--project", proj.root], {
        cwd: proj.root,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      expect(loadBrief(proj.root, epicId).commit_groups).toEqual([]);
    },
  );

  // test_close_preflight.py::TestCommitGroups::test_all_repos_broken_is_fail_loud
  //   -> DROP (python_only): monkeypatches planctl.api.load_epic in-process to
  //      inject an all-broken touched_repos — cannot cross the subprocess
  //      boundary. The AllReposBrokenError -> COMMIT_LOOKUP_FAILED path is
  //      covered by the direct AllReposBrokenError unit below + the verb's
  //      typed-error mapping shared across engines.
});

// ---------------------------------------------------------------------------
// id / existence gates.
// ---------------------------------------------------------------------------

describe("close-preflight gates", () => {
  const getProj = withProject("planctl-cpf-gate-");

  test("malformed id -> BAD_EPIC_ID", () => {
    // test_close_preflight.py::TestGates::test_bad_epic_id
    const proj = getProj();
    const r = runCli(["close-preflight", "not-an-id", "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("BAD_EPIC_ID");
  });

  test("task-shaped id -> BAD_EPIC_ID pointing at the parent epic", () => {
    // test_close_preflight.py::TestGates::test_task_id_names_parent_epic
    const proj = getProj();
    const r = runCli(
      ["close-preflight", "fn-1-demo.2", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(1);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).toBe("BAD_EPIC_ID");
    expect((error.message as string).includes("fn-1-demo")).toBe(true);
    const details = error.details as Record<string, unknown>;
    expect(details.parent_epic).toBe("fn-1-demo");
    expect(details.task_id).toBe("fn-1-demo.2");
  });

  test("unknown epic -> EPIC_NOT_FOUND", () => {
    // test_close_preflight.py::TestGates::test_epic_not_found
    const proj = getProj();
    const r = runCli(
      ["close-preflight", "fn-99-missing", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("EPIC_NOT_FOUND");
  });

  // test_close_preflight.py::test_run_directly_no_click_context
  //   -> DROP (python_only-shaped): calls run_close_preflight.run(SimpleNamespace)
  //      directly to exercise the no-click-context sentinel no-op — an in-process
  //      direct-call seam with no CLI subprocess analogue; the bun verb has no
  //      click-context coupling (the success path is the same code the
  //      CLI tests above already drive end-to-end).
});

// ---------------------------------------------------------------------------
// --project resolution.
// ---------------------------------------------------------------------------

describe("close-preflight --project flag", () => {
  const getProj = withProject("planctl-cpf-proj-");

  test("--project resolves from outside cwd", () => {
    // test_close_preflight.py::TestProjectFlag::test_project_resolves_from_outside_cwd
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    // cwd is an unrelated dir; --project carries the resolution.
    const elsewhere = mkdtempSync(join(tmpdir(), "planctl-cpf-elsewhere-"));
    try {
      const r = runCli(["close-preflight", epicId, "--project", proj.root], {
        cwd: elsewhere,
        home: proj.home,
      });
      expect(r.code).toBe(0);
      const env = parseCliOutput(r.output);
      expect(env.success).toBe(true);
      expect("brief_ref" in env).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test("relative --project -> usage error (exit 2)", () => {
    // test_close_preflight.py::TestProjectFlag::test_project_relative_raises_usage_error
    const proj = getProj();
    const r = runCli(
      ["close-preflight", "fn-1-bogus", "--project", "relative/path"],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).toBe(2);
    expect(r.output.includes("absolute path")).toBe(true);
  });

  test("--project unset falls back to cwd-walk", () => {
    // test_close_preflight.py::TestProjectFlag::test_project_unset_falls_back_to_cwd_walk
    const proj = getProj();
    const { epicId } = makeEpic(proj, ["done"]);
    const r = runCli(["close-preflight", epicId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).success).toBe(true);
  });

  test("tilde --project from non-project cwd: no spurious missing-project error", () => {
    // Regression for the trailer/verb tilde disagreement: trailerProjectRoot
    // must expandUser the flag before its absolute check, matching the verb, so
    // a `~`-form --project from an outside cwd resolves through the project root
    // and the read-only trailer never re-resolves from cwd into a missing-project
    // error envelope.
    const proj = getProj();
    // A project under the binary's HOME, so a `~/<name>` --project resolves to it.
    const projName = "tilde-cpf-proj";
    const tildeRoot = join(proj.home, projName);
    mkdirSync(tildeRoot, { recursive: true });
    git(["init", "-q"], tildeRoot);
    git(["config", "user.email", "t@p.local"], tildeRoot);
    git(["config", "user.name", "T"], tildeRoot);
    git(["config", "commit.gpgsign", "false"], tildeRoot);
    const initRes = runCli(["init"], { cwd: tildeRoot, home: proj.home });
    expect(initRes.code).toBe(0);
    const { epicId } = makeEpic({ root: tildeRoot, home: proj.home }, ["done"]);

    // cwd is an unrelated, non-project dir; only the tilde --project carries it.
    const elsewhere = mkdtempSync(
      join(tmpdir(), "planctl-cpf-tilde-elsewhere-"),
    );
    try {
      const r = runCli(
        ["close-preflight", epicId, "--project", `~/${projName}`],
        { cwd: elsewhere, home: proj.home },
      );
      expect(r.code).toBe(0);
      expect(r.output.includes("No planctl project found")).toBe(false);
      const env = parseCliOutput(r.output);
      expect(env.success).toBe(true);
      expect("brief_ref" in env).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Direct findCommitGroups unit coverage — the variants src-git-lookup.test.ts
// does not pin. (CITED variants: clean-miss, prose-drop, touched_repos=[],
// all-broken-raises, first-flatten-order — owned by src-git-lookup.test.ts.)
// ---------------------------------------------------------------------------

describe("findCommitGroups unit (test_close_preflight.py TestCommitLookup)", () => {
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "planctl-cpf-lookup-")));
  });
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function gitRepo(name: string): string {
    const p = join(repoRoot, name);
    mkdirSync(p, { recursive: true });
    git(["init", "-q"], p);
    git(["config", "user.email", "t@p.local"], p);
    git(["config", "user.name", "T"], p);
    git(["config", "commit.gpgsign", "false"], p);
    return realpathSync(p);
  }

  // test_close_preflight.py::TestCommitLookup::test_clean_miss_returns_empty
  //   -> CITED src-git-lookup.test.ts findCommitGroups "clean miss → empty result"
  // test_close_preflight.py::TestCommitLookup::test_prose_false_match_dropped_by_post_filter
  //   -> CITED src-git-lookup.test.ts findCommitGroups
  //      "a prose Task: mention is dropped by the trailer post-filter"

  test("is_task_id gate: a confirmed trailer whose value is an epic id never matches", () => {
    // test_close_preflight.py::TestCommitLookup::test_is_task_id_rejected_trailer_value_dropped
    const repo = gitRepo("r");
    seedCommit(repo, "fn-1-foo", "feat: x\n\nTask: fn-1-foo\n");
    expect(findCommitGroups(["fn-1-foo"], repo, null)).toEqual([]);
  });

  test("multi-valued Task: trailers — each task query finds the shared commit", () => {
    // test_close_preflight.py::TestCommitLookup::test_multi_valued_task_keys
    const repo = gitRepo("r");
    const sha = seedCommit(
      repo,
      "fn-1-foo.1",
      "feat: x\n\nTask: fn-1-foo.1\nTask: fn-1-foo.2\n",
    );
    expect(findCommitGroups(["fn-1-foo.1", "fn-1-foo.2"], repo, null)).toEqual([
      { repo, shas: [sha] },
    ]);
  });

  test("sha dedup within a repo (duplicate trailer for the same task)", () => {
    // test_close_preflight.py::TestCommitLookup::test_sha_dedup_within_repo
    const repo = gitRepo("r");
    const sha = seedCommit(
      repo,
      "fn-1-foo.1",
      "feat: x\n\nTask: fn-1-foo.1\nTask: fn-1-foo.1\n",
    );
    expect(findCommitGroups(["fn-1-foo.1"], repo, null)).toEqual([
      { repo, shas: [sha] },
    ]);
  });

  test("touched_repos=null scans primary", () => {
    // test_close_preflight.py::TestCommitLookup::test_touched_repos_none_scans_primary
    const primary = gitRepo("primary");
    const sha = seedCommit(primary, "fn-1-foo.1");
    expect(findCommitGroups(["fn-1-foo.1"], primary, null)).toEqual([
      { repo: primary, shas: [sha] },
    ]);
  });

  // test_close_preflight.py::TestCommitLookup::test_touched_repos_empty_scans_nothing
  //   -> CITED src-git-lookup.test.ts findCommitGroups "touched_repos=[] returns []"

  test("touched_repos first-seen order (not discovery order)", () => {
    // test_close_preflight.py::TestCommitLookup::test_touched_repos_first_seen_order
    const repoB = gitRepo("b");
    const repoA = gitRepo("a");
    const shaB = seedCommit(repoB, "fn-1-foo.1");
    const shaA = seedCommit(repoA, "fn-1-foo.1");
    expect(findCommitGroups(["fn-1-foo.1"], repoA, [repoB, repoA])).toEqual([
      { repo: repoB, shas: [shaB] },
      { repo: repoA, shas: [shaA] },
    ]);
  });

  test("one broken repo is skipped; the good repo still yields its group", () => {
    // test_close_preflight.py::TestCommitLookup::test_one_broken_repo_is_skipped
    const good = gitRepo("good");
    const broken = join(repoRoot, "broken");
    mkdirSync(broken, { recursive: true });
    const sha = seedCommit(good, "fn-1-foo.1");
    expect(
      findCommitGroups(["fn-1-foo.1"], good, [realpathSync(broken), good]),
    ).toEqual([{ repo: good, shas: [sha] }]);
  });

  test("all repos broken -> AllReposBrokenError with broken_repos", () => {
    // test_close_preflight.py::TestCommitLookup::test_all_repos_broken_raises
    //   (the raise itself is also CITED src-git-lookup.test.ts "every repo
    //    missing/non-git → AllReposBrokenError"; the broken_repos accessor is
    //    pinned here)
    const missing = join(repoRoot, "missing");
    const notGit = join(repoRoot, "not-git");
    mkdirSync(notGit, { recursive: true });
    let caught: AllReposBrokenError | null = null;
    try {
      findCommitGroups(["fn-1-foo.1"], missing, [missing, notGit]);
    } catch (e) {
      caught = e as AllReposBrokenError;
    }
    expect(caught).toBeInstanceOf(AllReposBrokenError);
    expect((caught as AllReposBrokenError).brokenRepos).toEqual([
      missing,
      realpathSync(notGit),
    ]);
  });
});
