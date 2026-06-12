// Byte-parity unit tests for src/specs.ts (the done verb's spec-patch port).
//
// patchTaskSection + ensureValidTaskSpec are whitespace-sensitive and the
// four-H2 template is the contract, so each case is byte-compared against the
// real planctl.specs.patch_task_section spawned via python3 — the same
// golden-against-Python shape src-store-write.test.ts uses for the serializer.

import { describe, expect, test } from "bun:test";

import {
  ensureValidTaskSpec,
  patchTaskSection,
  validateTaskSpecHeadings,
} from "../src/specs.ts";

const FOUR_H2 =
  "## Description\nseed-1\n\n## Acceptance\n- [ ] x\n\n## Done summary\n\n## Evidence\n";

/** Patch a section through the real Python planctl.specs.patch_task_section —
 * the executable spec the bun port is held to byte-for-byte. */
function pythonPatch(content: string, section: string, body: string): string {
  const proc = Bun.spawnSync(
    [
      "python3",
      "-c",
      "import json,sys;from planctl.specs import patch_task_section as p;" +
        "a=json.load(sys.stdin);sys.stdout.write(p(a['c'],a['s'],a['b']))",
    ],
    {
      stdin: Buffer.from(JSON.stringify({ c: content, s: section, b: body })),
      cwd: `${import.meta.dir}/..`,
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(`python patch failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

describe("patchTaskSection byte-parity with Python", () => {
  test("patches ## Done summary on the seed four-H2 spec", () => {
    expect(patchTaskSection(FOUR_H2, "## Done summary", "shipped it")).toBe(
      pythonPatch(FOUR_H2, "## Done summary", "shipped it"),
    );
  });

  test("patches the trailing ## Evidence section", () => {
    const body = "- Commits: abc123\n- Tests: pytest";
    expect(patchTaskSection(FOUR_H2, "## Evidence", body)).toBe(
      pythonPatch(FOUR_H2, "## Evidence", body),
    );
  });

  test("empty body collapses the section to its heading only", () => {
    expect(patchTaskSection(FOUR_H2, "## Done summary", "")).toBe(
      pythonPatch(FOUR_H2, "## Done summary", ""),
    );
  });

  test("a body whose first line repeats the heading is stripped", () => {
    const body = "## Done summary\nthe real summary";
    expect(patchTaskSection(FOUR_H2, "## Done summary", body)).toBe(
      pythonPatch(FOUR_H2, "## Done summary", body),
    );
  });

  test("a middle section patch leaves later sections intact", () => {
    expect(patchTaskSection(FOUR_H2, "## Acceptance", "- [x] done")).toBe(
      pythonPatch(FOUR_H2, "## Acceptance", "- [x] done"),
    );
  });

  test("multiline body preserves interior blank lines", () => {
    const body = "line one\n\nline three";
    expect(patchTaskSection(FOUR_H2, "## Done summary", body)).toBe(
      pythonPatch(FOUR_H2, "## Done summary", body),
    );
  });
});

describe("patchTaskSection error parity", () => {
  test("missing section throws", () => {
    expect(() => patchTaskSection(FOUR_H2, "## Nope", "x")).toThrow(
      "Section '## Nope' not found in task spec",
    );
  });

  test("duplicate heading throws", () => {
    const dup = `${FOUR_H2}## Done summary\nsecond\n`;
    expect(() => patchTaskSection(dup, "## Done summary", "x")).toThrow(
      "Cannot patch: duplicate heading '## Done summary' found (2 times)",
    );
  });
});

describe("ensureValidTaskSpec / validateTaskSpecHeadings", () => {
  test("the four-H2 seed spec validates clean", () => {
    expect(validateTaskSpecHeadings(FOUR_H2)).toEqual([]);
    expect(() => ensureValidTaskSpec(FOUR_H2)).not.toThrow();
  });

  test("missing heading is reported", () => {
    const noEvidence = "## Description\n\n## Acceptance\n\n## Done summary\n";
    expect(validateTaskSpecHeadings(noEvidence)).toContain(
      "Missing required heading: ## Evidence",
    );
    expect(() => ensureValidTaskSpec(noEvidence)).toThrow(
      "Missing required heading: ## Evidence",
    );
  });

  test("duplicate heading is reported with its count", () => {
    const dup = `${FOUR_H2}## Evidence\n`;
    expect(validateTaskSpecHeadings(dup)).toContain(
      "Duplicate heading: ## Evidence (found 2 times)",
    );
  });
});
