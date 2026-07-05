// Engine-agnostic conformance spec for `planctl refine-apply` — translated from
// tests/test_refine_apply.py, every node mapped by a source-comment. The delta
// applier over an existing epic: add_tasks / rewrite_specs / rewire_deps / epic-
// spec rewrite, the mixed existing-id + new-ordinal dep resolver, post-delta cycle
// rejection, the last_validated_at re-stamp, exactly-one invocation; the failure
// family (epic_not_found / target_invalid / dep_invalid / spec_invalid / bad_yaml);
// per-task target_repo persistence + touched_repos recompute (union / idempotent /
// stale-reject) + the repo_invalid / bad_yaml guards; stdin; the per-task tier
// enforcement on add_tasks (required, tier_invalid / bad_yaml, collect-all); the
// no-rollback persist-on-pre-commit-failure for the missing-session-id path.
//
// Every fixture is a real-git withProject — refine-apply seeds via scaffold then
// writes + auto-commits, so it needs real git history.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  firstJsonPayload,
  gitInit,
  type ProjectHandle,
  runCli,
  withProject,
} from "./harness.ts";

const VALID_TASK_SPEC = [
  "## Description",
  "Implement the thing.",
  "",
  "## Acceptance",
  "- [ ] It works.",
  "",
  "## Done summary",
  "",
  "## Evidence",
  "",
].join("\n");

let project: ProjectHandle;
const getProject = withProject("planctl-refine-");
beforeEach(() => {
  project = getProject();
});

function run(
  args: string[],
  opts: { input?: string; env?: Record<string, string> } = {},
) {
  return runCli(args, {
    cwd: project.root,
    home: project.home,
    input: opts.input,
    env: opts.env,
  });
}

function indent(text: string, n: number): string {
  const prefix = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : ""))
    .join("\n");
}

function parseEnvelope(output: string): Record<string, unknown> {
  return firstJsonPayload(output);
}

function countInvocationLines(output: string): number {
  return output
    .trim()
    .split("\n")
    .filter((ln) => ln.trim().startsWith("{") && ln.includes("plan_invocation"))
    .length;
}

function writeDelta(content: string, name = "delta.yaml"): string {
  const path = join(project.root, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

function readEpic(epicId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(project.root, ".keeper", "epics", `${epicId}.json`),
      "utf-8",
    ),
  );
}

function readTask(taskId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      join(project.root, ".keeper", "tasks", `${taskId}.json`),
      "utf-8",
    ),
  );
}

function readTaskSpec(taskId: string): string {
  return readFileSync(
    join(project.root, ".keeper", "specs", `${taskId}.md`),
    "utf-8",
  );
}

function readEpicSpec(epicId: string): string {
  return readFileSync(
    join(project.root, ".keeper", "specs", `${epicId}.md`),
    "utf-8",
  );
}

function taskExists(taskId: string): boolean {
  return existsSync(join(project.root, ".keeper", "tasks", `${taskId}.json`));
}

// Scaffold a 2-task epic (task 2 deps on 1) and return its epic id. Port of
// _seed_two_task_epic.
function seedTwoTaskEpic(): string {
  const yaml =
    "epic:\n  title: refine apply seed\n  spec: |\n    ## Overview\n    seed epic.\n" +
    `tasks:\n  - title: First task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
    `  - title: Second task\n    deps: [1]\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
  const path = join(project.root, "seed.yaml");
  writeFileSync(path, yaml, "utf-8");
  const r = run(["scaffold", "--file", path]);
  expect(r.code).toBe(0);
  return parseEnvelope(r.output).epic_id as string;
}

function stampMarker(epicId: string): void {
  const data = readEpic(epicId);
  data.last_validated_at = "2020-01-01T00:00:00Z";
  writeFileSync(
    join(project.root, ".keeper", "epics", `${epicId}.json`),
    JSON.stringify(data),
    "utf-8",
  );
}

