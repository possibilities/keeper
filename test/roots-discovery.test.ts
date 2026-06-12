// Conformance spec for planctl roots config + multi-project discovery + epic-id
// allocation — translated from tests/test_roots_discovery.py, every inventory
// node mapped by a source-comment (translated | cited | drop-with-reason). 15
// inventory nodes.
//
// The config loader (loadRoots) + discovery primitives (discoverProjects,
// scanEpicIdsGlobal) own a unit surface already exercised by
// src-discovery-config.test.ts and src-resolution.test.ts; the nodes those files
// cover are CITED there. The gap nodes (tilde expansion, drop-nonstring-keep-valid,
// literal empty list, dedup-across-duplicate-roots) are translated here against
// the same src functions under a tmp HOME. The two CLI-observable nodes
// (per-project numbering + global-name collision) drive the binary via setRoots.

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
import { discoverProjects } from "../src/discovery.ts";
import {
  gitInit,
  parseCliOutput,
  runCli,
  setRoots,
  withTmpdir,
} from "./harness.ts";

const SID = { CLAUDE_CODE_SESSION_ID: "test-roots-discovery-fixture" };

// --- Config-loader + discovery unit nodes — CITED, not re-translated. --------
// test_roots_discovery.py::test_load_roots_absent_defaults_to_code
//   -> CITED src-discovery-config.test.ts "absent file defaults to ~/code".
// test_roots_discovery.py::test_load_roots_present_expands_and_resolves
//   -> CITED src-discovery-config.test.ts "valid roots: list is expanded + resolved".
// test_roots_discovery.py::test_load_roots_malformed_yaml_falls_back
//   -> CITED src-discovery-config.test.ts "malformed YAML falls back to the default".
// test_roots_discovery.py::test_load_roots_wrong_type_falls_back
//   -> CITED src-discovery-config.test.ts "roots not a list falls back to the default".
// test_roots_discovery.py::test_discover_finds_immediate_children
//   -> CITED src-discovery-config.test.ts "returns immediate children holding
//      .planctl/, sorted".
// test_roots_discovery.py::test_discover_skips_nested_planctl
//   -> CITED src-discovery-config.test.ts "skips nested .planctl/ (only immediate
//      children)".
// test_roots_discovery.py::test_discover_missing_root_skipped
//   -> CITED src-discovery-config.test.ts "missing/unlistable roots are skipped,
//      not errors".
// test_roots_discovery.py::test_scan_epic_ids_global_across_projects
//   -> CITED src-resolution.test.ts "maps every bare epic id to its owner;
//      last-walked wins on dup".
// test_roots_discovery.py::test_scan_epic_ids_global_empty
//   -> CITED src-resolution.test.ts "project without .planctl contributes nothing
//      (fail-soft)".

describe("loadRoots gap nodes (config loader under a tmp HOME)", () => {
  let root: string;
  const savedHome = process.env.HOME;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-roots-cfg-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
  });

  function writeConfig(home: string, body: string): string {
    const dir = join(home, ".config", "planctl");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "config.yaml");
    writeFileSync(path, body);
    return path;
  }

  // test_roots_discovery.py::test_load_roots_tilde_expansion
  test("a ~ entry expands to an absolute home-relative path", () => {
    const home = join(root, "home-tilde");
    mkdirSync(join(home, "some-dir"), { recursive: true });
    process.env.HOME = home;
    const cfg = writeConfig(home, "roots:\n  - ~/some-dir\n");
    const roots = loadRoots(cfg);
    expect(roots).toHaveLength(1);
    expect(roots[0]).toBe(realpathSync(join(home, "some-dir")));
    expect(roots[0]?.includes("~")).toBe(false);
  });

  // test_roots_discovery.py::test_load_roots_drops_nonstring_entries
  test("non-string / empty entries are dropped; valid ones kept", () => {
    const home = join(root, "home-drop");
    const valid = join(root, "valid");
    mkdirSync(valid, { recursive: true });
    mkdirSync(join(home, "code"), { recursive: true });
    process.env.HOME = home;
    const cfg = writeConfig(home, `roots:\n  - ${valid}\n  - 42\n  - ''\n`);
    expect(loadRoots(cfg)).toEqual([realpathSync(valid)]);
  });

  // test_roots_discovery.py::test_load_roots_empty_list_falls_back
  test("an explicit empty roots list falls back to the default", () => {
    const home = join(root, "home-emptylist");
    mkdirSync(join(home, "code"), { recursive: true });
    process.env.HOME = home;
    const cfg = writeConfig(home, "roots: []\n");
    expect(loadRoots(cfg)).toEqual([realpathSync(join(home, "code"))]);
  });
});

describe("discoverProjects gap node", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "planctl-roots-disc-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // test_roots_discovery.py::test_discover_dedups_across_roots
  test("the same project via duplicate roots appears once", () => {
    const r = join(root, "code");
    const proj = join(r, "alpha");
    mkdirSync(join(proj, ".planctl", "epics"), { recursive: true });
    const projReal = realpathSync(proj);
    expect(discoverProjects([r, r])).toEqual([projReal]);
  });
});

describe("per-project numbering + global-name uniqueness (CLI via setRoots)", () => {
  const getRoot = withTmpdir("planctl-roots-root-");
  const getHome = withTmpdir("planctl-roots-home-");

  function initProject(root: string, home: string, name: string): string {
    const proj = join(root, name);
    mkdirSync(proj, { recursive: true });
    gitInit(proj);
    const r = runCli(["init"], { cwd: proj, home, env: SID });
    expect(r.code).toBe(0);
    return proj;
  }

  function createEpic(
    proj: string,
    home: string,
    title: string,
  ): {
    code: number;
    output: string;
  } {
    const r = runCli(["epic", "create", "--title", title], {
      cwd: proj,
      home,
      env: SID,
    });
    return { code: r.code, output: r.output };
  }

  function epicId(output: string): string {
    return (parseCliOutput(output).epic as Record<string, unknown>)
      .id as string;
  }

  // test_roots_discovery.py::test_creates_are_per_project_numbered — two projects
  // under one root; each gets its OWN monotonic fn-N (both start at fn-1).
  test("each project gets its own monotonic fn-N (both fn-1)", () => {
    const root = getRoot();
    const home = getHome();
    const a = initProject(root, home, "alpha");
    const b = initProject(root, home, "beta");
    setRoots(home, [root]);

    const ra = createEpic(a, home, "Alpha epic");
    expect(ra.code).toBe(0);
    const rb = createEpic(b, home, "Beta epic");
    expect(rb.code).toBe(0);

    expect(epicId(ra.output).split("-")[1]).toBe("1");
    expect(epicId(rb.output).split("-")[1]).toBe("1");
  });

  // test_roots_discovery.py::test_create_rejects_global_name_collision — two
  // projects minting the same full epic id: the second fails, naming the colliding
  // id (the cross-project discovery scan sees A's epic from B).
  test("a global epic-id collision fails the second create, naming the id", () => {
    const root = getRoot();
    const home = getHome();
    const a = initProject(root, home, "alpha");
    const b = initProject(root, home, "beta");
    setRoots(home, [root]);

    const ra = createEpic(a, home, "Shared title");
    expect(ra.code).toBe(0);
    const idA = epicId(ra.output);

    const rb = createEpic(b, home, "Shared title");
    expect(rb.code).not.toBe(0);
    expect(rb.output).toContain(idA);
  });
});
