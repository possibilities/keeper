/**
 * Structural import-boundary pin for the pure verdict core. Generalizes the
 * single-file `run-capture` hygiene grep into a TRANSITIVE walker: starting at
 * `src/reconcile-core.ts` it resolves and walks the relative-import closure
 * (comment-stripped source reads only — fast tier, no subprocess) and fails if any
 * module in that closure VALUE-imports an impure driver or calls a wall-clock.
 *
 * Per-statement import-type aware: `import type` / `export type` are erased at
 * runtime and legal across the boundary, so they are DROPPED before every check
 * (an inline `import { type Foo, bar }` is still a value statement — it pulls `bar`
 * at runtime — so it is NOT dropped). Only value imports are banned or followed.
 *
 * Banned value imports (each a runtime edge that would drag the daemon's impure
 * graph onto the re-fold-safe verdict path):
 *   - bun:sqlite / any bun:*  — the native DB / runtime graph
 *   - a `db` gateway module    — the SQLite entry point (inputs arrive as a snapshot)
 *   - worktree-git             — the git DRIVER (geometry is a pure DAG function)
 *   - exec-backend             — the tmux/exec spawn driver
 *   - node:child_process / node:net / node:http — subprocess + socket IO
 * Plus a wall-clock tripwire: no `Date.now(` / `new Date(` anywhere in the closure
 * (reconcile takes `now` as data).
 *
 * node:fs / node:os are also verdict-path IO, but the extracted core still reaches
 * them at MODULE LOAD ONLY (constants resolved once, never re-read while
 * reconciling): KEEPER_ROOT's path resolve, the worktrees-root fallback, and the
 * model×effort YAML parse. Likewise readiness.ts keeps ONE documented read-path
 * wall-clock (a diagnostic timestamp; the fold path takes the ts as data). Those
 * exact sites are grandfathered below; each baseline is a RATCHET that only ever
 * shrinks — a NEW banned edge from any OTHER closure file (or a new one in a
 * grandfathered file) is a hard fail, and the baselines should reach ∅ once the
 * core-purification follow-up hoists those reads producer-side.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const repoRoot = realpathSync(resolve(dirname(import.meta.dirname), "."));
const CLOSURE_ROOT = resolve(repoRoot, "src/reconcile-core.ts");

/** Source extensions the walker follows / scans. A relative import that resolves
 *  to anything else (a `.yaml` / `.json` data asset) is a leaf: it holds no
 *  imports and no runtime code, so it is neither followed nor scanned. */
const SOURCE_EXTS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/** Strip block + line comments before any scan — a module's own prose names the
 *  very specifiers we ban, so a naive full-text grep would false-positive. Same
 *  idiom as `test/agent-run-capture-depgraph.test.ts`. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

interface ParsedImport {
  spec: string;
  /** `import type` / `export type` — erased at runtime, dropped before checks. */
  typeOnly: boolean;
}

/** Parse every import/export specifier out of already-comment-stripped code,
 *  classifying each STATEMENT (not the whole module) as type-only or value. */
function parseImports(code: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  // `import … from "spec"` and `export … from "spec"` (static + re-export),
  // spanning newlines for multi-line clauses. Type-only iff the clause between
  // the keyword and `from` starts with the `type` word (`import type …`,
  // `export type …`) — an inline `{ type Foo, bar }` starts with `{`, so the
  // statement stays a value import.
  const fromRe = /\b(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m = fromRe.exec(code);
  while (m !== null) {
    out.push({ spec: m[2], typeOnly: /^\s*type\b/.test(m[1]) });
    m = fromRe.exec(code);
  }
  // Bare side-effect import `import "spec"` (always a value edge).
  const bareRe = /\bimport\s+['"]([^'"]+)['"]/g;
  m = bareRe.exec(code);
  while (m !== null) {
    out.push({ spec: m[1], typeOnly: false });
    m = bareRe.exec(code);
  }
  // Dynamic `import("spec")` (always a value edge).
  const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  m = dynRe.exec(code);
  while (m !== null) {
    out.push({ spec: m[1], typeOnly: false });
    m = dynRe.exec(code);
  }
  return out;
}

/** Resolve a RELATIVE specifier to a source file in the closure, or `null` for a
 *  bare/`node:` specifier (not walked) or a non-source asset (a leaf). */
function resolveSource(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    ...SOURCE_EXTS.map((e) => base + e),
    ...SOURCE_EXTS.map((e) => resolve(base, `index${e}`)),
  ];
  for (const c of candidates) {
    if (SOURCE_EXTS.some((e) => c.endsWith(e)) && existsSync(c)) return c;
  }
  return null;
}

