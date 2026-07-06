// Conformance spec for cross-project epic-level dependencies — translated from
// tests/test_cross_project_epic_deps.py, every inventory node mapped by a
// source-comment (translated | cited | drop-with-reason). 19 inventory nodes:
// 8 python_only drops (in-process resolve_epic_globally / discover_projects
// injections), 11 CLI-observable nodes translated via the harness setRoots over
// real projects under one shared root.
//
// Cross-project resolution is cwd-then-global: a dep id local to cwd's own
// project short-circuits; a sibling-project id resolves via the global discovery
// scan against the configured roots. Each test stands up >=2 git+init'd projects
// under one root, points the binary's roots config at that root (setRoots over a
// shared HOME), and invokes from a chosen cwd so the resolver's branch is
// exercised.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CliResult,
  firstJsonPayload,
  gitInit,
  parseCliOutput,
  runCli,
  scaffoldPlanYaml,
  setRoots,
  withTmpdir,
} from "./harness.ts";

const SID = { CLAUDE_CODE_SESSION_ID: "test-cross-project-fixture" };

interface MultiRepo {
  root: string;
  home: string;
  projects: Record<string, string>; // name -> abs path
}

// Stand up *names* git+init'd planctl projects under one shared root, with the
// binary's roots config pointed at that root. Port of the two_projects /
// three_projects fixtures. Returns {root, home, projects}.
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

// Scaffold a one-task epic inside *proj* (a member project) with a unique title,
// returning its minted id. Port of _seed_epic_in (scaffold from inside the
// project). Distinct titles avoid scaffold's duplicate-slug sibling guard.
function seedEpicIn(mr: MultiRepo, proj: string, title: string): string {
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
  return firstJsonPayload(r.output).epic_id as string;
}

function invoke(mr: MultiRepo, cwd: string, args: string[]): CliResult {
  return runCli(args, { cwd, home: mr.home, env: SID });
}

function epicJson(proj: string, epicId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(proj, ".keeper", "epics", `${epicId}.json`), "utf-8"),
  );
}

// Copy A's epic JSON into B to simulate legacy dup state (same id in two repos).
function dupEpicInto(srcProj: string, dstProj: string, epicId: string): void {
  const src = join(srcProj, ".keeper", "epics", `${epicId}.json`);
  const dst = join(dstProj, ".keeper", "epics", `${epicId}.json`);
  writeFileSync(dst, readFileSync(src));
}

function epicNumber(epicId: string): number {
  return Number.parseInt(epicId.split("-")[1] as string, 10);
}

// --- python_only DROPS (in-process resolver / discovery injections) ----------
// test_cross_project_epic_deps.py::test_resolve_epic_globally_cwd_hot_path
//   -> DROP python_only: calls discovery.resolve_epic_globally in-process. The
//      cwd short-circuit + cross-project resolution are CLI-exercised below via
//      add-dep happy-path / batch (which route through the same resolver).
// test_cross_project_epic_deps.py::test_resolve_epic_globally_cross_project
//   -> DROP python_only: in-process resolver call.
// test_cross_project_epic_deps.py::test_resolve_epic_globally_not_found
//   -> DROP python_only: in-process resolver call; CLI not-found is covered by
//      "add-dep not found" below.
// test_cross_project_epic_deps.py::test_resolve_epic_globally_ambiguous
//   -> DROP python_only: in-process resolver call; CLI ambiguity is covered by
//      "add-dep ambiguous" below.
// test_cross_project_epic_deps.py::test_resolve_epic_globally_single_repo_fallback
//   -> DROP python_only: in-process resolver call against an absent CONFIG_PATH.
// test_cross_project_epic_deps.py::test_resolve_epic_globally_number_only_cwd
//   -> DROP python_only: in-process resolver call (bare fn-N, cwd).
// test_cross_project_epic_deps.py::test_resolve_epic_globally_number_only_cross_project
//   -> DROP python_only: in-process resolver call (bare fn-N, cross-project).
// test_cross_project_epic_deps.py::test_add_deps_discover_projects_raises_degrades_gracefully
//   -> DROP python_only: monkeypatches planctl.discovery.discover_projects to
//      raise — an in-process injection with no subprocess seam.

