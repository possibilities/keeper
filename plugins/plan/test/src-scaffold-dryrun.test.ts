// Unit tests for validateScaffoldYaml — the dry-run validation half of scaffold,
// shared (not copied) with followup submit's scaffold-validate step. These pin
// the failure-code priority order and the ok/nTasks success shape so the dry-run
// stays behavior-identical to runScaffold's inline validation (the conformance
// divergence tests cross-check the two against the real binary). Mirrors the
// Python validate_scaffold_yaml unit coverage in tests/test_followup_submit.py.

import { describe, expect, test } from "bun:test";

import { validateScaffoldYaml } from "../src/verbs/scaffold.ts";

const TASK_SPEC = [
  "## Description",
  "x",
  "## Acceptance",
  "- [ ] x",
  "## Done summary",
  "## Evidence",
].join("\n      ");

function followupYaml(
  nTasks: number,
  opts: { deps?: Record<number, number[]> } = {},
): string {
  const deps = opts.deps ?? {};
  const lines = [
    "epic:",
    "  title: Follow up",
    "  spec: |",
    "    ## Overview",
    "    fu",
    "tasks:",
  ];
  for (let i = 1; i <= nTasks; i += 1) {
    lines.push(`  - title: task ${i}`);
    lines.push("    tier: medium");
    if (deps[i]) {
      lines.push(`    deps: [${deps[i].join(", ")}]`);
    }
    lines.push("    spec: |");
    lines.push(`      ${TASK_SPEC}`);
  }
  return `${lines.join("\n")}\n`;
}

function validate(yaml: string, checkEpicDeps = false) {
  return validateScaffoldYaml(Buffer.from(yaml, "utf-8"), "t", checkEpicDeps);
}

describe("validateScaffoldYaml", () => {
  test("accepts a well-formed multi-task plan with deps", () => {
    const result = validate(followupYaml(2, { deps: { 2: [1] } }));
    expect(result.ok).toBe(true);
    expect(result.nTasks).toBe(2);
  });

  test("non-mapping top-level → bad_yaml", () => {
    const result = validate("not a mapping\n");
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad_yaml");
  });

  test("missing tier → tier_invalid", () => {
    const yaml =
      "epic:\n  title: FU\n  spec: |\n    ## Overview\n    x\ntasks:\n" +
      "  - title: t1\n    spec: |\n" +
      `      ${TASK_SPEC}\n`;
    const result = validate(yaml);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("tier_invalid");
  });

  test("a spec missing required sections → spec_invalid", () => {
    const yaml =
      "epic:\n  title: FU\n  spec: |\n    ## Overview\n    x\ntasks:\n" +
      "  - title: t1\n    tier: medium\n    spec: |\n      just prose, no sections\n";
    const result = validate(yaml);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("spec_invalid");
  });

  test("a 1<->2 dep cycle → dep_cycle", () => {
    const result = validate(followupYaml(2, { deps: { 1: [2], 2: [1] } }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("dep_cycle");
  });

  test("oversize input → bad_yaml (byte cap, no parse)", () => {
    const result = validate("x".repeat(1 * 1024 * 1024 + 1));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("bad_yaml");
  });

  test("failure-code priority: spec_invalid wins over a later tier_invalid", () => {
    // task 1 has a bad spec; task 2 lacks a tier. spec_invalid outranks
    // tier_invalid in scaffold's priority order.
    const yaml =
      "epic:\n  title: FU\n  spec: |\n    ## Overview\n    x\ntasks:\n" +
      "  - title: t1\n    tier: medium\n    spec: |\n      just prose\n" +
      "  - title: t2\n    spec: |\n" +
      `      ${TASK_SPEC}\n`;
    const result = validate(yaml);
    expect(result.code).toBe("spec_invalid");
  });
});
