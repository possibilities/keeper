// Lane-vantage resolution for the cwd-discovery read verbs. A cwd inside a
// linked git worktree serves that lane's committed .keeper snapshot, which can
// lag the authoritative state repo. resolveProject detects the lane vantage
// from the filesystem alone (a `.git` FILE plus its gitdir/commondir pointers)
// and either redirects resolution to a positively-derived main checkout that
// carries `.keeper`, or keeps the cwd resolution and annotates on stderr —
// never a silent redirect on a guess. The single top-level JSON value on stdout
// is preserved (the note rides stderr). The lanes here are fabricated purely on
// disk (no `git` subprocess, no daemon, no Worker), following the harness
// patterns: a `.git` file with a `gitdir:` pointer + the minimal worktree gitdir
// carrying a `commondir`.

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  gitBaseline,
  gitHeadMessage,
  gitHeadSha,
  gitLogCount,
  parseCliOutput,
  runCli,
  seedState,
  withTmpdir,
} from "./harness.ts";

const getTmp = withTmpdir("planctl-lane-");

/** Fabricate the on-disk linked-worktree structure git writes: a `.git` FILE in
 * `lane` pointing at `<main>/.git/worktrees/<name>`, whose `commondir` resolves
 * back to `<main>/.git` (so the main toplevel is `<main>`). Pure filesystem. */
