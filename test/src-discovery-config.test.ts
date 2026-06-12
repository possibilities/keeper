// Unit tests for src/config.ts (roots loader, fail-soft) and src/discovery.ts
// (immediate-child project scan, skip-nested). These are the discovery subset
// claim resolves through; the config fail-soft semantics are the Acceptance's
// "honors config.yaml fail-soft under tmp HOME" pin.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRoots } from "../src/config.ts";
import { discoverProjects, findProjectsWithTask } from "../src/discovery.ts";

let root: string;
const savedHome = process.env.HOME;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-disc-test-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
});

/** Write a config.yaml under a tmp HOME and return its path. */
function writeConfig(home: string, body: string): string {
  const dir = join(home, ".config", "planctl");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "config.yaml");
  writeFileSync(path, body);
  return path;
}

describe("loadRoots fail-soft", () => {
  test("absent file defaults to ~/code (resolved under tmp HOME)", () => {
    const home = join(root, "home-absent");
    mkdirSync(join(home, "code"), { recursive: true });
    process.env.HOME = home;
    const roots = loadRoots();
    // Default ~/code resolves to <home>/code.
    expect(roots).toEqual([realpathSync(join(home, "code"))]);
  });

  test("valid roots: list is expanded + resolved", () => {
    const home = join(root, "home-valid");
    const a = join(root, "rootA");
    const b = join(root, "rootB");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const cfg = writeConfig(home, `roots:\n  - ${a}\n  - ${b}\n`);
    expect(loadRoots(cfg)).toEqual([realpathSync(a), realpathSync(b)]);
  });

  test("malformed YAML falls back to the default", () => {
    const home = join(root, "home-bad");
    mkdirSync(join(home, "code"), { recursive: true });
    process.env.HOME = home;
    const cfg = writeConfig(home, "roots: [unclosed\n  : : :");
    expect(loadRoots(cfg)).toEqual([realpathSync(join(home, "code"))]);
  });

  test("roots not a list falls back to the default", () => {
    const home = join(root, "home-wrongtype");
    mkdirSync(join(home, "code"), { recursive: true });
    process.env.HOME = home;
    const cfg = writeConfig(home, "roots: just-a-string\n");
    expect(loadRoots(cfg)).toEqual([realpathSync(join(home, "code"))]);
  });

  test("empty/non-string entries are dropped; an all-empty list falls back", () => {
    const home = join(root, "home-empty");
    mkdirSync(join(home, "code"), { recursive: true });
    process.env.HOME = home;
    const cfg = writeConfig(home, "roots:\n  - ''\n  - 42\n");
    expect(loadRoots(cfg)).toEqual([realpathSync(join(home, "code"))]);
  });
});

describe("discoverProjects", () => {
  /** Make `<parent>/<name>/.planctl/` and return the project dir. */
  function seedProject(parent: string, name: string): string {
    const proj = join(parent, name);
    mkdirSync(join(proj, ".planctl"), { recursive: true });
    return realpathSync(proj);
  }

  test("returns immediate children holding .planctl/, sorted", () => {
    const r = join(root, "roots1");
    mkdirSync(r, { recursive: true });
    const pB = seedProject(r, "bbb");
    const pA = seedProject(r, "aaa");
    // A non-project child is skipped.
    mkdirSync(join(r, "ccc-no-planctl"), { recursive: true });
    expect(discoverProjects([r])).toEqual([pA, pB]);
  });

  test("skips nested .planctl/ (only immediate children)", () => {
    const r = join(root, "roots2");
    mkdirSync(r, { recursive: true });
    const proj = seedProject(r, "proj");
    // A worktree-style nested .planctl two levels down must NOT surface.
    mkdirSync(join(proj, "deep", "child", ".planctl"), { recursive: true });
    expect(discoverProjects([r])).toEqual([proj]);
  });

  test("missing/unlistable roots are skipped, not errors", () => {
    const r = join(root, "roots3");
    mkdirSync(r, { recursive: true });
    const proj = seedProject(r, "p");
    const missing = join(root, "does-not-exist");
    expect(discoverProjects([missing, r])).toEqual([proj]);
  });
});

describe("findProjectsWithTask", () => {
  test("returns only roots whose .planctl/tasks/<id>.json exists", () => {
    const r = join(root, "roots4");
    mkdirSync(r, { recursive: true });
    const withTask = join(r, "has");
    mkdirSync(join(withTask, ".planctl", "tasks"), { recursive: true });
    writeFileSync(join(withTask, ".planctl", "tasks", "fn-1-x.1.json"), "{}");
    const withoutTask = join(r, "without");
    mkdirSync(join(withoutTask, ".planctl", "tasks"), { recursive: true });

    const matches = findProjectsWithTask("fn-1-x.1", [r]);
    expect(matches).toEqual([realpathSync(withTask)]);
  });

  test("no project holds the task => empty list", () => {
    const r = join(root, "roots5");
    mkdirSync(join(r, "p", ".planctl"), { recursive: true });
    expect(findProjectsWithTask("fn-9-none.1", [r])).toEqual([]);
  });
});
