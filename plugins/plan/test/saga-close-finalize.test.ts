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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  TRUNK_LEASE_SCHEMA_VERSION,
  type TrunkLeaseLeaf,
} from "../../../src/grant-leaf.ts";
import {
  AUDIT_SCHEMA_VERSION,
  computeCommitSetHash,
  followupMetaPath,
  followupPath,
  reportMetaPath,
  reportPath,
  verdictPath,
  writeArtifact,
  writeBriefArtifact,
} from "../src/audit_artifacts.ts";
import {
  CLOSE_OUTCOMES,
  type CloseOutcome,
  integrateEpicBases,
  integrateRepoUnderLease,
  type TrunkGitResult,
  type TrunkIntegrationDeps,
} from "../src/verbs/close_finalize.ts";
import {
  armInProgressOp,
  armRestoreFailure,
  failNextCommit,
} from "./fake-vcs.ts";
import {
  fakeDirtyPaths,
  firstJsonPayload,
  gitBaseline,
  gitInit,
  gitLogCount,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
  withTmpdir,
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

function seedFreshResumeReceipts(
  root: string,
  epicId: string,
  commitSetHash: string,
): string {
  writeArtifact(reportPath(root, epicId), "# Quality audit\n");
  seedReportMeta(root, epicId, commitSetHash, 1);
  writeArtifact(
    followupMetaPath(root, epicId),
    `${JSON.stringify(
      {
        schema_version: AUDIT_SCHEMA_VERSION,
        epic_id: epicId,
        commit_set_hash: commitSetHash,
        task_count: 1,
      },
      null,
      2,
    )}\n`,
  );
  const followupText = readFileSync(followupPath(root, epicId), "utf-8");
  const inputHash = createHash("sha256").update(followupText).digest("hex");
  const selectionDir = join(root, ".keeper", "state", "selections", epicId);
  mkdirSync(selectionDir, { recursive: true });
  writeArtifact(
    join(selectionDir, "followup-brief.json"),
    `${JSON.stringify(
      {
        schema_version: 1,
        epic_id: epicId,
        from_followup: true,
        input_hash: inputHash,
      },
      null,
      2,
    )}\n`,
  );
  const selectionVerdict = join(selectionDir, "followup-verdict.json");
  writeArtifact(
    selectionVerdict,
    `${JSON.stringify(
      {
        schema_version: 2,
        cells: {
          "1": {
            tier: "high",
            model: "sonnet",
            rationale: "fixture non-Spark selection",
            confidence: 0.8,
            spark_fit: false,
            spark_exclusion: "spark-not-on-axis",
          },
        },
        selection: {
          harness: "subagent",
          model: "plan:model-selector",
          config_hash: "fixture-config",
          input_hash: inputHash,
          shuffle_seed: 17,
          outcome: "completed",
          verdict_raw: "fixture",
          spark_axis_present: false,
        },
      },
      null,
      2,
    )}\n`,
  );
  return selectionVerdict;
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

function closeClaimMarkerPath(home: string, sessionId: string): string {
  return join(
    home,
    ".local",
    "state",
    "keeper",
    "sessions",
    `${sessionId}.json`,
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
// Commit failure: epic definition + close claim unwind together.
// ---------------------------------------------------------------------------

describe("close-finalize commit failure rollback", () => {
  const getProj = withProject("planctl-cf-commit-fail-");
  const COMMIT_FAILURE = "fake close commit failure";

  test("clean rollback restores the epic and releases the claim for a re-close", () => {
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, {
      commitSetHash: emptySetHash(),
      decisions: [],
    });
    gitBaseline(proj.root);
    const epicPath = join(proj.root, ".keeper", "epics", `${epicId}.json`);
    const before = readFileSync(epicPath, "utf-8");
    const failedSid = "close-commit-failed";

    const preflight = runCli(
      ["close-preflight", epicId, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
        env: { CLAUDE_CODE_SESSION_ID: failedSid },
      },
    );
    expect(preflight.code).toBe(0);
    expect(existsSync(closeClaimMarkerPath(proj.home, failedSid))).toBe(true);

    failNextCommit(proj.root, COMMIT_FAILURE);
    const failed = runCli(["close-finalize", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { CLAUDE_CODE_SESSION_ID: failedSid },
    });
    expect(failed.code).toBe(1);
    expect(readFileSync(epicPath, "utf-8")).toBe(before);
    expect(epicStatus(proj.root, epicId)).toBe("open");
    expect(gitLogCount(proj.root)).toBe(0);
    expect(fakeDirtyPaths(proj.root)).toEqual([]);
    expect(existsSync(closeClaimMarkerPath(proj.home, failedSid))).toBe(false);

    const retrySid = "close-commit-retry";
    const retryPreflight = runCli(
      ["close-preflight", epicId, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
        env: { CLAUDE_CODE_SESSION_ID: retrySid },
      },
    );
    expect(retryPreflight.code).toBe(0);

    const retry = runCli(["close-finalize", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { CLAUDE_CODE_SESSION_ID: retrySid },
    });
    expect(retry.code).toBe(0);
    expect(parseCliOutput(retry.output).outcome).toBe("closed_clean");
    expect(epicStatus(proj.root, epicId)).toBe("done");
    expect(gitLogCount(proj.root)).toBe(1);
  });

  test("standalone epic close keeps its commit_failed exit contract without a marker", () => {
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, {
      commitSetHash: emptySetHash(),
      decisions: [],
    });
    gitBaseline(proj.root);
    const epicPath = join(proj.root, ".keeper", "epics", `${epicId}.json`);
    const before = readFileSync(epicPath, "utf-8");
    const sid = "standalone-close-commit-failed";

    failNextCommit(proj.root, COMMIT_FAILURE);
    const failed = runCli(["epic", "close", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { CLAUDE_CODE_SESSION_ID: sid },
    });
    expect(failed.code).toBe(1);
    const payload = firstJsonPayload(failed.output);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("commit_failed");
    expect((payload.details as Record<string, unknown>).message).toBe(
      `git commit failed: ${COMMIT_FAILURE}`,
    );
    expect(readFileSync(epicPath, "utf-8")).toBe(before);
    expect(gitLogCount(proj.root)).toBe(0);
    expect(existsSync(closeClaimMarkerPath(proj.home, sid))).toBe(false);
  });

  test("incomplete rollback retains the close claim", () => {
    const proj = getProj();
    const { epicId } = doneEpic(proj, 1, {
      commitSetHash: emptySetHash(),
      decisions: [],
    });
    gitBaseline(proj.root);
    const sid = "close-rollback-incomplete";

    const preflight = runCli(
      ["close-preflight", epicId, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
        env: { CLAUDE_CODE_SESSION_ID: sid },
      },
    );
    expect(preflight.code).toBe(0);

    failNextCommit(proj.root, COMMIT_FAILURE);
    armRestoreFailure(proj.root);
    const failed = runCli(["close-finalize", epicId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
      env: { CLAUDE_CODE_SESSION_ID: sid },
    });
    expect(failed.code).toBe(1);
    expect(gitLogCount(proj.root)).toBe(0);
    expect(existsSync(closeClaimMarkerPath(proj.home, sid))).toBe(true);
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

  test("a finalize lock retry resumes every fresh phase and mints once", () => {
    const proj = getProj();
    const { epicId, hash } = doneEpic(
      proj,
      1,
      KEPT_ONE,
      "Durable phase resume",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const seededSelectionVerdict = seedFreshResumeReceipts(
      proj.root,
      epicId,
      hash,
    );
    const beforeLogs = gitLogCount(proj.root);
    const beforeEpics = countEpicFiles(proj.root);

    armInProgressOp(proj.root, "merge");
    const blocked = runCli(
      [
        "close-finalize",
        epicId,
        "--project",
        proj.root,
        "--selection-verdict",
        seededSelectionVerdict,
      ],
      { cwd: proj.root, home: proj.home },
    );
    expect(blocked.code).toBe(1);
    expect(
      (parseCliOutput(blocked.output).error as Record<string, unknown>).code,
    ).toBe("MERGE_IN_PROGRESS");
    expect(gitLogCount(proj.root)).toBe(beforeLogs);
    expect(countEpicFiles(proj.root)).toBe(beforeEpics);

    armInProgressOp(proj.root, "none");
    const preflight = runCli(
      ["close-preflight", epicId, "--project", proj.root],
      { cwd: proj.root, home: proj.home },
    );
    expect(preflight.code).toBe(0);
    const resume = parseCliOutput(preflight.output).phase_resume as Record<
      string,
      unknown
    >;
    expect(resume).toEqual({
      audit: "satisfied",
      plan: "satisfied",
      selection: "satisfied",
      findings: 1,
      fatal: false,
      followup_present: true,
      selection_verdict_path: seededSelectionVerdict,
    });

    const retried = runCli(
      [
        "close-finalize",
        epicId,
        "--project",
        proj.root,
        "--selection-verdict",
        resume.selection_verdict_path as string,
      ],
      { cwd: proj.root, home: proj.home },
    );
    expect(retried.code).toBe(0);
    const retriedEnv = parseCliOutput(retried.output);
    expect(retriedEnv.outcome).toBe("closed_with_followup");
    expect(countEpicFiles(proj.root)).toBe(beforeEpics + 1);
    // Follow-up scaffold records the epic and task, then source-close records one.
    expect(gitLogCount(proj.root)).toBe(beforeLogs + 3);
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

function nonSparkVerdictCell(
  tier: string,
  model = "opus",
  opts: { rationale?: string; confidence?: number } = {},
): Record<string, unknown> {
  return {
    tier,
    model,
    rationale: opts.rationale ?? "not a Spark fit",
    confidence: opts.confidence ?? 0.8,
    spark_fit: false,
    spark_exclusion: "spark-not-on-axis",
  };
}

// Write a selection-verdict JSON file the CLI reads via --selection-verdict.
function writeVerdict(
  root: string,
  epicId: string,
  cells: Record<string, Record<string, unknown>>,
  opts: {
    schemaVersion?: unknown;
    omitSparkAxisPresent?: boolean;
    sparkAxisPresent?: unknown;
    inputHash?: string;
  } = {},
): string {
  const p = join(root, "_selection_verdict.json");
  const followupText = readFileSync(followupPath(root, epicId), "utf-8");
  const selection: Record<string, unknown> = {
    harness: "claude",
    model: "sonnet",
    config_hash: "cfg-hash",
    input_hash:
      opts.inputHash ?? createHash("sha256").update(followupText).digest("hex"),
    shuffle_seed: 42,
    outcome: "completed",
    verdict_raw: "picked cells",
  };
  if (!opts.omitSparkAxisPresent) {
    selection.spark_axis_present = opts.sparkAxisPresent ?? false;
  }
  const doc = {
    schema_version: opts.schemaVersion ?? 2,
    cells,
    selection,
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
  const claudeAndPiMatrix = readFileSync(
    join(import.meta.dir, "fixtures", "matrix-claude-and-pi.yaml"),
    "utf-8",
  );

  function restrictedSparkMatrixEnv(proj: {
    home: string;
  }): Record<string, string> {
    const dir = join(proj.home, "restricted-spark-matrix");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "matrix.yaml"),
      claudeAndPiMatrix.replace(
        "      - openai-codex/gpt-5.3-codex-spark",
        "      - id: openai-codex/gpt-5.3-codex-spark\n" +
          "        efforts: [low, medium, high]",
      ),
      "utf-8",
    );
    return { KEEPER_CONFIG_DIR: dir };
  }

  function finalizeWithVerdict(
    proj: { root: string; home: string },
    epicId: string,
    verdictPath: string,
    env?: Record<string, string>,
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
      { cwd: proj.root, home: proj.home, env },
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
    const inputHash = createHash("sha256")
      .update(readFileSync(followupPath(proj.root, epicId), "utf-8"))
      .digest("hex");
    const vp = writeVerdict(proj.root, epicId, {
      "1": nonSparkVerdictCell("high", "sonnet", {
        rationale: "task 1 is subtle",
        confidence: 0.9,
      }),
      "2": nonSparkVerdictCell("max", "opus"),
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
    expect(s.input_hash).toBe(inputHash);
    const sCells = s.cells as Array<Record<string, unknown>>;
    expect(sCells).toHaveLength(2);
    expect(sCells[0]).toMatchObject({
      task_id: `${newEpicId}.1`,
      tier: "high",
      model: "sonnet",
      rationale: "task 1 is subtle",
      spark_fit: false,
      spark_exclusion: "spark-not-on-axis",
      label_source: "heuristic-guided",
    });
    expect(sCells[1]).toMatchObject({
      task_id: `${newEpicId}.2`,
      tier: "max",
      model: "opus",
      spark_fit: false,
      spark_exclusion: "spark-not-on-axis",
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

  test("mismatched follow-up input hash degrades without applying guided cells", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      { commitSetHash: emptySetHash(), decisions: keptOrdinals(1) },
      "Mismatched follow-up hash",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const vp = writeVerdict(
      proj.root,
      epicId,
      { "1": nonSparkVerdictCell("high", "sonnet") },
      { inputHash: "different-follow-up-document-hash" },
    );

    const { code, env } = finalizeWithVerdict(proj, epicId, vp);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;
    expect(taskCell(proj.root, `${newEpicId}.1`)).toEqual({
      tier: "medium",
      model: "opus",
    });
    const s = sidecar(proj.root, newEpicId) as Record<string, unknown>;
    expect(s.outcome).toBe("degraded:verdict-input-hash-mismatch");
    expect((s.cells as Array<Record<string, unknown>>)[0]).toMatchObject({
      spark_fit: null,
      spark_exclusion: null,
      label_source: "heuristic-default",
    });
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
      spark_fit: null,
      spark_exclusion: null,
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
    const vp = writeVerdict(proj.root, epicId, {
      // "ultra" is not a configured effort, but the cell shape is otherwise exact.
      "1": nonSparkVerdictCell("ultra", "sonnet"),
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
      spark_fit: null,
      spark_exclusion: null,
      label_source: "heuristic-default",
    });
    expect(epicStatus(proj.root, epicId)).toBe("done");
  });

  test("ragged matrix rejects a staged Spark effort unsupported by that model", () => {
    const proj = getProj();
    const env = restrictedSparkMatrixEnv(proj);
    const { epicId } = doneEpic(
      proj,
      1,
      { commitSetHash: emptySetHash(), decisions: keptOrdinals(1) },
      "Restricted Spark close",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const vp = writeVerdict(proj.root, epicId, {
      "1": {
        tier: "xhigh",
        model: "gpt-5.3-codex-spark",
        rationale: "Spark cannot render this effort",
        confidence: 0.7,
        spark_fit: true,
        spark_exclusion: null,
      },
    });

    const { code, env: result } = finalizeWithVerdict(proj, epicId, vp, env);
    expect(code).toBe(0);
    expect(result.outcome).toBe("closed_with_followup");
    const newEpicId = result.new_epic_id as string;
    expect(taskCell(proj.root, `${newEpicId}.1`)).toEqual({
      tier: "medium",
      model: "opus",
    });
    const s = sidecar(proj.root, newEpicId) as Record<string, unknown>;
    expect(s.outcome).toBe("degraded:verdict-cell-out-of-axis");
    expect((s.cells as Array<Record<string, unknown>>)[0]).toMatchObject({
      spark_fit: null,
      spark_exclusion: null,
      label_source: "heuristic-default",
    });
  });

  test("legacy v1 follow-up verdict degrades even with v2 Spark fields", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      { commitSetHash: emptySetHash(), decisions: keptOrdinals(1) },
      "Legacy v1 selection verdict",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const vp = writeVerdict(
      proj.root,
      epicId,
      { "1": nonSparkVerdictCell("high", "sonnet") },
      { schemaVersion: 1 },
    );

    const { code, env } = finalizeWithVerdict(proj, epicId, vp);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;
    const s = sidecar(proj.root, newEpicId) as Record<string, unknown>;
    expect(s.outcome).toBe("degraded:verdict-schema-legacy");
    expect((s.cells as Array<Record<string, unknown>>)[0]).toMatchObject({
      spark_fit: null,
      spark_exclusion: null,
      label_source: "heuristic-default",
    });
  });

  test("missing or invalid v2 Spark axis provenance degrades", () => {
    for (const [title, opts] of [
      ["missing", { omitSparkAxisPresent: true }],
      ["invalid", { sparkAxisPresent: "yes" }],
    ] as const) {
      const proj = getProj();
      const { epicId } = doneEpic(
        proj,
        1,
        { commitSetHash: emptySetHash(), decisions: keptOrdinals(1) },
        `Bad Spark axis ${title}`,
      );
      seedFollowupYaml(proj.root, epicId, epicId, 1);
      const vp = writeVerdict(
        proj.root,
        epicId,
        { "1": nonSparkVerdictCell("high", "sonnet") },
        opts,
      );

      const { code, env } = finalizeWithVerdict(proj, epicId, vp);
      expect(code).toBe(0);
      expect(env.outcome).toBe("closed_with_followup");
      const newEpicId = env.new_epic_id as string;
      const s = sidecar(proj.root, newEpicId) as Record<string, unknown>;
      expect(s.outcome).toBe("degraded:verdict-provenance-invalid");
      expect((s.cells as Array<Record<string, unknown>>)[0]).toMatchObject({
        spark_fit: null,
        spark_exclusion: null,
        label_source: "heuristic-default",
      });
    }
  });

  test("malformed follow-up verdict missing Spark fields degrades, never rejects finalize", () => {
    const proj = getProj();
    const { epicId } = doneEpic(
      proj,
      1,
      { commitSetHash: emptySetHash(), decisions: keptOrdinals(1) },
      "Legacy selection verdict",
    );
    seedFollowupYaml(proj.root, epicId, epicId, 1);
    const vp = writeVerdict(proj.root, epicId, {
      "1": { tier: "high", model: "sonnet" },
    });

    const { code, env } = finalizeWithVerdict(proj, epicId, vp);
    expect(code).toBe(0);
    expect(env.outcome).toBe("closed_with_followup");
    const newEpicId = env.new_epic_id as string;
    const s = sidecar(proj.root, newEpicId) as Record<string, unknown>;
    expect(s.outcome).toBe("degraded:verdict-cell-shape-invalid");
    expect((s.cells as Array<Record<string, unknown>>)[0]).toMatchObject({
      spark_fit: null,
      spark_exclusion: null,
      label_source: "heuristic-default",
    });
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
    const vp = writeVerdict(proj.root, epicId, {
      "1": nonSparkVerdictCell("high", "sonnet"),
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

// ---------------------------------------------------------------------------
// Trunk-lease integration saga — integrateRepoUnderLease / integrateEpicBases,
// driven directly (not through runCli/close-finalize) behind the pure
// TrunkIntegrationDeps git+lease seam. No real git spawn, no real daemon
// round-trip: every git call and every lease request/release is a scripted
// fake, so the fenced retry saga's typed exits are asserted deterministically.
// ---------------------------------------------------------------------------

const TRUNK_EPIC_ID = "fn-1-demo";
const TRUNK_SOURCE_BRANCH = `keeper/epic/${TRUNK_EPIC_ID}`;
const TRUNK_DEFAULT_BRANCH = "main";
const TRUNK_CLAIMANT = "test-session-fixture";
const TRUNK_REPO_ROOT = "/repo-a";

function gitOk(stdout = ""): TrunkGitResult {
  return { code: 0, stdout, stderr: "" };
}

function gitFail(code = 1, stderr = ""): TrunkGitResult {
  return { code, stdout: "", stderr };
}

function baseLeaseFor(overrides: Partial<TrunkLeaseLeaf> = {}): TrunkLeaseLeaf {
  return {
    schema_version: TRUNK_LEASE_SCHEMA_VERSION,
    active: true,
    epic_id: TRUNK_EPIC_ID,
    claimant_session_id: TRUNK_CLAIMANT,
    claimant_pid: 4242,
    claimant_start_time: "0",
    acquisition_id: "acq-1",
    repo_root: TRUNK_REPO_ROOT,
    writable_root: TRUNK_REPO_ROOT,
    source_branch: TRUNK_SOURCE_BRANCH,
    default_branch: TRUNK_DEFAULT_BRANCH,
    observed_default_tip: "base000",
    expires_at: Date.now() + 120_000,
    fencing_token: 1,
    ...overrides,
  };
}

/** Private carrier the patched process.exit throws, so a typed
 * emitFinalizeError exit unwinds to runTrunkVerb's catch instead of killing
 * the test process — the same technique runCli uses for the compiled CLI. */
class TrunkExitSignal {
  constructor(readonly code: number) {}
}

/** Call `fn` with process.exit/process.stdout.write patched, returning the
 * exit code (null when fn returned normally, with no typed exit) plus the
 * captured stdout for the typed-error envelope. */
function runTrunkVerb(fn: () => void): { code: number | null; stdout: string } {
  const priorExit = process.exit;
  const priorWrite = process.stdout.write;
  let stdout = "";
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdout +=
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk as Uint8Array).toString("utf-8");
    const cb = rest.find((r) => typeof r === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    cb?.(null);
    return true;
  }) as typeof process.stdout.write;
  process.exit = ((c?: number): never => {
    throw new TrunkExitSignal(c ?? 0);
  }) as typeof process.exit;

  let code: number | null = null;
  try {
    fn();
  } catch (exc) {
    if (exc instanceof TrunkExitSignal) {
      code = exc.code;
    } else {
      throw exc;
    }
  } finally {
    process.exit = priorExit;
    process.stdout.write = priorWrite;
  }
  return { code, stdout };
}

function trunkErrorCode(stdout: string): string {
  const payload = parseCliOutput(stdout) as {
    error?: { code?: string };
  };
  return payload.error?.code ?? "";
}

interface FakeTrunkDepsOptions {
  git: TrunkIntegrationDeps["git"];
  /** Lease minted per acquire attempt (0-based). Defaults to a fresh
   * baseLeaseFor with an incrementing fencing_token. */
  leaseFor?: (attempt: number) => TrunkLeaseLeaf;
  /** release() return value — false exercises TRUNK_LEASE_RELEASE_FAILED. */
  releaseOk?: boolean;
  /** acquireLock() returns null (lock contention) when false. */
  lockOk?: boolean;
}

/** Build a scripted TrunkIntegrationDeps: the caller supplies only the git
 * responder (the thing under test), while lock/lease plumbing defaults to an
 * always-succeeding fake that mirrors whatever lease it last minted back
 * through readLeaseLeaf — the in-fence "is my lease still valid" re-check
 * `integrateRepoUnderLease` performs every attempt. */
function makeFakeTrunkDeps(opts: FakeTrunkDepsOptions): {
  deps: TrunkIntegrationDeps;
  releasedLeases: TrunkLeaseLeaf[];
  requestAttempts: () => number;
} {
  let attempt = 0;
  let lastLease: TrunkLeaseLeaf | null = null;
  const releasedLeases: TrunkLeaseLeaf[] = [];
  const deps: TrunkIntegrationDeps = {
    git: opts.git,
    acquireLock: () => (opts.lockOk === false ? null : { release: () => {} }),
    requestLease: (
      _stateDir,
      epicId,
      repoRoot,
      sourceBranch,
      claimantSessionId,
    ) => {
      const currentAttempt = attempt;
      attempt += 1;
      const lease = opts.leaseFor
        ? opts.leaseFor(currentAttempt)
        : baseLeaseFor({
            epic_id: epicId,
            repo_root: repoRoot,
            writable_root: repoRoot,
            source_branch: sourceBranch,
            claimant_session_id: claimantSessionId,
            fencing_token: currentAttempt + 1,
          });
      lastLease = lease;
      return { ok: true, lease };
    },
    releaseLease: (_stateDir, lease) => {
      releasedLeases.push(lease);
      return opts.releaseOk ?? true;
    },
    readLeaseLeaf: () => lastLease,
  };
  return { deps, releasedLeases, requestAttempts: () => attempt };
}

describe("integrateRepoUnderLease saga (pure git seam)", () => {
  test("merges the source branch into local default and releases the lease", () => {
    // F1: the merge exit — reprobe finds not-yet-ancestor, live tip matches
    // the leased observation, merge succeeds, the objective re-probe confirms
    // containment.
    let mergeBaseCalls = 0;
    let mergeAttempted = false;
    const git: TrunkIntegrationDeps["git"] = (args) => {
      if (args[0] === "symbolic-ref") return gitOk(TRUNK_DEFAULT_BRANCH);
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return gitFail(1);
      }
      if (args[0] === "status") return gitOk("");
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_SOURCE_BRANCH}^{commit}`)
      ) {
        return gitOk("abc1234");
      }
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_DEFAULT_BRANCH}^{commit}`)
      ) {
        return gitOk("base000");
      }
      if (args[0] === "merge-base") {
        mergeBaseCalls += 1;
        // Pre-merge reprobe: not yet an ancestor. Post-merge objective check:
        // now contained.
        return mergeBaseCalls === 1 ? gitFail(1) : gitOk();
      }
      if (args[0] === "merge") {
        mergeAttempted = true;
        return gitOk();
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { deps, releasedLeases } = makeFakeTrunkDeps({ git });

    const result = runTrunkVerb(() =>
      integrateRepoUnderLease(
        TRUNK_EPIC_ID,
        TRUNK_REPO_ROOT,
        TRUNK_SOURCE_BRANCH,
        TRUNK_CLAIMANT,
        "json",
        deps,
      ),
    );

    expect(result.code).toBeNull();
    expect(mergeAttempted).toBe(true);
    expect(releasedLeases.length).toBe(1);
  });

  test("ancestor-skip: an in-fence reprobe already ancestor releases without merging", () => {
    // F1: the already-integrated exit — decideTrunkIntegrationFence grades
    // "already-integrated" before any merge is attempted.
    let mergeAttempted = false;
    const git: TrunkIntegrationDeps["git"] = (args) => {
      if (args[0] === "symbolic-ref") return gitOk(TRUNK_DEFAULT_BRANCH);
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return gitFail(1);
      }
      if (args[0] === "status") return gitOk("");
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_SOURCE_BRANCH}^{commit}`)
      ) {
        return gitOk("abc1234");
      }
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_DEFAULT_BRANCH}^{commit}`)
      ) {
        return gitOk("base000");
      }
      if (args[0] === "merge-base") return gitOk(); // already an ancestor
      if (args[0] === "merge") {
        mergeAttempted = true;
        return gitOk();
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { deps, releasedLeases } = makeFakeTrunkDeps({ git });

    const result = runTrunkVerb(() =>
      integrateRepoUnderLease(
        TRUNK_EPIC_ID,
        TRUNK_REPO_ROOT,
        TRUNK_SOURCE_BRANCH,
        TRUNK_CLAIMANT,
        "json",
        deps,
      ),
    );

    expect(result.code).toBeNull();
    expect(mergeAttempted).toBe(false);
    expect(releasedLeases.length).toBe(1);
  });

  test("conflict-retains-lease: TRUNK_INTEGRATION_CONFLICT exits without releasing", () => {
    // F1: the conflict exit — MERGE_HEAD appears only AFTER the failed merge
    // (absent on the pre-merge residue check), and the lease is never released
    // so a live closer keeps its fenced trunk ownership through resolution.
    let mergeHeadCalls = 0;
    const git: TrunkIntegrationDeps["git"] = (args) => {
      if (args[0] === "symbolic-ref") return gitOk(TRUNK_DEFAULT_BRANCH);
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        mergeHeadCalls += 1;
        return mergeHeadCalls === 1 ? gitFail(1) : gitOk("deadbeef1234");
      }
      if (args[0] === "status") return gitOk("");
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_SOURCE_BRANCH}^{commit}`)
      ) {
        return gitOk("abc1234");
      }
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_DEFAULT_BRANCH}^{commit}`)
      ) {
        return gitOk("base000");
      }
      if (args[0] === "merge-base") return gitFail(1); // not yet an ancestor
      if (args[0] === "merge") return gitFail(1, "CONFLICT (content)");
      if (args[0] === "diff") return gitOk("path/one.ts\npath/two.ts\n");
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { deps, releasedLeases } = makeFakeTrunkDeps({ git });

    const result = runTrunkVerb(() =>
      integrateRepoUnderLease(
        TRUNK_EPIC_ID,
        TRUNK_REPO_ROOT,
        TRUNK_SOURCE_BRANCH,
        TRUNK_CLAIMANT,
        "json",
        deps,
      ),
    );

    expect(result.code).toBe(1);
    expect(trunkErrorCode(result.stdout)).toBe("TRUNK_INTEGRATION_CONFLICT");
    const payload = parseCliOutput(result.stdout) as {
      error: { details: { conflicted_files: string[] } };
    };
    expect(payload.error.details.conflicted_files).toEqual([
      "path/one.ts",
      "path/two.ts",
    ]);
    expect(releasedLeases.length).toBe(0);
  });

  test("off-branch: HEAD on the wrong branch exits and releases the lease", () => {
    const git: TrunkIntegrationDeps["git"] = (args) => {
      if (args[0] === "symbolic-ref") return gitOk("some-other-branch");
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { deps, releasedLeases } = makeFakeTrunkDeps({ git });

    const result = runTrunkVerb(() =>
      integrateRepoUnderLease(
        TRUNK_EPIC_ID,
        TRUNK_REPO_ROOT,
        TRUNK_SOURCE_BRANCH,
        TRUNK_CLAIMANT,
        "json",
        deps,
      ),
    );

    expect(result.code).toBe(1);
    expect(trunkErrorCode(result.stdout)).toBe("TRUNK_INTEGRATION_OFF_BRANCH");
    expect(releasedLeases.length).toBe(1);
  });

  test("dirty: an unclean checkout exits and releases the lease", () => {
    const git: TrunkIntegrationDeps["git"] = (args) => {
      if (args[0] === "symbolic-ref") return gitOk(TRUNK_DEFAULT_BRANCH);
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return gitFail(1);
      }
      if (args[0] === "status") return gitOk(" M some/file.ts\n");
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { deps, releasedLeases } = makeFakeTrunkDeps({ git });

    const result = runTrunkVerb(() =>
      integrateRepoUnderLease(
        TRUNK_EPIC_ID,
        TRUNK_REPO_ROOT,
        TRUNK_SOURCE_BRANCH,
        TRUNK_CLAIMANT,
        "json",
        deps,
      ),
    );

    expect(result.code).toBe(1);
    expect(trunkErrorCode(result.stdout)).toBe("TRUNK_INTEGRATION_DIRTY");
    expect(releasedLeases.length).toBe(1);
  });

  test("residue: a pre-existing MERGE_HEAD exits and releases the lease", () => {
    const git: TrunkIntegrationDeps["git"] = (args) => {
      if (args[0] === "symbolic-ref") return gitOk(TRUNK_DEFAULT_BRANCH);
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return gitOk("existingmergehead");
      }
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { deps, releasedLeases } = makeFakeTrunkDeps({ git });

    const result = runTrunkVerb(() =>
      integrateRepoUnderLease(
        TRUNK_EPIC_ID,
        TRUNK_REPO_ROOT,
        TRUNK_SOURCE_BRANCH,
        TRUNK_CLAIMANT,
        "json",
        deps,
      ),
    );

    expect(result.code).toBe(1);
    expect(trunkErrorCode(result.stdout)).toBe("TRUNK_INTEGRATION_RESIDUE");
    expect(releasedLeases.length).toBe(1);
  });

  test("tip-drift: default advancing every fenced attempt exhausts the 3-try loop", () => {
    // F1: the tip-drift exit — the live default tip never matches the leased
    // observation, so every attempt defers and the loop exhausts without ever
    // attempting a merge.
    const git: TrunkIntegrationDeps["git"] = (args) => {
      if (args[0] === "symbolic-ref") return gitOk(TRUNK_DEFAULT_BRANCH);
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return gitFail(1);
      }
      if (args[0] === "status") return gitOk("");
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_SOURCE_BRANCH}^{commit}`)
      ) {
        return gitOk("abc1234");
      }
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_DEFAULT_BRANCH}^{commit}`)
      ) {
        return gitOk("drifted-tip");
      }
      if (args[0] === "merge-base") return gitFail(1); // not yet an ancestor
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { deps, releasedLeases, requestAttempts } = makeFakeTrunkDeps({
      git,
      leaseFor: (attempt) =>
        baseLeaseFor({
          fencing_token: attempt + 1,
          observed_default_tip: "base000",
        }),
    });

    const result = runTrunkVerb(() =>
      integrateRepoUnderLease(
        TRUNK_EPIC_ID,
        TRUNK_REPO_ROOT,
        TRUNK_SOURCE_BRANCH,
        TRUNK_CLAIMANT,
        "json",
        deps,
      ),
    );

    expect(result.code).toBe(1);
    expect(trunkErrorCode(result.stdout)).toBe("TRUNK_TIP_DRIFT");
    expect(requestAttempts()).toBe(3);
    expect(releasedLeases.length).toBe(3);
  });

  test("release-fail: a successful merge whose release the daemon never acks exits TRUNK_LEASE_RELEASE_FAILED", () => {
    let mergeBaseCalls = 0;
    const git: TrunkIntegrationDeps["git"] = (args) => {
      if (args[0] === "symbolic-ref") return gitOk(TRUNK_DEFAULT_BRANCH);
      if (args[0] === "rev-parse" && args.includes("MERGE_HEAD")) {
        return gitFail(1);
      }
      if (args[0] === "status") return gitOk("");
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_SOURCE_BRANCH}^{commit}`)
      ) {
        return gitOk("abc1234");
      }
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_DEFAULT_BRANCH}^{commit}`)
      ) {
        return gitOk("base000");
      }
      if (args[0] === "merge-base") {
        mergeBaseCalls += 1;
        return mergeBaseCalls === 1 ? gitFail(1) : gitOk();
      }
      if (args[0] === "merge") return gitOk();
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
    const { deps, releasedLeases } = makeFakeTrunkDeps({
      git,
      releaseOk: false,
    });

    const result = runTrunkVerb(() =>
      integrateRepoUnderLease(
        TRUNK_EPIC_ID,
        TRUNK_REPO_ROOT,
        TRUNK_SOURCE_BRANCH,
        TRUNK_CLAIMANT,
        "json",
        deps,
      ),
    );

    expect(result.code).toBe(1);
    expect(trunkErrorCode(result.stdout)).toBe("TRUNK_LEASE_RELEASE_FAILED");
    expect(releasedLeases.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// F2: the ancestor re-grade path reconciled with the SKILL.md recovery
// contract — a lingering active lease from a resolved conflict is adopted
// and released rather than left for daemon claimant-death reclaim.
// ---------------------------------------------------------------------------

describe("integrateEpicBases ancestor re-grade lease adoption (F2)", () => {
  const getRepo = withTmpdir("trunk-lease-adopt-");
  let priorWorktree: string | undefined;
  let priorSession: string | undefined;

  beforeEach(() => {
    priorWorktree = process.env.KEEPER_PLAN_WORKTREE;
    priorSession = process.env.CLAUDE_CODE_SESSION_ID;
    process.env.KEEPER_PLAN_WORKTREE = "worktree-lane-active";
    process.env.CLAUDE_CODE_SESSION_ID = TRUNK_CLAIMANT;
  });

  afterEach(() => {
    if (priorWorktree === undefined) {
      delete process.env.KEEPER_PLAN_WORKTREE;
    } else {
      process.env.KEEPER_PLAN_WORKTREE = priorWorktree;
    }
    if (priorSession === undefined) {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    } else {
      process.env.CLAUDE_CODE_SESSION_ID = priorSession;
    }
  });

  function ancestorRegradeGit(repoRoot: string): TrunkIntegrationDeps["git"] {
    return (args) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        return gitOk(`${repoRoot}\n`);
      }
      if (
        args[0] === "rev-parse" &&
        args.includes(`refs/heads/${TRUNK_SOURCE_BRANCH}^{commit}`)
      ) {
        return gitOk("abc1234");
      }
      if (
        args[0] === "symbolic-ref" &&
        args.includes("refs/remotes/origin/HEAD")
      ) {
        return gitOk(`origin/${TRUNK_DEFAULT_BRANCH}\n`);
      }
      if (args[0] === "merge-base") return gitOk(); // already an ancestor
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    };
  }

  test("adopts and releases a lingering active lease matching this closer", () => {
    const repoRoot = getRepo();
    const lease = baseLeaseFor({
      repo_root: repoRoot,
      writable_root: repoRoot,
    });
    const releasedLeases: TrunkLeaseLeaf[] = [];
    const deps: TrunkIntegrationDeps = {
      git: ancestorRegradeGit(repoRoot),
      acquireLock: () => ({ release: () => {} }),
      requestLease: () => {
        throw new Error(
          "requestLease must not be called on the ancestor re-grade path",
        );
      },
      releaseLease: (_stateDir, l) => {
        releasedLeases.push(l);
        return true;
      },
      readLeaseLeaf: () => lease,
    };

    const result = runTrunkVerb(() =>
      integrateEpicBases(TRUNK_EPIC_ID, repoRoot, null, "json", deps),
    );

    expect(result.code).toBeNull();
    expect(releasedLeases).toEqual([lease]);
  });

  test("leaves an absent lease alone (no adoption when nothing is lingering)", () => {
    const repoRoot = getRepo();
    const releasedLeases: TrunkLeaseLeaf[] = [];
    const deps: TrunkIntegrationDeps = {
      git: ancestorRegradeGit(repoRoot),
      acquireLock: () => ({ release: () => {} }),
      requestLease: () => {
        throw new Error(
          "requestLease must not be called on the ancestor re-grade path",
        );
      },
      releaseLease: (_stateDir, l) => {
        releasedLeases.push(l);
        return true;
      },
      readLeaseLeaf: () => null,
    };

    const result = runTrunkVerb(() =>
      integrateEpicBases(TRUNK_EPIC_ID, repoRoot, null, "json", deps),
    );

    expect(result.code).toBeNull();
    expect(releasedLeases.length).toBe(0);
  });

  test("leaves a lease held by a different claimant alone", () => {
    const repoRoot = getRepo();
    const lease = baseLeaseFor({
      repo_root: repoRoot,
      writable_root: repoRoot,
      claimant_session_id: "some-other-session",
    });
    const releasedLeases: TrunkLeaseLeaf[] = [];
    const deps: TrunkIntegrationDeps = {
      git: ancestorRegradeGit(repoRoot),
      acquireLock: () => ({ release: () => {} }),
      requestLease: () => {
        throw new Error(
          "requestLease must not be called on the ancestor re-grade path",
        );
      },
      releaseLease: (_stateDir, l) => {
        releasedLeases.push(l);
        return true;
      },
      readLeaseLeaf: () => lease,
    };

    const result = runTrunkVerb(() =>
      integrateEpicBases(TRUNK_EPIC_ID, repoRoot, null, "json", deps),
    );

    expect(result.code).toBeNull();
    expect(releasedLeases.length).toBe(0);
  });
});
