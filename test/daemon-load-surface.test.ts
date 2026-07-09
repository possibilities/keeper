/**
 * Daemon load-surface boundary check + fingerprint-seam unit tests.
 *
 * The reload gate fingerprints only the paths keeperd actually loads (the roots
 * manifest). That fingerprint is trustworthy ONLY if the daemon's real import
 * graph stays inside those roots, so this fast-tier test walks the daemon
 * entrypoint's transitive closure — relative imports, worker-thread spawn edges,
 * and attribute imports — and asserts every reachable in-repo path falls under a
 * manifest root. The boundary test and the install fingerprint read the manifest
 * through the SAME parser (parseRootsManifest, imported from the seam), so the
 * enforced boundary and the hashed boundary cannot drift apart.
 *
 * Pure file reads only — no subprocess, no git, no module load. See ADR 0029.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  composeFingerprint,
  composeRevParseArgs,
  parseRootsManifest,
} from "../scripts/daemon-fingerprint.ts";
import {
  parseWorkerSpecs,
  repoRoot,
  stripComments,
  walkClosure,
} from "./helpers/depgraph.ts";

const DAEMON_ENTRY = resolve(repoRoot, "src/daemon.ts");
const MANIFEST = resolve(repoRoot, "scripts/daemon-load-roots.txt");
const roots = parseRootsManifest(readFileSync(MANIFEST, "utf8"));

/** A reachable repo-relative path is inside the load surface iff it equals a
 *  declared root (file root) or lies under one (directory root). A file root is
 *  never a directory prefix of a sibling, so the two forms never cross-match. */
function underRoot(rel: string): boolean {
  return roots.some((r) => rel === r || rel.startsWith(`${r}/`));
}

describe("daemon load-surface boundary", () => {
  const closure = walkClosure(DAEMON_ENTRY);

  test("walk is non-vacuous and follows every edge class", () => {
    // A resolution bug that visited only the root would pass the boundary check
    // vacuously. The real daemon closure spans ~100 modules; anchor on a few.
    expect(closure.files.length).toBeGreaterThan(50);
    const rels = new Set(closure.files.map((f) => f.rel));
    expect(rels).toContain("src/daemon.ts");
    // src/bus-worker.ts is reachable ONLY through a worker-spawn edge — its
    // presence proves worker-edge discovery actually fired, not just that the
    // count is positive.
    expect(rels).toContain("src/bus-worker.ts");
  });

  test("worker-spawn edges are discovered (count positive)", () => {
    expect(closure.workerEdges.length).toBeGreaterThan(0);
    // The daemon spawns ~21 workers; a stripping regression that swallowed the
    // spawn block would silently drop most of them.
    expect(closure.workerEdges).toContain("src/bus-worker.ts");
    expect(closure.workerEdges).toContain("src/autopilot-worker.ts");
  });

  test("attribute-import edges are discovered", () => {
    // `import embeddedConfig from "../subagents.yaml" with { type: "text" }` is a
    // real load edge to a non-source asset — recorded, and covered by a file root.
    expect(closure.assetImports.length).toBeGreaterThan(0);
    expect(closure.assetImports).toContain("plugins/plan/subagents.yaml");
  });

  test("every reachable in-repo path falls under a manifest root", () => {
    const reachable = [
      ...closure.files.map((f) => f.rel),
      ...closure.assetImports,
    ];
    const outside = reachable.filter((rel) => !underRoot(rel)).sort();
    expect(outside).toEqual([]);
  });

  test("injected boundary violation is caught", () => {
    // Backwards edges the epic cleaned — a daemon import reaching into the CLI or
    // hook layer — must NOT be classified as inside the load surface.
    expect(underRoot("cli/duration.ts")).toBe(false);
    expect(underRoot("plugins/keeper/plugin/hooks/events-writer.ts")).toBe(
      false,
    );
    // Genuine roots pass, both directory and file forms.
    expect(underRoot("src/daemon.ts")).toBe(true);
    expect(underRoot("plugins/plan/src/subagents_config.ts")).toBe(true);
    expect(underRoot("plugins/plan/subagents.yaml")).toBe(true);
    expect(underRoot("package.json")).toBe(true);
  });
});

