// Conformance spec for `planctl verdict submit <epic_id>` — translated from
// tests/test_verdict_submit.py, every inventory node mapped by a source-comment
// (translated | cited | drop-with-reason). 16 inventory nodes.
//
// The verb validates the close-planner's verdict JSON at emission — structural
// (VERDICT_SCHEMA, additionalProperties:false) THEN the cross-field invariants —
// and on success persists it commit-free under audits/<epic_id>/verdict.json
// stamped with the brief's hash + schema_version. A reject returns the typed
// minimal envelope (top-3 errors + the first failing path's schema fragment).
//
// The four schema-module unit nodes (schema validity, schema_errors extra-key,
// cross_field dangling-merge, cross_field clean) are CITED to
// src-audit-spine.test.ts's "validateVerdict vs the golden corpus" +
// "computeCommitSetHash" describe blocks — that file owns the validateVerdict /
// schema spine via the frozen golden corpus + cross-field parity table.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  briefPath,
  computeCommitSetHash,
  writeArtifact,
} from "../src/audit_artifacts.ts";
import { BLOCKS_CLOSING_REASON_MAX } from "../src/verdict_schema.ts";
import { parseCliOutput, runCli, seedState, withProject } from "./harness.ts";

const EID = "fn-7-demo-epic";

// Seed the owning epic def (+ one task) on disk. The central plan-state resolver
// locates the committed def before the brief check, so the submit tests must
// carry the def the real close flow always has (close-preflight ran first).
function seedEpic(root: string): void {
  seedState(root, { epicId: EID, nTasks: 1, primaryRepo: root });
}

// Port of test_verdict_submit._seed_brief.
function seedBrief(root: string, commitSetHash?: string): string {
  seedEpic(root);
  const hash =
    commitSetHash ?? computeCommitSetHash([{ repo: root, shas: ["abc123"] }]);
  const brief = {
    schema_version: 1,
    epic_id: EID,
    primary_repo: root,
    commit_set_hash: hash,
    commit_groups: [],
    snippet_context: "",
    tasks: [],
  };
  writeArtifact(briefPath(root, EID), `${JSON.stringify(brief)}\n`);
  return hash;
}

function submit(
  proj: { root: string; home: string },
  verdict: Record<string, unknown> | string,
): { code: number; output: string } {
  const payload =
    typeof verdict === "string" ? verdict : JSON.stringify(verdict);
  const r = runCli(
    ["verdict", "submit", EID, "--file", "-", "--project", proj.root],
    { cwd: proj.root, home: proj.home, input: payload },
  );
  return { code: r.code, output: r.output };
}

function errorRows(output: string): Array<Record<string, unknown>> {
  const error = parseCliOutput(output).error as Record<string, unknown>;
  return (error.details as Record<string, unknown>).errors as Array<
    Record<string, unknown>
  >;
}

// --- Schema-module unit coverage — CITED, not re-translated. -----------------
// test_verdict_submit.py::test_schema_is_valid_json_schema
//   -> CITED src-audit-spine.test.ts "validateVerdict vs the golden corpus"
//      ("corpus is non-empty" + every golden envelope-parity row exercise the
//      compiled VERDICT_SCHEMA; an invalid schema cannot produce the frozen
//      goldens).
// test_verdict_submit.py::test_schema_errors_flags_extra_key
//   -> CITED src-audit-spine.test.ts: the golden corpus carries the
//      additionalProperties (extra-key) VERDICT_INVALID envelopes; schema_errors
//      is the structural half validateVerdict runs.
// test_verdict_submit.py::test_cross_field_dangling_merge
//   -> CITED src-audit-spine.test.ts: dangling_merge_target rides the golden
//      parity table; cross_field_errors is the cross-field half of validateVerdict.
// test_verdict_submit.py::test_cross_field_clean_verdict_has_no_errors
//   -> CITED src-audit-spine.test.ts "a structurally + cross-field valid verdict
//      yields null".