function linkLaneToMain(
  lane: string,
  main: string,
  name = basename(lane),
): void {
  const worktreeGitDir = join(main, ".git", "worktrees", name);
  mkdirSync(worktreeGitDir, { recursive: true });
  writeFileSync(join(worktreeGitDir, "commondir"), "../..\n", "utf-8");
  writeFileSync(join(lane, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf-8");
}

/** The served epic ids off an `epics` envelope (a single top-level JSON value). */
function servedEpicIds(stdout: string): string[] {
  const env = parseCliOutput(stdout);
  return (env.epics as Array<{ id: string }>).map((e) => e.id);
}

/** The resolved project path the envelope reports. */
function servedProjectPath(stdout: string): string {
  const env = parseCliOutput(stdout);
  return (env.project as { path: string }).path;
}

describe("lane-vantage resolution", () => {
  test("(a) main checkout cwd (.git directory) serves its own epics, no annotation", () => {
    const proj = join(getTmp(), "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    seedState(proj, { epicId: "fn-1-cafe", nTasks: 1 });

    const r = runCli(["epics"], { cwd: proj });

    expect(r.code).toBe(0);
    expect(servedEpicIds(r.stdout)).toEqual(["fn-1-cafe"]);
    expect(servedProjectPath(r.stdout)).toBe(proj);
    // A `.git` DIRECTORY is positively not a lane — zero annotation.
    expect(r.stderr).toBe("");
  });

  test("(b) lane cwd with a derivable main + .keeper redirects to the state repo", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, { epicId: "fn-1-cafe", nTasks: 1 }); // authoritative state
    seedState(lane, { epicId: "fn-9-stale", nTasks: 1 }); // lagging lane snapshot
    linkLaneToMain(lane, main);

    const r = runCli(["epics"], { cwd: lane });

    expect(r.code).toBe(0);
    // The MAIN epic is served — never the lane's stale snapshot epic.
    expect(servedEpicIds(r.stdout)).toEqual(["fn-1-cafe"]);
    expect(servedProjectPath(r.stdout)).toBe(main);
    // The redirect is announced on stderr, naming the state repo — stdout stays
    // a single JSON value (servedEpicIds parsed it).
    expect(r.stderr).toContain("resolving plan state against the state repo");
    expect(r.stderr).toContain(main);
  });

  test("(c) lane cwd whose main lacks .keeper keeps the lane snapshot and annotates loudly", () => {
    const tmp = getTmp();
    const main = join(tmp, "main"); // NO .keeper here
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(lane, { epicId: "fn-9-stale", nTasks: 1 });
    linkLaneToMain(lane, main);

    const r = runCli(["epics"], { cwd: lane });

    expect(r.code).toBe(0);
    // No redirect target carrying state → the lane's own snapshot is served.
    expect(servedEpicIds(r.stdout)).toEqual(["fn-9-stale"]);
    expect(servedProjectPath(r.stdout)).toBe(lane);
    expect(r.stderr).toContain("may lag");
    expect(r.stderr).toContain("--project");
  });

  test("(d) malformed .git file is inconclusive: no redirect, uncertainty annotation", () => {
    const tmp = getTmp();
    const lane = join(tmp, "lane");
    mkdirSync(lane, { recursive: true });
    seedState(lane, { epicId: "fn-9-stale", nTasks: 1 });
    // A `.git` file with no parseable `gitdir:` line — the worktree structure
    // cannot be read, so the main checkout is not derivable.
    writeFileSync(
      join(lane, ".git"),
      "this is not a gitdir pointer\n",
      "utf-8",
    );

    const r = runCli(["epics"], { cwd: lane });

    expect(r.code).toBe(0);
    // Inconclusive → current resolution kept, NEVER a silent redirect.
    expect(servedEpicIds(r.stdout)).toEqual(["fn-9-stale"]);
    expect(servedProjectPath(r.stdout)).toBe(lane);
    expect(r.stderr).toContain("could not be resolved");
    expect(r.stderr).toContain("--project");
  });

  test("(e) explicit --project from a lane cwd resolves to the named project, no lane annotation", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, {
      epicId: "fn-1-cafe",
      nTasks: 1,
      epicSpec: "## Overview\nMAIN SPEC\n",
    });
    seedState(lane, {
      epicId: "fn-9-stale",
      nTasks: 1,
      epicSpec: "## Overview\nLANE SPEC\n",
    });
    linkLaneToMain(lane, main);

    // cat is id-bearing and honors --project (the untouched resolver, not the
    // cwd-discovery seam); it reads exactly the named project's spec even from a
    // lane cwd, with no lane redirect or annotation.
    const r = runCli(["cat", "fn-9-stale", "--project", lane], { cwd: lane });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain("LANE SPEC");
    expect(r.stdout).not.toContain("MAIN SPEC");
    expect(r.stderr).not.toContain("lane worktree");
  });

  test("(f) lane cwd with NO .keeper of its own still redirects to main (no 'No plan project found')", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, { epicId: "fn-1-cafe", nTasks: 1 }); // authoritative state
    // The lane carries NO .keeper at all — the redirect must fire on the derived
    // main's data dir, never gate on the lane having its own.
    linkLaneToMain(lane, main);

    const r = runCli(["epics"], { cwd: lane });

    expect(r.code).toBe(0);
    expect(servedEpicIds(r.stdout)).toEqual(["fn-1-cafe"]);
    expect(servedProjectPath(r.stdout)).toBe(main);
    expect(r.stderr).toContain("resolving plan state against the state repo");
  });

  test("(g) a FORGED commondir pointing at an unrelated dir whose parent carries .keeper produces ZERO redirect", () => {
    const tmp = getTmp();
    const lane = join(tmp, "lane");
    const decoy = join(tmp, "decoy"); // an unrelated tree that carries .keeper
    mkdirSync(lane, { recursive: true });
    mkdirSync(decoy, { recursive: true });
    seedState(lane, { epicId: "fn-9-stale", nTasks: 1 });
    seedState(decoy, { epicId: "fn-1-cafe", nTasks: 1 }); // the forgery target

    // The forged common git dir EXISTS and is a directory, and its PARENT (decoy)
    // carries .keeper — so only the samefile backlink proof separates it from a
    // real main checkout. `decoy/.git` never exists, so realpath(decoy/.git)
    // cannot equal realpath(decoy/gitdir-decoy): the backlink fails.
    const forgedCommon = join(decoy, "gitdir-decoy");
    mkdirSync(forgedCommon, { recursive: true });
    const worktreeGitDir = join(tmp, "wt", "worktrees", "lane");
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(
      join(worktreeGitDir, "commondir"),
      `${forgedCommon}\n`,
      "utf-8",
    );
    writeFileSync(join(lane, ".git"), `gitdir: ${worktreeGitDir}\n`, "utf-8");

    const r = runCli(["epics"], { cwd: lane });

    expect(r.code).toBe(0);
    // NO redirect to the decoy — the lane's own snapshot is served, uncertainty
    // annotated (inconclusive), never the forged target's state.
    expect(servedEpicIds(r.stdout)).toEqual(["fn-9-stale"]);
    expect(servedProjectPath(r.stdout)).toBe(lane);
    expect(r.stderr).not.toContain(decoy);
    expect(r.stderr).toContain("could not be resolved");
  });
});

