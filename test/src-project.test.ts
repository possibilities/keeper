// Unit tests for src/project.ts — findGitRoot / findProjectRoot.
//
// findGitRoot walks parents for a `.git` entry (dir OR file) and resolves
// symlinks (realpathSync) to match Python's Path.resolve(); findProjectRoot
// falls back to the resolved cwd when no `.git` is found. resolveProject's
// missing-project exit path is covered by the compiled-binary dispatch test
// (it calls process.exit, which a same-process unit test cannot trap cleanly).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findGitRoot, findProjectRoot } from "../src/project.ts";

let root: string;
let origCwd: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-proj-test-")));
  origCwd = process.cwd();
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
});

describe("findGitRoot", () => {
  test("returns the dir holding a .git directory", () => {
    mkdirSync(join(root, ".git"));
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(root);
  });

  test("counts a .git file the same as a directory (linked worktree)", () => {
    Bun.write(join(root, ".git"), "gitdir: /elsewhere\n");
    expect(findGitRoot(root)).toBe(root);
  });

  test("returns null outside any git work tree", () => {
    const nested = join(root, "x");
    mkdirSync(nested);
    // tmpdir trees carry no .git up to the filesystem root.
    expect(findGitRoot(nested)).toBeNull();
  });
});

describe("findProjectRoot", () => {
  test("falls back to the resolved cwd when no .git is present", () => {
    process.chdir(root);
    expect(findProjectRoot()).toBe(root);
  });
});
