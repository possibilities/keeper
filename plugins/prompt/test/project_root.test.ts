// Corpus-root resolution: the `.git` walk only wins when the found root actually
// holds a corpus; otherwise resolution falls back to the config-driven authoring
// home. These drive resolveProjectRoot through its pure `cwd` seam over real
// tmpdirs (no git process) and toggle the corpus marker dir + the
// KEEPER_PROMPT_CORPUS_ROOT env to exercise every branch.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fallbackCorpusRoot,
  findGitRoot,
  hasCorpus,
  resolveProjectRoot,
} from "../src/project_root.ts";

let root: string;
const savedEnv = process.env.KEEPER_PROMPT_CORPUS_ROOT;

/** Create a `.git` marker under `dir` (a plain file suffices for the walk). */
function makeRepo(dir: string): void {
  mkdirSync(join(dir, ".git"), { recursive: true });
}

/** Create the corpus marker dir (`claude/arthack/template/_partials`) under `dir`. */
function makeCorpus(dir: string): void {
  mkdirSync(join(dir, "claude", "arthack", "template", "_partials"), {
    recursive: true,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kp-root-"));
  delete process.env.KEEPER_PROMPT_CORPUS_ROOT;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedEnv === undefined) {
    delete process.env.KEEPER_PROMPT_CORPUS_ROOT;
  } else {
    process.env.KEEPER_PROMPT_CORPUS_ROOT = savedEnv;
  }
});

describe("findGitRoot", () => {
  test("walks up to the nearest ancestor holding .git", () => {
    makeRepo(root);
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(root);
  });

  test("returns null when no ancestor is a repo", () => {
    // A tmpdir subtree with no `.git` all the way up to `/` — a stray `.git` on
    // the path to tmp would break this, but the OS tmp root carries none.
    expect(findGitRoot(root)).toBeNull();
  });
});

describe("hasCorpus", () => {
  test("true only when the _partials marker dir exists", () => {
    expect(hasCorpus(root)).toBe(false);
    makeCorpus(root);
    expect(hasCorpus(root)).toBe(true);
  });
});

describe("fallbackCorpusRoot", () => {
  test("honors KEEPER_PROMPT_CORPUS_ROOT when set", () => {
    process.env.KEEPER_PROMPT_CORPUS_ROOT = root;
    expect(fallbackCorpusRoot()).toBe(root);
  });

  test("defaults to ~/code/arthack when the env is unset", () => {
    expect(fallbackCorpusRoot()).toMatch(/[/\\]code[/\\]arthack$/);
  });
});

describe("resolveProjectRoot", () => {
  test("an explicit root wins outright, corpus or not", () => {
    expect(resolveProjectRoot(root)).toBe(root);
  });

  test("a corpus-holding .git root is used directly", () => {
    makeRepo(root);
    makeCorpus(root);
    const nested = join(root, "x");
    mkdirSync(nested, { recursive: true });
    expect(resolveProjectRoot(null, nested)).toBe(root);
  });

  test("a .git root WITHOUT a corpus falls back to the configured home", () => {
    makeRepo(root); // repo but no corpus — mirrors keeper's own root
    const home = mkdtempSync(join(tmpdir(), "kp-home-"));
    process.env.KEEPER_PROMPT_CORPUS_ROOT = home;
    try {
      expect(resolveProjectRoot(null, root)).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("no repo at all falls back to the configured home", () => {
    const home = mkdtempSync(join(tmpdir(), "kp-home-"));
    process.env.KEEPER_PROMPT_CORPUS_ROOT = home;
    try {
      expect(resolveProjectRoot(null, root)).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
