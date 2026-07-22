// Regression spec for cross-repo id-addressed verb resolution (fn-882). The
// id-addressed verbs — done / show / cat / refine-context — resolve a globally-
// unique id cwd-THEN-global, so a worker whose cwd is a non-owning repo can
// stamp / read a task or epic owned by ANOTHER repo's plan board. This is the
// fn-879 failure made impossible: an arthack-cwd worker stamping a keeper-owned
// task done. The stamp lands in the OWNING project's store, never the cwd one.
//
// Each test stands up >=2 git+init'd projects under one shared root, points the
// binary's roots config at that root, and invokes from a chosen cwd so the
// resolver's cwd-then-global branch is exercised end to end through the compiled
// binary (the same subprocess seam cross-project-deps.test.ts uses).

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CliResult,
  firstJsonPayload,
  gitInit,
  gitLogCount,
  parseCliOutput,
  runCli,
  scaffoldPlanYaml,
  setRoots,
  withTmpdir,
} from "./harness.ts";

const SID = { CLAUDE_CODE_SESSION_ID: "test-cross-repo-fixture" };

interface MultiRepo {
  root: string;
  home: string;
  projects: Record<string, string>; // name -> abs path
}

/** Stand up *names* git+init'd planctl projects under one shared root, roots
 * config pointed at that root. Same shape as cross-project-deps' multiRepo. */
function multiRepo(
  getRoot: () => string,
  getHome: () => string,
  names: string[],
): MultiRepo {
  const root = getRoot();
  const home = getHome();
  const projects: Record<string, string> = {};
  for (const name of names) {
    const proj = join(root, name);
    mkdirSync(proj, { recursive: true });
    gitInit(proj);
    const init = runCli(["init"], { cwd: proj, home, env: SID });
    if (init.code !== 0) {
      throw new Error(`init failed in ${proj}:\n${init.output}`);
    }
    projects[name] = proj;
  }
  setRoots(home, [root]);
  return { root, home, projects };
}

/** Scaffold a one-task epic inside *proj*; returns {epicId, taskId}. Distinct
 * titles avoid scaffold's duplicate-slug sibling guard. */
function seedEpicIn(
  mr: MultiRepo,
  proj: string,
  title: string,
): { epicId: string; taskId: string } {
  const planPath = join(proj, `_plan-${title.replace(/\W+/g, "-")}.yaml`);
  writeFileSync(planPath, scaffoldPlanYaml({ title, nTasks: 1 }), "utf-8");
  const r = runCli(["scaffold", "--file", planPath], {
    cwd: proj,
    home: mr.home,
    env: SID,
  });
  if (r.code !== 0) {
    throw new Error(`scaffold failed in ${proj}:\n${r.output}`);
  }
  const payload = firstJsonPayload(r.output);
  const epicId = payload.epic_id as string;
  const taskId = (payload.task_ids as string[])[0] as string;
  return { epicId, taskId };
}

function invoke(mr: MultiRepo, cwd: string, args: string[]): CliResult {
  return runCli(args, { cwd, home: mr.home, env: SID });
}

function taskJson(proj: string, taskId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(proj, ".keeper", "tasks", `${taskId}.json`), "utf-8"),
  );
}

function taskSpec(proj: string, taskId: string): string {
  return readFileSync(join(proj, ".keeper", "specs", `${taskId}.md`), "utf-8");
}

// Copy A's epic JSON into B to simulate legacy dup state (same id in two repos).
function dupEpicInto(srcProj: string, dstProj: string, epicId: string): void {
  const src = join(srcProj, ".keeper", "epics", `${epicId}.json`);
  const dst = join(dstProj, ".keeper", "epics", `${epicId}.json`);
  writeFileSync(dst, readFileSync(src));
}

