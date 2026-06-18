// Byte-parity unit tests for src/specs.ts (the done verb's spec-patch port).
//
// patchTaskSection + ensureValidTaskSpec are whitespace-sensitive and the
// four-H2 template is the contract, so each case is byte-compared against a
// frozen golden literal captured from the section-patch spec — the executable
// contract the bun port is held to byte-for-byte.

import { describe, expect, test } from "bun:test";

import {
  ensureValidTaskSpec,
  patchTaskSection,
  validateTaskSpecHeadings,
} from "../src/specs.ts";

const FOUR_H2 =
  "## Description\nseed-1\n\n## Acceptance\n- [ ] x\n\n## Done summary\n\n## Evidence\n";

describe("patchTaskSection byte-parity with the frozen spec", () => {
  test("patches ## Done summary on the seed four-H2 spec", () => {
    expect(patchTaskSection(FOUR_H2, "## Done summary", "shipped it")).toBe(
      "## Description\nseed-1\n\n## Acceptance\n- [ ] x\n\n## Done summary\nshipped it\n## Evidence\n",
    );
  });

  test("patches the trailing ## Evidence section", () => {
    const body = "- Commits: abc123\n- Tests: pytest";
    expect(patchTaskSection(FOUR_H2, "## Evidence", body)).toBe(
      "## Description\nseed-1\n\n## Acceptance\n- [ ] x\n\n## Done summary\n\n## Evidence\n- Commits: abc123\n- Tests: pytest",
    );
  });

  test("empty body collapses the section to its heading only", () => {
    expect(patchTaskSection(FOUR_H2, "## Done summary", "")).toBe(
      "## Description\nseed-1\n\n## Acceptance\n- [ ] x\n\n## Done summary\n\n## Evidence\n",
    );
  });

  test("a body whose first line repeats the heading is stripped", () => {
    const body = "## Done summary\nthe real summary";
    expect(patchTaskSection(FOUR_H2, "## Done summary", body)).toBe(
      "## Description\nseed-1\n\n## Acceptance\n- [ ] x\n\n## Done summary\nthe real summary\n## Evidence\n",
    );
  });

  test("a middle section patch leaves later sections intact", () => {
    expect(patchTaskSection(FOUR_H2, "## Acceptance", "- [x] done")).toBe(
      "## Description\nseed-1\n\n## Acceptance\n- [x] done\n## Done summary\n\n## Evidence\n",
    );
  });

  test("multiline body preserves interior blank lines", () => {
    const body = "line one\n\nline three";
    expect(patchTaskSection(FOUR_H2, "## Done summary", body)).toBe(
      "## Description\nseed-1\n\n## Acceptance\n- [ ] x\n\n## Done summary\nline one\n\nline three\n## Evidence\n",
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
