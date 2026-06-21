// Unit tests for validateScaffoldYaml — the dry-run validation half of scaffold,
// shared (not copied) with followup submit's scaffold-validate step. These pin
// the failure-code priority order and the ok/nTasks success shape so the dry-run
// stays behavior-identical to runScaffold's inline validation (the conformance
// divergence tests cross-check the two against the real binary). Mirrors the
// Python validate_scaffold_yaml unit coverage in tests/test_followup_submit.py.

import { describe, expect, test } from "bun:test";

import {
  buildSourceRepoGuard,
  validateScaffoldYaml,
} from "../src/verbs/scaffold.ts";

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
  opts: {
    deps?: Record<number, number[]>;
    targetRepos?: Record<number, string>;
  } = {},
): string {
  const deps = opts.deps ?? {};
  const targetRepos = opts.targetRepos ?? {};
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
    if (targetRepos[i]) {
      lines.push(`    target_repo: ${targetRepos[i]}`);
    }
    lines.push("    spec: |");
    lines.push(`      ${TASK_SPEC}`);
  }
  return `${lines.join("\n")}\n`;
}

function validate(
  yaml: string,
  checkEpicDeps = false,
  sourceRepoGuard: Parameters<typeof validateScaffoldYaml>[3] = null,
) {
  return validateScaffoldYaml(
    Buffer.from(yaml, "utf-8"),
    "t",
    checkEpicDeps,
    sourceRepoGuard,
  );
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

  test("collects per-task target_repos on the success return", () => {
    const result = validate(
      followupYaml(2, { targetRepos: { 1: "/repo/a", 2: "/repo/b" } }),
    );
    expect(result.ok).toBe(true);
    expect(result.taskTargetRepos).toEqual(["/repo/a", "/repo/b"]);
  });

  test("omitted target_repo collects as null", () => {
    const result = validate(followupYaml(2, { targetRepos: { 1: "/repo/a" } }));
    expect(result.ok).toBe(true);
    expect(result.taskTargetRepos).toEqual(["/repo/a", null]);
  });
});

// ---------------------------------------------------------------------------
// Cross-repo follow-up guard (multi-repo source → repo_required)
// ---------------------------------------------------------------------------

describe("validateScaffoldYaml cross-repo guard", () => {
  // Two non-existent absolute paths normalize to themselves (realpath falls
  // back to the absolute form), so the guard is deterministic without real git.
  const A = "/repo/source-a";
  const B = "/repo/source-b";

  test("single-repo source → no guard fires (default-to-primary preserved)", () => {
    const guard = buildSourceRepoGuard([A], A);
    expect(guard.multiRepo).toBe(false);
    const result = validate(followupYaml(2), false, guard);
    expect(result.ok).toBe(true);
  });

  test("multi-repo source with an omitted target_repo → repo_required", () => {
    const guard = buildSourceRepoGuard([A, B], A);
    expect(guard.multiRepo).toBe(true);
    const result = validate(
      followupYaml(2, { targetRepos: { 1: A } }),
      false,
      guard,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("repo_required");
    expect(result.details.some((d) => d.includes("task #2"))).toBe(true);
  });

  test("multi-repo source, every task carries an in-set target_repo → ok", () => {
    const guard = buildSourceRepoGuard([A, B], A);
    const result = validate(
      followupYaml(2, { targetRepos: { 1: A, 2: B } }),
      false,
      guard,
    );
    expect(result.ok).toBe(true);
  });

  test("multi-repo source, an out-of-set target_repo → repo_required", () => {
    const guard = buildSourceRepoGuard([A, B], A);
    const result = validate(
      followupYaml(2, { targetRepos: { 1: A, 2: "/repo/elsewhere" } }),
      false,
      guard,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("repo_required");
    expect(result.details.some((d) => d.includes("not in the source"))).toBe(
      true,
    );
  });

  test("a structural error (missing tier) outranks repo_required", () => {
    const guard = buildSourceRepoGuard([A, B], A);
    // task 2 lacks a tier AND lacks a target_repo; tier_invalid wins.
    const yaml =
      "epic:\n  title: FU\n  spec: |\n    ## Overview\n    x\ntasks:\n" +
      `  - title: t1\n    tier: medium\n    target_repo: ${A}\n    spec: |\n` +
      `      ${TASK_SPEC}\n` +
      "  - title: t2\n    spec: |\n" +
      `      ${TASK_SPEC}\n`;
    const result = validate(yaml, false, guard);
    expect(result.code).toBe("tier_invalid");
  });
});