const NEW_SPEC =
  "## Description\nRewritten approach.\n\n" +
  "## Acceptance\n- [ ] New bar.\n\n## Done summary\n\n## Evidence\n";

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("refine-apply happy path", () => {
  test("add_tasks lands a new task with one invocation", () => {
    // test_refine_apply.py::test_refine_apply_add_task
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(true);
    expect(payload.added_task_ids).toEqual([`${epicId}.3`]);
    expect(countInvocationLines(r.output)).toBe(1);
    const pc = payload.plan_invocation as Record<string, unknown>;
    expect(pc.op).toBe("refine-apply");
    expect(pc.target).toBe(epicId);
    const newTask = readTask(`${epicId}.3`);
    expect(newTask.title).toBe("Third task");
    expect(newTask.depends_on).toEqual([]);
    expect(readTaskSpec(`${epicId}.3`)).toContain("Implement the thing.");
  });

  test("rewrite_specs replaces a task spec", () => {
    // test_refine_apply.py::test_refine_apply_rewrite_spec
    const epicId = seedTwoTaskEpic();
    const delta = `rewrite_specs:\n  - task_id: ${epicId}.1\n    spec: |\n${indent(NEW_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    expect(parseEnvelope(r.output).rewritten_specs).toEqual([`${epicId}.1`]);
    expect(readTaskSpec(`${epicId}.1`)).toContain("Rewritten approach.");
  });

  test("rewire_deps drops a dep", () => {
    // test_refine_apply.py::test_refine_apply_rewire_deps_drop_and_add
    const epicId = seedTwoTaskEpic();
    const delta = `rewire_deps:\n  - task_id: ${epicId}.2\n    deps: []\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    expect(parseEnvelope(r.output).rewired_deps).toEqual([`${epicId}.2`]);
    expect(readTask(`${epicId}.2`).depends_on).toEqual([]);
  });

  test("epic spec rewrite", () => {
    // test_refine_apply.py::test_refine_apply_rewrite_epic_spec
    const epicId = seedTwoTaskEpic();
    const delta =
      "epic:\n  spec: |\n    ## Overview\n    Rewritten epic spec.\n";
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    expect(parseEnvelope(r.output).epic_spec_rewritten).toBe(true);
    expect(readEpicSpec(epicId)).toContain("Rewritten epic spec.");
  });

  test("new task deps on both an existing id and a new ordinal", () => {
    // test_refine_apply.py::test_refine_apply_new_task_deps_on_existing_and_new
    const epicId = seedTwoTaskEpic();
    const delta =
      "add_tasks:\n" +
      `  - title: New A\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: New B\n    deps: [${epicId}.1, 1]\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    expect(parseEnvelope(r.output).added_task_ids).toEqual([
      `${epicId}.3`,
      `${epicId}.4`,
    ]);
    expect(readTask(`${epicId}.4`).depends_on).toEqual([
      `${epicId}.1`,
      `${epicId}.3`,
    ]);
  });

  test("re-stamps the validation marker to a strictly-newer value", () => {
    // test_refine_apply.py::test_refine_apply_restamps_validation_marker
    const epicId = seedTwoTaskEpic();
    stampMarker(epicId);
    const pre = readEpic(epicId).last_validated_at as string;
    expect(pre).not.toBeNull();
    const delta = "epic:\n  spec: |\n    ## Overview\n    touch it.\n";
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    const post = readEpic(epicId).last_validated_at as string;
    expect(typeof post === "string" && post > pre).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Failure shapes
// ---------------------------------------------------------------------------

describe("refine-apply failure shapes", () => {
  test("post-delta cycle is rejected, nothing written", () => {
    // test_refine_apply.py::test_refine_apply_cycle_rejected
    const epicId = seedTwoTaskEpic();
    const delta = `rewire_deps:\n  - task_id: ${epicId}.1\n    deps: [${epicId}.2]\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(1);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(false);
    expect((payload.error as Record<string, unknown>).code).toBe("dep_cycle");
    expect(readTask(`${epicId}.1`).depends_on).toEqual([]);
  });

  test("epic_not_found", () => {
    // test_refine_apply.py::test_refine_apply_epic_not_found
    seedTwoTaskEpic();
    const delta = "epic:\n  spec: |\n    ## Overview\n    x.\n";
    const r = run([
      "refine-apply",
      "fn-99999-nope",
      "--file",
      writeDelta(delta),
    ]);
    expect(r.code).toBe(1);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("epic_not_found");
  });

  test("target_invalid on a missing task id", () => {
    // test_refine_apply.py::test_refine_apply_target_invalid
    const epicId = seedTwoTaskEpic();
    const delta = `rewrite_specs:\n  - task_id: ${epicId}.99\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(1);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("target_invalid");
  });

  test("dep_invalid on a missing dep id", () => {
    // test_refine_apply.py::test_refine_apply_dep_invalid
    const epicId = seedTwoTaskEpic();
    const delta = `rewire_deps:\n  - task_id: ${epicId}.1\n    deps: [${epicId}.999]\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(1);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("dep_invalid");
  });

  test("spec_invalid on a malformed add_tasks spec", () => {
    // test_refine_apply.py::test_refine_apply_spec_invalid
    const epicId = seedTwoTaskEpic();
    const delta =
      "add_tasks:\n  - title: Bad spec task\n    deps: []\n    spec: |\n" +
      "      ## Description\n      missing the other required sections\n";
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(1);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("spec_invalid");
  });

  test("empty delta is bad_yaml", () => {
    // test_refine_apply.py::test_refine_apply_empty_delta_rejected
    const epicId = seedTwoTaskEpic();
    const r = run(["refine-apply", epicId, "--file", writeDelta("{}\n")]);
    expect(r.code).toBe(1);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("bad_yaml");
  });
});