describe("walker hardening for the new edge classes", () => {
  test("worker specs parse from both inline and multi-line spawn forms", () => {
    const inline =
      'const w = new Worker(new URL("./a-worker.ts", import.meta.url).href, {});';
    expect(parseWorkerSpecs(inline)).toEqual(["./a-worker.ts"]);
    const multiline =
      'serverWorker = new Worker(\n  new URL("./b-worker.ts", import.meta.url).href,\n  { workerData },\n);';
    expect(parseWorkerSpecs(multiline)).toEqual(["./b-worker.ts"]);
  });

  test("stripComments is literal-aware: no phantom comments, no eaten code", () => {
    // A `/*` inside a `//` line comment must NOT open a block comment that eats
    // the code below it (the bug that hid ~9 daemon worker-spawn edges).
    const lineWithSlashStar =
      "const a = 1; // path .keeper/** here\nconst b = 2;\n";
    expect(stripComments(lineWithSlashStar)).toContain("const b = 2;");
    // A `//` inside a regex literal must not open a line comment that swallows a
    // following import.
    const regexThenImport = "const re = /x\\/\\*y/g;\nimport z from './z.ts';";
    expect(stripComments(regexThenImport)).toContain("import z from './z.ts';");
    // A comment-like sequence inside a string literal is inert (preserved).
    const stringLiteral = 'const s = "/* not a comment */"; const t = 3;';
    expect(stripComments(stringLiteral)).toContain("/* not a comment */");
    // A real block comment is still removed.
    expect(stripComments("a/* gone */b")).toBe("ab");
    // A real line comment is still removed.
    expect(stripComments("a // gone\nb")).toBe("a \nb");
  });
});

describe("daemon-fingerprint seam (pure core)", () => {
  test("parseRootsManifest strips comments, blanks, and whitespace", () => {
    const text =
      "# header\n\n  src  \nplugins/plan/src\n# trailing note\npackage.json\n";
    expect(parseRootsManifest(text)).toEqual([
      "src",
      "plugins/plan/src",
      "package.json",
    ]);
  });

  test("the committed manifest is non-empty and parses", () => {
    expect(roots.length).toBeGreaterThan(0);
    expect(roots).toContain("src");
    expect(roots).toContain("plugins/plan/src");
    expect(roots).toContain("plugins/plan/subagents.yaml");
  });

  test("composeRevParseArgs builds an argv array with no shell interpolation", () => {
    expect(composeRevParseArgs(["src", "package.json"])).toEqual([
      "rev-parse",
      "HEAD:src",
      "HEAD:package.json",
    ]);
  });

  test("composeFingerprint is deterministic, sorted, and matches an independent digest", () => {
    const input = {
      manifestHash: "abc123",
      // Intentionally unsorted to prove the composite sorts before hashing.
      roots: [
        { root: "src", hash: "deadbeef" },
        { root: "package.json", hash: "cafef00d" },
      ],
    };
    // Independent source of truth: sha256 of "manifest abc123\npackage.json
    // cafef00d\nsrc deadbeef", computed out-of-band with `shasum -a 256`.
    const expected =
      "4a2fe16235ffd4dc131cd1038f24a201eae7db83127a38ee11d96dbd839cd3d9";
    expect(composeFingerprint(input)).toBe(expected);
    // Two calls agree (determinism) and argv/manifest order cannot perturb it.
    expect(composeFingerprint(input)).toBe(composeFingerprint(input));
    const reordered = {
      manifestHash: "abc123",
      roots: [
        { root: "package.json", hash: "cafef00d" },
        { root: "src", hash: "deadbeef" },
      ],
    };
    expect(composeFingerprint(reordered)).toBe(expected);
  });

  test("composeFingerprint is sensitive to a moved root or a moved manifest", () => {
    const base = {
      manifestHash: "m0",
      roots: [{ root: "src", hash: "h0" }],
    };
    const rootMoved = {
      manifestHash: "m0",
      roots: [{ root: "src", hash: "h1" }],
    };
    const manifestMoved = {
      manifestHash: "m1",
      roots: [{ root: "src", hash: "h0" }],
    };
    expect(composeFingerprint(base)).not.toBe(composeFingerprint(rootMoved));
    expect(composeFingerprint(base)).not.toBe(
      composeFingerprint(manifestMoved),
    );
  });
});
