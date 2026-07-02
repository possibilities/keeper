// Functional tests for the human/scout `keeper prompt` verbs ported with relaxed
// (not byte-identical) parity: find-snippets, save-snippet, save-bundle,
// list-bundles, show-bundle, validate-bundles. These exercise the contract the
// task acceptance pins — sensible ranked hits with a stable tiebreak, zod
// `.strict()` rejecting the same malformed bundles the Pydantic schema did, and
// the save verbs round-tripping through atomicWrite — against a per-test corpus
// fixture, not the live arthack tree.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseBundle, zodErrorMessage } from "../src/bundle_schema.ts";
import { findSnippets } from "../src/find_snippets.ts";
import { listBundles } from "../src/list_bundles.ts";
import { listSnippets } from "../src/list_snippets.ts";
import { saveBundle } from "../src/save_bundle.ts";
import { saveSnippet } from "../src/save_snippet.ts";
import { ShowBundleError, showBundle } from "../src/show_bundle.ts";
import { findMisses } from "../src/validate_bundles.ts";

let root: string;

/** Templates partials root inside the fixture. */
function partials(): string {
  return join(root, "claude", "arthack", "template", "_partials");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kp-human-"));
  mkdirSync(join(partials(), "snippets"), { recursive: true });
  mkdirSync(join(partials(), "bundles"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("save-snippet", () => {
  test("writes a frontmatter snippet + index row, defaults stamped", () => {
    const row = saveSnippet(root, {
      name: "alpha",
      domain: "dom",
      summary: "alpha summary",
      body: "alpha body line",
      tags: "a,b",
    });
    expect(row.name).toBe("alpha");
    expect(row.audience).toBe("agent");
    expect(row.severity).toBe("default");
    expect(row.path).toBe("_partials/snippets/dom/alpha.md.tmpl");
    expect(row.tags).toEqual(["a", "b"]);
  });

  test("collision without force throws; force overwrites", () => {
    saveSnippet(root, { name: "x", domain: "d", summary: "s", body: "b1" });
    expect(() =>
      saveSnippet(root, { name: "x", domain: "d", summary: "s", body: "b2" }),
    ).toThrow(/already exists/);
    const row = saveSnippet(root, {
      name: "x",
      domain: "d",
      summary: "s2",
      body: "b3",
      force: true,
    });
    expect(row.summary).toBe("s2");
  });

  test("incremental saves both land in the readable index", () => {
    saveSnippet(root, {
      name: "bbb",
      domain: "z",
      summary: "sharedterm here",
      body: "sharedterm body",
    });
    saveSnippet(root, {
      name: "aaa",
      domain: "a",
      summary: "sharedterm here",
      body: "sharedterm body",
    });
    // find-snippets reads _index.yaml; both incrementally-inserted rows resolve.
    const results = findSnippets("sharedterm", root, { limit: 50 });
    const names = results.map((r) => r.name);
    expect(names).toContain("aaa");
    expect(names).toContain("bbb");
  });
});

describe("find-snippets", () => {
  beforeEach(() => {
    saveSnippet(root, {
      name: "directory-layout",
      domain: "cli",
      summary: "directory layout for CLIs",
      body: "Directory structure and layout conventions for command line tools.",
    });
    saveSnippet(root, {
      name: "click-group",
      domain: "cli",
      summary: "click group scaffolding",
      body: "Click group command registration patterns.",
    });
    saveSnippet(root, {
      name: "web-philosophy",
      domain: "web",
      summary: "web ui philosophy",
      body: "Design philosophy for web user interfaces.",
    });
  });

  test("ranks the most relevant snippet first", () => {
    const results = findSnippets("directory layout structure", root, {});
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.name).toBe("directory-layout");
    expect(results[0]?.excerpt).toContain("Directory");
  });

  test("empty query throws", () => {
    expect(() => findSnippets("   ", root, {})).toThrow(/query is required/);
  });

  test("--limit 0 throws", () => {
    expect(() => findSnippets("layout", root, { limit: 0 })).toThrow(
      /--limit 0 is not supported/,
    );
  });

  test("--domain filters post-rank", () => {
    const results = findSnippets("philosophy layout", root, { domain: "web" });
    for (const r of results) {
      expect(r.domain).toBe("web");
    }
  });

  test("stable tiebreak: equal scores order by name ASC", () => {
    // Two snippets sharing the single query term tie on score; name ASC breaks it.
    saveSnippet(root, {
      name: "zeta-tie",
      domain: "t",
      summary: "tiebreak token",
      body: "uniquetoken appears once.",
    });
    saveSnippet(root, {
      name: "alpha-tie",
      domain: "t",
      summary: "tiebreak token",
      body: "uniquetoken appears once.",
    });
    const results = findSnippets("uniquetoken", root, { limit: 50 });
    const tied = results.filter((r) => r.name.endsWith("-tie"));
    expect(tied.map((r) => r.name)).toEqual(["alpha-tie", "zeta-tie"]);
  });

  test("zero-score hits are dropped", () => {
    const results = findSnippets("nonexistentqueryterm", root, {});
    expect(results).toEqual([]);
  });
});

describe("list-snippets (unranked enumeration)", () => {
  beforeEach(() => {
    saveSnippet(root, {
      name: "beta",
      domain: "cli",
      summary: "b",
      body: "bb",
    });
    saveSnippet(root, {
      name: "alpha",
      domain: "cli",
      summary: "a",
      body: "aa",
    });
    saveSnippet(root, {
      name: "gamma",
      domain: "web",
      summary: "g",
      body: "gg",
    });
  });

  test("enumerates every snippet, no query needed, sorted by domain then name", () => {
    const rows = listSnippets(root);
    expect(rows.map((r) => `${r.domain}/${r.name}`)).toEqual([
      "cli/alpha",
      "cli/beta",
      "web/gamma",
    ]);
  });

  test("--domain scopes the enumeration", () => {
    const rows = listSnippets(root, "web");
    expect(rows.map((r) => r.name)).toEqual(["gamma"]);
  });

  test("empty corpus enumerates to nothing", () => {
    const empty = mkdtempSync(join(tmpdir(), "kp-empty-"));
    mkdirSync(
      join(empty, "claude", "arthack", "template", "_partials", "snippets"),
      { recursive: true },
    );
    try {
      expect(listSnippets(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("bundle schema (zod .strict parity with pydantic)", () => {
  function reject(data: unknown): string {
    try {
      parseBundle(data);
      throw new Error("expected rejection");
    } catch (e) {
      if (e instanceof z.ZodError) {
        return zodErrorMessage(e);
      }
      throw e;
    }
  }

  test("accepts a valid bundle, normalizes created_at to ISO", () => {
    const b = parseBundle({
      id: "ok-bundle",
      snippet_ids: ["a", "b"],
      created_at: "2026-01-01T00:00:00Z",
    });
    expect(b.id).toBe("ok-bundle");
    expect(b.snippet_ids).toEqual(["a", "b"]);
    expect(b.summary).toBeNull();
    expect(b.tags).toEqual([]);
    expect(b.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("rejects non-kebab id", () => {
    expect(
      reject({ id: "Bad_Id", created_at: "2026-01-01T00:00:00Z" }),
    ).toMatch(/kebab-case/);
  });

  test("rejects duplicate snippet_ids", () => {
    expect(
      reject({
        id: "x",
        snippet_ids: ["a", "a"],
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toMatch(/duplicate id 'a'/);
  });

  test("rejects unknown keys (extra=forbid)", () => {
    expect(
      reject({ id: "x", created_at: "2026-01-01T00:00:00Z", bogus: 1 }),
    ).toMatch(/Unrecognized key/);
  });

  test("rejects missing created_at", () => {
    expect(reject({ id: "x" })).toMatch(/created_at/);
  });

  test("rejects empty-string snippet id", () => {
    expect(
      reject({
        id: "x",
        snippet_ids: ["a", ""],
        created_at: "2026-01-01T00:00:00Z",
      }),
    ).toMatch(/non-empty strings/);
  });
});

describe("save-bundle / show-bundle / list-bundles round-trip", () => {
  test("create then show round-trips", () => {
    const warns: string[] = [];
    const created = saveBundle(
      "bundle/my-bundle",
      root,
      { snippets: "a,b", summary: "sum", tags: "t1,t2" },
      (m) => warns.push(m),
    );
    expect(created.id).toBe("my-bundle");
    expect(created.snippet_ids).toEqual(["a", "b"]);
    const shown = showBundle("bundle/my-bundle", root);
    expect(shown).toEqual(created);
  });

  test("create collision without force throws; append unions ids", () => {
    saveBundle("bundle/b1", root, { snippets: "a" }, () => {});
    expect(() =>
      saveBundle("bundle/b1", root, { snippets: "b" }, () => {}),
    ).toThrow(/already exists/);
    const merged = saveBundle(
      "bundle/b1",
      root,
      { snippets: "b,a,c", append: true },
      () => {},
    );
    expect(merged.snippet_ids).toEqual(["a", "b", "c"]);
  });

  test("zero-snippet create warns but still writes", () => {
    const warns: string[] = [];
    const b = saveBundle("bundle/empty", root, {}, (m) => warns.push(m));
    expect(b.snippet_ids).toEqual([]);
    expect(warns.some((w) => w.includes("zero snippet ids"))).toBe(true);
  });

  test("show-bundle on a snippet ref errors", () => {
    expect(() => showBundle("just-a-snippet", root)).toThrow(ShowBundleError);
  });

  test("list-bundles returns sorted summary rows", () => {
    saveBundle("bundle/zeta", root, { snippets: "a", summary: "z" }, () => {});
    saveBundle(
      "bundle/alpha",
      root,
      { snippets: "a,b", summary: "a" },
      () => {},
    );
    const rows = listBundles(root, null, () => {});
    expect(rows.map((r) => r.ref)).toEqual(["bundle/alpha", "bundle/zeta"]);
    expect(rows[0]?.snippet_count).toBe(2);
  });

  test("list-bundles --namespace filters to bundle/", () => {
    saveBundle("bundle/x", root, { snippets: "a" }, () => {});
    const rows = listBundles(root, "bundle/", () => {});
    expect(rows.every((r) => r.ref.startsWith("bundle/"))).toBe(true);
  });
});

describe("validate-bundles", () => {
  test("clean corpus yields no misses", () => {
    saveSnippet(root, { name: "known", domain: "d", summary: "s", body: "b" });
    saveBundle("bundle/clean", root, { snippets: "known" }, () => {});
    expect(findMisses(root)).toEqual([]);
  });

  test("collects every miss across bundles", () => {
    saveSnippet(root, { name: "known", domain: "d", summary: "s", body: "b" });
    saveBundle(
      "bundle/drift",
      root,
      { snippets: "known,phantom-one,phantom-two" },
      () => {},
    );
    const misses = findMisses(root);
    expect(misses).toEqual([
      ["drift", "phantom-one"],
      ["drift", "phantom-two"],
    ]);
  });

  test("resolves the <domain>/<name> qualified form", () => {
    saveSnippet(root, { name: "qual", domain: "dd", summary: "s", body: "b" });
    saveBundle("bundle/q", root, { snippets: "dd/qual" }, () => {});
    expect(findMisses(root)).toEqual([]);
  });
});
