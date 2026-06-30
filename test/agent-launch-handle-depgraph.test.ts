/**
 * Dep-graph hygiene pin for `src/agent/launch-handle.ts`. The shared launch→handle
 * helper (reached via `cli/agent.ts` off the cold-start `keeper plan` / `keeper
 * status` path) MUST NOT pull `src/db.ts` / `bun:sqlite` — that would drag the
 * daemon's DB graph onto a path with no daemon dependency. The module wires only
 * the already-db-free launch primitives (`pair-command` / `tmux-launch` / `args`)
 * and takes every effect as a seam, so its import scan must stay clean.
 *
 * Strips block + line comments BEFORE scanning (the module's own JSDoc names
 * `src/db.ts`/`bun:sqlite` as the thing to avoid — a naive full-text grep would
 * false-positive on the prose), then asserts no static OR dynamic import
 * specifier resolves to a `db` module or `bun:sqlite`. Comment-strip rather than
 * the line-filter form so a multi-line `import { … } from "./db"` is caught.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = realpathSync(resolve(dirname(import.meta.dirname), "."));

describe("launch-handle.ts is db.ts-free (hygiene grep)", () => {
  test("src/agent/launch-handle.ts imports no src/db.ts (no bun:sqlite drag)", () => {
    const src = readFileSync(
      join(repoRoot, "src", "agent", "launch-handle.ts"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // An `import … from "./db"` / `"../db"` or a dynamic `import("…/db")` would
    // drag the daemon's DB graph; `bun:sqlite` is the underlying native module.
    expect(code).not.toMatch(/from\s+["'][^"']*\bdb["']/);
    expect(code).not.toMatch(/import\(\s*["'][^"']*\bdb["']/);
    expect(code).not.toMatch(/bun:sqlite/);
  });
});
