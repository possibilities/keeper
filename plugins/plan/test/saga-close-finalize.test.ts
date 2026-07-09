// Conformance spec for `planctl close-finalize <epic_id>` — the /plan:close saga
// encoded as a verb, translated from tests/test_close_finalize.py, every node
// mapped by a source-comment (translated | cited | drop-with-reason).
//
// close-finalize derives its position purely from observable state (the
// persisted audit artifacts + the epic's own status). Every reversible check
// runs FIRST; the irreversible epic close runs LAST, so a crash mid-saga leaves
// the source epic OPEN and the verb re-runnable. The tests drive the real binary
// in a withProject repo, seeding the audit artifacts through the SAME
// src/audit_artifacts writers the verb reads (writeArtifact / writeBriefArtifact
// / verdictPath / reportMetaPath / followupPath) so the on-disk shape carries
// zero drift. The outcome-exhaustiveness node imports CLOSE_OUTCOMES from src;
// the retired `epic followup-of` node asserts the unknown-subcommand error.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  AUDIT_SCHEMA_VERSION,
  computeCommitSetHash,
  followupPath,
  reportMetaPath,
  verdictPath,
  writeArtifact,
  writeBriefArtifact,
} from "../src/audit_artifacts.ts";
import {
  CLOSE_OUTCOMES,
  type CloseOutcome,
} from "../src/verbs/close_finalize.ts";
import { armInProgressOp } from "./fake-vcs.ts";
import {
  fakeDirtyPaths,
  firstJsonPayload,
  gitInit,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

// The set of outcomes the /plan:close coordinator switches on (mirrors the saga).
const CLOSE_SKILL_HANDLERS = new Set([
  "closed_clean",
  "closed_with_followup",
  "fatal_halt",
  "partial_followup",
  "followup_blocks_close",
]);

// The empty-set canonical hash the verb re-derives for an epic with no source
// commits (seeded tasks carry no Task: trailers). Stamping it makes freshness pass.
function emptySetHash(): string {
  return computeCommitSetHash([]);
}

// Mark every task done via the runtime sidecar (epic close honors it). Port of
// _mark_all_done.
function markAllDone(root: string, taskIds: string[]): void {
  for (const tid of taskIds) {
    const p = join(root, ".keeper", "state", "tasks", `${tid}.state.json`);
    writeFileSync(p, `${JSON.stringify({ status: "done" })}\n`, "utf-8");
  }
}

function seedBrief(root: string, epicId: string, commitSetHash: string): void {
  writeBriefArtifact(root, epicId, {
    schema_version: 1,
    epic_id: epicId,
    primary_repo: root,
    commit_set_hash: commitSetHash,
    commit_groups: [],
    snippet_context: "",
    tasks: [],
  });
}

function seedVerdict(
  root: string,
  epicId: string,
  opts: {
    commitSetHash: string;
    fatal?: boolean;
    fatalReason?: string;
    decisions?: Array<Record<string, unknown>>;
    blocksClosing?: boolean;
    blocksClosingReason?: string;
  },
): void {
  const record: Record<string, unknown> = {
    schema_version: 1,
    commit_set_hash: opts.commitSetHash,
    fatal: opts.fatal ?? false,
    fatal_reason: opts.fatalReason ?? "",
    decisions: opts.decisions ?? [],
  };
  if (opts.blocksClosing !== undefined) {
    record.blocks_closing = opts.blocksClosing;
    record.blocks_closing_reason =
      opts.blocksClosingReason ?? (opts.blocksClosing ? "gate reason" : "");
  }
  writeArtifact(
    verdictPath(root, epicId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function seedReportMeta(
  root: string,
  epicId: string,
  commitSetHash: string,
  findings: number,
  risk = "Low",
): void {
  const meta = {
    schema_version: AUDIT_SCHEMA_VERSION,
    epic_id: epicId,
    commit_set_hash: commitSetHash,
    findings,
    risk,
  };
  writeArtifact(
    reportMetaPath(root, epicId),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
}

// Write a valid scaffold-plan followup.yaml wiring back to the source epic.
function seedFollowupYaml(
  root: string,
  epicId: string,
  sourceEpicId: string,
  nTasks: number,
): void {
  const blocks: string[] = [];
  for (let i = 1; i <= nTasks; i++) {
    const spec =
      "      ## Description\n      follow-up\n\n" +
      "      ## Acceptance\n      - [ ] x\n\n" +
      "      ## Done summary\n\n      ## Evidence\n";
    blocks.push(
      `  - title: Follow task ${i}\n    tier: medium\n    model: opus\n    spec: |\n${spec}`,
    );
  }
  const yaml =
    `epic:\n  title: Follow-up of ${sourceEpicId}\n` +
    `  depends_on_epics: [${sourceEpicId}]\n` +
    "  spec: |\n    ## Overview\n    follow overview\n" +
    `tasks:\n${blocks.join("\n")}\n`;
  writeArtifact(followupPath(root, epicId), yaml);
}

function epicStatus(root: string, epicId: string): string {
  return (
    JSON.parse(
      readFileSync(join(root, ".keeper", "epics", `${epicId}.json`), "utf-8"),
    ) as Record<string, unknown>
  ).status as string;
}

function readEpicDef(root: string, epicId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, ".keeper", "epics", `${epicId}.json`), "utf-8"),
  ) as Record<string, unknown>;
}

function patchEpicDef(
  root: string,
  epicId: string,
  patch: Record<string, unknown>,
): void {
  const p = join(root, ".keeper", "epics", `${epicId}.json`);
  const def = { ...readEpicDef(root, epicId), ...patch };
  writeFileSync(p, `${JSON.stringify(def, null, 2)}\n`, "utf-8");
}

function countEpicFiles(root: string): number {
  return readdirSync(join(root, ".keeper", "epics")).filter((n) =>
    n.endsWith(".json"),
  ).length;
}

function blockingMarkerPath(root: string, sourceEpicId: string): string {
  return join(
    root,
    ".keeper",
    "state",
    "audits",
    sourceEpicId,
    "blocking-followup.json",
  );
}

function finalize(
  proj: { root: string; home: string },
  epicId: string,
): { code: number; env: Record<string, unknown> } {
  const r = runCli(["close-finalize", epicId, "--project", proj.root], {
    cwd: proj.root,
    home: proj.home,
  });
  return { code: r.code, env: parseCliOutput(r.output) };
}

// Seed a done epic with brief+verdict; returns {epicId, taskIds}.
function doneEpic(
  proj: { root: string; home: string },
  nTasks: number,
  verdictOpts: Parameters<typeof seedVerdict>[2] | null,
  title = "Demo",
): { epicId: string; taskIds: string[]; hash: string } {
  const { epicId, taskIds } = scaffoldEpic(
    { root: proj.root, home: proj.home },
    { title, nTasks },
  );
  markAllDone(proj.root, taskIds);
  const hash = emptySetHash();
  seedBrief(proj.root, epicId, hash);
  if (verdictOpts) {
    seedVerdict(proj.root, epicId, verdictOpts);
  }
  return { epicId, taskIds, hash };
}

// ---------------------------------------------------------------------------
// Outcome: closed_clean.
// ---------------------------------------------------------------------------

describe("close-finalize closed_clean", () => {
  const getProj = withProject("planctl-cf-clean-");

  test("empty decisions -> closed_clean, epic done", () => {
    // test_close_finalize.py::test_closed_clean_empty_decisions
    const proj = getProj();
    const { epicId, taskIds, hash } = doneEpic(proj, 2, {
      commitSetHash: emptySetHash(),
      decisions: [],
    });
    void taskIds;
    void hash;
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_clean");
    expect(env.epic_id).toBe(epicId);
    expect("new_epic_id" in env).toBe(false);
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });

  test("all decisions culled -> closed_clean", () => {
    // test_close_finalize.py::test_closed_clean_all_culled
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, {
      commitSetHash: emptySetHash(),
      decisions: [
        { fid: "f1", action: "culled", task: null, rationale: "noise" },
      ],
    });
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_clean");
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });

  test("idempotent re-run returns the SAME terminal outcome", () => {
    // test_close_finalize.py::test_closed_clean_idempotent_rerun
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, {
      commitSetHash: emptySetHash(),
      decisions: [],
    });
    const first = finalize(proj, epicId);
    expect(first.env.outcome).toBe("closed_clean");
    const second = finalize(proj, epicId);
    expect(second.env.outcome).toBe("closed_clean");
    expect(second.env.epic_id).toBe(epicId);
  });
});

