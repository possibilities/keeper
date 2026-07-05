// Engine-agnostic conformance spec for the creation/deletion surface —
// translated from tests/test_creation_verbs.py, every node mapped by a
// source-comment. scaffold / refine-apply / epic rm end-to-end through the
// compiled binary: the keystone {epic_id, task_ids, repo_distribution} envelope
// seed_epic rides, the YAML-scalar divergence matrix surfaced as error
// ENVELOPES (the unit-level yaml_input matrix in src-creation-machinery pins the
// thrown YamlInputError; this pins the CLI error.code / error.details — a
// distinct surface, so translated end-to-end not cited), the duplicate_epic
// guard + --allow-duplicate, the 1 MiB cap message, refine-apply delta + cap,
// and epic rm --dry-run / lock / --force.
//
// Each test runs against a withProject handle (a real git repo + planctl init —
// the planctl_git_repo port): scaffold's mint-time integrity gate uses real
// .git/. Slow bucket in pytest (integration); here they run by default since the
// compiled binary IS the unit under test.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { gitHeadSha, parseCliOutput, runCli, withProject } from "./harness.ts";

const VALID_TASK_SPEC =
  "## Description\nImplement the thing.\n\n## Acceptance\n- [ ] It works.\n\n" +
  "## Done summary\n\n## Evidence\n";

// Indent each line of *text* by *n* spaces (blank lines stay blank). Port of
// the pytest _indent helper for the scaffold YAML task-spec block.
function indent(text: string, n: number): string {
  const prefix = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : ""))
    .join("\n");
}

// One epic + one task. *epicExtra* injects extra epic-node lines (already
// 2-space indented); *tier* / *deps* are written verbatim so the scalar matrix
// can exercise their parse path. Port of _scaffold_yaml.
function scaffoldYaml(
  opts: { epicExtra?: string; tier?: string; deps?: string } = {},
): string {
  const { epicExtra = "", tier = "medium", deps = "[]" } = opts;
  return (
    "epic:\n  title: creation matrix\n" +
    epicExtra +
    "  spec: |\n    ## Overview\n    A creation-verb conformance fixture.\n" +
    "tasks:\n  - title: First task\n" +
    `    deps: ${deps}\n    tier: ${tier}\n    model: opus\n    spec: |\n` +
    `${indent(VALID_TASK_SPEC, 6)}\n`
  );
}

// Write *content* to <root>/plan.yaml and return the path. Port of _write_yaml.
function writeYaml(root: string, content: string): string {
  const path = join(root, "plan.yaml");
  writeFileSync(path, content, "utf-8");
  return path;
}

function scaffold(project: { root: string; home: string }, yaml: string) {
  return runCli(["scaffold", "--file", writeYaml(project.root, yaml)], {
    cwd: project.root,
    home: project.home,
    env: { CLAUDE_CODE_SESSION_ID: "test-creation-verbs" },
  });
}

function epicDef(root: string, epicId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, ".keeper", "epics", `${epicId}.json`), "utf-8"),
  );
}

const getProject = withProject("planctl-creation-");
const SID = { CLAUDE_CODE_SESSION_ID: "test-creation-verbs" };

// ===========================================================================
// Keystone: the scaffold success envelope seed_epic rides.
// ===========================================================================

