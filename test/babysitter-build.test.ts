/**
 * `test/babysitter-build.test.ts` (fn-766 task .1) — the IMPORT-PIN that keeps a
 * keeper refactor from silently killing the performance sitter's ticks.
 *
 * Why this test exists. The performance sitter (`babysitters/performance/`) is
 * an external read-only scanner that imports a small slice of keeper's `src/`
 * (the `src/db.ts` resolvers + `openDb` + `atomicWriteFile`, the pure
 * `parsePlanRef` deriver, `scripts/backstop-stats`). It is NOT part of keeper's
 * own import graph, so a keeper refactor that removes / renames an export the
 * sitter's transitive graph re-exports does not break keeper's build — it breaks
 * the sitter SILENTLY.
 *
 * That is exactly the fn-756 incident: fn-756 removed an export
 * (`setApprovalKickSignal` from `src/rpc-handlers.ts`) that was RE-EXPORTED
 * across the transitive graph of the sitter's then-`isPidAlive`-from-
 * `server-worker` import. Every `watch.ts --tick` died at module-load with
 * `SyntaxError: Export named 'setApprovalKickSignal' not found …` — and nothing
 * in keeper's suite noticed. Only the standalone watchdog's 15-min staleness
 * alarm caught it, ~15 minutes late.
 *
 * The pin. A dynamic `import()` of each sitter entrypoint forces Bun's ESM
 * loader to LINK the whole transitive graph the same way `bun run watch.ts
 * --tick` does in production. A removed / renamed RE-EXPORT anywhere in the graph
 * throws `SyntaxError: export '…' not found` at link time, so this test goes RED
 * at commit time on the fn-756 class. (`Bun.build` is deliberately NOT used — the
 * bundler tolerates a missing re-export; only a live ESM link reproduces the
 * production failure. A plain missing NAMED import that is never called is
 * genuinely inert in Bun, so it is correctly not a failure.) The sitter
 * entrypoints guard their CLI body behind `if (import.meta.main)`, so importing
 * them is inert — it links + evaluates module scope without running a tick.
 *
 * fn-766 also narrowed the sitter's import surface — dropping the whole
 * `src/server-worker.ts` module in favor of a two-line local `isPidAlive` — so
 * the graph this pins is minimal. The text-assertion below guards that narrowing
 * against regression.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/** The sitter standalone bun entrypoints (NOT keeper subcommands). */
const SITTER_ENTRYPOINTS = [
  "babysitters/performance/watch.ts",
  "babysitters/builds/watch.ts",
  "babysitters/builds/watchdog.ts",
  "babysitters/helptailing/watch.ts",
] as const;

describe("babysitter import-pin (fn-766)", () => {
  for (const rel of SITTER_ENTRYPOINTS) {
    test(`${rel} links — its keeper-src re-exports all resolve`, async () => {
      // A missing re-export anywhere in the transitive graph throws at link
      // time (the fn-756 class). `import.meta.main` is false under the test
      // runner, so the CLI body does not run — this only links + evaluates
      // module scope. A successful link resolves to the module namespace.
      const mod = await import(join(REPO_ROOT, rel));
      expect(mod).toBeDefined();
    });
  }

  test("watch.ts exposes the public surface the --tick path wires", async () => {
    // Pin the named exports the production `--tick` / `--json` paths depend on,
    // so a refactor that drops one fails here rather than at the next launchd
    // tick. (Importing the module already links its graph; this asserts the
    // surface is the shape the CLI entry + tests consume.)
    const mod = await import(
      join(REPO_ROOT, "babysitters/performance/watch.ts")
    );
    for (const name of ["scan", "tick", "liveDeps", "liveTickDeps", "main"]) {
      expect(typeof mod[name]).toBe("function");
    }
  });

  test("watch.ts no longer imports the heavy src/server-worker module (fn-766)", async () => {
    // The fn-756 break rode in through `isPidAlive` imported from the ~3k-line
    // `src/server-worker.ts`. fn-766 inlined that two-line helper, so the sitter
    // must NOT re-import server-worker (a regression would re-widen the surface
    // the import-pin has to defend). Match the actual IMPORT statement, not a
    // bare mention (the inlining rationale comment names the module deliberately).
    const src = await Bun.file(
      join(REPO_ROOT, "babysitters/performance/watch.ts"),
    ).text();
    expect(src).not.toMatch(/from\s+["'][^"']*src\/server-worker["']/);
    // And it still owns a local isPidAlive (the inlined replacement).
    expect(src).toContain("export function isPidAlive");
  });
});
