// Drift gate for the vendored keeper-relevant snippet corpus. Three guarantees:
//   1. every vendored file matches its sha256 in `vendor.lock` (a hand-edit not
//      reflected in the lock fails here);
//   2. every byte-verbatim BAKE guard in the hack skill equals its render, and
//      every POINTER ref resolves;
//   3. every `keeper prompt render <ref>` cite in a keeper/plan skill body
//      resolves against the vendored corpus.
// All checks read the in-repo vendored corpus — no arthack checkout required.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "../src/render.ts";
import {
  bakeCount,
  loadVendorLock,
  vendoredCorpusRoot,
  verifyBakes,
  verifyVendorLock,
} from "../src/vendor.ts";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const CORPUS = vendoredCorpusRoot();
const HACK_SKILL = join(
  REPO_ROOT,
  "plugins",
  "plan",
  "skills",
  "hack",
  "SKILL.md",
);
const SKILL_DIRS = [
  join(REPO_ROOT, "plugins", "keeper", "skills"),
  join(REPO_ROOT, "plugins", "plan", "skills"),
];

/** All `keeper prompt render <ref>` refs found in `text` (deduped by caller). */
function citeRefs(text: string): string[] {
  const re = /keeper prompt render ((?:bundle\/|sketch\/)?[a-z0-9/-]+)/g;
  return Array.from(text.matchAll(re), (m) => m[1] as string);
}

/** Recursively collect skill bodies (`.md` + `.md.tmpl`) under `dir`. */
function skillFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur)) {
      const full = join(cur, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name.endsWith(".md") || name.endsWith(".md.tmpl")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

describe("vendor.lock manifest", () => {
  test("every vendored file matches its locked sha256", () => {
    const { ok, errors } = verifyVendorLock(CORPUS);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  test("records upstream provenance + a non-empty filter rule", () => {
    const lock = loadVendorLock(CORPUS);
    expect(lock.upstream.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.filter_rule.length).toBeGreaterThan(0);
    expect(Object.keys(lock.files).length).toBeGreaterThan(0);
  });
});

describe("baked snippets", () => {
  test("every BAKE guard equals its render; every POINTER ref resolves", () => {
    const { ok, errors } = verifyBakes(HACK_SKILL, CORPUS);
    expect(errors).toEqual([]);
    expect(ok).toBe(true);
  });

  test("the four byte-verbatim bake guards are all present", () => {
    expect(bakeCount(readFileSync(HACK_SKILL, "utf-8"))).toBe(4);
  });
});

describe("render cites resolve from the vendored corpus", () => {
  test("every cite in a keeper/plan skill body renders", () => {
    const refs = new Set<string>();
    for (const dir of SKILL_DIRS) {
      for (const file of skillFiles(dir)) {
        for (const ref of citeRefs(readFileSync(file, "utf-8"))) {
          refs.add(ref);
        }
      }
    }
    expect(refs.size).toBeGreaterThan(0);
    const unresolved: string[] = [];
    for (const ref of refs) {
      try {
        render(ref, CORPUS, () => {});
      } catch (e) {
        unresolved.push(`${ref}: ${e instanceof Error ? e.message : e}`);
      }
    }
    expect(unresolved).toEqual([]);
  });
});