describe("scaffold keystone envelope", () => {
  test("{epic_id, task_ids, sorted repo_distribution}", () => {
    // test_creation_verbs.py::test_scaffold_success_envelope_keystone
    const project = getProject();
    const yaml =
      "epic:\n  title: keystone epic\n  spec: |\n    ## Overview\n    keystone.\n" +
      "tasks:\n  - title: First task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n" +
      `${indent(VALID_TASK_SPEC, 6)}\n` +
      "  - title: Second task\n    deps: [1]\n    tier: high\n    model: opus\n    spec: |\n" +
      `${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = scaffold(project, yaml);
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    const epicId = payload.epic_id as string;
    expect(epicId.startsWith("fn-")).toBe(true);
    expect(payload.task_ids).toEqual([`${epicId}.1`, `${epicId}.2`]);

    const repoDist = payload.repo_distribution as Record<string, number>;
    expect(typeof repoDist).toBe("object");
    expect(Object.values(repoDist).reduce((a, b) => a + b, 0)).toBe(2);
    expect(Object.keys(repoDist)).toEqual([...Object.keys(repoDist)].sort());
    expect(Object.keys(repoDist)).toContain(project.root);
  });
});

// ===========================================================================
// YAML scalar divergence matrix — surfaced as CLI error envelopes.
// ===========================================================================

describe("yaml scalar matrix (error envelopes)", () => {
  test("norway boolean branch -> bad_yaml", () => {
    // test_creation_verbs.py::test_yaml_norway_boolean_branch_is_bad_yaml
    const r = scaffold(
      getProject(),
      scaffoldYaml({ epicExtra: "  branch: no\n" }),
    );
    expect(r.code).not.toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(false);
    const err = env.error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(err.details).toEqual([
      "epic: `branch` must be a string when present",
    ]);
  });

  test("norway boolean tier -> bad_yaml (type guard, not tier_invalid)", () => {
    // test_creation_verbs.py::test_yaml_norway_boolean_tier_is_bad_yaml_not_tier_invalid
    const r = scaffold(getProject(), scaffoldYaml({ tier: "no" }));
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(err.details).toEqual(["task #1: `tier` must be a string"]);
  });

  test("bad string tier -> tier_invalid (value guard)", () => {
    // test_creation_verbs.py::test_yaml_bad_string_tier_is_tier_invalid
    const r = scaffold(getProject(), scaffoldYaml({ tier: "ultrahigh" }));
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("tier_invalid");
    expect(err.details).toEqual([
      "task #1: `tier` 'ultrahigh' is not one of low, medium, high, xhigh, max",
    ]);
  });

  test("octal dep ordinal 010 coerces to 8 -> dep_invalid", () => {
    // test_creation_verbs.py::test_yaml_octal_dep_ordinal_coerces_to_decimal
    const r = scaffold(getProject(), scaffoldYaml({ deps: "[010]" }));
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("dep_invalid");
    expect(err.details).toEqual([
      "task #1: dep ordinal 8 out of range (must be 1..1)",
    ]);
  });

  test("underscore dep ordinal 1_0 coerces to 10 -> dep_invalid", () => {
    // test_creation_verbs.py::test_yaml_underscore_dep_ordinal_coerces_to_decimal
    const r = scaffold(getProject(), scaffoldYaml({ deps: "[1_0]" }));
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("dep_invalid");
    expect(err.details).toEqual([
      "task #1: dep ordinal 10 out of range (must be 1..1)",
    ]);
  });

  test("ISO-date title scalar is not a string", () => {
    // test_creation_verbs.py::test_yaml_iso_date_title_is_not_a_string
    const yaml =
      "epic:\n  title: 2024-01-01\n  spec: |\n    ## Overview\n    iso date title.\n" +
      "tasks:\n  - title: First task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n" +
      `${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = scaffold(getProject(), yaml);
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(err.details).toEqual(["epic: `title` must be a non-empty string"]);
  });

  test("duplicate key is silent last-wins", () => {
    // test_creation_verbs.py::test_yaml_duplicate_key_silent_last_wins
    const project = getProject();
    const yaml =
      "epic:\n  title: dup key matrix\n  branch: feat-first\n  branch: feat-second\n" +
      "  spec: |\n    ## Overview\n    duplicate key.\n" +
      "tasks:\n  - title: First task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n" +
      `${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = scaffold(project, yaml);
    expect(r.code).toBe(0);
    const epicId = parseCliOutput(r.output).epic_id as string;
    expect(epicDef(project.root, epicId).branch_name).toBe("feat-second");
  });
});

// ===========================================================================
// duplicate_epic guard + --allow-duplicate.
// ===========================================================================

describe("duplicate_epic guard", () => {
  test("a same-slug second scaffold hard-errors, zero new writes", () => {
    // test_creation_verbs.py::test_duplicate_epic_guard_details_shape
    const project = getProject();
    const yaml = scaffoldYaml();
    const first = scaffold(project, yaml);
    expect(first.code).toBe(0);
    const existingId = parseCliOutput(first.output).epic_id as string;

    const second = scaffold(project, yaml);
    expect(second.code).not.toBe(0);
    const err = parseCliOutput(second.output).error as Record<string, unknown>;
    expect(err.code).toBe("duplicate_epic");
    expect(err.details).toEqual([`${existingId} (status: open)`]);
    const epics = readdirSync(join(project.root, ".keeper", "epics")).filter(
      (f) => f.startsWith("fn-") && f.endsWith(".json"),
    );
    expect(epics.length).toBe(1);
  });

  test("--allow-duplicate mints a distinct fn-N with the same slug stem", () => {
    // test_creation_verbs.py::test_allow_duplicate_mints_distinct_fn_n
    const project = getProject();
    const yaml = scaffoldYaml();
    const first = scaffold(project, yaml);
    expect(first.code).toBe(0);
    const firstId = parseCliOutput(first.output).epic_id as string;

    const r = runCli(
      [
        "scaffold",
        "--file",
        writeYaml(project.root, yaml),
        "--allow-duplicate",
      ],
      { cwd: project.root, home: project.home, env: SID },
    );
    expect(r.code).toBe(0);
    const secondId = parseCliOutput(r.output).epic_id as string;
    expect(secondId).not.toBe(firstId);
    // Same slug stem (drop fn-N), distinct ordinal.
    expect(firstId.split("-").slice(2).join("-")).toBe(
      secondId.split("-").slice(2).join("-"),
    );
  });
});

// ===========================================================================
// 1 MiB cap message.
// ===========================================================================

describe("1 MiB cap", () => {
  test("--file over the cap reports the actual byte count", () => {
    // test_creation_verbs.py::test_scaffold_file_cap_reports_full_byte_count
    const project = getProject();
    const over = 1024 * 1024 + 50;
    const big = join(project.root, "big.yaml");
    writeFileSync(big, `# ${"x".repeat(over - 2)}`, "utf-8");
    const r = runCli(["scaffold", "--file", big], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(err.message).toBe(`YAML file exceeds 1048576 bytes (got ${over})`);
    expect(err.details).toEqual([`file: ${big}`]);
  });

  test("--file - stdin reports the truncated-read count", () => {
    // test_creation_verbs.py::test_scaffold_stdin_cap_reports_truncated_read_count
    const project = getProject();
    const payload = `# ${"x".repeat(1024 * 1024 + 500)}`;
    const r = runCli(["scaffold", "--file", "-"], {
      cwd: project.root,
      home: project.home,
      env: SID,
      input: payload,
    });
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(err.message).toBe("YAML file exceeds 1048576 bytes (got 1048577)");
    expect(err.details).toEqual(["file: -"]);
  });
});

// ===========================================================================
// refine-apply delta parse + stdin cap.
// ===========================================================================

describe("refine-apply", () => {
  test("empty delta is bad_yaml with empty details", () => {
    // test_creation_verbs.py::test_refine_apply_empty_delta_is_bad_yaml
    const project = getProject();
    const first = scaffold(project, scaffoldYaml());
    expect(first.code).toBe(0);
    const epicId = parseCliOutput(first.output).epic_id as string;

    const delta = join(project.root, "delta.yaml");
    writeFileSync(delta, "epic: {}\n", "utf-8");
    const r = runCli(["refine-apply", epicId, "--file", delta], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect((err.message as string).startsWith("Delta is empty")).toBe(true);
    expect(err.details).toEqual([]);
  });

  test("stdin delta over the cap reports the truncated-read count", () => {
    // test_creation_verbs.py::test_refine_apply_stdin_cap_reports_truncated_read_count
    const project = getProject();
    const first = scaffold(project, scaffoldYaml());
    expect(first.code).toBe(0);
    const epicId = parseCliOutput(first.output).epic_id as string;

    const payload = `# ${"x".repeat(1024 * 1024 + 500)}`;
    const r = runCli(["refine-apply", epicId, "--file", "-"], {
      cwd: project.root,
      home: project.home,
      env: SID,
      input: payload,
    });
    expect(r.code).not.toBe(0);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(err.message).toBe("YAML file exceeds 1048576 bytes (got 1048577)");
    expect(err.details).toEqual(["file: -"]);
  });
});

// ===========================================================================
// epic rm --dry-run / lock / --force.
// ===========================================================================

describe("epic rm", () => {
  test("--dry-run previews the unlink set without writing", () => {
    // test_creation_verbs.py::test_epic_rm_dry_run_previews_without_writing
    const project = getProject();
    const first = scaffold(project, scaffoldYaml());
    expect(first.code).toBe(0);
    const epicId = parseCliOutput(first.output).epic_id as string;

    const headBefore = gitHeadSha(project.root);
    const r = runCli(["epic", "rm", epicId, "--dry-run"], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.dry_run).toBe(true);
    expect(env.epic_id).toBe(epicId);
    expect(env.task_count).toBe(1);
    const removed = new Set(env.removed_files as string[]);
    expect(removed.has(`.keeper/epics/${epicId}.json`)).toBe(true);
    expect(removed.has(`.keeper/specs/${epicId}.md`)).toBe(true);
    expect(removed.has(`.keeper/specs/${epicId}.1.md`)).toBe(true);
    expect(removed.has(`.keeper/tasks/${epicId}.1.json`)).toBe(true);

    expect(
      existsSync(join(project.root, ".keeper", "epics", `${epicId}.json`)),
    ).toBe(true);
    expect(gitHeadSha(project.root)).toBe(headBefore);
  });

  test("a held lock blocks rm without --force", () => {
    // test_creation_verbs.py::test_epic_rm_live_lock_blocks_without_force
    const project = getProject();
    const first = scaffold(project, scaffoldYaml());
    expect(first.code).toBe(0);
    const epicId = parseCliOutput(first.output).epic_id as string;

    const locks = join(project.root, ".keeper", "state", "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${epicId}.1.lock`), "held", "utf-8");

    const r = runCli(["epic", "rm", epicId], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).not.toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(false);
    expect(env.error as string).toContain(`${epicId}.1 (locked)`);
    expect(
      existsSync(join(project.root, ".keeper", "epics", `${epicId}.json`)),
    ).toBe(true);
  });

  test("--force overrides a held lock", () => {
    // test_creation_verbs.py::test_epic_rm_force_overrides_live_lock
    const project = getProject();
    const first = scaffold(project, scaffoldYaml());
    expect(first.code).toBe(0);
    const epicId = parseCliOutput(first.output).epic_id as string;

    const locks = join(project.root, ".keeper", "state", "locks");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, `${epicId}.1.lock`), "held", "utf-8");

    const r = runCli(["epic", "rm", epicId, "--force"], {
      cwd: project.root,
      home: project.home,
      env: SID,
    });
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(true);
    expect(env.epic_id).toBe(epicId);
    expect(
      existsSync(join(project.root, ".keeper", "epics", `${epicId}.json`)),
    ).toBe(false);
    expect(
      existsSync(join(project.root, ".keeper", "tasks", `${epicId}.1.json`)),
    ).toBe(false);
  });
});