// ---------------------------------------------------------------------------
// Outcome: fatal_halt.
// ---------------------------------------------------------------------------

describe("close-finalize fatal_halt", () => {
  const getProj = withProject("planctl-cf-fatal-");

  test("fatal verdict halts without closing", () => {
    // test_close_finalize.py::test_fatal_halt_does_not_close
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, {
      commitSetHash: emptySetHash(),
      fatal: true,
      fatalReason: "ships a data-loss bug",
      decisions: [],
    });
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("fatal_halt");
    expect(env.fatal_reason).toBe("ships a data-loss bug");
    expect(epicStatus(proj.root, epicId)).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Outcome: closed_with_followup (scaffold + adopt paths).
// ---------------------------------------------------------------------------

describe("close-finalize closed_with_followup", () => {
  const getProj = withProject("planctl-cf-followup-");

  const KEPT_ONE = {
    commitSetHash: emptySetHash(),
    decisions: [{ fid: "f1", action: "kept", task: 1, rationale: "real" }],
  };

  test("scaffolds the follow-up + closes the source", () => {
    // test_close_finalize.py::test_closed_with_followup_scaffolds_and_closes
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, KEPT_ONE, "Needs followup");
    seedFollowupYaml(proj.root, epicId, epicId, 1);

    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;
    expect(newEpicId).toBeTruthy();
    expect(newEpicId).not.toBe(epicId);
    expect(epicStatus(proj.root, epicId)).toBe("done");
    const newDef = JSON.parse(
      readFileSync(
        join(proj.root, ".keeper", "epics", `${newEpicId}.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect((newDef.depends_on_epics as string[]).includes(epicId)).toBe(true);
    expect(newDef.created_by_close_of).toBe(epicId);
    // close-finalize ARMS the follow-up: scaffold mints it as a null ghost, and
    // the finalize chokepoint flips last_validated_at null→timestamp so autopilot
    // can dispatch it once the source is closed (never a permanent ghost).
    expect(newDef.last_validated_at).not.toBeNull();
  });

  test("a follow-up scaffold that hits the merge window is retryable, not terminal", () => {
    // The follow-up scaffold delegate refuses mid-operation (merge_in_progress);
    // close-finalize passes that class through as a distinct RE-RUNNABLE outcome
    // rather than terminal SCAFFOLD_FAILED, and the source epic stays open so a
    // re-close once the window closes completes.
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, KEPT_ONE, "Merge blocked followup");
    seedFollowupYaml(proj.root, epicId, epicId, 1);

    // The state repo (the epic's primary_repo) is mid-merge when the delegated
    // scaffold fires.
    armInProgressOp(proj.root, "merge");
    const { code, env } = finalize(proj, epicId);

    expect(code).not.toBe(0);
    expect((env.error as Record<string, unknown>).code).toBe(
      "MERGE_IN_PROGRESS",
    );
    // Distinct from terminal SCAFFOLD_FAILED and NOT a terminal close outcome.
    expect((env.error as Record<string, unknown>).code).not.toBe(
      "SCAFFOLD_FAILED",
    );
    // The source epic is untouched — the irreversible close never ran.
    expect(epicStatus(proj.root, epicId)).toBe("open");

    // The merge window closes; a re-run completes the close (fresh scaffold + close).
    armInProgressOp(proj.root, "none");
    const rerun = finalize(proj, epicId);
    expect(rerun.code).toBe(0);
    expect(rerun.env.outcome).toBe("closed_with_followup");
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });

  test("an unrelated open dependent (no stamp) is NOT adopted", () => {
    // test_close_finalize.py::test_preexisting_dependent_without_stamp_ignored
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, KEPT_ONE, "Has innocent dependent");
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    // An unrelated human-planned dependent: open, NO close-provenance stamp,
    // a different task count.
    const { epicId: innocentId } = scaffoldEpic(
      { root: proj.root, home: proj.home },
      { title: "Innocent dependent", nTasks: 3 },
    );
    const innPath = join(proj.root, ".keeper", "epics", `${innocentId}.json`);
    const innDef = JSON.parse(readFileSync(innPath, "utf-8")) as Record<
      string,
      unknown
    >;
    innDef.depends_on_epics = [epicId];
    writeFileSync(innPath, JSON.stringify(innDef), "utf-8");

    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;
    expect([epicId, innocentId].includes(newEpicId)).toBe(false);
    expect(epicStatus(proj.root, epicId)).toBe("done");
    const newDef = JSON.parse(
      readFileSync(
        join(proj.root, ".keeper", "epics", `${newEpicId}.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(newDef.created_by_close_of).toBe(epicId);
  });

  test("a plain scaffold never stamps close-provenance", () => {
    // test_close_finalize.py::test_plain_scaffold_does_not_stamp_provenance
    const proj = getProj();
    const { epicId } = scaffoldEpic(
      { root: proj.root, home: proj.home },
      { title: "Hand authored", nTasks: 1 },
    );
    const def = JSON.parse(
      readFileSync(
        join(proj.root, ".keeper", "epics", `${epicId}.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    // Absent or null — what matters is it is not a source id.
    expect(def.created_by_close_of ?? null).toBeNull();
  });

  test("idempotent re-run: same outcome + same new_epic_id, no second scaffold", () => {
    // test_close_finalize.py::test_closed_with_followup_idempotent_rerun
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, KEPT_ONE, "Followup idempotent");
    seedFollowupYaml(proj.root, epicId, epicId, 1);

    const first = finalize(proj, epicId);
    expect(first.env.outcome).toBe("closed_with_followup");
    const newId = first.env.new_epic_id;
    const second = finalize(proj, epicId);
    expect(second.env.outcome).toBe("closed_with_followup");
    expect(second.env.new_epic_id).toBe(newId);
    // The follow-up is armed across the idempotent status==done adopt path (the
    // re-run's arm is a no-op — an already-stamped epic short-circuits).
    const followDef = JSON.parse(
      readFileSync(
        join(proj.root, ".keeper", "epics", `${String(newId)}.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(followDef.last_validated_at).not.toBeNull();
  });

  test("crash-resume adopts a pre-scaffolded follow-up, no duplicate", () => {
    // test_close_finalize.py::test_crash_resume_adopts_scaffolded_followup
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, KEPT_ONE, "Crash resume");
    // Pre-create the follow-up (the crashed run's scaffold landed) with the
    // close-provenance stamp + exactly 1 task = the expected cluster count.
    const { epicId: followId } = scaffoldEpic(
      { root: proj.root, home: proj.home },
      { title: `Follow-up of ${epicId}`, nTasks: 1 },
    );
    const fPath = join(proj.root, ".keeper", "epics", `${followId}.json`);
    const fDef = JSON.parse(readFileSync(fPath, "utf-8")) as Record<
      string,
      unknown
    >;
    fDef.depends_on_epics = [epicId];
    fDef.created_by_close_of = epicId;
    writeFileSync(fPath, JSON.stringify(fDef), "utf-8");
    // A stale followup.yaml is also on disk; the adopt path must NOT re-scaffold.
    seedFollowupYaml(proj.root, epicId, epicId, 1);

    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    expect(env.new_epic_id).toBe(followId);
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Pre-selection: --selection-verdict folds researched cells into the follow-up.
// ---------------------------------------------------------------------------

// Read a minted task JSON's {tier, model}.
function taskCell(
  root: string,
  taskId: string,
): { tier: string; model: string } {
  const def = JSON.parse(
    readFileSync(join(root, ".keeper", "tasks", `${taskId}.json`), "utf-8"),
  ) as Record<string, unknown>;
  return { tier: def.tier as string, model: def.model as string };
}

// The committed selection sidecar for `epicId`, or null when none was written.
function sidecar(root: string, epicId: string): Record<string, unknown> | null {
  const p = join(root, ".keeper", "selections", `${epicId}.json`);
  if (!require("node:fs").existsSync(p)) {
    return null;
  }
  return JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
}

// Write a selection-verdict JSON file the CLI reads via --selection-verdict.
function writeVerdict(
  root: string,
  cells: Record<string, Record<string, unknown>>,
): string {
  const p = join(root, "_selection_verdict.json");
  const doc = {
    schema_version: 1,
    cells,
    selection: {
      harness: "claude",
      model: "sonnet",
      config_hash: "cfg-hash",
      input_hash: "in-hash",
      shuffle_seed: 42,
      outcome: "completed",
      verdict_raw: "picked cells",
    },
  };
  writeFileSync(p, `${JSON.stringify(doc)}\n`, "utf-8");
  return p;
}

// N distinct kept ordinals -> N expected follow-up tasks.
function keptOrdinals(n: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= n; i++) {
    out.push({ fid: `f${i}`, action: "kept", task: i, rationale: "real" });
  }
  return out;
}

describe("close-finalize selection pre-selection", () => {
  const getProj = withProject("planctl-cf-select-");

  function finalizeWithVerdict(
    proj: { root: string; home: string },
    epicId: string,
    verdictPath: string,
  ): { code: number; env: Record<string, unknown> } {
    const r = runCli(
      [
        "close-finalize",
        epicId,
        "--project",
        proj.root,
        "--selection-verdict",
        verdictPath,
      ],
      { cwd: proj.root, home: proj.home },
    );
    return { code: r.code, env: parseCliOutput(r.output) };
  }

  test("verdict supplied -> tasks born selected + heuristic-guided sidecar", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      2,
      { commitSetHash: emptySetHash(), decisions: keptOrdinals(2) },
      "Guided select",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 2);
    const vp = writeVerdict(proj.root, {
      "1": {
        tier: "high",
        model: "sonnet",
        rationale: "task 1 is subtle",
        confidence: 0.9,
      },
      "2": { tier: "max", model: "opus" },
    });

    const { code, env } = finalizeWithVerdict(proj, epicId, vp);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;

    // Tasks are BORN with the verdict cells (not the document's medium/opus).
    expect(taskCell(proj.root, `${newEpicId}.1`)).toEqual({
      tier: "high",
      model: "sonnet",
    });
    expect(taskCell(proj.root, `${newEpicId}.2`)).toEqual({
      tier: "max",
      model: "opus",
    });

    const side = sidecar(proj.root, newEpicId);
    expect(side).not.toBeNull();
    const s = side as Record<string, unknown>;
    expect(s.schema_version).toBe(1);
    expect(s.epic_id).toBe(newEpicId);
    expect(s.outcome).toBe("completed");
    expect(s.selector).toEqual({ harness: "claude", model: "sonnet" });
    expect(s.config_hash).toBe("cfg-hash");
    expect(s.input_hash).toBe("in-hash");
    const sCells = s.cells as Array<Record<string, unknown>>;
    expect(sCells).toHaveLength(2);
    expect(sCells[0]).toMatchObject({
      task_id: `${newEpicId}.1`,
      tier: "high",
      model: "sonnet",
      rationale: "task 1 is subtle",
      label_source: "heuristic-guided",
    });
    expect(sCells[1]).toMatchObject({
      task_id: `${newEpicId}.2`,
      tier: "max",
      model: "opus",
      label_source: "heuristic-guided",
    });

    // Committed: the sidecar is a top-level selections/ file swept clean by close.
    expect(fakeDirtyPaths(proj.root)).not.toContain(
      `.keeper/selections/${newEpicId}.json`,
    );
    // Armed identically to the no-verdict path.
    const newDef = JSON.parse(
      readFileSync(
        join(proj.root, ".keeper", "epics", `${newEpicId}.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(newDef.last_validated_at).not.toBeNull();
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });

  test("no verdict -> template defaults + degraded sidecar; arming identical", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      { commitSetHash: emptySetHash(), decisions: keptOrdinals(1) },
      "Degraded default",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);

    // No --selection-verdict flag.
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;

    // The document's stamped defaults (seedFollowupYaml stamps medium/opus).
    expect(taskCell(proj.root, `${newEpicId}.1`)).toEqual({
      tier: "medium",
      model: "opus",
    });

    const s = sidecar(proj.root, newEpicId) as Record<string, unknown>;
    expect(s).not.toBeNull();
    expect(s.outcome).toBe("degraded:no-selection-verdict-supplied");
    expect(s.selector).toEqual({ harness: "none", model: "none" });
    const sCells = s.cells as Array<Record<string, unknown>>;
    expect(sCells[0]).toMatchObject({
      task_id: `${newEpicId}.1`,
      tier: "medium",
      model: "opus",
      label_source: "heuristic-default",
    });

    const newDef = JSON.parse(
      readFileSync(
        join(proj.root, ".keeper", "epics", `${newEpicId}.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(newDef.last_validated_at).not.toBeNull();
  });

  test("malformed verdict (out-of-axis cell) degrades, never rejects finalize", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      { commitSetHash: emptySetHash(), decisions: keptOrdinals(1) },
      "Bad cell",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const vp = writeVerdict(proj.root, {
      "1": { tier: "ultra", model: "sonnet" }, // "ultra" is not a configured effort
    });

    const { code, env } = finalizeWithVerdict(proj, epicId, vp);
    // Degrades rather than rejecting the whole finalize.
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;
    expect(taskCell(proj.root, `${newEpicId}.1`)).toEqual({
      tier: "medium",
      model: "opus",
    });
    const s = sidecar(proj.root, newEpicId) as Record<string, unknown>;
    expect(s.outcome).toBe("degraded:verdict-cell-out-of-axis");
    expect((s.cells as Array<Record<string, unknown>>)[0]).toMatchObject({
      label_source: "heuristic-default",
    });
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });

  test("adopt path runs no selection even with a verdict supplied", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      { commitSetHash: emptySetHash(), decisions: keptOrdinals(1) },
      "Adopt no select",
    );
    // Pre-scaffold the follow-up (crash-resume adopt) with the provenance stamp.
    const { epicId: followId } = scaffoldEpic(
      { root: proj.root, home: proj.home },
      { title: `Follow-up of ${epicId}`, nTasks: 1 },
    );
    const fPath = join(proj.root, ".keeper", "epics", `${followId}.json`);
    const fDef = JSON.parse(readFileSync(fPath, "utf-8")) as Record<
      string,
      unknown
    >;
    fDef.depends_on_epics = [epicId];
    fDef.created_by_close_of = epicId;
    writeFileSync(fPath, JSON.stringify(fDef), "utf-8");
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const vp = writeVerdict(proj.root, {
      "1": { tier: "high", model: "sonnet" },
    });

    const { code, env } = finalizeWithVerdict(proj, epicId, vp);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    expect(env.new_epic_id).toBe(followId);
    // Adopt writes NO sidecar and does not re-select the adopted tree.
    expect(sidecar(proj.root, followId)).toBeNull();
    expect(taskCell(proj.root, `${followId}.1`)).toEqual({
      tier: "medium",
      model: "opus",
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-repo follow-up guard at the close-finalize -> scaffold mint seam.
//
// A MULTI-repo source epic forces the scaffolded follow-up to carry an explicit,
// in-set per-task target_repo. A followup.yaml that omits it makes the mint
// reject repo_required, which close-finalize surfaces as SCAFFOLD_FAILED — a
// re-runnable refusal that leaves the source epic OPEN.
// ---------------------------------------------------------------------------

describe("close-finalize cross-repo follow-up guard", () => {
  const getProj = withProject("planctl-cf-xrepo-");

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

  function indent(text: string, n: number): string {
    const prefix = " ".repeat(n);
    return text
      .split("\n")
      .map((line) => (line ? prefix + line : ""))
      .join("\n");
  }

  // Two real git repos under the project root; the source epic spans both, so
  // its touched_repos == sorted([a, b]) (a strict superset of {primary}).
  function twoForeignRepos(root: string): [string, string] {
    const a = join(root, "foreign-a");
    const b = join(root, "foreign-b");
    for (const d of [a, b]) {
      mkdirSync(d, { recursive: true });
      gitInit(d);
    }
    return [realpathSync(a), realpathSync(b)];
  }

  // Mint a done MULTI-repo source epic spanning the two foreign repos; seed its
  // brief + a one-kept-finding verdict at the empty-set hash. Returns the id.
  function doneMultiRepoSource(
    proj: { root: string; home: string },
    a: string,
    b: string,
  ): string {
    const yaml =
      "epic:\n  title: multi repo source\n  spec: |\n    ## Overview\n    span repos.\n" +
      `tasks:\n  - title: task A\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${a}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n` +
      `  - title: task B\n    deps: []\n    tier: medium\n    model: opus\n    target_repo: ${b}\n    spec: |\n${indent(VALID_TASK_SPEC, 6)}\n`;
    const planPath = join(proj.root, "_xrepo_source.yaml");
    writeFileSync(planPath, yaml, "utf-8");
    const res = runCli(["scaffold", "--file", planPath], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(res.code).toBe(0);
    const epicId = firstJsonPayload(res.output).epic_id as string;
    markAllDone(proj.root, [`${epicId}.1`, `${epicId}.2`]);
    const hash = emptySetHash();
    seedBrief(proj.root, epicId, hash);
    seedVerdict(proj.root, epicId, {
      commitSetHash: hash,
      decisions: [{ fid: "f1", action: "kept", task: 1, rationale: "real" }],
    });
    return epicId;
  }

  test("multi-repo source + followup.yaml omitting target_repo -> SCAFFOLD_FAILED, source open", () => {
    const proj = getProj();
    const [a, b] = twoForeignRepos(proj.root);
    void a;
    void b;
    const epicId = doneMultiRepoSource(proj, a, b);
    // A followup.yaml whose single task carries NO target_repo (seedFollowupYaml
    // emits none) — the mint must refuse rather than default to primary.
    seedFollowupYaml(proj.root, epicId, epicId, 1);

    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(1);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("SCAFFOLD_FAILED");
    // The mint reject (repo_required) rides the captured scaffold_output.
    expect(JSON.stringify(error.details ?? {}).includes("repo_required")).toBe(
      true,
    );
    // Re-runnable: the source epic stays OPEN.
    expect(epicStatus(proj.root, epicId)).toBe("open");
  });

  test("multi-repo source + in-set per-task target_repo -> closed_with_followup", () => {
    const proj = getProj();
    const [a, b] = twoForeignRepos(proj.root);
    void b;
    const epicId = doneMultiRepoSource(proj, a, b);
    // A followup.yaml whose task carries an explicit in-set target_repo.
    const spec =
      "      ## Description\n      follow-up\n\n" +
      "      ## Acceptance\n      - [ ] x\n\n" +
      "      ## Done summary\n\n      ## Evidence\n";
    const yaml =
      `epic:\n  title: Follow-up of ${epicId}\n` +
      `  depends_on_epics: [${epicId}]\n` +
      "  spec: |\n    ## Overview\n    follow overview\n" +
      `tasks:\n  - title: Follow task\n    tier: medium\n    model: opus\n    target_repo: ${a}\n    spec: |\n${spec}`;
    writeArtifact(followupPath(proj.root, epicId), yaml);

    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;
    expect(newEpicId).not.toBe(epicId);
    expect(epicStatus(proj.root, epicId)).toBe("done");
    const newTask = JSON.parse(
      readFileSync(
        join(proj.root, ".keeper", "tasks", `${newEpicId}.1.json`),
        "utf-8",
      ),
    ) as Record<string, unknown>;
    expect(newTask.target_repo).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Outcome: partial_followup.
// ---------------------------------------------------------------------------

describe("close-finalize partial_followup", () => {
  const getProj = withProject("planctl-cf-partial-");

  test("under-provisioned follow-up stops without close", () => {
    // test_close_finalize.py::test_partial_followup_stops_without_close
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      {
        commitSetHash: emptySetHash(),
        // Two distinct kept ordinals → expected 2 follow-up tasks.
        decisions: [
          { fid: "f1", action: "kept", task: 1, rationale: "a" },
          { fid: "f2", action: "kept", task: 2, rationale: "b" },
        ],
      },
      "Partial",
    );
    // A closer-scaffolded follow-up with only 1 task (under-provisioned).
    const { epicId: followId } = scaffoldEpic(
      { root: proj.root, home: proj.home },
      { title: `Partial follow ${epicId}`, nTasks: 1 },
    );
    const fp = join(proj.root, ".keeper", "epics", `${followId}.json`);
    const fd = JSON.parse(readFileSync(fp, "utf-8")) as Record<string, unknown>;
    fd.depends_on_epics = [epicId];
    fd.created_by_close_of = epicId;
    writeFileSync(fp, JSON.stringify(fd), "utf-8");

    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("partial_followup");
    expect(env.new_epic_id).toBe(followId);
    expect(env.expected_tasks).toBe(2);
    expect(env.actual_tasks).toBe(1);
    expect(epicStatus(proj.root, epicId)).toBe("open");
    // Mirror of the closed_with_followup arm assertion: the partial path is
    // deliberately EXCLUDED from the arm block, so the under-provisioned
    // follow-up must stay a null ghost — never autopilot-dispatchable.
    const followDef = JSON.parse(readFileSync(fp, "utf-8")) as Record<
      string,
      unknown
    >;
    expect(followDef.last_validated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Refusals: stale hash, missing verdict, missing followup.
// ---------------------------------------------------------------------------

describe("close-finalize refusals", () => {
  const getProj = withProject("planctl-cf-refuse-");

  test("stale verdict hash -> STALE_ARTIFACTS, refuse never delete", () => {
    // test_close_finalize.py::test_stale_artifacts_refusal
    const proj = getProj();
    const fresh = emptySetHash();
    const { epicId } = doneEpic(
      proj,
      1,
      { commitSetHash: "deadbeef".repeat(8), decisions: [] },
      "Stale",
    );
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(1);
    expect(env.success).toBe(false);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("STALE_ARTIFACTS");
    expect((error.details as Record<string, unknown>).fresh_hash).toBe(fresh);
    expect(require("node:fs").existsSync(verdictPath(proj.root, epicId))).toBe(
      true,
    );
    expect(epicStatus(proj.root, epicId)).toBe("open");
  });

  test("no verdict + no report meta -> VERDICT_MISSING", () => {
    // test_close_finalize.py::test_missing_verdict_no_meta_fails_closed
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, null, "No verdict");
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(1);
    expect((env.error as Record<string, unknown>).code).toBe("VERDICT_MISSING");
    expect(epicStatus(proj.root, epicId)).toBe("open");
  });

  test("no verdict, meta.findings==0 -> synthesize empty -> closed_clean", () => {
    // test_close_finalize.py::test_zero_findings_no_verdict_closes_clean
    const proj = getProj();
    const { epicId, hash } = doneEpic(proj, 1, null, "Zero findings skip");
    seedReportMeta(proj.root, epicId, hash, 0);
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_clean");
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });

  test("no verdict, meta.findings>0 -> VERDICT_MISSING (planner crashed)", () => {
    // test_close_finalize.py::test_nonzero_findings_no_verdict_fails_closed
    const proj = getProj();
    const { epicId, hash } = doneEpic(proj, 1, null, "Planner crashed");
    seedReportMeta(proj.root, epicId, hash, 2, "Medium");
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(1);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("VERDICT_MISSING");
    expect((error.details as Record<string, unknown>).audit_findings).toBe(2);
    expect(epicStatus(proj.root, epicId)).toBe("open");
  });

  test("surviving decision but no followup.yaml -> FOLLOWUP_MISSING", () => {
    // test_close_finalize.py::test_missing_followup_fails_closed
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      {
        commitSetHash: emptySetHash(),
        decisions: [{ fid: "f1", action: "kept", task: 1, rationale: "real" }],
      },
      "No followup yaml",
    );
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(1);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("FOLLOWUP_MISSING");
    expect((error.details as Record<string, unknown>).expected_tasks).toBe(1);
    expect(epicStatus(proj.root, epicId)).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Outcome: followup_blocks_close (the blocking close-gate truth-table).
// ---------------------------------------------------------------------------

describe("close-finalize followup_blocks_close (blocking gate)", () => {
  const getProj = withProject("planctl-cf-block-");

  const BLOCK_KEPT = {
    commitSetHash: emptySetHash(),
    decisions: [{ fid: "f1", action: "kept", task: 1, rationale: "real" }],
    blocksClosing: true,
    blocksClosingReason:
      "ships a consumer-observable flaw a follow-up corrects",
  };

  test("blocking first pass mints an armed, pointer-stamped follow-up with substituted deps and holds the source open", () => {
    const proj = getProj();
    // A real upstream the source depends on (must survive into the follow-up),
    // alongside a dangling id (filtered) and the source itself (never included).
    const { epicId: depEpicId } = scaffoldEpic(
      { root: proj.root, home: proj.home },
      { title: "Upstream dep", nTasks: 1 },
    );
    const { epicId } = doneEpic(proj, 1, BLOCK_KEPT, "Blocking source");
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    // A real upstream (kept) alongside a now-unresolvable id (filtered).
    patchEpicDef(proj.root, epicId, {
      depends_on_epics: [depEpicId, "fn-88888-missing"],
    });

    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("followup_blocks_close");
    // The source stays OPEN — the gate holds it (and every dependent).
    expect(epicStatus(proj.root, epicId)).toBe("open");

    const newEpicId = env.new_epic_id as string;
    expect(newEpicId).toBeTruthy();
    expect(newEpicId).not.toBe(epicId);

    const followup = readEpicDef(proj.root, newEpicId);
    // The gate pointer + provenance land atomically in the scaffold commit.
    expect(followup.blocks_closing_of).toBe(epicId);
    expect(followup.created_by_close_of).toBe(epicId);
    // Deps are the still-resolving subset — the real upstream only, never the
    // source (a cycle) and never the dangling id.
    expect(followup.depends_on_epics).toEqual([depEpicId]);
    // Armed so an armed-mode board can dispatch it (the gate cannot wedge).
    expect(followup.last_validated_at).not.toBeNull();
    // The durable minted-marker records the mint (adopt-vs-deleted disambiguator).
    expect(existsSync(blockingMarkerPath(proj.root, epicId))).toBe(true);
    const marker = JSON.parse(
      readFileSync(blockingMarkerPath(proj.root, epicId), "utf-8"),
    ) as Record<string, unknown>;
    expect(marker.followup_epic_id).toBe(newEpicId);
  });

  test("an empty substitution set scaffolds the follow-up with no epic-deps", () => {
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, BLOCK_KEPT, "No-dep blocking source");
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    // Only a now-unresolvable dep -> nothing survives the substitution.
    patchEpicDef(proj.root, epicId, {
      depends_on_epics: ["fn-77777-missing"],
    });
    const { code, env } = finalize(proj, epicId);
    expect(code).toBe(0);
    expect(env.outcome).toBe("followup_blocks_close");
    const followup = readEpicDef(proj.root, env.new_epic_id as string);
    expect(followup.depends_on_epics).toEqual([]);
  });

  test("re-entry with a live follow-up re-emits idempotently and never re-scaffolds", () => {
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, BLOCK_KEPT, "Live re-entry source");
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const first = finalize(proj, epicId);
    expect(first.env.outcome).toBe("followup_blocks_close");
    const newEpicId = first.env.new_epic_id as string;
    const epicsAfterFirst = countEpicFiles(proj.root);

    const second = finalize(proj, epicId);
    expect(second.code).toBe(0);
    expect(second.env.outcome).toBe("followup_blocks_close");
    expect(second.env.new_epic_id).toBe(newEpicId);
    // No duplicate follow-up minted; source still open.
    expect(countEpicFiles(proj.root)).toBe(epicsAfterFirst);
    expect(epicStatus(proj.root, epicId)).toBe("open");
  });

  test("re-entry with a done follow-up adopts it into closed_with_followup", () => {
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, BLOCK_KEPT, "Adopt re-entry source");
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const first = finalize(proj, epicId);
    const newEpicId = first.env.new_epic_id as string;
    expect(epicStatus(proj.root, epicId)).toBe("open");

    // The follow-up lands (its own close would set its epic def status done).
    patchEpicDef(proj.root, newEpicId, { status: "done" });

    const second = finalize(proj, epicId);
    expect(second.code).toBe(0);
    expect(second.env.outcome).toBe("closed_with_followup");
    expect(second.env.new_epic_id).toBe(newEpicId);
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });

  test("a deleted-while-gated follow-up is a typed failure, never a close or re-scaffold", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      BLOCK_KEPT,
      "Deleted follow-up source",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const first = finalize(proj, epicId);
    const newEpicId = first.env.new_epic_id as string;

    // Delete the follow-up epic def (as `epic rm` would), leaving the source's
    // durable minted-marker in place.
    rmSync(join(proj.root, ".keeper", "epics", `${newEpicId}.json`));
    expect(existsSync(blockingMarkerPath(proj.root, epicId))).toBe(true);

    const second = finalize(proj, epicId);
    expect(second.code).toBe(1);
    const error = second.env.error as Record<string, unknown>;
    expect(error.code).toBe("BLOCKING_FOLLOWUP_DELETED");
    // The source is NOT closed.
    expect(epicStatus(proj.root, epicId)).toBe("open");
  });

  test("the gate outcome releases the close-exclusive claim so a re-dispatch can re-claim", () => {
    const proj = getProj();
    const SID = "block-release-session";
    const { epicId } = doneEpic(proj, 1, BLOCK_KEPT, "Claim release source");
    seedFollowupYaml(proj.root, epicId, epicId, 1);

    const markerFor = join(
      proj.home,
      ".local",
      "state",
      "keeper",
      "sessions",
      `${SID}.json`,
    );
    const pre = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { CLAUDE_CODE_SESSION_ID: SID },
    });
    expect(pre.code).toBe(0);
    // Preflight reports no in-flight gate on the first pass.
    expect(parseCliOutput(pre.output).blocking_followup).toBeNull();
    expect(existsSync(markerFor)).toBe(true);

    const fin = runCli(["close-finalize", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { CLAUDE_CODE_SESSION_ID: SID },
    });
    expect(parseCliOutput(fin.output).outcome).toBe("followup_blocks_close");
    // The claim is released — a leaked marker would jam the re-dispatched closer.
    expect(existsSync(markerFor)).toBe(false);
  });

  test("preflight surfaces the in-flight gate's id and status on re-entry", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      BLOCK_KEPT,
      "Preflight re-entry source",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const first = finalize(proj, epicId);
    const newEpicId = first.env.new_epic_id as string;

    const pre = runCli(["close-preflight", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(pre.code).toBe(0);
    const bf = parseCliOutput(pre.output).blocking_followup as Record<
      string,
      unknown
    > | null;
    expect(bf).not.toBeNull();
    expect((bf as Record<string, unknown>).id).toBe(newEpicId);
    expect((bf as Record<string, unknown>).status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Id validation + exhaustiveness + retired verb.
// ---------------------------------------------------------------------------

describe("close-finalize gates + exhaustiveness + retired verb", () => {
  const getProj = withProject("planctl-cf-gate-");

  test("malformed id -> BAD_EPIC_ID", () => {
    // test_close_finalize.py::test_bad_epic_id
    const proj = getProj();
    const { code, env } = finalize(proj, "not-an-id");
    expect(code).toBe(1);
    expect((env.error as Record<string, unknown>).code).toBe("BAD_EPIC_ID");
  });

  test("task-shaped id -> BAD_EPIC_ID pointing at the parent", () => {
    // test_close_finalize.py::test_task_shaped_id_points_at_parent
    const proj = getProj();
    const { code, env } = finalize(proj, "fn-7-demo.3");
    expect(code).toBe(1);
    const error = env.error as Record<string, unknown>;
    expect(error.code).toBe("BAD_EPIC_ID");
    expect((error.details as Record<string, unknown>).parent_epic).toBe(
      "fn-7-demo",
    );
  });

  test("unknown epic -> EPIC_NOT_FOUND", () => {
    // test_close_finalize.py::test_epic_not_found
    const proj = getProj();
    const { code, env } = finalize(proj, "fn-9999-missing");
    expect(code).toBe(1);
    expect((env.error as Record<string, unknown>).code).toBe("EPIC_NOT_FOUND");
  });

  test("every CloseOutcome member has a /plan:close handler and vice versa", () => {
    // test_close_finalize.py::test_close_outcome_exhaustiveness
    const members = new Set(Object.values(CLOSE_OUTCOMES) as CloseOutcome[]);
    expect(members).toEqual(CLOSE_SKILL_HANDLERS);
  });

  test("retired `epic followup-of` is gone (unknown subcommand)", () => {
    // test_close_finalize.py::test_epic_followup_of_verb_is_gone
    const proj = getProj();
    const r = runCli(["epic", "followup-of", "fn-1-x"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(r.output.toLowerCase().includes("no such command")).toBe(true);
  });
});