describe("cross-project epic deps (two/three projects under one root)", () => {
  const getRoot = withTmpdir("planctl-xproj-root-");
  const getHome = withTmpdir("planctl-xproj-home-");

  // test_cross_project_epic_deps.py::test_add_deps_number_only_cross_project_collision_ambiguous
  test("a bare fn-N colliding across two foreign projects routes to ambiguous", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b", "proj-c"]);
    const { "proj-a": a, "proj-b": b, "proj-c": c } = mr.projects;
    // Target lives in neutral C (number 1); collide on a number C does NOT carry.
    const epicC = seedEpicIn(mr, c as string, "C target");
    const collideNum = epicNumber(epicC) + 1;
    // Seed A + B until each carries an epic with collideNum (unique slugs).
    let n = 0;
    let epicA = "";
    while (true) {
      epicA = seedEpicIn(mr, a as string, `A epic ${n}`);
      n += 1;
      if (epicNumber(epicA) === collideNum) break;
    }
    while (true) {
      const epicB = seedEpicIn(mr, b as string, `B epic ${n}`);
      n += 1;
      if (epicNumber(epicB) === collideNum) break;
    }

    const r = invoke(mr, c as string, [
      "epic",
      "add-deps",
      epicC,
      `fn-${collideNum}`,
    ]);
    expect(r.code).not.toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe(
      "dep_ambiguous_id",
    );
    expect(epicJson(c as string, epicC).depends_on_epics).toEqual([]);

    // --skip-invalid routes the same collision into SKIPPED_AMBIGUOUS.
    const r2 = invoke(mr, c as string, [
      "epic",
      "add-deps",
      epicC,
      `fn-${collideNum}`,
      "--skip-invalid",
    ]);
    expect(r2.code).toBe(0);
    const results = parseCliOutput(r2.output).results as Array<
      Record<string, unknown>
    >;
    const statuses = Object.fromEntries(
      results.map((x) => [x.dep_id, x.status]),
    );
    expect(statuses).toEqual({ [`fn-${collideNum}`]: "SKIPPED_AMBIGUOUS" });
    expect(epicJson(c as string, epicC).depends_on_epics).toEqual([]);
  });

  // test_cross_project_epic_deps.py::test_add_dep_cross_project_happy_path
  test("add-dep wires a cross-project edge resolved globally", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const epicA = seedEpicIn(mr, a as string, "A epic");
    const epicB = seedEpicIn(mr, b as string, "B epic");

    const r = invoke(mr, b as string, ["epic", "add-dep", epicB, epicA]);
    expect(r.code).toBe(0);
    // Edge landed on B's epic, pointing at A's id; A untouched.
    expect(epicJson(b as string, epicB).depends_on_epics).toEqual([epicA]);
    expect(epicJson(a as string, epicA).depends_on_epics).toEqual([]);
  });

  // test_cross_project_epic_deps.py::test_add_dep_cross_project_not_found
  test("add-dep on an id present in no project errors 'Epic not found'", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-b": b } = mr.projects;
    const epicB = seedEpicIn(mr, b as string, "B epic");
    const r = invoke(mr, b as string, [
      "epic",
      "add-dep",
      epicB,
      "fn-9999-missing",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("Epic not found");
  });

  // test_cross_project_epic_deps.py::test_add_dep_cross_project_ambiguous
  test("add-dep on a dup id across two foreign projects errors 'multiple projects'", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b", "proj-c"]);
    const { "proj-a": a, "proj-b": b, "proj-c": c } = mr.projects;
    const dupId = seedEpicIn(mr, a as string, "Dup");
    dupEpicInto(a as string, b as string, dupId);
    const epicC = seedEpicIn(mr, c as string, "Parent");

    const r = invoke(mr, c as string, ["epic", "add-dep", epicC, dupId]);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain("multiple projects");
    expect(epicJson(c as string, epicC).depends_on_epics).toEqual([]);
  });

  // test_cross_project_epic_deps.py::test_add_deps_cross_project_batch
  test("add-deps batch wires a mix of in-project and cross-project edges", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const epicA1 = seedEpicIn(mr, a as string, "A1");
    const epicBLocal = seedEpicIn(mr, b as string, "B local");
    const epicBParent = seedEpicIn(mr, b as string, "B parent");

    const r = invoke(mr, b as string, [
      "epic",
      "add-deps",
      epicBParent,
      epicA1,
      epicBLocal,
    ]);
    expect(r.code).toBe(0);
    const results = parseCliOutput(r.output).results as Array<
      Record<string, unknown>
    >;
    const statuses = Object.fromEntries(
      results.map((x) => [x.dep_id, x.status]),
    );
    expect(statuses).toEqual({ [epicA1]: "WIRED", [epicBLocal]: "WIRED" });
    expect(epicJson(b as string, epicBParent).depends_on_epics).toEqual([
      epicA1,
      epicBLocal,
    ]);
  });

  // test_cross_project_epic_deps.py::test_add_deps_ambiguous_priority_order
  test("add-deps: dep_ambiguous_id slots between bad_id and not-found (bad_id wins)", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b", "proj-c"]);
    const { "proj-a": a, "proj-b": b, "proj-c": c } = mr.projects;
    const dupId = seedEpicIn(mr, a as string, "Dup");
    dupEpicInto(a as string, b as string, dupId);
    const epicCParent = seedEpicIn(mr, c as string, "Parent");

    const r = invoke(mr, c as string, [
      "epic",
      "add-deps",
      epicCParent,
      "not-an-id",
      dupId,
      "fn-9999-missing",
    ]);
    expect(r.code).not.toBe(0);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).toBe("bad_id");
    const blob = (error.details as string[]).join(" | ");
    expect(blob).toContain("not-an-id");
    expect(blob).toContain(dupId);
    expect(blob).toContain("fn-9999-missing");
  });

  // test_cross_project_epic_deps.py::test_add_deps_ambiguous_alone_picks_code
  test("add-deps with only ambiguous edges picks dep_ambiguous_id", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b", "proj-c"]);
    const { "proj-a": a, "proj-b": b, "proj-c": c } = mr.projects;
    const dupId = seedEpicIn(mr, a as string, "Dup");
    dupEpicInto(a as string, b as string, dupId);
    const epicCParent = seedEpicIn(mr, c as string, "Parent");

    const r = invoke(mr, c as string, ["epic", "add-deps", epicCParent, dupId]);
    expect(r.code).not.toBe(0);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).toBe("dep_ambiguous_id");
    expect(
      (error.details as string[]).some((d) => d.includes("multiple projects")),
    ).toBe(true);
    expect(epicJson(c as string, epicCParent).depends_on_epics).toEqual([]);
  });

  // test_cross_project_epic_deps.py::test_add_deps_skip_invalid_routes_ambiguous
  test("add-deps --skip-invalid: SKIPPED_AMBIGUOUS distinct from SKIPPED_NOT_FOUND", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b", "proj-c"]);
    const { "proj-a": a, "proj-b": b, "proj-c": c } = mr.projects;
    const dupId = seedEpicIn(mr, a as string, "Dup");
    dupEpicInto(a as string, b as string, dupId);
    const epicBValid = seedEpicIn(mr, b as string, "B valid");
    const epicCParent = seedEpicIn(mr, c as string, "Parent");

    const r = invoke(mr, c as string, [
      "epic",
      "add-deps",
      "--skip-invalid",
      epicCParent,
      dupId,
      "fn-9999-missing",
      epicBValid,
    ]);
    expect(r.code).toBe(0);
    const results = parseCliOutput(r.output).results as Array<
      Record<string, unknown>
    >;
    const statuses = Object.fromEntries(
      results.map((x) => [x.dep_id, x.status]),
    );
    expect(statuses).toEqual({
      [dupId]: "SKIPPED_AMBIGUOUS",
      "fn-9999-missing": "SKIPPED_NOT_FOUND",
      [epicBValid]: "WIRED",
    });
    expect(epicJson(c as string, epicCParent).depends_on_epics).toEqual([
      epicBValid,
    ]);
  });

  // test_cross_project_epic_deps.py::test_scaffold_accepts_cross_project_dep
  test("scaffold accepts a declared cross-project depends_on_epics id", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const epicA = seedEpicIn(mr, a as string, "A epic");

    const planPath = join(b as string, "plan.yaml");
    writeFileSync(
      planPath,
      scaffoldPlanYamlWithDep("B cross-dep epic", [epicA]),
      "utf-8",
    );
    const r = invoke(mr, b as string, ["scaffold", "--file", planPath]);
    expect(r.code).toBe(0);
    const newEpicId = firstJsonPayload(r.output).epic_id as string;
    expect(epicJson(b as string, newEpicId).depends_on_epics).toEqual([epicA]);
  });

  // test_cross_project_epic_deps.py::test_scaffold_rejects_ambiguous_cross_project_dep
  test("scaffold rejects an ambiguous cross-project dep id with epic_dep_invalid", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b", "proj-c"]);
    const { "proj-a": a, "proj-b": b, "proj-c": c } = mr.projects;
    const dupId = seedEpicIn(mr, a as string, "Dup");
    dupEpicInto(a as string, b as string, dupId);

    const planPath = join(c as string, "plan.yaml");
    writeFileSync(
      planPath,
      scaffoldPlanYamlWithDep("C dup-dep epic", [dupId]),
      "utf-8",
    );
    const r = invoke(mr, c as string, ["scaffold", "--file", planPath]);
    expect(r.code).not.toBe(0);
    const error = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(error.code).toBe("epic_dep_invalid");
    expect(
      (error.details as string[]).some((d) => d.includes("multiple projects")),
    ).toBe(true);
  });

  // test_cross_project_epic_deps.py::test_cross_project_cycle_rejected_and_rolled_back
  test("an A->B->A cross-project cycle is rejected by the integrity gate + rolled back", () => {
    const mr = multiRepo(getRoot, getHome, ["proj-a", "proj-b"]);
    const { "proj-a": a, "proj-b": b } = mr.projects;
    const epicA = seedEpicIn(mr, a as string, "A");
    const epicB = seedEpicIn(mr, b as string, "B");

    // Leg 1: A -> B.
    const r1 = invoke(mr, a as string, ["epic", "add-dep", epicA, epicB]);
    expect(r1.code).toBe(0);
    expect(epicJson(a as string, epicA).depends_on_epics).toEqual([epicB]);

    // Leg 2: B -> A would close the cycle; the post-write integrity gate rejects
    // and the rollback hook leaves B's dep list empty on disk.
    const r2 = invoke(mr, b as string, ["epic", "add-dep", epicB, epicA]);
    expect(r2.code).not.toBe(0);
    const payload = parseCliOutput(r2.output);
    expect(payload.success).toBe(false);
    const err = payload.error as Record<string, unknown>;
    const details = (err.details as string[]) ?? [];
    expect(
      err.code === "integrity_failed" ||
        details.some((d) => d.includes("epic-dep cycle detected")),
    ).toBe(true);
    expect(epicJson(b as string, epicB).depends_on_epics).toEqual([]);
  });
});

// A scaffold plan YAML carrying an epic-level depends_on_epics list.
function scaffoldPlanYamlWithDep(title: string, depIds: string[]): string {
  const taskSpec = [
    "      ## Description",
    "      Implement.",
    "      ## Acceptance",
    "      - [ ] It works.",
    "      ## Done summary",
    "      ## Evidence",
  ].join("\n");
  const depsLine =
    depIds.length > 0 ? `  depends_on_epics: [${depIds.join(", ")}]\n` : "";
  return (
    `epic:\n  title: ${title}\n${depsLine}` +
    "  spec: |\n    ## Overview\n    x.\n" +
    `tasks:\n  - title: T1\n    tier: medium\n    model: opus\n    spec: |\n${taskSpec}\n`
  );
}
