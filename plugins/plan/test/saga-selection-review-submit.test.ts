// Conformance spec for `keeper plan selection-review-submit <epic_id> --file -`
// — validate the auditor verdict + land the committed per-epic review dataset.
//
// Validates the 3-way enum + exact auditable coverage (no missing / extra /
// duplicate), writes the committed `.keeper/selection-reviews/<epic>.json` (each
// verdict snapshotting the graded {tier, model} + selection hashes) riding the
// verb auto-commit, and sets the task-2 display-only misfit flag ONLY on a
// non-right-sized verdict. A malformed verdict is rejected with the single
// distinct VERDICT_INVALID code, leaving no file and no flag. Write-once without
// --force.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  SELECTION_SCHEMA_VERSION,
  type SidecarCell,
} from "../src/selection_sidecar.ts";
import { serializeStateJson } from "../src/store.ts";
import {
  fakeSourceCommit,
  gitLogCount,
  type ProjectHandle,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

function writeSidecar(
  root: string,
  epicId: string,
  cells: Array<Partial<SidecarCell> & { task_id: string }>,
): void {
  const dir = join(root, ".keeper", "selections");
  mkdirSync(dir, { recursive: true });
  const sidecar = {
    schema_version: SELECTION_SCHEMA_VERSION,
    epic_id: epicId,
    created_at: "2026-06-06T00:00:00.000000Z",
    selector: { harness: "claude", model: "opus" },
    config_hash: "cfg-hash-abc",
    input_hash: "in-hash-xyz",
    shuffle_seed: 42,
    outcome: "completed",
    verdict_raw: null,
    cells: cells.map((c) => ({
      task_id: c.task_id,
      tier: c.tier ?? "medium",
      model: c.model ?? "opus",
      rationale: c.rationale ?? "mid task",
      confidence: c.confidence ?? 0.7,
      label_source: c.label_source ?? "heuristic-guided",
    })),
  };
  writeFileSync(
    join(dir, `${epicId}.json`),
    serializeStateJson(sidecar),
    "utf-8",
  );
}

function doneTask(proj: ProjectHandle, taskId: string): void {
  const r = runCli(["done", taskId, "--summary", `did ${taskId}`, "--force"], {
    cwd: proj.root,
    home: proj.home,
  });
  if (r.code !== 0) {
    throw new Error(`done failed for ${taskId}:\n${r.output}`);
  }
}

/** Scaffold + sidecar + done + a source commit per task, then run
 * selection-audit-brief. Returns {epicId, taskIds, auditableIds}. */
function setupAuditable(
  proj: ProjectHandle,
  nTasks: number,
  cellOverrides: Array<Partial<SidecarCell>> = [],
): { epicId: string; taskIds: string[]; auditableIds: string[] } {
  const { epicId, taskIds } = scaffoldEpic(proj, { nTasks });
  writeSidecar(
    proj.root,
    epicId,
    taskIds.map((t, i) => ({ task_id: t, ...(cellOverrides[i] ?? {}) })),
  );
  for (const t of taskIds) {
    doneTask(proj, t);
    fakeSourceCommit(proj.root, `feat: work\n\nTask: ${t}\n`, {
      numstat: [{ path: `${t}.ts`, insertions: 4, deletions: 1 }],
    });
  }
  const r = runCli(["selection-audit-brief", epicId, "--project", proj.root], {
    cwd: proj.root,
    home: proj.home,
  });
  if (r.code !== 0) {
    throw new Error(`audit-brief failed:\n${r.output}`);
  }
  const auditableIds = parseCliOutput(r.output).auditable_task_ids as string[];
  return { epicId, taskIds, auditableIds };
}

function reviewPath(root: string, epicId: string): string {
  return join(root, ".keeper", "selection-reviews", `${epicId}.json`);
}

function loadReview(root: string, epicId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(reviewPath(root, epicId), "utf-8")) as Record<
    string,
    unknown
  >;
}