interface ClosureFile {
  abs: string;
  rel: string;
  code: string;
  valueSpecs: string[];
}

/** Walk the transitive relative-import closure from `rootAbs`, returning every
 *  visited source file with its comment-stripped code + value-import specifiers. */
function walkClosure(rootAbs: string): ClosureFile[] {
  const visited = new Set<string>();
  const queue = [rootAbs];
  const files: ClosureFile[] = [];
  while (queue.length > 0) {
    const abs = queue.shift() as string;
    if (visited.has(abs)) continue;
    visited.add(abs);
    const code = stripComments(readFileSync(abs, "utf8"));
    const imports = parseImports(code);
    const valueSpecs: string[] = [];
    for (const imp of imports) {
      if (imp.typeOnly) continue;
      valueSpecs.push(imp.spec);
      const next = resolveSource(abs, imp.spec);
      if (next !== null) queue.push(next);
    }
    files.push({ abs, rel: relative(repoRoot, abs), code, valueSpecs });
  }
  return files;
}

/** Impure-driver value-import bans — each edge would pull the daemon's IO graph
 *  onto the verdict path. Ordered list of `{match, why}` so a hit reports WHY. */
const DRIVER_BANS: { match: (spec: string) => boolean; why: string }[] = [
  {
    match: (s) => s === "bun:sqlite" || s.startsWith("bun:"),
    why: "bun:sqlite / any bun:* native module = the daemon DB/runtime graph",
  },
  {
    match: (s) => /(?:^|\/)db(?:\.ts)?$/.test(s),
    why: "a db gateway module is the SQLite entry point (inputs arrive as a snapshot)",
  },
  {
    match: (s) => s.includes("worktree-git"),
    why: "worktree-git is the git DRIVER; geometry is a pure DAG function",
  },
  {
    match: (s) => s.includes("exec-backend"),
    why: "exec-backend is the tmux/exec spawn driver (type-only imports are dropped first)",
  },
  {
    match: (s) => s === "node:child_process",
    why: "spawning a subprocess is a producer-side effect",
  },
  {
    match: (s) => s === "node:net" || s === "node:http",
    why: "sockets/HTTP are IO the pure core must not reach",
  },
];

/** node:fs / node:os value imports are banned EXCEPT at these grandfathered
 *  module-load sites. Keyed by repo-relative path → the allowed specifiers. This
 *  baseline is a ratchet: it must only ever shrink (ideally to empty). */
const FS_OS_GRANDFATHER: Record<string, Set<string>> = {
  // KEEPER_ROOT: realpathSync + homedir resolve the worker cell-tree root ONCE at
  // module load — read as a constant while reconciling, never re-derived.
  "src/reconcile-core.ts": new Set(["node:fs", "node:os"]),
  // homedir() is the worktrees-root fallback when the producer omits the injected
  // root; the verdict path passes `worktreesRoot` in, so it stays env-free there.
  "src/worktree-plan.ts": new Set(["node:os"]),
  // readFileSync loads the embedded model×effort matrix YAML at config-parse time.
  "plugins/plan/src/yaml_input.ts": new Set(["node:fs"]),
  // readFileSync / readSync read stdin for the plan-config loader.
  "plugins/plan/src/stdin.ts": new Set(["node:fs"]),
};
const FS_OS_BANNED = new Set(["node:fs", "node:os"]);

/** Every banned-value-import violation in one file, as human-readable strings. */
function bannedHits(rel: string, valueSpecs: string[]): string[] {
  const hits: string[] = [];
  for (const spec of valueSpecs) {
    for (const ban of DRIVER_BANS) {
      if (ban.match(spec))
        hits.push(`${rel}: value-imports "${spec}" — ${ban.why}`);
    }
    if (FS_OS_BANNED.has(spec) && !FS_OS_GRANDFATHER[rel]?.has(spec)) {
      hits.push(
        `${rel}: value-imports "${spec}" — node IO outside the grandfathered module-load baseline`,
      );
    }
  }
  return hits;
}

/** Files allowed ONE documented read-path wall-clock. Same ratchet contract as
 *  FS_OS_GRANDFATHER: this baseline must only ever shrink. */
const WALLCLOCK_GRANDFATHER: Record<string, string> = {
  // readiness.ts#resolveEpicDep is the read-path wrapper that stamps a DIAGNOSTIC
  // `new Date().toISOString()`; the fold-safe path calls epic-deps#resolveEpicDep
  // with an event-derived ts, and the verdict itself takes `now` as data.
  "src/readiness.ts": "read-path diagnostic timestamp in resolveEpicDep",
};

