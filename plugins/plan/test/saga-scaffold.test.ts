// Engine-agnostic conformance spec for `planctl scaffold` — translated from
// tests/test_scaffold.py, every node mapped by a source-comment. The single
// transactional mint: one plan_invocation envelope covering epic JSON + spec +
// every task JSON + spec; verbatim specs; 1-based ordinal deps + forward-ref two-
// pass resolution; epic-level depends_on_epics order-preservation + the typed
// epic_dep_invalid failure family; the bad_yaml / spec_invalid / dep_invalid /
// dep_cycle failure shapes (each writes nothing); per-task target_repo persistence
// + sorted-uniq repo_distribution rollup; repo_invalid / bad_yaml target_repo
// guards; the fresh-epic last_validated_at stamp + one-commit coverage; the
// missing-session-id fail-closed; stdin (--file -) + the 1 MiB cap; per-task tier
// persistence + the tier_invalid / bad_yaml tier guards + collect-all-offenders;
// the dup-slug guard + --allow-duplicate +
// the suffix false-positive regression + atomicity.
//
// Runs in the default tier: the harness withProject + gitInit fixture the repo
// through the fake VCS facade (a bare `.git/` dir satisfies scaffold's mint-time
// integrity gate's git-root resolution), so every node here spawns ZERO real git.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { runScaffold } from "../src/verbs/scaffold.ts";
import {
  firstJsonPayload,
  gitInit,
  gitLogCount,
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
const getProject = withProject("planctl-scaffold-");
beforeEach(() => {
  project = getProject();
});

function run(args: string[], opts: { input?: string } = {}) {
  return runCli(args, {
    cwd: project.root,
    home: project.home,
    input: opts.input,
  });
}

// Write a plan.yaml under the project root and return its path. Port of _write_yaml.
function writeYaml(content: string): string {
  const path = join(project.root, "plan.yaml");
  writeFileSync(path, content, "utf-8");
  return path;
}

// Indent every line of *text* by *n* spaces (blank lines stay blank). Port of _indent.
function indent(text: string, n: number): string {
  const prefix = " ".repeat(n);
  return text
    .split("\n")
    .map((line) => (line ? prefix + line : ""))
    .join("\n");
}

// First compact NDJSON line that parses as a JSON object. Port of _parse_envelope.
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

// The two-task plan with task 2 deps on [1]. Port of _two_task_yaml.
function twoTaskYaml(): string {
  return (
    "epic:\n  title: scaffold smoke test\n  spec: |\n    ## Overview\n" +
    "    A scaffold smoke test.\ntasks:\n  - title: First task\n    deps: []\n" +
    `    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
    "  - title: Second task\n    deps: [1]\n    tier: medium\n    model: opus\n    spec: |\n" +
    `${indent(VALID_TASK_SPEC, 6)}\n`
  );
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(project.root, ".keeper", rel), "utf-8"));
}

// No fn-* epic/task/spec files landed. Port of _no_epics_or_tasks_landed.
function noEpicsOrTasksLanded(): boolean {
  for (const sub of ["epics", "tasks", "specs"]) {
    const dir = join(project.root, ".keeper", sub);
    const glob = new Bun.Glob("fn-*.*");
    for (const _ of glob.scanSync({ cwd: dir, onlyFiles: true })) {
      return false;
    }
  }
  return true;
}

// Scaffold a one-task epic with the given title; return the allocated epic id.
// Port of _seed_epic (the in-file helper, NOT the harness scaffoldEpic).
function seedEpic(title = "seed epic"): string {
  const yaml =
    `epic:\n  title: ${title}\n  spec: |\n    ## Overview\n    seed.\n` +
    `tasks:\n  - title: only task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
  const r = run(["scaffold", "--file", writeYaml(yaml)]);
  expect(r.code).toBe(0);
  return parseEnvelope(r.output).epic_id as string;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("scaffold happy path", () => {
  test("emits exactly one invocation covering the full tree", () => {
    // test_scaffold.py::test_scaffold_happy_path_emits_one_invocation
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(true);
    const epicId = payload.epic_id as string;
    expect(epicId.startsWith("fn-")).toBe(true);
    expect(payload.task_ids).toEqual([`${epicId}.1`, `${epicId}.2`]);
    expect(countInvocationLines(r.output)).toBe(1);

    const pc = payload.plan_invocation as Record<string, unknown>;
    expect(pc.op).toBe("scaffold");
    expect(pc.target).toBe(epicId);
    expect(pc.subject).toBe(`chore(plan): scaffold ${epicId}`);
    const expected = [
      `.keeper/epics/${epicId}.json`,
      `.keeper/specs/${epicId}.md`,
      `.keeper/tasks/${epicId}.1.json`,
      `.keeper/specs/${epicId}.1.md`,
      `.keeper/tasks/${epicId}.2.json`,
      `.keeper/specs/${epicId}.2.md`,
    ];
    const files = new Set(pc.files as string[]);
    for (const f of expected) {
      expect(files.has(f)).toBe(true);
    }
  });

  test("writes verbatim specs, not skeletons", () => {
    // test_scaffold.py::test_scaffold_writes_verbatim_specs_not_skeletons
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    const spec1 = readFileSync(
      join(project.root, ".keeper", "specs", `${epicId}.1.md`),
      "utf-8",
    );
    expect(spec1).toContain("Implement the thing.");
    expect(spec1).toContain("- [ ] It works.");
  });

  test("1-based ordinal dep resolves to fn-N.M", () => {
    // test_scaffold.py::test_scaffold_dep_resolves_to_fn_n_m
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`tasks/${epicId}.2.json`).depends_on).toEqual([
      `${epicId}.1`,
    ]);
  });

  test("forward ref (task1 deps [2]) resolves via two-pass allocation", () => {
    // test_scaffold.py::test_scaffold_forward_ref_resolves
    const yaml =
      "epic:\n  title: forward ref test\n  spec: |\n    ## Overview\n    forward ref.\n" +
      `tasks:\n  - title: First task\n    deps: [2]\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: Second task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`tasks/${epicId}.1.json`).depends_on).toEqual([
      `${epicId}.2`,
    ]);
  });

  test("epic + task carry snippets/bundles + fresh validated marker", () => {
    // test_scaffold.py::test_scaffold_epic_carries_snippets_bundles
    const yaml =
      "epic:\n  title: snippet metadata\n  snippets: [snip-a, snip-b]\n" +
      "  bundles: [bundle/dev-env, bundle/snippeting-main]\n  spec: |\n    ## Overview\n    yes.\n" +
      "tasks:\n  - title: only task\n    deps: []\n    tier: medium\n    model: opus\n" +
      `    snippets: [task-snip]\n    bundles: [bundle/dev-env]\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    const epicDef = readJson(`epics/${epicId}.json`);
    expect(epicDef.snippets).toEqual(["snip-a", "snip-b"]);
    expect(epicDef.bundles).toEqual([
      "bundle/dev-env",
      "bundle/snippeting-main",
    ]);
    // scaffold mints the epic as a not-ready ghost (deferred arm).
    expect(epicDef.last_validated_at).toBeNull();
    const taskDef = readJson(`tasks/${epicId}.1.json`);
    expect(taskDef.snippets).toEqual(["task-snip"]);
    expect(taskDef.bundles).toEqual(["bundle/dev-env"]);
  });

  test("no epic branch defaults branch_name to main", () => {
    // test_scaffold.py::test_scaffold_no_branch_defaults_to_main
    const yaml =
      "epic:\n  title: no branch given\n  spec: |\n    ## Overview\n    yes.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`epics/${epicId}.json`).branch_name).toBe("main");
  });

  test("no substrate emits no advisory + single invocation", () => {
    // test_scaffold.py::test_scaffold_no_substrate_emits_no_advisory
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(true);
    expect("warnings" in payload).toBe(false);
    expect(countInvocationLines(r.output)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Epic-level depends_on_epics
// ---------------------------------------------------------------------------

describe("scaffold epic deps", () => {
  function epicDepYaml(depsLiteral: string, title = "dependent epic"): string {
    return (
      `epic:\n  title: ${title}\n  depends_on_epics: ${depsLiteral}\n  spec: |\n    ## Overview\n    x.\n` +
      `tasks:\n  - title: only task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`
    );
  }

  test("happy path preserves declared order", () => {
    // test_scaffold.py::test_scaffold_epic_dep_happy_path_preserves_order
    const first = seedEpic("seed epic first");
    const second = seedEpic("seed epic second");
    const r = run([
      "scaffold",
      "--file",
      writeYaml(epicDepYaml(`[${second}, ${first}]`)),
    ]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`epics/${epicId}.json`).depends_on_epics).toEqual([
      second,
      first,
    ]);
  });

  test("absent field coerces to []", () => {
    // test_scaffold.py::test_scaffold_no_epic_deps_yields_empty_list
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`epics/${epicId}.json`).depends_on_epics).toEqual([]);
  });

  test("non-list epic dep is typed epic_dep_invalid", () => {
    // test_scaffold.py::test_scaffold_epic_dep_non_list_is_typed
    const r = run([
      "scaffold",
      "--file",
      writeYaml(epicDepYaml('"fn-1-foo"', "bad dep type")),
    ]);
    expect(r.code).not.toBe(0);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("epic_dep_invalid");
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("list of non-strings is typed", () => {
    // test_scaffold.py::test_scaffold_epic_dep_list_of_non_strings_is_typed
    const r = run([
      "scaffold",
      "--file",
      writeYaml(epicDepYaml("[1, 2]", "bad dep elem type")),
    ]);
    expect(r.code).not.toBe(0);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("epic_dep_invalid");
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("malformed id is typed", () => {
    // test_scaffold.py::test_scaffold_epic_dep_malformed_id_is_typed
    const r = run([
      "scaffold",
      "--file",
      writeYaml(epicDepYaml("[fn-abc]", "malformed dep id")),
    ]);
    expect(r.code).not.toBe(0);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("epic_dep_invalid");
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("nonexistent dep is typed with a does-not-exist detail", () => {
    // test_scaffold.py::test_scaffold_epic_dep_nonexistent_is_typed
    const r = run([
      "scaffold",
      "--file",
      writeYaml(epicDepYaml("[fn-9999-nope]", "nonexistent dep")),
    ]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("epic_dep_invalid");
    expect(
      (err.details as string[]).some((d) => d.includes("does not exist")),
    ).toBe(true);
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("duplicate dep is typed", () => {
    // test_scaffold.py::test_scaffold_epic_dep_duplicate_is_typed
    const first = seedEpic();
    const r = run([
      "scaffold",
      "--file",
      writeYaml(epicDepYaml(`[${first}, ${first}]`, "dup dep")),
    ]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("epic_dep_invalid");
    expect(
      (err.details as string[]).some((d) => d.includes("duplicated")),
    ).toBe(true);
  });

  test("an all-done dep list still passes — the validator is STATUS-BLIND", () => {
    // Carve-out guarding the blocking close-gate dep substitution: the gate
    // substitutes the source's still-resolving epic-deps (status irrelevant) into
    // the follow-up, then scaffold re-validates them. A future "only depend on
    // non-done epics" hardening would silently break that substitution, so pin
    // that a dependent may declare a DONE dep and scaffold accepts it.
    const dep = seedEpic("done dep");
    const depPath = join(project.root, ".keeper", "epics", `${dep}.json`);
    const depDef = JSON.parse(readFileSync(depPath, "utf-8")) as Record<
      string,
      unknown
    >;
    depDef.status = "done";
    writeFileSync(depPath, `${JSON.stringify(depDef, null, 2)}\n`, "utf-8");

    const r = run([
      "scaffold",
      "--file",
      writeYaml(epicDepYaml(`[${dep}]`, "depends on a done epic")),
    ]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`epics/${epicId}.json`).depends_on_epics).toEqual([dep]);
  });
});

// ---------------------------------------------------------------------------
// Failure shapes — typed code, no writes
// ---------------------------------------------------------------------------

describe("scaffold failure shapes", () => {
  test("non-mapping doc is bad_yaml", () => {
    // test_scaffold.py::test_scaffold_bad_yaml_non_mapping_doc
    const r = run(["scaffold", "--file", writeYaml("just a string\n")]);
    expect(r.code).not.toBe(0);
    const env = parseEnvelope(r.output);
    expect(env.success).toBe(false);
    expect((env.error as Record<string, unknown>).code).toBe("bad_yaml");
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("empty tasks list is bad_yaml", () => {
    // test_scaffold.py::test_scaffold_empty_tasks_list_is_bad_yaml
    const yaml =
      "epic:\n  title: no tasks\n  spec: |\n    ## Overview\n    x.\ntasks: []\n";
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(
      (err.details as string[]).some((d) =>
        d.includes("tasks: must contain at least one entry"),
      ),
    ).toBe(true);
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("spec_invalid lists the offending task #2", () => {
    // test_scaffold.py::test_scaffold_spec_invalid_lists_offending_task
    const badSpec = "## Description\n\n## Acceptance\n\n## Done summary\n";
    const yaml =
      "epic:\n  title: malformed spec\n  spec: |\n    ## Overview\n    nope.\n" +
      `tasks:\n  - title: ok\n    deps: []\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: bad\n    deps: []\n    spec: |\n${indent(badSpec, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("spec_invalid");
    expect((err.details as string[]).some((d) => d.includes("task #2"))).toBe(
      true,
    );
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("out-of-range dep ordinal is dep_invalid", () => {
    // test_scaffold.py::test_scaffold_dep_out_of_range_is_typed
    const yaml =
      "epic:\n  title: bad ordinal\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: only task\n    deps: [5]\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("dep_invalid");
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("self-ref dep is dep_invalid", () => {
    // test_scaffold.py::test_scaffold_dep_self_ref_is_typed
    const yaml =
      "epic:\n  title: self ref\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: only task\n    deps: [1]\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("dep_invalid");
  });

  test("dep cycle is dep_cycle", () => {
    // test_scaffold.py::test_scaffold_dep_cycle_is_typed
    const yaml =
      "epic:\n  title: cycle\n  spec: |\n    ## Overview\n    cycle.\n" +
      `tasks:\n  - title: a\n    deps: [2]\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: b\n    deps: [1]\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    expect(
      (parseEnvelope(r.output).error as Record<string, unknown>).code,
    ).toBe("dep_cycle");
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  // test_scaffold_registered_in_verb_templates — CITED: the bun buildSubject is
  //   template-free; the happy-path subject assertion pins `chore(plan):
  //   scaffold <id>` (python_only VERB_TEMPLATES import).
  // scaffold is NOT an INTEGRITY_GATE_VERBS member — src-integrity.test.ts pins
  //   the canonical set (scaffold absent).
});

// ---------------------------------------------------------------------------
// Per-task target_repo + repo_distribution rollup
// ---------------------------------------------------------------------------

describe("scaffold target_repo", () => {
  // Two real git repos under the project tree (the multi_repo_project port).
  function twoForeignRepos(): [string, string] {
    const a = join(project.root, "foreign-a");
    const b = join(project.root, "foreign-b");
    for (const d of [a, b]) {
      mkdirSync(d, { recursive: true });
      gitInit(d);
    }
    return [realpathSync(a), realpathSync(b)];
  }

  test("default-omit: every task targets primary, single-element rollup", () => {
    // test_scaffold.py::test_scaffold_default_target_repo_unchanged
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    const epicId = payload.epic_id as string;
    const primary = realpathSync(project.root);
    expect(payload.repo_distribution).toEqual({ [primary]: 2 });
    const epicDef = readJson(`epics/${epicId}.json`);
    expect(epicDef.touched_repos).toEqual([primary]);
    expect(epicDef.primary_repo).toBe(primary);
    for (const i of [1, 2]) {
      expect(readJson(`tasks/${epicId}.${i}.json`).target_repo).toBe(primary);
    }
  });

  test("two distinct target_repos persist + sorted rollup", () => {
    // test_scaffold.py::test_scaffold_per_task_target_repo
    const [a, b] = twoForeignRepos();
    const yaml =
      "epic:\n  title: per task target repo\n  spec: |\n    ## Overview\n    fan out across repos.\n" +
      `tasks:\n  - title: task A\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${a}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: task B\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${b}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    const epicId = payload.epic_id as string;
    const dist = payload.repo_distribution as Record<string, number>;
    expect(dist).toEqual({ [a]: 1, [b]: 1 });
    expect(Object.keys(dist)).toEqual(Object.keys(dist).sort());
    expect(readJson(`epics/${epicId}.json`).touched_repos).toEqual(
      [a, b].sort(),
    );
    expect(readJson(`tasks/${epicId}.1.json`).target_repo).toBe(a);
    expect(readJson(`tasks/${epicId}.2.json`).target_repo).toBe(b);
  });

  test("mixed target_repo dedups, omitted task falls to primary", () => {
    // test_scaffold.py::test_scaffold_mixed_target_repo_dedup
    const [a, b] = twoForeignRepos();
    const yaml =
      "epic:\n  title: mixed dedup\n  spec: |\n    ## Overview\n    mixed.\n" +
      `tasks:\n  - title: task A\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${a}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: task B\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${a}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: task C\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    const primary = realpathSync(project.root);
    const epicDef = readJson(`epics/${epicId}.json`);
    expect(epicDef.touched_repos).toEqual([a, primary].sort());
    expect((epicDef.touched_repos as string[]).includes(b)).toBe(false);
    expect(readJson(`tasks/${epicId}.1.json`).target_repo).toBe(a);
    expect(readJson(`tasks/${epicId}.2.json`).target_repo).toBe(a);
    expect(readJson(`tasks/${epicId}.3.json`).target_repo).toBe(primary);
  });

  test("relative target_repo is rejected with repo_invalid", () => {
    // test_scaffold.py::test_scaffold_target_repo_relative_rejected
    const yaml =
      "epic:\n  title: relative path\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    target_repo: "apps/foo"\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("repo_invalid");
    expect(
      (err.details as string[]).some((d) => d.includes("absolute path")),
    ).toBe(true);
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("non-string target_repo is bad_yaml", () => {
    // test_scaffold.py::test_scaffold_target_repo_not_string_rejected
    const yaml =
      "epic:\n  title: bad target_repo type\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    target_repo: 42\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(
      (err.details as string[]).some((d) =>
        d.includes("`target_repo` must be a string"),
      ),
    ).toBe(true);
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("empty-after-strip target_repo is repo_invalid", () => {
    // test_scaffold.py::test_scaffold_target_repo_empty_string_rejected
    const yaml =
      "epic:\n  title: empty target_repo\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    target_repo: "   "\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("repo_invalid");
    expect(
      (err.details as string[]).some((d) =>
        d.includes("non-empty after strip"),
      ),
    ).toBe(true);
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  // test_scaffold_target_repo_tilde_expansion — DROP (python_only): repoints HOME
  //   to expand `~` to a git root via an in-process monkeypatch the conformance
  //   subprocess can't model deterministically.
});

// ---------------------------------------------------------------------------
// Fresh-epic marker + one-commit coverage + commit-boundary
// ---------------------------------------------------------------------------

describe("scaffold mint boundary", () => {
  test("fresh epic mints a null ghost marker (deferred arm)", () => {
    // scaffold mints last_validated_at:null — the epic is a not-ready ghost
    // (blocked by autopilot readiness predicate 2, rendered dashed) until the
    // create/defer/close flow's trailing `validate --epic` arms it once deps are
    // wired.
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    const marker = readJson(`epics/${epicId}.json`).last_validated_at;
    expect(marker).toBeNull();
  });

  test("the invocation covers the whole tree (one commit)", () => {
    // test_scaffold.py::test_scaffold_fresh_epic_emit_covers_one_commit
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    const epicId = payload.epic_id as string;
    const files = new Set(
      (payload.plan_invocation as Record<string, unknown>).files as string[],
    );
    for (const f of [
      `.keeper/epics/${epicId}.json`,
      `.keeper/specs/${epicId}.md`,
      `.keeper/tasks/${epicId}.1.json`,
      `.keeper/specs/${epicId}.1.md`,
      `.keeper/tasks/${epicId}.2.json`,
      `.keeper/specs/${epicId}.2.md`,
    ]) {
      expect(files.has(f)).toBe(true);
    }
  });

  test("missing session id fails closed before any write or commit", () => {
    // test_scaffold.py::test_scaffold_missing_session_id_writes_nothing
    const logBefore = gitLogCount(project.root);
    const r = runCli(["scaffold", "--file", writeYaml(twoTaskYaml())], {
      cwd: project.root,
      home: project.home,
      env: { CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("missing_session_id");
    expect(noEpicsOrTasksLanded()).toBe(true);
    expect(gitLogCount(project.root)).toBe(logBefore);
  });

  // test_scaffold_integrity_failure_aborts_no_writes — DROP (python_only):
  //   monkeypatches check_epic_tree_in_memory to a synthetic-error spy.
  // test_scaffold_invocation_raise_persists_written_tree — DROP (python_only):
  //   monkeypatches build_planctl_invocation to raise post-write.
  // test_scaffold_integrity_failure_leaves_scan_max_unchanged — DROP (python_only).
  // test_scaffold_integrity_failure_writes_no_spec_files_at_all — DROP (python_only).
});

// ---------------------------------------------------------------------------
// stdin support via `--file -`
// ---------------------------------------------------------------------------

describe("scaffold stdin", () => {
  test("--file - reads YAML from stdin", () => {
    // test_scaffold.py::test_scaffold_reads_yaml_from_stdin
    const r = run(["scaffold", "--file", "-"], { input: twoTaskYaml() });
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(true);
    const epicId = payload.epic_id as string;
    expect(epicId.startsWith("fn-")).toBe(true);
    expect(payload.task_ids).toEqual([`${epicId}.1`, `${epicId}.2`]);
    expect(countInvocationLines(r.output)).toBe(1);
  });

  test("the 1 MiB cap fires on stdin pre-decode", () => {
    // test_scaffold.py::test_scaffold_stdin_byte_cap_enforced
    const bigComment = `# ${"x".repeat(1024 * 1024 + 100)}\n`;
    const r = run(["scaffold", "--file", "-"], {
      input: bigComment + twoTaskYaml(),
    });
    expect(r.code).not.toBe(0);
    const env = parseEnvelope(r.output);
    expect(env.success).toBe(false);
    const err = env.error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(err.message as string).toContain("exceeds");
  });
});

// ---------------------------------------------------------------------------
// Per-task tier
// ---------------------------------------------------------------------------

describe("scaffold per-task tier", () => {
  test("tier persists per task", () => {
    // test_scaffold.py::test_scaffold_per_task_tier_persists
    const yaml =
      "epic:\n  title: per task tier\n  spec: |\n    ## Overview\n    tier per task.\n" +
      `tasks:\n  - title: task A\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: task B\n    deps: []\n    tier: xhigh\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`tasks/${epicId}.1.json`).tier).toBe("medium");
    expect(readJson(`tasks/${epicId}.2.json`).tier).toBe("xhigh");
  });

  function oneTaskTierYaml(tierLiteral: string, title: string): string {
    return (
      `epic:\n  title: ${title}\n  spec: |\n    ## Overview\n    x.\n` +
      `tasks:\n  - title: only task\n    deps: []\n    tier: ${tierLiteral}\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`
    );
  }

  test("missing tier field is tier_invalid with the allowlist", () => {
    // test_scaffold.py::test_scaffold_missing_tier_field_rejected
    const yaml =
      "epic:\n  title: missing tier\n  spec: |\n    ## Overview\n    no tier.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("tier_invalid");
    const blob = (err.details as string[]).join(" ");
    expect(blob).toContain("missing");
    for (const valid of ["low", "medium", "high", "xhigh", "max"]) {
      expect(blob).toContain(valid);
    }
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("unknown tier value is tier_invalid", () => {
    // test_scaffold.py::test_scaffold_tier_invalid_value_rejected
    const r = run([
      "scaffold",
      "--file",
      writeYaml(oneTaskTierYaml("bogus", "bogus tier")),
    ]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("tier_invalid");
    expect((err.details as string[]).some((d) => d.includes("'bogus'"))).toBe(
      true,
    );
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("'low' is accepted as a valid tier", () => {
    const r = run([
      "scaffold",
      "--file",
      writeYaml(oneTaskTierYaml("low", "low tier")),
    ]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`tasks/${epicId}.1.json`).tier).toBe("low");
  });

  test("non-string tier is bad_yaml", () => {
    // test_scaffold.py::test_scaffold_tier_non_string_is_bad_yaml
    const r = run([
      "scaffold",
      "--file",
      writeYaml(oneTaskTierYaml("42", "bad tier type")),
    ]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(
      (err.details as string[]).some((d) =>
        d.includes("`tier` must be a string"),
      ),
    ).toBe(true);
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("every TASK_TIERS member is accepted", () => {
    // test_scaffold.py::test_scaffold_tier_all_valid_values_accepted
    const tiers = ["low", "medium", "high", "xhigh", "max"];
    const tasksBlock = tiers
      .map(
        (tier, i) =>
          `  - title: tier task ${i + 1}\n    deps: []\n    tier: ${tier}\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`,
      )
      .join("");
    const yaml =
      "epic:\n  title: all tiers\n  spec: |\n    ## Overview\n    all tiers.\n" +
      `tasks:\n${tasksBlock}`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    tiers.forEach((tier, i) => {
      expect(readJson(`tasks/${epicId}.${i + 1}.json`).tier).toBe(tier);
    });
  });

  test("tier_invalid collects all offenders", () => {
    // test_scaffold.py::test_scaffold_tier_invalid_collects_all_offenders
    const yaml =
      "epic:\n  title: two bad tiers\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: task A\n    deps: []\n    tier: bogus\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: task B\n    deps: []\n    tier: extreme\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("tier_invalid");
    const details = err.details as string[];
    expect(
      details.some((d) => d.includes("task #1") && d.includes("'bogus'")),
    ).toBe(true);
    expect(
      details.some((d) => d.includes("task #2") && d.includes("'extreme'")),
    ).toBe(true);
    expect(noEpicsOrTasksLanded()).toBe(true);
  });
});

describe("scaffold per-task model", () => {
  test("model persists per task", () => {
    const yaml =
      "epic:\n  title: per task model\n  spec: |\n    ## Overview\n    model per task.\n" +
      `tasks:\n  - title: task A\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    const epicId = parseEnvelope(r.output).epic_id as string;
    expect(readJson(`tasks/${epicId}.1.json`).model).toBe("opus");
  });

  test("missing model field is model_invalid with the allowlist", () => {
    const yaml =
      "epic:\n  title: missing model\n  spec: |\n    ## Overview\n    no model.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    tier: medium\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("model_invalid");
    const blob = (err.details as string[]).join(" ");
    expect(blob).toContain("missing");
    expect(blob).toContain("opus");
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("unknown model value is model_invalid", () => {
    const yaml =
      "epic:\n  title: bad model\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    tier: medium\n    model: gpt\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("model_invalid");
    expect((err.details as string[]).some((d) => d.includes("'gpt'"))).toBe(
      true,
    );
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("non-string model is bad_yaml", () => {
    const yaml =
      "epic:\n  title: bad model type\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    tier: medium\n    model: 42\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("bad_yaml");
    expect(
      (err.details as string[]).some((d) =>
        d.includes("`model` must be a string"),
      ),
    ).toBe(true);
    expect(noEpicsOrTasksLanded()).toBe(true);
  });

  test("model_invalid accumulates in the SAME pass as tier_invalid; tier wins priority", () => {
    // Both axes bad on the same task: the accumulate-all pass collects tier AND
    // model offenders, but tier_invalid is reported first (model does not
    // short-circuit ahead of it). tier_invalid's details still carry the model
    // offenders appended so no offender is silently dropped.
    const yaml =
      "epic:\n  title: both bad\n  spec: |\n    ## Overview\n    x.\n" +
      `tasks:\n  - title: only task\n    deps: []\n    tier: ultrahigh\n    model: gpt\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("tier_invalid");
    const blob = (err.details as string[]).join(" ");
    expect(blob).toContain("'ultrahigh'");
    expect(blob).toContain("'gpt'");
    expect(noEpicsOrTasksLanded()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Atomicity + dup guard
// ---------------------------------------------------------------------------

describe("scaffold dup guard + atomicity", () => {
  function sameSlugYaml(title: string): string {
    return (
      `epic:\n  title: ${title}\n  spec: |\n    ## Overview\n    second attempt.\n` +
      `tasks:\n  - title: only task\n    deps: []\n    tier: medium\n    model: opus\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`
    );
  }

  test("same-slug scaffold is rejected with duplicate_epic", () => {
    // test_scaffold.py::test_scaffold_dup_slug_rejected_with_duplicate_epic
    const firstId = seedEpic("duplicate guard");
    const r = run([
      "scaffold",
      "--file",
      writeYaml(sameSlugYaml("duplicate guard")),
    ]);
    expect(r.code).not.toBe(0);
    const err = parseEnvelope(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("duplicate_epic");
    const blob = (err.details as string[]).join(" ");
    expect(blob).toContain(firstId);
    expect(blob).toContain("status:");
  });

  test("--allow-duplicate mints a distinct fn-N with the same slug", () => {
    // test_scaffold.py::test_scaffold_dup_slug_allow_duplicate_mints_distinct_fn_n
    const firstId = seedEpic("allow duplicate");
    const r = run([
      "scaffold",
      "--file",
      writeYaml(sameSlugYaml("allow duplicate")),
      "--allow-duplicate",
    ]);
    expect(r.code).toBe(0);
    const secondId = parseEnvelope(r.output).epic_id as string;
    expect(secondId).not.toBe(firstId);
    expect(secondId.endsWith("-allow-duplicate")).toBe(true);
    expect(firstId.endsWith("-allow-duplicate")).toBe(true);
  });

  test("unrelated-slug second scaffold proceeds normally", () => {
    // test_scaffold.py::test_scaffold_dup_slug_unrelated_slug_unaffected
    const firstId = seedEpic("first slug");
    const secondId = seedEpic("second slug different");
    expect(firstId).not.toBe(secondId);
    expect(firstId.endsWith("-first-slug")).toBe(true);
    expect(secondId.endsWith("-second-slug-different")).toBe(true);
  });

  test("dup-guard does not false-match a suffix slug", () => {
    // test_scaffold.py::test_scaffold_dup_slug_suffix_false_positive_regression
    const fooBarId = seedEpic("foo bar");
    expect(fooBarId.endsWith("-foo-bar")).toBe(true);

    const barR = run(["scaffold", "--file", writeYaml(sameSlugYaml("bar"))]);
    expect(barR.code).toBe(0);
    const barId = parseEnvelope(barR.output).epic_id as string;
    expect(barId.endsWith("-bar")).toBe(true);
    expect(barId.endsWith("-foo-bar")).toBe(false);
    expect(barId).not.toBe(fooBarId);

    const dupR = run([
      "scaffold",
      "--file",
      writeYaml(sameSlugYaml("foo bar")),
    ]);
    expect(dupR.code).not.toBe(0);
    const err = parseEnvelope(dupR.output).error as Record<string, unknown>;
    expect(err.code).toBe("duplicate_epic");
    const blob = (err.details as string[]).join(" ");
    expect(blob).toContain(fooBarId);
    expect(blob.includes(barId)).toBe(false);
  });

  test("the normal path still succeeds + commits the whole tree", () => {
    // test_scaffold.py::test_scaffold_normal_path_still_succeeds_post_atomicity_fix
    const r = run(["scaffold", "--file", writeYaml(twoTaskYaml())]);
    expect(r.code).toBe(0);
    const payload = parseEnvelope(r.output);
    expect(payload.success).toBe(true);
    const epicId = payload.epic_id as string;
    for (const rel of [
      `epics/${epicId}.json`,
      `specs/${epicId}.md`,
      `tasks/${epicId}.1.json`,
      `specs/${epicId}.1.md`,
      `tasks/${epicId}.2.json`,
      `specs/${epicId}.2.md`,
    ]) {
      expect(existsSync(join(project.root, ".keeper", rel))).toBe(true);
    }
    expect(countInvocationLines(r.output)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cross-repo follow-up guard at the MINT seam (createdByCloseOf path).
//
// The createdByCloseOf flag is internal-only (the CLI always passes null), so
// the mint-seam guard is driven by calling runScaffold in-process with cwd set
// to the project root and stdout captured — exactly how close-finalize's
// scaffoldFollowup delegate invokes it. A multi-repo SOURCE epic forces every
// follow-up task to carry an explicit, in-set target_repo or the mint rejects
// repo_required, leaving the disk untouched.
// ---------------------------------------------------------------------------

describe("scaffold cross-repo follow-up guard (mint seam)", () => {
  // Two real git repos under the project tree (the multi_repo_project port).
  function twoForeignRepos(): [string, string] {
    const a = join(project.root, "foreign-a");
    const b = join(project.root, "foreign-b");
    for (const d of [a, b]) {
      mkdirSync(d, { recursive: true });
      gitInit(d);
    }
    return [realpathSync(a), realpathSync(b)];
  }

  // Mint a SOURCE epic whose touched_repos span the two foreign repos. Returns
  // the source epic id; afterward its touched_repos == sorted([a, b]).
  function seedMultiRepoSource(a: string, b: string): string {
    const yaml =
      "epic:\n  title: multi repo source\n  spec: |\n    ## Overview\n    span repos.\n" +
      `tasks:\n  - title: task A\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${a}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: task B\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${b}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const r = run(["scaffold", "--file", writeYaml(yaml)]);
    expect(r.code).toBe(0);
    return parseEnvelope(r.output).epic_id as string;
  }

  // Build a one-task follow-up YAML, optionally with an explicit target_repo.
  function followupYaml(targetRepo: string | null): string {
    const repoLine =
      targetRepo !== null ? `    target_repo: ${targetRepo}\n` : "";
    return (
      "epic:\n  title: follow up of source\n  spec: |\n    ## Overview\n    fu.\n" +
      `tasks:\n  - title: follow task\n    deps: []\n    tier: medium\n    model: opus\n${repoLine}    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`
    );
  }

  // Run runScaffold in-process with cwd pinned to the project + stdout captured.
  // Mirrors close_finalize.runCaptured's chdir + redirect dance.
  function mintFollowup(
    yaml: string,
    sourceId: string,
  ): { code: number; output: string } {
    const planPath = join(project.root, "followup.yaml");
    writeFileSync(planPath, yaml, "utf-8");

    const prevCwd = process.cwd();
    const prevSession = process.env.CLAUDE_CODE_SESSION_ID;
    const chunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (
      chunk: unknown,
    ): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    try {
      process.chdir(project.root);
      process.env.CLAUDE_CODE_SESSION_ID = "test-session-fixture";
      const code = runScaffold({
        file: planPath,
        allowDuplicate: false,
        createdByCloseOf: sourceId,
      });
      return { code, output: chunks.join("") };
    } finally {
      process.chdir(prevCwd);
      if (prevSession === undefined) {
        delete process.env.CLAUDE_CODE_SESSION_ID;
      } else {
        process.env.CLAUDE_CODE_SESSION_ID = prevSession;
      }
      (process.stdout as unknown as { write: typeof origWrite }).write =
        origWrite;
    }
  }

  function noFollowupLanded(sourceId: string): boolean {
    const epicsDir = join(project.root, ".keeper", "epics");
    const glob = new Bun.Glob("fn-*.json");
    for (const f of glob.scanSync({ cwd: epicsDir, onlyFiles: true })) {
      const stem = f.slice(0, -".json".length);
      if (stem === sourceId) {
        continue;
      }
      return false;
    }
    return true;
  }

  test("multi-repo source + omitted target_repo -> repo_required, no write", () => {
    const [a, b] = twoForeignRepos();
    const sourceId = seedMultiRepoSource(a, b);
    const { code, output } = mintFollowup(followupYaml(null), sourceId);
    expect(code).toBe(1);
    const err = parseEnvelope(output).error as Record<string, unknown>;
    expect(err.code).toBe("repo_required");
    expect((err.details as string[]).some((d) => d.includes("task #1"))).toBe(
      true,
    );
    expect(noFollowupLanded(sourceId)).toBe(true);
  });

  test("multi-repo source + explicit in-set target_repo -> mints cleanly", () => {
    const [a, b] = twoForeignRepos();
    const sourceId = seedMultiRepoSource(a, b);
    const { code, output } = mintFollowup(followupYaml(a), sourceId);
    expect(code).toBe(0);
    const payload = parseEnvelope(output);
    const newEpicId = payload.epic_id as string;
    expect(newEpicId).not.toBe(sourceId);
    expect(readJson(`tasks/${newEpicId}.1.json`).target_repo).toBe(a);
    void b;
  });

  test("multi-repo source + out-of-set target_repo -> repo_required, no write", () => {
    const [a, b] = twoForeignRepos();
    void b;
    const sourceId = seedMultiRepoSource(a, b);
    // A third foreign repo, not in the source's touched_repos.
    const c = join(project.root, "foreign-c");
    mkdirSync(c, { recursive: true });
    gitInit(c);
    const cReal = realpathSync(c);
    const { code, output } = mintFollowup(followupYaml(cReal), sourceId);
    expect(code).toBe(1);
    const err = parseEnvelope(output).error as Record<string, unknown>;
    expect(err.code).toBe("repo_required");
    expect(
      (err.details as string[]).some((d) => d.includes("not in the source")),
    ).toBe(true);
    expect(noFollowupLanded(sourceId)).toBe(true);
  });

  test("single-repo source + omitted target_repo -> mints, defaults to primary", () => {
    // The source epic touches only primary_repo (no foreign target_repo), so the
    // guard does NOT fire — the existing default-to-primary behavior stands.
    const sourceId = seedEpic("single repo source");
    const { code, output } = mintFollowup(followupYaml(null), sourceId);
    expect(code).toBe(0);
    const newEpicId = parseEnvelope(output).epic_id as string;
    const primary = realpathSync(project.root);
    expect(readJson(`tasks/${newEpicId}.1.json`).target_repo).toBe(primary);
  });
});
