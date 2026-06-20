// Unit tests for src/discovery.ts resolution surface — resolveEpicGlobally,
// scanEpicIdsGlobal, findProjectsWithEpic. Multi-root pin: seed each project dir
// under a tmp root and pass the roots list explicitly (mirrors the conformance
// set_roots pattern). resolveEpicGlobally's cwd short-circuit is exercised via a
// chdir into a seeded project.

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

import {
  findProjectsWithEpic,
  resolveEpicGlobally,
  scanEpicIdsGlobal,
} from "../src/discovery.ts";

let root: string;
let cwd: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-resolve-")));
  cwd = process.cwd();
});

afterEach(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

/** Seed `<parent>/<name>/.keeper/epics/<epicId>.json` and return the project
 * dir (realpathed). */
function seedEpic(parent: string, name: string, epicId: string): string {
  const proj = join(parent, name);
  mkdirSync(join(proj, ".keeper", "epics"), { recursive: true });
  writeFileSync(
    join(proj, ".keeper", "epics", `${epicId}.json`),
    JSON.stringify({ id: epicId }),
  );
  return realpathSync(proj);
}

describe("resolveEpicGlobally (roots scan, cwd outside any project)", () => {
  test("single owner -> resolved with epicPath + resolvedId", () => {
    process.chdir(root); // not a planctl project -> cwd short-circuit misses
    const proj = seedEpic(root, "p1", "fn-3-add-auth");
    const res = resolveEpicGlobally("fn-3-add-auth", [root]);
    expect(res.resolved).toBe(true);
    expect(res.ambiguous).toBe(false);
    expect(res.projectPath).toBe(proj);
    expect(res.resolvedId).toBe("fn-3-add-auth");
    expect(res.epicPath).toBe(
      join(proj, ".keeper", "epics", "fn-3-add-auth.json"),
    );
  });

  test("number-only fn-N resolves by integer equality to the full slug", () => {
    process.chdir(root);
    const proj = seedEpic(root, "p1", "fn-7-queue-skill");
    const res = resolveEpicGlobally("fn-7", [root]);
    expect(res.resolved).toBe(true);
    expect(res.projectPath).toBe(proj);
    expect(res.resolvedId).toBe("fn-7-queue-skill");
  });

  test("fn-1 never matches fn-10 (integer equality, not prefix)", () => {
    process.chdir(root);
    seedEpic(root, "p1", "fn-10-ten");
    const res = resolveEpicGlobally("fn-1", [root]);
    expect(res.resolved).toBe(false);
    expect(res.ambiguous).toBe(false);
  });

  test("not found -> all null, owners empty", () => {
    process.chdir(root);
    seedEpic(root, "p1", "fn-3-add-auth");
    const res = resolveEpicGlobally("fn-99-nope", [root]);
    expect(res.resolved).toBe(false);
    expect(res.ambiguous).toBe(false);
    expect(res.projectPath).toBeNull();
    expect(res.owners).toEqual([]);
  });

  test("two owners -> ambiguous with owners listed, nothing resolved", () => {
    process.chdir(root);
    const a = seedEpic(root, "pA", "fn-5-dup");
    const b = seedEpic(root, "pB", "fn-5-dup");
    const res = resolveEpicGlobally("fn-5-dup", [root]);
    expect(res.resolved).toBe(false);
    expect(res.ambiguous).toBe(true);
    expect([...res.owners].sort()).toEqual([a, b].sort());
    expect(res.projectPath).toBeNull();
  });
});

describe("resolveEpicGlobally cwd short-circuit", () => {
  test("cwd project carrying the id wins without configured roots", () => {
    const proj = seedEpic(root, "here", "fn-4-local");
    process.chdir(proj);
    // Pass an unrelated roots list: the cwd short-circuit must win first.
    const res = resolveEpicGlobally("fn-4-local", []);
    expect(res.resolved).toBe(true);
    expect(res.projectPath).toBe(proj);
    expect(res.resolvedId).toBe("fn-4-local");
  });

  test("cwd is not double-counted as ambiguous when also under roots", () => {
    const proj = seedEpic(root, "p", "fn-6-x");
    process.chdir(proj);
    // root is the parent of proj, so discovery would re-surface proj; the cwd
    // short-circuit resolves first and the candidate filter prevents a dup.
    const res = resolveEpicGlobally("fn-6-x", [root]);
    expect(res.resolved).toBe(true);
    expect(res.ambiguous).toBe(false);
    expect(res.projectPath).toBe(proj);
  });
});

describe("findProjectsWithEpic", () => {
  test("returns every owner (number-only matches the slug epic)", () => {
    process.chdir(root);
    const a = seedEpic(root, "pA", "fn-8-alpha");
    const res = findProjectsWithEpic("fn-8", [root]);
    expect(res).toEqual([a]);
  });
});

describe("scanEpicIdsGlobal", () => {
  test("maps every bare epic id to its owner; last-walked wins on dup", () => {
    const a = seedEpic(root, "pA", "fn-1-a");
    const b = seedEpic(root, "pB", "fn-2-b");
    // Also drop a spec-only epic id under pA/specs.
    mkdirSync(join(a, ".keeper", "specs"), { recursive: true });
    writeFileSync(join(a, ".keeper", "specs", "fn-9-spec-only.md"), "# x");
    const owners = scanEpicIdsGlobal([a, b]);
    expect(owners["fn-1-a"]).toBe(a);
    expect(owners["fn-2-b"]).toBe(b);
    expect(owners["fn-9-spec-only"]).toBe(a);
  });

  test("project without .keeper contributes nothing (fail-soft)", () => {
    const a = seedEpic(root, "pA", "fn-1-a");
    const missing = join(root, "no-such-project");
    const owners = scanEpicIdsGlobal([missing, a]);
    expect(owners).toEqual({ "fn-1-a": a });
  });
});