describe("cross-repo id-addressed verb resolution (fn-882)", () => {
  const getRoot = withTmpdir("planctl-xrepo-root-");
  const getHome = withTmpdir("planctl-xrepo-home-");

  test("done from a non-owning repo's cwd stamps the task in the OWNING store", () => {
    // The fn-879 failure, made a passing case: scaffold + claim in A's board,
    // run done from B's cwd, assert the stamp landed in A (not B).
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const { taskId } = seedEpicIn(mr, a as string, "A task");

    // claim is already cwd-agnostic — claim from B's cwd so done's in_progress
    // gate is satisfied without --force. claim's readonly envelope carries the
    // task_state object; assert it claimed into in_progress.
    const claim = invoke(mr, b as string, ["claim", taskId]);
    expect(claim.code).toBe(0);
    const claimState = parseCliOutput(claim.output).task_state as Record<
      string,
      unknown
    >;
    expect(claimState.status).toBe("in_progress");

    // done from B's cwd: today this hit B's board ("Task not found"). Now it
    // resolves A's board globally and stamps there.
    const r = invoke(mr, b as string, [
      "done",
      taskId,
      "--summary",
      "shipped",
      "--no-op-reason",
      "no code",
    ]);
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).status).toBe("done");

    // The stamp landed in A's tracked task JSON, and A's spec carries the
    // summary — proof the write routed to the owning project, not the cwd one.
    expect(taskJson(a as string, taskId).worker_done_at).toBeTruthy();
    expect(taskSpec(a as string, taskId)).toContain("shipped");
  });

  test("show resolves a task owned by another repo from a non-owning cwd", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const { taskId } = seedEpicIn(mr, a as string, "A task");

    const r = invoke(mr, b as string, ["show", taskId]);
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.type).toBe("task");
    expect((env.task as Record<string, unknown>).id).toBe(taskId);
  });

  test("show resolves an epic owned by another repo from a non-owning cwd", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const { epicId } = seedEpicIn(mr, a as string, "A epic");

    const r = invoke(mr, b as string, ["show", epicId]);
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.type).toBe("epic");
    expect((env.epic as Record<string, unknown>).id).toBe(epicId);
  });

  test("cat resolves a spec owned by another repo from a non-owning cwd", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const { taskId } = seedEpicIn(mr, a as string, "A task");

    const r = invoke(mr, b as string, ["cat", taskId]);
    expect(r.code).toBe(0);
    expect(r.output.startsWith("## Description")).toBe(true);
  });

  test("refine-context resolves an epic owned by another repo from a non-owning cwd", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const { epicId } = seedEpicIn(mr, a as string, "A epic");

    const r = invoke(mr, b as string, ["refine-context", epicId]);
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.epic_id).toBe(epicId);
    expect(env.success).toBe(true);
  });

  test("not-found: an id present in no project errors cleanly", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-b": b } = mr.projects;

    const doneR = invoke(mr, b as string, ["done", "fn-9999-missing.1"]);
    expect(doneR.code).not.toBe(0);
    expect(doneR.output).toContain("Task not found");

    const showR = invoke(mr, b as string, ["show", "fn-9999-missing"]);
    expect(showR.code).not.toBe(0);
    expect(showR.output).toContain("Epic not found");

    const catR = invoke(mr, b as string, ["cat", "fn-9999-missing"]);
    expect(catR.code).not.toBe(0);
    expect(catR.output).toContain("Epic not found");
  });

  test("ambiguous: a dup id across two projects surfaces a multiple-projects signal", () => {
    // Legacy dup state: the same epic id lives in A and B. A task/epic id verb
    // run from a NEUTRAL cwd (C) must not silently pick one — it surfaces the
    // same multiple-projects signal add-deps emits, naming --project.
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b", "proj-c"]);
    const { "proj-a": a, "proj-b": b, "proj-c": c } = mr.projects;
    const { epicId } = seedEpicIn(mr, a as string, "Dup");
    dupEpicInto(a as string, b as string, epicId);

    const showR = invoke(mr, c as string, ["show", epicId]);
    expect(showR.code).not.toBe(0);
    expect(showR.output).toContain("multiple projects");

    const rcR = invoke(mr, c as string, ["refine-context", epicId]);
    expect(rcR.code).not.toBe(0);
    expect(rcR.output).toContain("multiple projects");

    const catR = invoke(mr, c as string, ["cat", epicId]);
    expect(catR.code).not.toBe(0);
    expect(catR.output).toContain("multiple projects");

    // --project bypasses the ambiguity (the documented escape hatch), pinning
    // A's board.
    const showPinned = invoke(mr, c as string, [
      "show",
      epicId,
      "--project",
      a as string,
    ]);
    expect(showPinned.code).toBe(0);
    expect(
      (parseCliOutput(showPinned.output).epic as Record<string, unknown>).id,
    ).toBe(epicId);
  });

  test("single-repo: cwd project wins first (a same-cwd id is never global)", () => {
    // A and B each carry a distinct epic. From A's cwd, show A's own id resolves
    // to A directly via the cwd short-circuit — single-repo behavior unchanged.
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a } = mr.projects;
    const { epicId, taskId } = seedEpicIn(mr, a as string, "A epic");

    const showEpic = invoke(mr, a as string, ["show", epicId]);
    expect(showEpic.code).toBe(0);
    expect(
      (parseCliOutput(showEpic.output).epic as Record<string, unknown>).id,
    ).toBe(epicId);

    // A claim+done from A's own cwd stamps A — the unchanged single-repo flow.
    expect(invoke(mr, a as string, ["claim", taskId]).code).toBe(0);
    const doneR = invoke(mr, a as string, [
      "done",
      taskId,
      "--summary",
      "ok",
      "--no-op-reason",
      "no code",
    ]);
    expect(doneR.code).toBe(0);
    expect(taskJson(a as string, taskId).worker_done_at).toBeTruthy();
  });

  test("a state verb in a lane whose primary_repo lacks the def FAILS LOUD, never writing the lane (fn-999)", () => {
    // Worktree-mode shape: the worker runs IN a lane checkout that owns the
    // epic+task, while the epic's primary_repo points at a MAIN toplevel that
    // does NOT carry the committed defs (a stale / cross-repo primary_repo). The
    // central resolver re-roots STATE to primary_repo and FAILS LOUD when primary
    // lacks the id's def — the backstop against a stale primary_repo. It never
    // falls back to a lane write, so done's stamp can neither land on the lane nor
    // silently escape onto a primary that doesn't own the def.
    const mr = multiRepo(getRoot, getHome, ["lane", "main"]);
    const { lane, main } = mr.projects;
    const { epicId, taskId } = seedEpicIn(mr, lane as string, "Lane work");

    // Point the epic's primary_repo at MAIN (which holds no def for this id).
    const epicPath = join(lane as string, ".keeper", "epics", `${epicId}.json`);
    const epicDef = JSON.parse(readFileSync(epicPath, "utf-8"));
    epicDef.primary_repo = main as string;
    writeFileSync(epicPath, `${JSON.stringify(epicDef, null, 2)}\n`);

    const laneCommitsBefore = gitLogCount(lane as string);
    const mainCommitsBefore = gitLogCount(main as string);

    const doneR = invoke(mr, lane as string, [
      "done",
      taskId,
      "--summary",
      "lane-shipped",
    ]);
    // Primary (main) carries no def for the id → the resolver fails loud rather
    // than writing lane-adjacent state.
    expect(doneR.code).not.toBe(0);
    expect(doneR.output).toContain("unusable");

    // Never a lane write: no done commit, no runtime overlay, no done-stamp.
    expect(gitLogCount(lane as string)).toBe(laneCommitsBefore);
    expect(gitLogCount(main as string)).toBe(mainCommitsBefore);
    expect(
      existsSync(
        join(
          lane as string,
          ".keeper",
          "state",
          "tasks",
          `${taskId}.state.json`,
        ),
      ),
    ).toBe(false);
    expect(taskJson(lane as string, taskId).worker_done_at).toBeFalsy();
  });

  test("list stays project-scoped (the cwd board, not a global view)", () => {
    // list is a board view, NOT id-addressed — it must remain the cwd project's
    // board. A's epic appears in A's list; B's list never carries A's epic.
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const { epicId: epicA } = seedEpicIn(mr, a as string, "A only");
    const { epicId: epicB } = seedEpicIn(mr, b as string, "B only");

    const listB = invoke(mr, b as string, ["list"]);
    expect(listB.code).toBe(0);
    expect(listB.output).toContain(epicB);
    expect(listB.output).not.toContain(epicA);
  });
});
