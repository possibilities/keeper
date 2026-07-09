/**
 * Structural import-boundary pin for the pure verdict core. Walks the transitive
 * relative-import closure from `src/reconcile-core.ts` (via the shared
 * `test/helpers/depgraph` walker — comment-stripped source reads only, fast tier)
 * and fails if any module in that closure VALUE-imports an impure driver or calls
 * a wall-clock. Import-type classification, comment stripping, and resolution live
 * in the shared helper; this file owns only the reconcile-specific bans below.
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
import { resolve } from "node:path";
import {
  parseImports,
  repoRoot,
  stripComments,
  walkClosure,
} from "./helpers/depgraph.ts";

const CLOSURE_ROOT = resolve(repoRoot, "src/reconcile-core.ts");

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
  const closure = walkClosure(CLOSURE_ROOT).files;

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
