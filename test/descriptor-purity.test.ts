/**
 * Import-graph pin for the three pure-data CLI descriptor modules (ADR 0008):
 * `cli/descriptor.ts` and `plugins/{plan,prompt}/src/descriptor.ts`. The help and
 * completion paths lazily consume these — `cli/keeper.ts` merges the plan/prompt
 * verb sets for `keeper --help --json` and completions — so each MUST resolve with
 * ZERO runtime (non-type) imports: no plugin boot, no `src/db.ts`, no daemon
 * client. A single value import would let a `--help` open a database or touch the
 * socket. This asserts that at the source, the independent source of truth being
 * the module text itself (comments stripped so the modules' own purity-contract
 * prose, which names `import`, never trips the scan).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

const DESCRIPTOR_MODULES = [
  "cli/descriptor.ts",
  "plugins/plan/src/descriptor.ts",
  "plugins/prompt/src/descriptor.ts",
] as const;

/** Strip block + line comments so header prose naming `import` is not scanned. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readCode(rel: string): string {
  return stripComments(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

describe("CLI descriptor modules carry zero non-type imports (ADR 0008)", () => {
  for (const rel of DESCRIPTOR_MODULES) {
    test(`${rel}`, () => {
      const code = readCode(rel);
      // A VALUE `import … from …` (anything but `import type …`) is a runtime dep.
      expect(code).not.toMatch(/\bimport\s+(?!type\b)[^;]*?\bfrom\b/);
      // A bare side-effect `import "…"` or a dynamic `import(…)` is a runtime dep.
      expect(code).not.toMatch(/\bimport\s*['"(]/);
    });
  }

  test("the native + plan descriptors import NOTHING at all — pure literals", () => {
    // Neither carries even a type import: self-contained data + local lookups.
    for (const rel of ["cli/descriptor.ts", "plugins/plan/src/descriptor.ts"]) {
      expect(readCode(rel)).not.toMatch(/\bimport\b/);
    }
  });

  test("the prompt descriptor's ONLY import is a type import from cli/descriptor", () => {
    // It reuses the ordinal-1 CommandDescriptor/FlagDescriptor shapes; a type
    // import is erased at build, so the module stays runtime-dependency-free.
    const code = readCode("plugins/prompt/src/descriptor.ts");
    const imports = code.match(/\bimport\b[^;]*?\bfrom\b[^;]*;/g) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toContain("import type");
    expect(imports[0]).toContain("cli/descriptor");
  });
});