// ---------------------------------------------------------------------------
// The id-bearing resolvers (claim / show / cat / refine-context / set-branch)
// route their cwd candidate through the SAME lane-vantage seam, so a lane cwd
// resolves and serves the authoritative state repo — the #73 production
// specimen (a stale lane epic missing a task added later on main) and the
// ordinary stale-definition read both.
// ---------------------------------------------------------------------------

/** The epic JSON on disk for `epicId` under `root`'s .keeper. */
function readEpicJson(root: string, epicId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, ".keeper", "epics", `${epicId}.json`), "utf-8"),
  ) as Record<string, unknown>;
}

/** Arm `epicId`'s validation marker on disk (the read path parses any valid
 * JSON, so a plain write suffices) so `refine-context --invalidate` mutates
 * rather than short-circuiting readonly. */
function armEpic(root: string, epicId: string): void {
  const p = join(root, ".keeper", "epics", `${epicId}.json`);
  const def = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  def.last_validated_at = "2026-01-01T00:00:00.000000Z";
  writeFileSync(p, JSON.stringify(def, null, 2), "utf-8");
}

describe("lane-vantage id-bearing resolution", () => {
  test("(h) claim of a task the lane's stale epic lacks resolves against main (not 'Task not found')", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    // Main's epic carries task .2; the lane's older committed epic has only .1.
    seedState(main, { epicId: "fn-1-cafe", nTasks: 2 });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    linkLaneToMain(lane, main);

    const r = runCli(["claim", "fn-1-cafe.2"], { cwd: lane });

    expect(r.code).toBe(0);
    // The single JSON value is on stdout; the lane warning rides stderr.
    const env = parseCliOutput(r.stdout);
    expect(env.success).toBe(true);
    expect(env.task_id).toBe("fn-1-cafe.2");
    expect((env.task_state as Record<string, unknown>).status).toBe(
      "in_progress",
    );
    // The runtime overlay + brief landed in MAIN, never the lane.
    expect(env.primary_repo).toBe(main);
    const briefRef = env.brief_ref as string;
    expect(briefRef.startsWith(main)).toBe(true);
  });

  test("(i) show of a task the lane's stale epic lacks serves main's task", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, { epicId: "fn-1-cafe", nTasks: 2 });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    linkLaneToMain(lane, main);

    const r = runCli(["show", "fn-1-cafe.2"], { cwd: lane });

    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(true);
    expect((env.task as Record<string, unknown>).id).toBe("fn-1-cafe.2");
  });

  test("(j) a no-override read from a lane serves MAIN's definition when both trees carry the id", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, {
      epicId: "fn-1-cafe",
      title: "MAIN EPIC",
      nTasks: 1,
      epicSpec: "## Overview\nMAIN SPEC\n",
    });
    seedState(lane, {
      epicId: "fn-1-cafe",
      title: "LANE EPIC",
      nTasks: 1,
      epicSpec: "## Overview\nLANE SPEC\n",
    });
    linkLaneToMain(lane, main);

    // cat: raw spec markdown — main's, not the lane's stale definition.
    const cat = runCli(["cat", "fn-1-cafe"], { cwd: lane });
    expect(cat.code).toBe(0);
    expect(cat.stdout).toContain("MAIN SPEC");
    expect(cat.stdout).not.toContain("LANE SPEC");

    // show: the epic metadata is main's.
    const show = runCli(["show", "fn-1-cafe"], { cwd: lane });
    expect(show.code).toBe(0);
    expect(
      (parseCliOutput(show.output).epic as Record<string, unknown>).title,
    ).toBe("MAIN EPIC");

    // refine-context: the epic spec markdown is main's.
    const rc = runCli(["refine-context", "fn-1-cafe"], { cwd: lane });
    expect(rc.code).toBe(0);
    expect(parseCliOutput(rc.output).epic_spec_md).toContain("MAIN SPEC");

    // An explicit --project <lane> stays authoritative for the lane (test (e)
    // precedent): the operator override is never redirected.
    const catLane = runCli(["cat", "fn-1-cafe", "--project", lane], {
      cwd: lane,
    });
    expect(catLane.code).toBe(0);
    expect(catLane.stdout).toContain("LANE SPEC");
  });

  test("(k) a claim from a lane cwd carries a source-staleness warning naming BOTH the lane and the state repo", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, { epicId: "fn-1-cafe", nTasks: 1 });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    linkLaneToMain(lane, main);

    const r = runCli(["claim", "fn-1-cafe.1"], { cwd: lane });

    expect(r.code).toBe(0);
    // The single JSON value is on stdout; the same warning also rides stderr.
    const env = parseCliOutput(r.stdout);
    expect(r.stderr).toContain("may predate");
    const warning = env.source_staleness_warning as string;
    // Names BOTH paths, conservative "may predate" wording — never a fabricated
    // behind-count.
    expect(warning).toContain(lane);
    expect(warning).toContain(main);
    expect(warning).toContain("may predate");

    // The persisted brief carries the same warning (what the worker reads first).
    const brief = JSON.parse(
      readFileSync(env.brief_ref as string, "utf-8"),
    ) as Record<string, unknown>;
    expect(brief.source_staleness_warning).toBe(warning);
  });

  test("(l) a MUTATOR from a lane cwd writes + commits ONLY main; the lane tree and HEAD are untouched", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, { epicId: "fn-1-cafe", nTasks: 1 });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    gitBaseline(main); // main is the committable state repo
    linkLaneToMain(lane, main);

    // Capture the lane's pre-mutation state — bytes AND HEAD.
    const laneEpicBytesBefore = readFileSync(
      join(lane, ".keeper", "epics", "fn-1-cafe.json"),
      "utf-8",
    );
    const laneHeadBefore = gitHeadSha(lane);
    const laneLogBefore = gitLogCount(lane);
    const mainLogBefore = gitLogCount(main);

    const r = runCli(
      ["epic", "set-branch", "fn-1-cafe", "--branch", "feat/from-lane"],
      { cwd: lane },
    );
    expect(r.code).toBe(0);

    // The write + auto-commit landed in MAIN.
    expect(readEpicJson(main, "fn-1-cafe").branch_name).toBe("feat/from-lane");
    expect(gitLogCount(main)).toBe(mainLogBefore + 1);
    expect(gitHeadMessage(main).split("\n")[0]).toBe(
      "chore(plan): set-branch fn-1-cafe",
    );

    // The lane's own .keeper is byte-untouched and its HEAD did not move: the
    // lane's epic keeps its seeded branch_name (never the mutation's value).
    expect(
      readFileSync(join(lane, ".keeper", "epics", "fn-1-cafe.json"), "utf-8"),
    ).toBe(laneEpicBytesBefore);
    expect(readEpicJson(lane, "fn-1-cafe").branch_name).not.toBe(
      "feat/from-lane",
    );
    expect(gitHeadSha(lane)).toBe(laneHeadBefore);
    expect(gitLogCount(lane)).toBe(laneLogBefore);
  });

  test("(m) --project <lane> is the sole intentional way to write a lane's own .keeper", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, { epicId: "fn-1-cafe", nTasks: 1 });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    armEpic(main, "fn-1-cafe");
    armEpic(lane, "fn-1-cafe");
    linkLaneToMain(lane, main);

    // Default (no --project) from the lane: the redirect writes MAIN, so main's
    // marker clears while the lane's own armed marker is left intact.
    const toMain = runCli(["refine-context", "fn-1-cafe", "--invalidate"], {
      cwd: lane,
    });
    expect(toMain.code).toBe(0);
    expect(readEpicJson(main, "fn-1-cafe").last_validated_at).toBeNull();
    expect(readEpicJson(lane, "fn-1-cafe").last_validated_at).not.toBeNull();

    // Explicit --project <lane>: the SOLE intentional way to write the lane's own
    // .keeper — the override is never redirected to the state repo.
    const toLane = runCli(
      ["refine-context", "fn-1-cafe", "--invalidate", "--project", lane],
      { cwd: lane },
    );
    expect(toLane.code).toBe(0);
    expect(readEpicJson(lane, "fn-1-cafe").last_validated_at).toBeNull();
  });
});