/** Wall-clock tripwire on comment-stripped code — reconcile takes `now` as data.
 *  A grandfathered file is exempt (see WALLCLOCK_GRANDFATHER). */
function wallClockHits(rel: string, code: string): string[] {
  if (rel in WALLCLOCK_GRANDFATHER) return [];
  const hits: string[] = [];
  if (/\bDate\.now\s*\(/.test(code)) hits.push(`${rel}: Date.now(`);
  if (/\bnew\s+Date\s*\(/.test(code)) hits.push(`${rel}: new Date(`);
  return hits;
}

describe("reconcile-core.ts pure import boundary", () => {
  const closure = walkClosure(CLOSURE_ROOT);

  test("walk is non-vacuous (guards a silent resolution bug)", () => {
    // A resolution bug that visited only the root would make every ban below
    // pass vacuously. The real closure spans a dozen modules; anchor on a few.
    expect(closure.length).toBeGreaterThan(1);
    const rels = new Set(closure.map((f) => f.rel));
    expect(rels).toContain("src/reconcile-core.ts");
    expect(rels).toContain("src/readiness.ts");
    expect(rels).toContain("src/worktree-plan.ts");
  });

  test("no closure module value-imports an impure driver", () => {
    const hits = closure.flatMap((f) => bannedHits(f.rel, f.valueSpecs));
    expect(hits).toEqual([]);
  });

  test("no closure module (outside the grandfathered baseline) calls a wall-clock", () => {
    const hits = closure.flatMap((f) => wallClockHits(f.rel, f.code));
    expect(hits).toEqual([]);
  });
});

describe("import-boundary checker detects violations (injected)", () => {
  test("a banned driver value-import trips the ban", () => {
    for (const spec of [
      "bun:sqlite",
      "bun:ffi",
      "./db",
      "../src/db",
      "./worktree-git",
      "./exec-backend",
      "node:child_process",
      "node:net",
      "node:http",
    ]) {
      const hits = bannedHits("src/reconcile-core.ts", [spec]);
      expect(hits.length).toBeGreaterThan(0);
    }
  });

  test("node:fs/node:os trip OUTSIDE the grandfathered baseline, pass inside it", () => {
    // A NEW closure file reaching node IO is a hard fail.
    expect(
      bannedHits("src/armed-closure.ts", ["node:fs"]).length,
    ).toBeGreaterThan(0);
    expect(
      bannedHits("src/armed-closure.ts", ["node:os"]).length,
    ).toBeGreaterThan(0);
    // The exact grandfathered module-load sites pass.
    expect(bannedHits("src/reconcile-core.ts", ["node:fs", "node:os"])).toEqual(
      [],
    );
    expect(bannedHits("src/worktree-plan.ts", ["node:os"])).toEqual([]);
    // But only for the specifier they are grandfathered for.
    expect(
      bannedHits("src/worktree-plan.ts", ["node:fs"]).length,
    ).toBeGreaterThan(0);
  });

  test("a wall-clock call trips the tripwire; commented + grandfathered ones do not", () => {
    expect(
      wallClockHits("src/armed-closure.ts", "const t = Date.now();").length,
    ).toBeGreaterThan(0);
    expect(
      wallClockHits("src/armed-closure.ts", "const d = new Date( );").length,
    ).toBeGreaterThan(0);
    // A comment mention is stripped before the scan.
    expect(
      wallClockHits(
        "src/armed-closure.ts",
        stripComments("// see Date.now() note\n"),
      ),
    ).toEqual([]);
    // The grandfathered file is exempt (its one documented diagnostic clock).
    expect(wallClockHits("src/readiness.ts", "const d = new Date();")).toEqual(
      [],
    );
  });

  test("type-only imports are dropped; node:path passes; inline type stays a value", () => {
    // `import type` from a banned module is erased at runtime → legal.
    expect(
      parseImports('import type { Database } from "bun:sqlite";')[0],
    ).toEqual({
      spec: "bun:sqlite",
      typeOnly: true,
    });
    // An inline `type` specifier does NOT make the statement type-only.
    expect(
      parseImports('import { type Foo, Bar } from "bun:sqlite";')[0],
    ).toEqual({
      spec: "bun:sqlite",
      typeOnly: false,
    });
    // node:path is pure — never banned.
    expect(bannedHits("src/reconcile-core.ts", ["node:path"])).toEqual([]);
  });
});