describe("verdict submit", () => {
  const getProj = withProject("planctl-verdict-submit-");

  // test_verdict_submit.py::test_happy_path_persists_and_stamps_hash
  test("happy path persists + stamps hash + reports clusters", () => {
    const proj = getProj();
    const h = seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [
        { fid: "f1", action: "kept", task: 1, rationale: "ship" },
        { fid: "f2", action: "merged-into-f1", task: 1, rationale: "dup" },
        { fid: "f3", action: "culled", task: null, rationale: "noise" },
      ],
    });
    expect(code).toBe(0);
    const env = parseCliOutput(output);
    expect(env.commit_set_hash).toBe(h);
    expect(env.fatal).toBe(false);
    expect(env.decision_count).toBe(3);
    // f1 + f2 both land in ordinal 1 -> one distinct cluster.
    expect(env.expected_clusters).toEqual([1]);

    const record = JSON.parse(readFileSync(env.verdict_ref as string, "utf-8"));
    expect(record.schema_version).toBe(1);
    expect(record.commit_set_hash).toBe(h);
    expect(record.decisions).toHaveLength(3);
  });

  // test_verdict_submit.py::test_bad_json_rejects
  test("malformed JSON rejects with BAD_JSON", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, "{not json");
    expect(code).toBe(1);
    expect((parseCliOutput(output).error as Record<string, unknown>).code).toBe(
      "BAD_JSON",
    );
  });

  // test_verdict_submit.py::test_extra_key_rejects_minimal
  test("extra key rejects VERDICT_INVALID with a minimal, machine-readable envelope", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [],
      junk: 1,
    });
    expect(code).toBe(1);
    const error = parseCliOutput(output).error as Record<string, unknown>;
    expect(error.code).toBe("VERDICT_INVALID");
    const details = error.details as Record<string, unknown>;
    const rows = details.errors as Array<Record<string, unknown>>;
    for (const row of rows) {
      expect("loc" in row && "type" in row && "msg" in row).toBe(true);
    }
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(details.error_count as number).toBeGreaterThanOrEqual(1);
    // A minimal schema fragment — not the whole schema.
    const frag = details.schema_fragment as Record<string, unknown>;
    const props = (frag.properties as Record<string, unknown>) ?? frag;
    expect("decisions" in props).toBe(true);
  });

  // test_verdict_submit.py::test_wrong_type_task_rejects
  test("wrong-type task rejects VERDICT_INVALID", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [{ fid: "f1", action: "kept", task: "1", rationale: "r" }],
    });
    expect(code).toBe(1);
    expect((parseCliOutput(output).error as Record<string, unknown>).code).toBe(
      "VERDICT_INVALID",
    );
  });

  // test_verdict_submit.py::test_dangling_merge_rejects
  test("dangling merge target rejects with the typed cross-field row", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [
        { fid: "f1", action: "merged-into-nope", task: 1, rationale: "r" },
      ],
    });
    expect(code).toBe(1);
    expect((parseCliOutput(output).error as Record<string, unknown>).code).toBe(
      "VERDICT_INVALID",
    );
    expect(
      errorRows(output).some((r) => r.type === "dangling_merge_target"),
    ).toBe(true);
  });

  // test_verdict_submit.py::test_culled_with_task_rejects
  test("culled-with-task rejects with culled_task_not_null", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [{ fid: "f1", action: "culled", task: 2, rationale: "r" }],
    });
    expect(code).toBe(1);
    expect(
      errorRows(output).some((r) => r.type === "culled_task_not_null"),
    ).toBe(true);
  });

  // test_verdict_submit.py::test_kept_without_task_rejects
  test("kept-without-task rejects with task_ordinal_required", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [{ fid: "f1", action: "kept", task: null, rationale: "r" }],
    });
    expect(code).toBe(1);
    expect(
      errorRows(output).some((r) => r.type === "task_ordinal_required"),
    ).toBe(true);
  });

  // test_verdict_submit.py::test_fatal_without_reason_rejects
  test("fatal-without-reason rejects with fatal_reason_required", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: true,
      fatal_reason: "  ",
      decisions: [],
    });
    expect(code).toBe(1);
    expect(
      errorRows(output).some((r) => r.type === "fatal_reason_required"),
    ).toBe(true);
  });

  // test_verdict_submit.py::test_fatal_with_reason_passes
  test("fatal with a reason passes", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: true,
      fatal_reason: "ship blocker",
      decisions: [],
    });
    expect(code).toBe(0);
    expect(parseCliOutput(output).fatal).toBe(true);
  });

  // test_verdict_submit.py::test_missing_brief_rejects
  test("missing brief rejects with BRIEF_MISSING", () => {
    const proj = getProj();
    seedEpic(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [],
    });
    expect(code).toBe(1);
    expect((parseCliOutput(output).error as Record<string, unknown>).code).toBe(
      "BRIEF_MISSING",
    );
  });

  // test_verdict_submit.py::test_oversize_stdin_rejects
  test("oversize stdin rejects with PAYLOAD_TOO_LARGE", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, "x".repeat(1 * 1024 * 1024 + 1));
    expect(code).toBe(1);
    expect((parseCliOutput(output).error as Record<string, unknown>).code).toBe(
      "PAYLOAD_TOO_LARGE",
    );
  });

  // test_verdict_submit.py::test_no_commit_fires — the verdict mutates only
  // gitignored state/; no .keeper/ commit payload rides the output.
  test("no commit fires: no files-bearing invocation payload", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [],
    });
    expect(code).toBe(0);
    expect(output.includes('"files":[')).toBe(false);
  });

  // --- Optional close-gate pair: blocks_closing / blocks_closing_reason -------
  // Shaped and enforced exactly like fatal / fatal_reason.

  test("a true blocking verdict with a non-empty reason persists", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      blocks_closing: true,
      blocks_closing_reason:
        "ships a consumer-observable flaw a follow-up fixes",
      decisions: [{ fid: "f1", action: "kept", task: 1, rationale: "real" }],
    });
    expect(code).toBe(0);
    const record = JSON.parse(
      readFileSync(parseCliOutput(output).verdict_ref as string, "utf-8"),
    );
    expect(record.blocks_closing).toBe(true);
    expect(record.blocks_closing_reason).toBeTruthy();
  });

  test("absent close-gate fields persist unchanged (legacy non-blocking)", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      decisions: [],
    });
    expect(code).toBe(0);
    const record = JSON.parse(
      readFileSync(parseCliOutput(output).verdict_ref as string, "utf-8"),
    );
    expect("blocks_closing" in record).toBe(false);
  });

  test("blocks_closing:true with an empty reason rejects (pairing rule)", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      blocks_closing: true,
      blocks_closing_reason: "",
      decisions: [],
    });
    expect(code).toBe(1);
    const error = parseCliOutput(output).error as Record<string, unknown>;
    expect(error.code).toBe("VERDICT_INVALID");
    const types = errorRows(output).map((r) => r.type);
    expect(types).toContain("blocks_closing_reason_required");
  });

  test("a non-boolean blocks_closing rejects (strict boolean)", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      blocks_closing: "true",
      blocks_closing_reason: "x",
      decisions: [],
    });
    expect(code).toBe(1);
    const error = parseCliOutput(output).error as Record<string, unknown>;
    expect(error.code).toBe("VERDICT_INVALID");
    const rows = errorRows(output);
    expect(
      rows.some((r) => r.loc === "blocks_closing" && r.type === "type"),
    ).toBe(true);
  });

  test("an over-cap blocks_closing_reason rejects (length-capped)", () => {
    const proj = getProj();
    seedBrief(proj.root);
    const { code, output } = submit(proj, {
      fatal: false,
      fatal_reason: "",
      blocks_closing: true,
      blocks_closing_reason: "x".repeat(BLOCKS_CLOSING_REASON_MAX + 1),
      decisions: [],
    });
    expect(code).toBe(1);
    const error = parseCliOutput(output).error as Record<string, unknown>;
    expect(error.code).toBe("VERDICT_INVALID");
    const types = errorRows(output).map((r) => r.type);
    expect(types).toContain("maxLength");
  });
});
