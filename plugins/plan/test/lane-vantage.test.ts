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
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { parseCliOutput, runCli, seedState, withTmpdir } from "./harness.ts";

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
});
