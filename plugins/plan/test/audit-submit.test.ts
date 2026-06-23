// Conformance spec for `planctl audit submit <epic_id>` — translated from
// tests/test_audit_submit.py, every inventory node mapped by a source-comment
// (translated | cited | drop-with-reason). 8 inventory nodes.
//
// The verb persists the content-blind quality-auditor's report markdown
// commit-free under audits/<epic_id>/report.md (+ a report.meta.json sidecar),
// stamped with the brief's commit_set_hash + schema_version, and echoes the
// handle + the --findings / --risk flags. Tests drive the real binary in a
// withProject repo, seeding the brief through the SAME src/audit_artifacts
// writer the verb reads so the on-disk shape carries zero drift.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  briefPath,
  computeCommitSetHash,
  writeArtifact,
} from "../src/audit_artifacts.ts";
import { parseCliOutput, runCli, withProject } from "./harness.ts";

const EID = "fn-7-demo-epic";

// Write an audits/<epic_id>/brief.json directly (skips close-preflight) so the
// submit tests stay hermetic. Returns the stamped commit_set_hash. Port of
// test_audit_submit._seed_brief.
function seedBrief(
  root: string,
  epicId: string,
  commitSetHash?: string,
): string {
  const hash =
    commitSetHash ?? computeCommitSetHash([{ repo: root, shas: ["abc123"] }]);
  const brief = {
    schema_version: 1,
    epic_id: epicId,
    primary_repo: root,
    commit_set_hash: hash,
    commit_groups: [],
    snippet_context: "",
    tasks: [],
  };
  writeArtifact(briefPath(root, epicId), `${JSON.stringify(brief)}\n`);
  return hash;
}

function submit(
  proj: { root: string; home: string },
  epicId: string,
  input: string,
  flags: string[],
): { code: number; output: string } {
  const r = runCli(
    [
      "audit",
      "submit",
      epicId,
      "--file",
      "-",
      "--project",
      proj.root,
      ...flags,
    ],
    { cwd: proj.root, home: proj.home, input },
  );
  return { code: r.code, output: r.output };
}

describe("audit submit", () => {
  const getProj = withProject("planctl-audit-submit-");

  // test_audit_submit.py::test_happy_path_persists_report_and_meta
  test("happy path persists report + meta and echoes the flags", () => {
    const proj = getProj();
    const h = seedBrief(proj.root, EID);
    const { code, output } = submit(
      proj,
      EID,
      "# Audit report\n\nNo fatal findings.\n",
      ["--findings", "3", "--risk", "Medium"],
    );
    expect(code).toBe(0);
    const env = parseCliOutput(output);
    expect(env.success).toBe(true);
    expect(env.findings).toBe(3);
    expect(env.risk).toBe("Medium");
    expect(env.commit_set_hash).toBe(h);

    expect(readFileSync(env.report_ref as string, "utf-8")).toBe(
      "# Audit report\n\nNo fatal findings.\n",
    );
    const meta = JSON.parse(readFileSync(env.meta_ref as string, "utf-8"));
    expect(meta.commit_set_hash).toBe(h);
    expect(meta.schema_version).toBe(1);
    expect(meta.findings).toBe(3);
    expect(meta.risk).toBe("Medium");
  });

  // test_audit_submit.py::test_meta_stamps_hash_from_brief
  test("stamps the brief's hash, not a recomputed one", () => {
    const proj = getProj();
    const custom = "deadbeef".repeat(8);
    seedBrief(proj.root, EID, custom);
    const { code, output } = submit(proj, EID, "report\n", ["--risk", "Low"]);
    expect(code).toBe(0);
    expect(parseCliOutput(output).commit_set_hash).toBe(custom);
  });

  // test_audit_submit.py::test_last_writer_wins
  test("last writer wins", () => {
    const proj = getProj();
    seedBrief(proj.root, EID);
    submit(proj, EID, "v1\n", ["--risk", "Low"]);
    const { code, output } = submit(proj, EID, "v2\n", ["--risk", "High"]);
    expect(code).toBe(0);
    expect(
      readFileSync(parseCliOutput(output).report_ref as string, "utf-8"),
    ).toBe("v2\n");
  });

  // test_audit_submit.py::test_no_commit_fires — the submit mutates only
  // gitignored state/; no .keeper/ commit payload rides the output. (withProject
  // is a real git repo, so this is the real-git assertion the pytest marks.)
  test("no commit fires: no files-bearing invocation payload", () => {
    const proj = getProj();
    seedBrief(proj.root, EID);
    const { code, output } = submit(proj, EID, "rep\n", ["--risk", "Low"]);
    expect(code).toBe(0);
    expect(output.includes('"files":[')).toBe(false);
  });

  // test_audit_submit.py::test_missing_brief_rejects
  test("missing brief rejects with BRIEF_MISSING naming the real epic id", () => {
    const proj = getProj();
    const { code, output } = submit(proj, EID, "x\n", ["--risk", "Low"]);
    expect(code).toBe(1);
    const env = parseCliOutput(output);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("BRIEF_MISSING");
    const msg = error.message as string;
    expect(msg).toContain(EID);
    expect(msg).not.toContain("{epic_id}");
    expect(msg).toContain(`keeper plan close-preflight ${EID}`);
  });

  // test_audit_submit.py::test_bad_risk_rejects_before_brief — click.Choice
  // rejects an invalid --risk at parse time (exit 2) before the verb body.
  test("bad --risk rejected at parse (exit 2) naming the value", () => {
    const proj = getProj();
    const { code, output } = submit(proj, EID, "x\n", ["--risk", "Severe"]);
    expect(code).toBe(2);
    expect(output).toContain("Severe");
  });

  // test_audit_submit.py::test_task_shaped_id_rejects_with_parent
  test("task-shaped id rejects with parent epic in details", () => {
    const proj = getProj();
    const { code, output } = submit(proj, "fn-7-demo-epic.2", "x\n", [
      "--risk",
      "Low",
    ]);
    expect(code).toBe(1);
    const error = parseCliOutput(output).error as Record<string, unknown>;
    expect(error.code).toBe("BAD_EPIC_ID");
    expect((error.details as Record<string, unknown>).parent_epic).toBe(
      "fn-7-demo-epic",
    );
  });

  // test_audit_submit.py::test_oversize_stdin_rejects
  test("oversize stdin rejects with PAYLOAD_TOO_LARGE", () => {
    const proj = getProj();
    seedBrief(proj.root, EID);
    const big = "x".repeat(1 * 1024 * 1024 + 1);
    const { code, output } = submit(proj, EID, big, ["--risk", "Low"]);
    expect(code).toBe(1);
    expect((parseCliOutput(output).error as Record<string, unknown>).code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });
});
