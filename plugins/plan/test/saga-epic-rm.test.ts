// Engine-agnostic conformance spec for `planctl epic rm` — translated from
// tests/test_epic_rm.py, every node mapped by a source-comment. The delete verb:
// the full-artifact-set unlink + auto-commit lands the deletions in HEAD (the
// _record_touched-before-unlink load-bearing assertion), --dry-run writes nothing,
// the in_progress guard + --force override, missing-id / traversal-guard clean
// errors, ambiguous-id-across-roots + --project disambiguation, and dependents
// surfaced as a non-blocking warning.
//
// Fixtures use the fake VCS seam, so deletion and commit assertions remain
// deterministic and process-free.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  firstJsonPayload,
  gitBaseline,
  gitFilesInHead,
  gitHeadMessage,
  gitInit,
  gitLogCount,
  type ProjectHandle,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  seedRuntime,
  seedState,
  setRoots,
  withProject,
} from "./harness.ts";

let project: ProjectHandle;
const getProject = withProject("planctl-epic-rm-");
beforeEach(() => {
  project = getProject();
});

function run(args: string[], env?: Record<string, string>) {
  return runCli(args, { cwd: project.root, home: project.home, env });
}

function artifact(...parts: string[]): string {
  return join(project.root, ".keeper", ...parts);
}

function _setEpicTouchedRepos(epicId: string, repos: string[]): void {
  const path = artifact("epics", `${epicId}.json`);
  const data = JSON.parse(readFileSync(path, "utf-8")) as Record<
    string,
    unknown
  >;
  data.touched_repos = repos;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

// Tolerant payload parser mirroring the Python _invoke: read verbs (dry-run /
// error envelopes) emit multi-line pretty JSON, mutating verbs single-line
// NDJSON. parseCliOutput handles the multi-line shape; fall back to the
// single-line scan for compact envelopes parseCliOutput trips on.
function payload(output: string): Record<string, unknown> {
  try {
    return parseCliOutput(output);
  } catch {
    return firstJsonPayload(output);
  }
}

// ---------------------------------------------------------------------------
// Happy path: full artifact set unlinked AND the auto-commit lands it
// ---------------------------------------------------------------------------

describe("epic rm happy path", () => {
  test("unlinks the full artifact set + commits the deletions", () => {
    // test_epic_rm.py::test_rm_unlinks_full_artifact_set_and_commits
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 2 });
    expect(taskIds.length).toBe(2);

    const epicJson = artifact("epics", `${epicId}.json`);
    const epicSpec = artifact("specs", `${epicId}.md`);
    const taskJsons = taskIds.map((t) => artifact("tasks", `${t}.json`));
    const taskSpecs = taskIds.map((t) => artifact("specs", `${t}.md`));
    for (const p of [epicJson, epicSpec, ...taskJsons, ...taskSpecs]) {
      expect(existsSync(p)).toBe(true);
    }

    // Plant a runtime state file for one task to exercise the state cleanup.
    const stateFile = artifact("state", "tasks", `${taskIds[0]}.state.json`);
    mkdirSync(join(stateFile, ".."), { recursive: true });
    writeFileSync(stateFile, '{"status": "todo"}\n', "utf-8");

    const r = run(["epic", "rm", epicId]);
    expect(r.code).toBe(0);
    const obj = payload(r.output);
    expect(obj.success).toBe(true);
    expect(obj.epic_id).toBe(epicId);
    expect(obj.task_count).toBe(taskIds.length);
    expect(obj.torn_down_lanes).toEqual([]);
    expect(obj.skipped_lanes).toEqual([]);

    for (const p of [
      epicJson,
      epicSpec,
      ...taskJsons,
      ...taskSpecs,
      stateFile,
    ]) {
      expect(existsSync(p)).toBe(false);
    }

    // The auto-commit landed the deletions in HEAD (not an empty commit).
    const headFiles = gitFilesInHead(project.root);
    expect(headFiles).toContain(`.keeper/epics/${epicId}.json`);
    for (const t of taskIds) {
      expect(headFiles).toContain(`.keeper/tasks/${t}.json`);
      expect(headFiles).toContain(`.keeper/specs/${t}.md`);
    }

    expect(gitHeadMessage(project.root).split("\n")[0]).toBe(
      `chore(plan): rm ${epicId}`,
    );
    const inv = (obj.plan_invocation ?? {}) as Record<string, unknown>;
    expect(inv.op).toBe("rm");
    expect(inv.target).toBe(epicId);
  });

  // test_rm_registered_in_verb_templates — CITED: the bun buildSubject is
  //   template-free (no per-verb whitelist) and the happy-path subject assertion
  //   above pins `chore(plan): rm <id>`; the Python node imports VERB_TEMPLATES
  //   (python_only in-process surface).
});