// ---------------------------------------------------------------------------
// Per-task target_repo + touched_repos recompute
// ---------------------------------------------------------------------------

describe("refine-apply target_repo", () => {
  function foreignRepo(name: string): string {
    const dir = join(project.root, name);
    mkdirSync(dir, { recursive: true });
    gitInit(dir);
    return realpathSync(dir);
  }

  test("add_tasks declares target_repo: persisted + unioned into rollup", () => {
    // test_refine_apply.py::test_refine_apply_add_tasks_target_repo
    const foreignA = foreignRepo("foreign-a");
    const primary = realpathSync(project.root);
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${foreignA}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    expect(readTask(`${epicId}.3`).target_repo).toBe(foreignA);
    expect(readEpic(epicId).touched_repos).toEqual([primary, foreignA].sort());
  });

  test("add_tasks omits target_repo: falls back to primary", () => {
    // test_refine_apply.py::test_refine_apply_add_tasks_omit_target_repo
    const primary = realpathSync(project.root);
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    expect(readTask(`${epicId}.3`).target_repo).toBe(primary);
    expect(readEpic(epicId).touched_repos).toEqual([primary]);
  });

  test("relative target_repo is repo_invalid, no writes", () => {
    // test_refine_apply.py::test_refine_apply_add_tasks_relative_rejected
    const epicId = seedTwoTaskEpic();
    const epicBefore = readEpic(epicId);
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    target_repo: "apps/foo"\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(1);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("repo_invalid");
    expect(
      (err.details as string[]).some((d) => d.includes("absolute path")),
    ).toBe(true);
    expect(readEpic(epicId)).toEqual(epicBefore);
    expect(taskExists(`${epicId}.3`)).toBe(false);
  });

  test("rewrite_specs-only still recomputes touched_repos idempotently", () => {
    // test_refine_apply.py::test_refine_apply_recompute_on_rewrite_specs_only
    const primary = realpathSync(project.root);
    const epicId = seedTwoTaskEpic();
    expect(readEpic(epicId).touched_repos).toEqual([primary]);
    const delta = `rewrite_specs:\n  - task_id: ${epicId}.1\n    spec: |\n${indent(NEW_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    expect(readEpic(epicId).touched_repos).toEqual([primary]);
  });

  test("touched_repos unions existing + new", () => {
    // test_refine_apply.py::test_refine_apply_recompute_unions_existing_and_new
    const foreignB = foreignRepo("foreign-b");
    const primary = realpathSync(project.root);
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: New B\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${foreignB}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(0);
    expect(readEpic(epicId).touched_repos).toEqual([primary, foreignB].sort());
  });

  test("a stale on-disk target_repo surfaces as integrity_failed (not rewritten)", () => {
    // test_refine_apply.py::test_refine_apply_recompute_rejects_stale_target_repo
    const epicId = seedTwoTaskEpic();
    const stale = "/definitely/not/a/real/path/on/this/host";
    const t1Path = join(project.root, ".keeper", "tasks", `${epicId}.1.json`);
    const t1 = JSON.parse(readFileSync(t1Path, "utf-8"));
    t1.target_repo = stale;
    writeFileSync(t1Path, JSON.stringify(t1), "utf-8");

    const delta = `rewrite_specs:\n  - task_id: ${epicId}.2\n    spec: |\n${indent(NEW_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(1);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("integrity_failed");
    expect((err.details as string[]).some((d) => d.includes(stale))).toBe(true);
    expect(JSON.parse(readFileSync(t1Path, "utf-8")).target_repo).toBe(stale);
  });

  test("non-string target_repo is bad_yaml, no writes", () => {
    // test_refine_apply.py::test_refine_apply_target_repo_not_string_rejected
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    target_repo: 42\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).toBe(1);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(
      (err.details as string[]).some((d) =>
        d.includes("`target_repo` must be a string"),
      ),
    ).toBe(true);
    expect(taskExists(`${epicId}.3`)).toBe(false);
  });

  // test_refine_apply_target_repo_tilde_expansion — DROP (python_only): repoints
  //   HOME via in-process monkeypatch to expand `~` to a git root.
});

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

describe("refine-apply stdin", () => {
  test("--file - reads delta from stdin", () => {
    // test_refine_apply.py::test_refine_apply_reads_yaml_from_stdin
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", "-"], { input: delta });
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(true);
    expect(payload.added_task_ids).toEqual([`${epicId}.3`]);
    expect(countInvocationLines(r.output)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-task tier on add_tasks
// ---------------------------------------------------------------------------

describe("refine-apply add_tasks tier", () => {
  test("missing tier is tier_invalid with the allowlist", () => {
    // test_refine_apply.py::test_refine_apply_add_tasks_missing_tier_rejected
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("tier_invalid");
    const blob = (err.details as string[]).join(" ");
    expect(blob).toContain("missing");
    for (const v of ["low", "medium", "high", "xhigh", "max"]) {
      expect(blob).toContain(v);
    }
    expect(taskExists(`${epicId}.3`)).toBe(false);
  });

  test("unknown tier value is tier_invalid", () => {
    // test_refine_apply.py::test_refine_apply_add_tasks_invalid_tier_rejected
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: bogus\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("tier_invalid");
    expect((err.details as string[]).some((d) => d.includes("'bogus'"))).toBe(
      true,
    );
    expect(taskExists(`${epicId}.3`)).toBe(false);
  });

  test("every TASK_TIERS member persists", () => {
    // test_refine_apply.py::test_refine_apply_add_tasks_valid_tier_persists
    const tiers = ["low", "medium", "high", "xhigh", "max"];
    const epicId = seedTwoTaskEpic();
    const block = tiers
      .map(
        (tier, i) =>
          `  - title: tier add #${i + 1}\n    deps: []\n    tier: ${tier}\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`,
      )
      .join("");
    const r = run([
      "refine-apply",
      epicId,
      "--file",
      writeDelta(`add_tasks:\n${block}`),
    ]);
    expect(r.code).toBe(0);
    tiers.forEach((tier, i) => {
      expect(readTask(`${epicId}.${i + 3}`).tier).toBe(tier);
    });
  });

  test("non-string tier is bad_yaml", () => {
    // test_refine_apply.py::test_refine_apply_add_tasks_tier_non_string_is_bad_yaml
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: 42\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(
      (err.details as string[]).some((d) =>
        d.includes("`tier` must be a string"),
      ),
    ).toBe(true);
    expect(taskExists(`${epicId}.3`)).toBe(false);
  });

  test("tier collects all offenders", () => {
    // test_refine_apply.py::test_refine_apply_add_tasks_tier_collects_all_offenders
    const epicId = seedTwoTaskEpic();
    const delta =
      "add_tasks:\n" +
      `  - title: missing tier\n    deps: []\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: bogus tier\n    deps: []\n    tier: bogus\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).not.toBe(0);
    const details = (parseEnvelope(r.output).error as Record<string, unknown>)
      .details as string[];
    expect(
      details.some((d) => d.includes("add_tasks #1") && d.includes("missing")),
    ).toBe(true);
    expect(
      details.some((d) => d.includes("add_tasks #2") && d.includes("'bogus'")),
    ).toBe(true);
    expect(taskExists(`${epicId}.3`)).toBe(false);
    expect(taskExists(`${epicId}.4`)).toBe(false);
  });
});

describe("refine-apply add_tasks model", () => {
  test("missing model is model_invalid with the allowlist", () => {
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: medium\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("model_invalid");
    const blob = (err.details as string[]).join(" ");
    expect(blob).toContain("missing");
    expect(blob).toContain("opus");
    expect(taskExists(`${epicId}.3`)).toBe(false);
  });

  test("unknown model value is model_invalid", () => {
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: medium\n    model: gpt\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("model_invalid");
    expect((err.details as string[]).some((d) => d.includes("'gpt'"))).toBe(
      true,
    );
    expect(taskExists(`${epicId}.3`)).toBe(false);
  });

  test("model_invalid accumulates in the SAME pass as tier_invalid; tier wins priority", () => {
    const epicId = seedTwoTaskEpic();
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: ultrahigh\n    model: gpt\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("tier_invalid");
    const blob = (err.details as string[]).join(" ");
    expect(blob).toContain("'ultrahigh'");
    expect(blob).toContain("'gpt'");
    expect(taskExists(`${epicId}.3`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Commit-boundary: no-rollback persist-on-pre-commit-failure
// ---------------------------------------------------------------------------

describe("refine-apply commit boundary", () => {
  test("missing session id persists the written tree (no seam unwind)", () => {
    // test_refine_apply.py::test_refine_apply_missing_session_id_persists_writes
    const epicId = seedTwoTaskEpic();
    expect(taskExists(`${epicId}.3`)).toBe(false);
    const delta = `add_tasks:\n  - title: Third task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["refine-apply", epicId, "--file", writeDelta(delta)], {
      env: { CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(r.code).not.toBe(0);
    // The write phase completed before the invocation-build raise; the tree
    // persists on disk (§10 no-rollback).
    expect(taskExists(`${epicId}.3`)).toBe(true);
    expect(
      existsSync(join(project.root, ".keeper", "specs", `${epicId}.3.md`)),
    ).toBe(true);
  });

  // test_refine_apply_invocation_raise_persists_written_tree — DROP (python_only):
  //   monkeypatches build_planctl_invocation to raise post-write.
  // test_refine_apply_commit_failure_persists_written_tree — DROP (python_only):
  //   monkeypatches auto_commit_from_invocation to raise CommitFailed.
  // test_refine_apply_lock_disjoint_from_commit_lock — DROP (python_only):
  //   spies _epic_id_lock / _git_commit in-process for the lock-ordering proof.
});
