// Drift gate for the vendored keeper-relevant snippet corpus. Four guarantees:
//   1. every vendored file matches its sha256 in `vendor.lock` (a hand-edit not
//      reflected in the lock fails here);
//   2. every byte-verbatim BAKE guard in the hack skill equals its render, and
//      every POINTER ref resolves;
//   3. every `keeper prompt render <ref>` cite reachable from a worker/skill
//      surface — keeper/plan skill bodies, the plan agent briefs, and the
//      transitive cites inside the vendored snippet bodies themselves — resolves
//      against the vendored corpus AND names a row in the subset `_index.yaml`,
//      so a future edit that cites a ref outside the vendored subset fails loud;
//   4. the arthack prompt-reminder bundle (`bundle/hookctl-bus-pointer`) stays
//      upstream-only — it is arthack-personal advocacy, lives only in arthack's
//      own UserPromptSubmit hook, and is deliberately NOT vendored; nothing
//      keeper-side may cite it.
// All checks read the in-repo vendored corpus — no arthack checkout required.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
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
// The worker/skill-reachable surfaces a render cite can appear on: keeper + plan
// skill bodies, the plan agent briefs (worker + practice-scout templates), and
// the vendored snippet bodies themselves (a cite inside a rendered snippet is
// reachable when a reader follows it). Every ref found here must resolve inside
// the vendored subset — that is the arthack-free reachability guarantee.
const SNIPPETS_SUBDIR = [
  "claude",
  "arthack",
  "template",
  "_partials",
  "snippets",
];
const REACHABLE_DIRS = [
  join(REPO_ROOT, "plugins", "keeper", "skills"),
  join(REPO_ROOT, "plugins", "plan", "skills"),
  join(REPO_ROOT, "plugins", "plan", "template", "agents"),
  join(CORPUS, ...SNIPPETS_SUBDIR),
];

/** All `keeper prompt render <ref>` refs found in `text` (deduped by caller). */
function citeRefs(text: string): string[] {
  const re = /keeper prompt render ((?:bundle\/|sketch\/)?[a-z0-9/-]+)/g;
  return Array.from(text.matchAll(re), (m) => m[1] as string);
}

/** Recursively collect prompt-bearing bodies (`.md` + `.md.tmpl`) under `dir`. */
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

/** Snippet `name`s in the vendored subset index — the pin the reachable set is
 * checked against, so a cite naming a snippet outside the subset fails loud. */
function subsetSnippetNames(): Set<string> {
  const p = join(CORPUS, ...SNIPPETS_SUBDIR, "_index.yaml");
  const data = yaml.load(readFileSync(p, "utf-8")) as {
    snippets?: { name: string }[];
  } | null;
  return new Set((data?.snippets ?? []).map((r) => r.name));
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

  test("the six byte-verbatim bake guards are all present", () => {
    expect(bakeCount(readFileSync(HACK_SKILL, "utf-8"))).toBe(6);
  });
});

describe("render cites resolve from the vendored corpus", () => {
  /** Deduped refs cited across every worker/skill-reachable surface. */
  function reachableRefs(): Set<string> {
    const refs = new Set<string>();
    for (const dir of REACHABLE_DIRS) {
      for (const file of skillFiles(dir)) {
        for (const ref of citeRefs(readFileSync(file, "utf-8"))) {
          refs.add(ref);
        }
      }
    }
    return refs;
  }

  test("every reachable cite renders arthack-free from the subset", () => {
    const refs = reachableRefs();
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

  test("every reachable snippet cite names a row in the subset index", () => {
    const names = subsetSnippetNames();
    // Snippet refs are `<name>` or `<domain>/<name>`; the terminal segment is
    // the snippet name. Bundle/sketch refs are namespaced and resolve via
    // render() above — they carry no snippet-index row, so skip them here.
    const outside: string[] = [];
    for (const ref of reachableRefs()) {
      if (ref.startsWith("bundle/") || ref.startsWith("sketch/")) {
        continue;
      }
      const name = ref.split("/").pop() as string;
      if (!names.has(name)) {
        outside.push(ref);
      }
    }
    expect(outside).toEqual([]);
  });

  test("the arthack prompt-reminder bundle is not cited keeper-side", () => {
    // `bundle/hookctl-bus-pointer` is arthack-personal advocacy and is
    // deliberately upstream-only. If a keeper surface ever cites it, render()
    // would throw (it is not vendored) — this pins the upstream-only invariant
    // with an explicit, self-documenting failure.
    const bundleRefs = [...reachableRefs()].filter((r) =>
      r.startsWith("bundle/"),
    );
    expect(bundleRefs).toEqual([]);
  });
});