/** The `selection_review` overlay field, or undefined when the overlay is absent
 * or carries no review. */
function overlayReview(root: string, epicId: string): unknown {
  const p = join(root, ".keeper", "state", "epics", `${epicId}.state.json`);
  if (!existsSync(p)) {
    return undefined;
  }
  return (JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>)
    .selection_review;
}

function submit(
  proj: ProjectHandle,
  epicId: string,
  verdict: unknown,
  extra: string[] = [],
) {
  return runCli(
    [
      "selection-review-submit",
      epicId,
      "--file",
      "-",
      "--project",
      proj.root,
      ...extra,
    ],
    { cwd: proj.root, home: proj.home, input: JSON.stringify(verdict) },
  );
}

describe("selection-review-submit success", () => {
  const getProj = withProject("planctl-srs-");

  test("misfit verdict writes a snapshotted review file + sets the flag (one commit)", () => {
    const proj = getProj();
    const { epicId, auditableIds } = setupAuditable(proj, 2, [
      { tier: "low", model: "sonnet" },
      { tier: "xhigh", model: "opus" },
    ]);
    const verdict = {
      verdicts: [
        {
          task_id: auditableIds[0],
          verdict: "underpowered",
          evidence: "multi-file refactor thrashed on the low cell",
        },
        {
          task_id: auditableIds[1],
          verdict: "right_sized",
          evidence: "matched the work",
        },
      ],
    };
    const before = gitLogCount(proj.root);
    const r = submit(proj, epicId, verdict);
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(true);
    expect(env.flag_set).toBe(true);
    expect(env.counts).toEqual({
      underpowered: 1,
      right_sized: 1,
      overpowered: 0,
    });
    // Exactly one commit lands (the committed review file).
    expect(gitLogCount(proj.root)).toBe(before + 1);

    const review = loadReview(proj.root, epicId);
    expect(review.schema_version).toBe(1);
    expect(review.epic_id).toBe(epicId);
    expect(review.selection_config_hash).toBe("cfg-hash-abc");
    expect(review.selection_input_hash).toBe("in-hash-xyz");
    expect(review.counts).toEqual({
      underpowered: 1,
      right_sized: 1,
      overpowered: 0,
    });
    const verdicts = review.verdicts as Array<Record<string, unknown>>;
    const byId = new Map(verdicts.map((v) => [v.task_id as string, v]));
    // Each verdict snapshots the graded cell + selection hashes (the join key).
    const v0 = byId.get(auditableIds[0] as string) as Record<string, unknown>;
    expect(v0.verdict).toBe("underpowered");
    expect(v0.tier).toBe("low");
    expect(v0.model).toBe("sonnet");
    expect(v0.config_hash).toBe("cfg-hash-abc");
    expect(v0.input_hash).toBe("in-hash-xyz");
    const v1 = byId.get(auditableIds[1] as string) as Record<string, unknown>;
    expect(v1.tier).toBe("xhigh");
    expect(v1.model).toBe("opus");

    // The display-only flag overlay carries the counts payload.
    const flag = overlayReview(proj.root, epicId);
    expect(typeof flag).toBe("string");
    const parsedFlag = JSON.parse(flag as string) as Record<string, unknown>;
    expect(parsedFlag.underpowered).toBe(1);
    expect(parsedFlag.overpowered).toBe(0);
  });

  test("fully right-sized epic writes the dataset but raises no flag", () => {
    const proj = getProj();
    const { epicId, auditableIds } = setupAuditable(proj, 2);
    const verdict = {
      verdicts: auditableIds.map((id) => ({
        task_id: id,
        verdict: "right_sized",
        evidence: "cell matched the work",
      })),
    };
    const r = submit(proj, epicId, verdict);
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.flag_set).toBe(false);
    expect(env.counts).toEqual({
      underpowered: 0,
      right_sized: 2,
      overpowered: 0,
    });
    // The committed dataset still lands.
    expect(existsSync(reviewPath(proj.root, epicId))).toBe(true);
    // No misfit flag raised.
    expect(overlayReview(proj.root, epicId)).toBeUndefined();
  });
});

