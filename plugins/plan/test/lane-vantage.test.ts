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
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

/** A recursive digest over EVERY byte under `<root>/.keeper` — the sorted file
 * list AND each file's content — so a "lane untouched" proof covers the whole
 * tree, not a single epic JSON. */
function digestKeeperTree(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (lstatSync(abs).isDirectory()) {
        h.update(`D:${relPath}\n`);
        walk(abs, relPath);
      } else {
        h.update(`F:${relPath}\n`);
        h.update(readFileSync(abs));
      }
    }
  };
  walk(join(root, ".keeper"), "");
  return h.digest("hex");
}

/** The typed error code off a claim error envelope on stdout. */
function claimErrCode(stdout: string): unknown {
  return (parseCliOutput(stdout).error as Record<string, unknown>).code;
}

/** Point a task's `target_repo` at `laneDir` so `resolveWorkerRepos` resolves
 * the worker's TARGET to that lane WITHOUT a KEEPER_PLAN_WORKTREE env — the
 * filesystem-classification branch of the source-staleness check. */
function setTaskTargetRepo(
  stateRoot: string,
  taskId: string,
  laneDir: string,
): void {
  const p = join(stateRoot, ".keeper", "tasks", `${taskId}.json`);
  const def = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  def.target_repo = laneDir;
  writeFileSync(p, JSON.stringify(def), "utf-8");
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

  test("(k) Gap 2 (ii): a clustered target lane whose source-main lacks .keeper (lane_no_state) carries the warning", () => {
    const tmp = getTmp();
    const state = join(tmp, "state"); // the plan state repo (.keeper lives here)
    const laneB = join(tmp, "laneB"); // the worker's TARGET lane (a second repo)
    const mainB = join(tmp, "mainB"); // laneB's own main checkout — NO .keeper
    mkdirSync(state, { recursive: true });
    mkdirSync(laneB, { recursive: true });
    mkdirSync(mainB, { recursive: true });
    seedState(state, { epicId: "fn-1-cafe", nTasks: 1 });
    // laneB is a linked worktree of mainB; mainB carries no .keeper → lane_no_state.
    linkLaneToMain(laneB, mainB);
    // No KEEPER_PLAN_WORKTREE — target_repo points at laneB, so the warning must
    // fire off the filesystem-classification branch, not the producer env.
    setTaskTargetRepo(state, "fn-1-cafe.1", laneB);

    const r = runCli(["claim", "fn-1-cafe.1", "--project", state], {
      cwd: state,
    });

    expect(r.code).toBe(0);
    const env = parseCliOutput(r.stdout);
    expect(env.target_repo).toBe(laneB);
    const warning = env.source_staleness_warning as string;
    // Names BOTH the target lane and the state repo, conservative "may predate"
    // wording — never a fabricated behind-count.
    expect(warning).not.toBeNull();
    expect(warning).toContain(laneB);
    expect(warning).toContain(state);
    expect(warning).toContain("may predate");
    expect(r.stderr).toContain("may predate");

    // The persisted brief carries the same warning (what the worker reads first).
    const brief = JSON.parse(
      readFileSync(env.brief_ref as string, "utf-8"),
    ) as Record<string, unknown>;
    expect(brief.source_staleness_warning).toBe(warning);
  });

  test("(n) Gap 2 (iii): a plain non-lane target emits no source-staleness warning", () => {
    const tmp = getTmp();
    const main = join(tmp, "main");
    mkdirSync(main, { recursive: true });
    seedState(main, { epicId: "fn-1-cafe", nTasks: 1 });
    // No KEEPER_PLAN_WORKTREE; the target resolves to main itself (a plain
    // checkout, not a worktree lane).
    const r = runCli(["claim", "fn-1-cafe.1", "--project", main], {
      cwd: main,
    });

    expect(r.code).toBe(0);
    const env = parseCliOutput(r.stdout);
    expect(env.source_staleness_warning).toBeNull();
    expect(r.stderr).not.toContain("may predate");
  });

  test("(r6) explicit --project <lane> with target==state==lane still carries the warning", () => {
    const tmp = getTmp();
    const main = join(tmp, "main"); // carries .keeper → the lane classifies redirect
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(main, { epicId: "fn-1-cafe", nTasks: 1 });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    linkLaneToMain(lane, main);
    // Point the lane task's own target_repo at the lane, so with --project <lane>
    // the resolved TARGET and STATE both equal the lane. No KEEPER_PLAN_WORKTREE —
    // the lane classification comes from the filesystem, not the producer env.
    setTaskTargetRepo(lane, "fn-1-cafe.1", lane);

    const r = runCli(["claim", "fn-1-cafe.1", "--project", lane], {
      cwd: lane,
    });

    expect(r.code).toBe(0);
    const env = parseCliOutput(r.stdout);
    // target == state == lane; equality never suppresses a lane target — the
    // lane's own SOURCE can still lag its local default, which is what the
    // warning is about.
    expect(env.target_repo).toBe(lane);
    expect(env.primary_repo).toBe(lane);
    const warning = env.source_staleness_warning as string;
    expect(warning).not.toBeNull();
    expect(warning).toContain(lane);
    expect(warning).toContain("may predate");
    expect(r.stderr).toContain("may predate");
  });

  // -------------------------------------------------------------------------
  // Gap 5: the id-bearing verbs surface the weaker-vantage annotation the
  // id-less resolveProject emits — lane_no_state / inconclusive keep cwd
  // resolution but must not silently serve a possibly-lagging snapshot.
  // -------------------------------------------------------------------------

  test("(o) Gap 5: a malformed-.git-file lane (inconclusive) annotates show AND cat on stderr", () => {
    const tmp = getTmp();
    const lane = join(tmp, "lane");
    mkdirSync(lane, { recursive: true });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    // A `.git` file with no parseable gitdir pointer → inconclusive vantage.
    writeFileSync(join(lane, ".git"), "not a gitdir pointer\n", "utf-8");

    const show = runCli(["show", "fn-1-cafe.1"], { cwd: lane });
    expect(show.code).toBe(0);
    // The annotation rides stderr; the single JSON value is on stdout.
    expect(parseCliOutput(show.stdout).success).toBe(true);
    expect(show.stderr).toContain("could not be resolved");
    expect(show.stderr).toContain("--project");

    const cat = runCli(["cat", "fn-1-cafe"], { cwd: lane });
    expect(cat.code).toBe(0);
    expect(cat.stderr).toContain("could not be resolved");
    expect(cat.stderr).toContain("--project");
  });

  test("(p) Gap 5: a lane_no_state lane annotates show AND cat on stderr", () => {
    const tmp = getTmp();
    const main = join(tmp, "main"); // NO .keeper → lane_no_state
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    linkLaneToMain(lane, main);

    const show = runCli(["show", "fn-1-cafe.1"], { cwd: lane });
    expect(show.code).toBe(0);
    // The annotation rides stderr; the single JSON value is on stdout.
    expect(parseCliOutput(show.stdout).success).toBe(true);
    expect(show.stderr).toContain("carries no .keeper");
    expect(show.stderr).toContain("--project");

    const cat = runCli(["cat", "fn-1-cafe"], { cwd: lane });
    expect(cat.code).toBe(0);
    expect(cat.stderr).toContain("carries no .keeper");
  });

  test("(q) Gap 5: a claim that fails TASK_NOT_FOUND from a weaker-vantage lane still carries the annotation", () => {
    const tmp = getTmp();
    const main = join(tmp, "main"); // NO .keeper → lane_no_state
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    linkLaneToMain(lane, main);

    // Claim a task the lane does not carry → TASK_NOT_FOUND; the annotation fires
    // first so the operator sees WHY the id might be missing.
    const r = runCli(["claim", "fn-9-absent.1"], { cwd: lane });
    expect(r.code).not.toBe(0);
    expect(claimErrCode(r.stdout)).toBe("TASK_NOT_FOUND");
    expect(r.stderr).toContain("carries no .keeper");
  });

  test("(r) Gap 5: resolve-task on a lane_no_state lane annotates a successful stale read", () => {
    const tmp = getTmp();
    const main = join(tmp, "main"); // NO .keeper → lane_no_state
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    linkLaneToMain(lane, main);

    const r = runCli(["resolve-task", "fn-1-cafe.1"], { cwd: lane });
    expect(r.code).toBe(0);
    // The single JSON value is on stdout; the lane note rides stderr.
    const env = parseCliOutput(r.stdout);
    expect(env.task_id).toBe("fn-1-cafe.1");
    expect(r.stderr).toContain("carries no .keeper");
    expect(r.stderr).toContain("--project");
  });

  test("(s) Gap 5: resolve-task on a malformed-.git lane (inconclusive) annotates a successful stale read", () => {
    const tmp = getTmp();
    const lane = join(tmp, "lane");
    mkdirSync(lane, { recursive: true });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    // A `.git` file with no parseable gitdir pointer → inconclusive vantage.
    writeFileSync(join(lane, ".git"), "not a gitdir pointer\n", "utf-8");

    const r = runCli(["resolve-task", "fn-1-cafe.1"], { cwd: lane });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.stdout);
    expect(env.task_id).toBe("fn-1-cafe.1");
    expect(r.stderr).toContain("could not be resolved");
    expect(r.stderr).toContain("--project");
  });

  test("(t) Gap 5: resolve-task failing TASK_NOT_FOUND from a weaker-vantage lane still annotates", () => {
    const tmp = getTmp();
    const main = join(tmp, "main"); // NO .keeper → lane_no_state
    const lane = join(tmp, "lane");
    mkdirSync(main, { recursive: true });
    mkdirSync(lane, { recursive: true });
    seedState(lane, { epicId: "fn-1-cafe", nTasks: 1 });
    linkLaneToMain(lane, main);

    // Resolve a task the lane does not carry → TASK_NOT_FOUND; the annotation
    // fires first so the operator sees WHY the id might be missing.
    const r = runCli(["resolve-task", "fn-9-absent.1"], { cwd: lane });
    expect(r.code).not.toBe(0);
    expect(claimErrCode(r.stdout)).toBe("TASK_NOT_FOUND");
    expect(r.stderr).toContain("carries no .keeper");
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

    // Capture the lane's pre-mutation state — the WHOLE .keeper tree (every file
    // + content), not just one epic JSON, plus HEAD.
    const laneKeeperDigestBefore = digestKeeperTree(lane);
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

    // The lane's ENTIRE .keeper tree is byte-untouched and its HEAD did not move:
    // the full-tree digest matches, the lane's epic keeps its seeded branch_name
    // (never the mutation's value), and the fake commit log is unchanged.
    expect(digestKeeperTree(lane)).toBe(laneKeeperDigestBefore);
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
