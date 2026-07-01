// Conformance spec for `planctl followup submit <epic_id>` — translated from
// tests/test_followup_submit.py, every inventory node mapped by a source-comment
// (translated | cited | drop-with-reason). 14 inventory nodes.
//
// The verb validates the close-planner's follow-up plan YAML via scaffold's
// DRY-RUN semantics (the assert-all half, no mutate phase, no session id), then
// cross-checks the YAML task count against the persisted verdict's distinct
// non-null kept/merged ordinals. On success it persists the YAML commit-free
// under audits/<epic_id>/followup.yaml. Tests drive the real binary in a
// withProject repo over a real scaffolded source epic.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  briefPath,
  computeCommitSetHash,
  verdictPath,
  writeArtifact,
} from "../src/audit_artifacts.ts";
import {
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

const TASK_SPEC_LINES = [
  "## Description",
  "x",
  "## Acceptance",
  "- [ ] x",
  "## Done summary",
  "## Evidence",
];

function seedBrief(root: string, epicId: string): string {
  const h = computeCommitSetHash([{ repo: root, shas: ["abc123"] }]);
  const brief = {
    schema_version: 1,
    epic_id: epicId,
    primary_repo: root,
    commit_set_hash: h,
    commit_groups: [],
    snippet_context: "",
    tasks: [],
  };
  writeArtifact(briefPath(root, epicId), `${JSON.stringify(brief)}\n`);
  return h;
}

// A brief whose source epic is MULTI-repo: touched_repos spans the primary
// (root) plus a second repo, the source-of-truth the cross-repo guard reads.
function seedMultiRepoBrief(
  root: string,
  epicId: string,
  otherRepo: string,
): string {
  const h = computeCommitSetHash([{ repo: root, shas: ["abc123"] }]);
  const brief = {
    schema_version: 1,
    epic_id: epicId,
    primary_repo: root,
    touched_repos: [root, otherRepo],
    commit_set_hash: h,
    commit_groups: [],
    snippet_context: "",
    tasks: [],
  };
  writeArtifact(briefPath(root, epicId), `${JSON.stringify(brief)}\n`);
  return h;
}

// A one-task follow-up YAML carrying an explicit per-task target_repo.
function followupYamlWithRepo(source: string, targetRepo: string): string {
  const lines = [
    "epic:",
    "  title: Follow up",
    `  depends_on_epics: [${source}]`,
    "  spec: |",
    "    ## Overview",
    "    fu",
    "tasks:",
    "  - title: task 1",
    "    tier: medium",
    "    model: opus",
    `    target_repo: ${targetRepo}`,
    "    spec: |",
  ];
  for (const ln of TASK_SPEC_LINES) {
    lines.push(`      ${ln}`);
  }
  return `${lines.join("\n")}\n`;
}

// Persist a verdict whose kept decisions occupy *ordinals* (distinct count = the
// expected follow-up cluster count). Port of _seed_verdict.
function seedVerdict(root: string, epicId: string, ordinals: number[]): void {
  const decisions = ordinals.map((o, i) => ({
    fid: `f${i + 1}`,
    action: "kept",
    task: o,
    rationale: "r",
  }));
  const record = {
    schema_version: 1,
    commit_set_hash: "h",
    fatal: false,
    fatal_reason: "",
    decisions,
  };
  writeArtifact(verdictPath(root, epicId), `${JSON.stringify(record)}\n`);
}

// A scaffold-valid follow-up YAML with *nTasks* well-formed task entries. Port
// of _followup_yaml.
function followupYaml(
  nTasks: number,
  opts: { source?: string; deps?: Record<number, number[]> } = {},
): string {
  const { source, deps = {} } = opts;
  const lines = ["epic:", "  title: Follow up"];
  if (source !== undefined) {
    lines.push(`  depends_on_epics: [${source}]`);
  }
  lines.push("  spec: |", "    ## Overview", "    fu", "tasks:");
  for (let i = 1; i <= nTasks; i += 1) {
    lines.push(`  - title: task ${i}`);
    lines.push("    tier: medium");
    lines.push("    model: opus");
    if (i in deps) {
      lines.push(`    deps: [${deps[i]?.join(", ")}]`);
    }
    lines.push("    spec: |");
    for (const ln of TASK_SPEC_LINES) {
      lines.push(`      ${ln}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function submit(
  proj: { root: string; home: string },
  epicId: string,
  yaml: string,
): { code: number; output: string } {
  const r = runCli(
    ["followup", "submit", epicId, "--file", "-", "--project", proj.root],
    { cwd: proj.root, home: proj.home, input: yaml },
  );
  return { code: r.code, output: r.output };
}

function scaffold(
  proj: { root: string; home: string },
  yaml: string,
): { code: number; output: string } {
  const planPath = join(
    proj.root,
    `plan-${Math.random().toString(36).slice(2)}.yaml`,
  );
  writeFileSync(planPath, yaml, "utf-8");
  const r = runCli(["scaffold", "--file", planPath], {
    cwd: proj.root,
    home: proj.home,
  });
  return { code: r.code, output: r.output };
}

// Scaffold a real one-task source epic; the follow-up's depends_on_epics points
// at it (close always runs against an existing all-done epic). Port of the
// source_epic fixture.
function sourceEpic(proj: { root: string; home: string }): string {
  const { epicId } = scaffoldEpic(proj, { title: "Source epic", nTasks: 1 });
  return epicId;
}

function errCode(output: string): string {
  return (parseCliOutput(output).error as Record<string, unknown>)
    .code as string;
}

describe("followup submit", () => {
  const getProj = withProject("planctl-followup-submit-");

  // test_followup_submit.py::test_happy_path_persists
  test("happy path persists + envelope shape", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    const h = seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1]);
    const yaml = followupYaml(1, { source: src });
    const { code, output } = submit(proj, src, yaml);
    expect(code).toBe(0);
    const env = parseCliOutput(output);
    expect(env.task_count).toBe(1);
    expect(env.expected_tasks).toBe(1);
    expect(env.commit_set_hash).toBe(h);
    expect(readFileSync(env.followup_ref as string, "utf-8")).toBe(yaml);
    const meta = JSON.parse(readFileSync(env.meta_ref as string, "utf-8"));
    expect(meta.commit_set_hash).toBe(h);
    expect(meta.task_count).toBe(1);
  });

  // test_followup_submit.py::test_merged_ordinals_collapse_to_distinct_count
  test("merged ordinals collapse to a distinct count", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    const record = {
      schema_version: 1,
      commit_set_hash: "h",
      fatal: false,
      fatal_reason: "",
      decisions: [
        { fid: "f1", action: "kept", task: 1, rationale: "r" },
        { fid: "f2", action: "merged-into-f1", task: 1, rationale: "r" },
      ],
    };
    writeArtifact(verdictPath(proj.root, src), `${JSON.stringify(record)}\n`);
    const { code, output } = submit(
      proj,
      src,
      followupYaml(1, { source: src }),
    );
    expect(code).toBe(0);
    expect(parseCliOutput(output).expected_tasks).toBe(1);
  });

  // test_followup_submit.py::test_count_mismatch_rejects
  test("count mismatch vs the verdict's ordinals rejects", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1, 2]); // expect 2
    const { code, output } = submit(
      proj,
      src,
      followupYaml(1, { source: src }),
    ); // plan 1
    expect(code).toBe(1);
    const error = parseCliOutput(output).error as Record<string, unknown>;
    expect(error.code).toBe("TASK_COUNT_MISMATCH");
    const details = error.details as Record<string, unknown>;
    expect(details.actual_tasks).toBe(1);
    expect(details.expected_tasks).toBe(2);
  });

  // test_followup_submit.py::test_missing_tier_surfaces_scaffold_code
  test("missing tier surfaces scaffold's tier_invalid", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1]);
    const yaml =
      `epic:\n  title: FU\n  depends_on_epics: [${src}]\n  spec: |\n` +
      "    ## Overview\n    x\ntasks:\n" +
      "  - title: t1\n    spec: |\n" +
      "      ## Description\n      x\n      ## Acceptance\n" +
      "      - [ ] x\n      ## Done summary\n      ## Evidence\n";
    const { code, output } = submit(proj, src, yaml);
    expect(code).toBe(1);
    expect(errCode(output)).toBe("tier_invalid");
  });

  // test_followup_submit.py::test_bad_yaml_shape_surfaces_scaffold_code
  test("non-mapping YAML surfaces scaffold's bad_yaml", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1]);
    const { code, output } = submit(proj, src, "not a mapping\n");
    expect(code).toBe(1);
    expect(errCode(output)).toBe("bad_yaml");
  });

  // test_followup_submit.py::test_invalid_spec_surfaces_scaffold_code
  test("a sectionless task spec surfaces scaffold's spec_invalid", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1]);
    const yaml =
      `epic:\n  title: FU\n  depends_on_epics: [${src}]\n  spec: |\n` +
      "    ## Overview\n    x\ntasks:\n" +
      "  - title: t1\n    tier: medium\n    model: opus\n    spec: |\n      just prose, no sections\n";
    const { code, output } = submit(proj, src, yaml);
    expect(code).toBe(1);
    expect(errCode(output)).toBe("spec_invalid");
  });

  // test_followup_submit.py::test_dep_cycle_surfaces_scaffold_code
  test("a dep cycle surfaces scaffold's dep_cycle", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1, 2]);
    const { code, output } = submit(
      proj,
      src,
      followupYaml(2, { source: src, deps: { 1: [2], 2: [1] } }),
    );
    expect(code).toBe(1);
    expect(errCode(output)).toBe("dep_cycle");
  });

  // test_followup_submit.py::test_no_session_id_required — the dry-run mints
  // nothing, so the verb succeeds with CLAUDE_CODE_SESSION_ID unset.
  test("no session id required", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1]);
    const r = runCli(
      ["followup", "submit", src, "--file", "-", "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
        input: followupYaml(1, { source: src }),
        env: { CLAUDE_CODE_SESSION_ID: "" },
      },
    );
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).task_count).toBe(1);
  });

  // test_followup_submit.py::test_missing_verdict_rejects
  test("missing verdict rejects with VERDICT_MISSING", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    const { code, output } = submit(
      proj,
      src,
      followupYaml(1, { source: src }),
    );
    expect(code).toBe(1);
    expect(errCode(output)).toBe("VERDICT_MISSING");
  });

  // test_followup_submit.py::test_missing_brief_rejects
  test("missing brief rejects with BRIEF_MISSING", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    const { code, output } = submit(
      proj,
      src,
      followupYaml(1, { source: src }),
    );
    expect(code).toBe(1);
    expect(errCode(output)).toBe("BRIEF_MISSING");
  });

  // test_followup_submit.py::test_oversize_stdin_rejects
  test("oversize stdin rejects with PAYLOAD_TOO_LARGE", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1]);
    const { code, output } = submit(proj, src, "x".repeat(1 * 1024 * 1024 + 1));
    expect(code).toBe(1);
    expect(errCode(output)).toBe("PAYLOAD_TOO_LARGE");
  });

  // test_followup_submit.py::test_dryrun_validator_accepts_scaffold_valid_yaml —
  // the in-process validateScaffoldYaml half is CITED to
  // src-scaffold-dryrun.test.ts "accepts a well-formed multi-task plan with deps";
  // here the CLI-observable half asserts scaffold itself mints the same YAML
  // cleanly (the divergence guard's binary side).
  test("a scaffold-valid YAML mints cleanly through scaffold", () => {
    const proj = getProj();
    const yaml = followupYaml(2, { deps: { 2: [1] } });
    const { code } = scaffold(proj, yaml);
    expect(code).toBe(0);
  });

  // test_followup_submit.py::test_dryrun_validator_rejects_what_scaffold_rejects —
  // in-process validator half CITED to src-scaffold-dryrun.test.ts "missing tier
  // → tier_invalid"; the CLI-observable half asserts scaffold rejects a tier-less
  // task with the SAME tier_invalid code (the divergence guard's binary side).
  test("a tier-less YAML is rejected by scaffold with tier_invalid", () => {
    const proj = getProj();
    const yaml =
      "epic:\n  title: FU\n  spec: |\n    ## Overview\n    x\ntasks:\n" +
      "  - title: t1\n    spec: |\n" +
      "      ## Description\n      x\n      ## Acceptance\n" +
      "      - [ ] x\n      ## Done summary\n      ## Evidence\n";
    const { code, output } = scaffold(proj, yaml);
    expect(code).not.toBe(0);
    expect(errCode(output)).toBe("tier_invalid");
  });

  // test_followup_submit.py::test_no_commit_fires — followup mutates only
  // gitignored state/; no .keeper/ commit payload rides the output.
  test("no commit fires: no files-bearing invocation payload", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1]);
    const { code, output } = submit(
      proj,
      src,
      followupYaml(1, { source: src }),
    );
    expect(code).toBe(0);
    expect(output.includes('"files":[')).toBe(false);
  });

  // Cross-repo guard at the dry-run seam: a multi-repo source brief makes an
  // omitted per-task target_repo a typed repo_required reject (re-runnably — the
  // verb persists nothing), while an explicit in-set target_repo passes.
  test("multi-repo source + omitted target_repo -> repo_required", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    const other = `${proj.root}-other`;
    seedMultiRepoBrief(proj.root, src, other);
    seedVerdict(proj.root, src, [1]);
    const { code, output } = submit(
      proj,
      src,
      followupYaml(1, { source: src }),
    );
    expect(code).toBe(1);
    expect(errCode(output)).toBe("repo_required");
  });

  test("multi-repo source + in-set target_repo passes the dry-run", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    const other = `${proj.root}-other`;
    seedMultiRepoBrief(proj.root, src, other);
    seedVerdict(proj.root, src, [1]);
    const { code, output } = submit(
      proj,
      src,
      followupYamlWithRepo(src, other),
    );
    expect(code).toBe(0);
    expect(parseCliOutput(output).task_count).toBe(1);
  });

  test("multi-repo source + out-of-set target_repo -> repo_required", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    const other = `${proj.root}-other`;
    seedMultiRepoBrief(proj.root, src, other);
    seedVerdict(proj.root, src, [1]);
    const { code, output } = submit(
      proj,
      src,
      followupYamlWithRepo(src, `${proj.root}-elsewhere`),
    );
    expect(code).toBe(1);
    expect(errCode(output)).toBe("repo_required");
  });

  test("single-repo source brief never rejects on an omitted target_repo", () => {
    const proj = getProj();
    const src = sourceEpic(proj);
    // seedBrief carries no touched_repos -> single-repo -> guard off.
    seedBrief(proj.root, src);
    seedVerdict(proj.root, src, [1]);
    const { code } = submit(proj, src, followupYaml(1, { source: src }));
    expect(code).toBe(0);
  });
});