// ---------------------------------------------------------------------------
// --dry-run: writes nothing
// ---------------------------------------------------------------------------

describe("epic rm --dry-run", () => {
  test("previews the unlink set without deleting or committing", () => {
    // test_epic_rm.py::test_rm_dry_run_writes_nothing
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    const epicJson = artifact("epics", `${epicId}.json`);
    const taskJson = artifact("tasks", `${taskIds[0]}.json`);

    const logBefore = gitLogCount(project.root);
    const r = run(["epic", "rm", epicId, "--dry-run"]);
    expect(r.code).toBe(0);
    const obj = payload(r.output);
    expect(obj.dry_run).toBe(true);
    const rels = obj.removed_files as string[];
    expect(rels).toContain(`.keeper/epics/${epicId}.json`);
    expect(rels).toContain(`.keeper/tasks/${taskIds[0]}.json`);
    expect(obj.torn_down_lanes).toEqual([]);
    expect(obj.skipped_lanes).toEqual([]);

    expect(existsSync(epicJson)).toBe(true);
    expect(existsSync(taskJson)).toBe(true);
    expect(gitLogCount(project.root)).toBe(logBefore);
  });
});

// ---------------------------------------------------------------------------
// Worktree lane teardown
// ---------------------------------------------------------------------------

describe("epic rm in_progress guard", () => {
  function plantInProgress(taskId: string): void {
    const dir = artifact("state", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${taskId}.state.json`),
      '{"status": "in_progress"}\n',
      "utf-8",
    );
  }

  test("an in_progress task blocks rm without --force", () => {
    // test_epic_rm.py::test_rm_blocked_by_in_progress_without_force
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    plantInProgress(taskIds[0] as string);

    const r = run(["epic", "rm", epicId]);
    expect(r.code).not.toBe(0);
    const obj = payload(r.output);
    expect(obj.success).toBe(false);
    expect(obj.error as string).toContain("in_progress");
    expect(obj.error as string).toContain("--force");
    expect(existsSync(artifact("epics", `${epicId}.json`))).toBe(true);
  });

  test("--force skips the live-work check and deletes", () => {
    // test_epic_rm.py::test_rm_force_overrides_in_progress_guard
    const { epicId, taskIds } = scaffoldEpic(project, { nTasks: 1 });
    plantInProgress(taskIds[0] as string);

    const r = run(["epic", "rm", epicId, "--force"]);
    expect(r.code).toBe(0);
    expect(payload(r.output).success).toBe(true);
    expect(existsSync(artifact("epics", `${epicId}.json`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Missing epic / traversal guard
// ---------------------------------------------------------------------------

describe("epic rm input guards", () => {
  test("missing id yields a clean error, not a crash", () => {
    // test_epic_rm.py::test_rm_missing_epic_clean_error
    const r = run(["epic", "rm", "fn-9999-nope"]);
    expect(r.code).not.toBe(0);
    const obj = payload(r.output);
    expect(obj.success).toBe(false);
    expect(obj.error as string).toContain("fn-9999-nope");
  });

  test("a traversal id is rejected before any glob", () => {
    // test_epic_rm.py::test_rm_traversal_guard_rejects_bad_id
    const r = run(["epic", "rm", "../escape"]);
    expect(r.code).not.toBe(0);
    const obj = payload(r.output);
    expect(obj.success).toBe(false);
    expect(obj.error as string).toContain("Invalid epic id");
  });
});

// ---------------------------------------------------------------------------
// Ambiguous resolution + --project escape (two projects under a shared root)
// ---------------------------------------------------------------------------

describe("epic rm ambiguous resolution", () => {
  // Two sibling planctl projects under a shared roots parent, both forced to
  // carry the SAME epic id. Returns the parent, both project roots, the shared
  // HOME the roots config lives under, and the duplicated id. Port of the
  // Two independent fake-VCS project roots share a deterministic home.
  let parent: string;
  let projA: string;
  let projB: string;
  let sharedHome: string;
  let dupId: string;

  beforeEach(() => {
    parent = realpathSync(mkdtempSync(join(tmpdir(), "planctl-rm-roots-")));
    sharedHome = realpathSync(mkdtempSync(join(tmpdir(), "planctl-rm-home-")));
    projA = join(parent, "proj_a");
    projB = join(parent, "proj_b");
    for (const p of [projA, projB]) {
      mkdirSync(p, { recursive: true });
      gitInit(p);
    }
    // proj_a is a convention-dir (`.keeper/`) project via init + scaffold.
    const initA = runCli(["init"], { cwd: projA, home: sharedHome });
    expect(initA.code).toBe(0);

    // Seed an epic in proj_a via scaffold, then force the SAME id onto proj_b's
    // disk (the legacy-dup scenario the resolver refuses to silently pick).
    const a = scaffoldEpic(
      { root: projA, home: sharedHome },
      {
        title: "Ambiguous epic",
      },
    );
    dupId = a.epicId;
    // Materialise the dup directly on proj_b's disk (CLI-free), byte-faithful.
    // seedState builds the `.keeper/` tree, so proj_b resolves the same id —
    // exercising an ambiguous same-id board pair.
    seedState(projB, { epicId: dupId, title: "Ambiguous epic", nTasks: 1 });

    setRoots(sharedHome, [parent]);
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
    rmSync(sharedHome, { recursive: true, force: true });
  });

  test("an id in two projects hard-errors listing both owners", () => {
    // test_epic_rm.py::test_rm_ambiguous_id_errors_with_owners
    // Run from OUTSIDE either project so the cwd short-circuit doesn't pick one.
    const r = runCli(["epic", "rm", dupId], {
      cwd: join(parent, ".."),
      home: sharedHome,
    });
    expect(r.code).not.toBe(0);
    const obj = payload(r.output);
    expect(obj.success).toBe(false);
    expect(obj.error as string).toContain("multiple projects");
    expect(obj.error as string).toContain("--project");
    expect(
      (obj.error as string).includes(projA) ||
        (obj.error as string).includes(projB),
    ).toBe(true);

    expect(existsSync(join(projA, ".keeper", "epics", `${dupId}.json`))).toBe(
      true,
    );
    expect(existsSync(join(projB, ".keeper", "epics", `${dupId}.json`))).toBe(
      true,
    );
  });

  test("--project disambiguates the owning project", () => {
    // test_epic_rm.py::test_rm_project_flag_disambiguates
    const r = runCli(["epic", "rm", dupId, "--project", projA], {
      cwd: join(parent, ".."),
      home: sharedHome,
    });
    expect(r.code).toBe(0);
    expect(payload(r.output).success).toBe(true);

    expect(existsSync(join(projA, ".keeper", "epics", `${dupId}.json`))).toBe(
      false,
    );
    expect(existsSync(join(projB, ".keeper", "epics", `${dupId}.json`))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Dependents surfaced as a non-blocking warning
// ---------------------------------------------------------------------------

describe("epic rm dependents", () => {
  test("a depended-on epic is still removable; dependents surface as a warning", () => {
    // test_epic_rm.py::test_rm_surfaces_dependents_as_warning_not_blocker
    const target = scaffoldEpic(project, { title: "Target" });
    const dependent = scaffoldEpic(project, { title: "Dependent" });
    // Wire dependent -> target via the real verb (keeps the tree clean for the
    // auto-commit; the Python file hand-edited + manually committed).
    const wire = run(["epic", "add-dep", dependent.epicId, target.epicId]);
    expect(wire.code).toBe(0);

    const r = run(["epic", "rm", target.epicId]);
    expect(r.code).toBe(0);
    const obj = payload(r.output);
    expect(obj.success).toBe(true);
    expect(obj.dependents as string[]).toContain(dependent.epicId);
    expect((obj.warnings as string[]).length).toBeGreaterThan(0);
    expect(
      (obj.warnings as string[]).some((w) => w.includes(dependent.epicId)),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lane routing: a destructive rm run from a worktree lane (no --project) targets
// PRIMARY's artifacts via resolvePlanStateContext, never the lane's checked-out
// defs (which would orphan primary's state). The lane is a sibling dir holding
// ONLY the committed defs (state/ stripped) — what a worktree checkout sees.
// ---------------------------------------------------------------------------

describe("epic rm resolves the destructive op to primary from a lane", () => {
  const created: string[] = [];
  afterEach(() => {
    for (const dir of created) {
      rmSync(dir, { recursive: true, force: true });
    }
    created.length = 0;
  });
  function freshDir(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    created.push(dir);
    return dir;
  }

  test("rm-from-lane deletes PRIMARY's artifacts, never the lane's defs", () => {
    const primary = freshDir("planctl-erm-lane-primary-");
    const lane = freshDir("planctl-erm-lane-lane-");
    const home = freshDir("planctl-erm-lane-home-");
    const epicId = "fn-1-demo";

    const [, taskIds] = seedState(primary, {
      epicId,
      nTasks: 1,
      primaryRepo: primary,
    });
    const taskId = taskIds[0] as string;
    seedRuntime(primary, taskId, { status: "todo" });
    // Adopt primary's committed defs as the baseline so the deletions register
    // as a real commit (not an untracked-file no-op).
    gitBaseline(primary);

    // The lane carries the committed defs only — state/ is gitignored, absent.
    seedState(lane, { epicId, nTasks: 1, primaryRepo: primary });
    rmSync(join(lane, ".keeper", "state"), { recursive: true, force: true });
    gitBaseline(lane);

    const r = runCli(["epic", "rm", epicId], {
      cwd: lane,
      home,
      env: { CLAUDE_CODE_SESSION_ID: "test-epic-rm-lane" },
    });
    expect(r.code).toBe(0);
    expect(payload(r.output).success).toBe(true);

    // PRIMARY's full artifact set is gone...
    expect(
      existsSync(join(primary, ".keeper", "epics", `${epicId}.json`)),
    ).toBe(false);
    expect(
      existsSync(join(primary, ".keeper", "tasks", `${taskId}.json`)),
    ).toBe(false);
    expect(
      existsSync(
        join(primary, ".keeper", "state", "tasks", `${taskId}.state.json`),
      ),
    ).toBe(false);
    // ...while the lane's checked-out defs were never touched.
    expect(existsSync(join(lane, ".keeper", "epics", `${epicId}.json`))).toBe(
      true,
    );
    expect(existsSync(join(lane, ".keeper", "tasks", `${taskId}.json`))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Missing session id routes through the emit seam
// ---------------------------------------------------------------------------

describe("epic rm seam", () => {
  test("missing CLAUDE_CODE_SESSION_ID surfaces a failure from the seam", () => {
    // test_epic_rm.py::test_rm_missing_session_id_routes_through_seam
    const { epicId } = scaffoldEpic(project, { nTasks: 1 });
    expect(existsSync(artifact("epics", `${epicId}.json`))).toBe(true);

    const r = run(["epic", "rm", epicId], { CLAUDE_CODE_SESSION_ID: "" });
    expect(r.code).not.toBe(0);
  });

  // test_rm_commit_failure_emits_structured_envelope — DROP (python_only):
  //   monkeypatches auto_commit_from_invocation to raise — an in-process fault
  //   injection a conformance subprocess can't observe.
  // test_rm_no_lock_nesting — DROP (python_only): spies _git_commit /
  //   _epic_id_lock in-process internals (no-id-lock structural assertion).
});