describe("selection-review-submit validation (no file, no flag)", () => {
  const getProj = withProject("planctl-srs-inv-");

  function expectRejected(
    proj: ProjectHandle,
    epicId: string,
    r: { code: number; output: string },
  ): void {
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("VERDICT_INVALID");
    expect(existsSync(reviewPath(proj.root, epicId))).toBe(false);
    expect(overlayReview(proj.root, epicId)).toBeUndefined();
  }

  test("bad enum -> VERDICT_INVALID", () => {
    const proj = getProj();
    const { epicId, auditableIds } = setupAuditable(proj, 1);
    const before = gitLogCount(proj.root);
    const r = submit(proj, epicId, {
      verdicts: [{ task_id: auditableIds[0], verdict: "meh", evidence: "x" }],
    });
    expectRejected(proj, epicId, r);
    expect(gitLogCount(proj.root)).toBe(before);
  });

  test("missing task (incomplete coverage) -> VERDICT_INVALID", () => {
    const proj = getProj();
    const { epicId, auditableIds } = setupAuditable(proj, 2);
    const r = submit(proj, epicId, {
      verdicts: [
        { task_id: auditableIds[0], verdict: "right_sized", evidence: "x" },
      ],
    });
    expectRejected(proj, epicId, r);
  });

  test("extra task (not auditable) -> VERDICT_INVALID", () => {
    const proj = getProj();
    const { epicId, auditableIds } = setupAuditable(proj, 1);
    const r = submit(proj, epicId, {
      verdicts: [
        { task_id: auditableIds[0], verdict: "right_sized", evidence: "x" },
        { task_id: `${epicId}.99`, verdict: "right_sized", evidence: "x" },
      ],
    });
    expectRejected(proj, epicId, r);
  });

  test("empty evidence -> VERDICT_INVALID", () => {
    const proj = getProj();
    const { epicId, auditableIds } = setupAuditable(proj, 1);
    const r = submit(proj, epicId, {
      verdicts: [
        { task_id: auditableIds[0], verdict: "right_sized", evidence: "  " },
      ],
    });
    expectRejected(proj, epicId, r);
  });

  test("malformed JSON -> VERDICT_INVALID (distinct code, no file, no flag)", () => {
    const proj = getProj();
    const { epicId } = setupAuditable(proj, 1);
    const r = runCli(
      [
        "selection-review-submit",
        epicId,
        "--file",
        "-",
        "--project",
        proj.root,
      ],
      { cwd: proj.root, home: proj.home, input: "{not json" },
    );
    expectRejected(proj, epicId, r);
  });
});

describe("selection-review-submit write-once + brief gate", () => {
  const getProj = withProject("planctl-srs-once-");

  test("a second submit without --force is refused; --force overwrites", () => {
    const proj = getProj();
    const { epicId, auditableIds } = setupAuditable(proj, 1);
    const verdict = {
      verdicts: [
        { task_id: auditableIds[0], verdict: "right_sized", evidence: "x" },
      ],
    };
    expect(submit(proj, epicId, verdict).code).toBe(0);

    const second = submit(proj, epicId, verdict);
    expect(second.code).toBe(1);
    expect(
      (parseCliOutput(second.output).error as Record<string, unknown>).code,
    ).toBe("REVIEW_EXISTS");

    const forced = submit(proj, epicId, verdict, ["--force"]);
    expect(forced.code).toBe(0);
    expect(parseCliOutput(forced.output).success).toBe(true);
  });

  test("no audit brief -> BRIEF_MISSING", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 1 });
    doneTask(proj, taskIds[0] as string);
    const r = submit(proj, epicId, { verdicts: [] });
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("BRIEF_MISSING");
  });
});
