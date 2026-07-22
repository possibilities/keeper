// Conformance spec for `keeper plan selection-audit-brief <epic_id>` — the
// committed selection-audit capture beat. The verb assembles the grading record
// for each AUDITABLE completed task (spec, assigned {tier, model}, selection
// hashes, per-task diff stats from Task-trailer commits, done summary), excludes
// degraded-default and never-executed tasks, and lands the brief committed at
// `.keeper/selection-audit-briefs/<epic>.json` (auto-committed, top-level data-dir
// sibling). Write-once on its OWN existence: a second invocation without --force
// skips idempotently (no rewrite, no second commit); --force re-derives it.

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
  seedRuntime,
  withProject,
} from "./harness.ts";

/** Write a selection sidecar directly under `.keeper/selections/<epic>.json`
 * (the committed home assign-cells / close-finalize write). Cells default to
 * heuristic-guided so a caller opts into a degraded default per cell. */
function writeSidecar(
  root: string,
  epicId: string,
  cells: Array<Partial<SidecarCell> & { task_id: string }>,
  opts?: { configHash?: string; inputHash?: string },
): void {
  const dir = join(root, ".keeper", "selections");
  mkdirSync(dir, { recursive: true });
  const sidecar = {
    schema_version: SELECTION_SCHEMA_VERSION,
    epic_id: epicId,
    created_at: "2026-06-06T00:00:00.000000Z",
    selector: { harness: "claude", model: "opus" },
    config_hash: opts?.configHash ?? "cfg-hash-abc",
    input_hash: opts?.inputHash ?? "in-hash-xyz",
    shuffle_seed: 42,
    outcome: "completed",
    verdict_raw: null,
    cells: cells.map((c) => ({
      task_id: c.task_id,
      tier: c.tier ?? "medium",
      model: c.model ?? "opus",
      rationale: c.rationale ?? "picked medium/opus for a mid task",
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

/** Drive a task to done via the binary (force skips the claim gate). */
function doneTask(proj: ProjectHandle, taskId: string): void {
  const r = runCli(
    [
      "done",
      taskId,
      "--summary",
      `did ${taskId}`,
      "--no-op-reason",
      "fixture: no code",
      "--force",
    ],
    {
      cwd: proj.root,
      home: proj.home,
    },
  );
  if (r.code !== 0) {
    throw new Error(`done failed for ${taskId}:\n${r.output}`);
  }
}

/** Seed a Task-trailer source commit with numstat rows for `taskId`. */
function seedCommit(
  root: string,
  taskId: string,
  numstat: Array<{ path: string; insertions: number; deletions: number }>,
): string {
  return fakeSourceCommit(root, `feat: work\n\nTask: ${taskId}\n`, {
    numstat,
  });
}

function briefPath(root: string, epicId: string): string {
  return join(root, ".keeper", "selection-audit-briefs", `${epicId}.json`);
}

function loadBrief(root: string, epicId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(briefPath(root, epicId), "utf-8")) as Record<
    string,
    unknown
  >;
}

describe("selection-audit-brief assembly", () => {
  const getProj = withProject("planctl-sab-");

  test("auditable task carries diff stats + sidecar provenance + done summary", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 1 });
    const t0 = taskIds[0] as string;
    writeSidecar(proj.root, epicId, [
      {
        task_id: t0,
        tier: "high",
        model: "opus",
        rationale: "architectural work",
        confidence: 0.9,
      },
    ]);
    doneTask(proj, t0);
    seedCommit(proj.root, t0, [
      { path: "src/a.ts", insertions: 10, deletions: 2 },
      { path: "src/b.ts", insertions: 5, deletions: 0 },
    ]);

    const before = gitLogCount(proj.root);
    const r = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.success).toBe(true);
    expect(env.auditable_task_ids).toEqual([t0]);
    expect(env.excluded).toEqual([]);
    expect(env.selection_config_hash).toBe("cfg-hash-abc");
    expect(env.selection_input_hash).toBe("in-hash-xyz");

    // The committed brief lands (top-level data-dir sibling), riding the verb's
    // own auto-commit.
    expect(gitLogCount(proj.root)).toBe(before + 1);

    const brief = loadBrief(proj.root, epicId);
    expect(brief.schema_version).toBe(2);
    expect(brief.epic_id).toBe(epicId);
    expect(brief.selection_config_hash).toBe("cfg-hash-abc");
    expect(brief.selection_input_hash).toBe("in-hash-xyz");
    const auditable = brief.auditable_tasks as Array<Record<string, unknown>>;
    expect(auditable).toHaveLength(1);
    const a0 = auditable[0] as Record<string, unknown>;
    expect(a0.task_id).toBe(t0);
    // No dispatched_* runtime keys were seeded, so the documented fallback
    // applies: the dispatched cell equals the assigned cell, no constraint.
    expect(a0.tier).toBe("high");
    expect(a0.model).toBe("opus");
    expect(a0.assigned_tier).toBe("high");
    expect(a0.assigned_model).toBe("opus");
    expect(a0.constraint).toBeNull();
    // The blinded brief never carries the selector's rationale/confidence/
    // label_source — those stay in the selection sidecar for calibration only.
    expect(a0.rationale).toBeUndefined();
    expect(a0.confidence).toBeUndefined();
    expect(a0.label_source).toBeUndefined();
    expect(a0.config_hash).toBe("cfg-hash-abc");
    expect(a0.input_hash).toBe("in-hash-xyz");
    expect(a0.done_summary).toBe(`did ${t0}`);
    expect(typeof a0.spec_md).toBe("string");
    expect((a0.spec_md as string).length).toBeGreaterThan(0);
    // Diff stats aggregated across the task's commits (independent expectation).
    expect(a0.diff_stats).toEqual({
      commit_count: 1,
      files_changed: 2,
      insertions: 15,
      deletions: 2,
    });
  });

  test("degraded-default cell is excluded, never graded", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 2 });
    const [t0, t1] = taskIds as [string, string];
    writeSidecar(proj.root, epicId, [
      { task_id: t0, label_source: "heuristic-guided" },
      { task_id: t1, label_source: "heuristic-default" },
    ]);
    doneTask(proj, t0);
    doneTask(proj, t1);
    seedCommit(proj.root, t0, [{ path: "a.ts", insertions: 3, deletions: 1 }]);
    seedCommit(proj.root, t1, [{ path: "b.ts", insertions: 3, deletions: 1 }]);

    const r = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.auditable_task_ids).toEqual([t0]);
    expect(env.excluded).toEqual([{ task_id: t1, reason: "degraded-default" }]);
  });

  test("never-executed task (no commit, no claim) is excluded", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 2 });
    const [t0, t1] = taskIds as [string, string];
    writeSidecar(proj.root, epicId, [{ task_id: t0 }, { task_id: t1 }]);
    doneTask(proj, t0);
    doneTask(proj, t1);
    // Only t0 has a source commit; t1 has neither commit nor a claim.
    seedCommit(proj.root, t0, [{ path: "a.ts", insertions: 1, deletions: 0 }]);

    const r = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.auditable_task_ids).toEqual([t0]);
    expect(env.excluded).toEqual([
      { task_id: t1, reason: "no-execution-evidence" },
    ]);
  });

  test("job evidence (claimed_at) makes a commit-less task auditable", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 1 });
    const t0 = taskIds[0] as string;
    writeSidecar(proj.root, epicId, [{ task_id: t0 }]);
    doneTask(proj, t0);
    // A worker claimed it (claimed_at set) but landed no Task-trailer commit —
    // still an exercised cell decision, so auditable via the job branch.
    seedRuntime(proj.root, t0, {
      status: "done",
      claimed_at: "2026-06-06T00:00:00.000000Z",
      assignee: "worker@x",
    });

    const r = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(0);
    const env = parseCliOutput(r.output);
    expect(env.auditable_task_ids).toEqual([t0]);
    const brief = loadBrief(proj.root, epicId);
    const a0 = (brief.auditable_tasks as Array<Record<string, unknown>>)[0];
    expect((a0 as Record<string, unknown>).diff_stats).toEqual({
      commit_count: 0,
      files_changed: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  test("constrained task emits both cells + constraint; unconstrained task falls back to dispatched == assigned", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 2 });
    const [t0, t1] = taskIds as [string, string];
    writeSidecar(proj.root, epicId, [
      { task_id: t0, tier: "high", model: "opus" },
      { task_id: t1, tier: "medium", model: "opus" },
    ]);
    // t0: a worker-provider constraint translated the assigned cell at claim,
    // so the runtime carries the dispatched cell that actually ran, distinct
    // from the sidecar's assigned cell.
    seedRuntime(proj.root, t0, {
      status: "done",
      claimed_at: "2026-06-06T00:00:00.000000Z",
      assignee: "worker@x",
      dispatched_model: "sonnet",
      dispatched_tier: "low",
      dispatch_constraint: "worker_provider=claude",
    });
    // t1: an ordinary unconstrained done task — no dispatched_* runtime keys.
    // Needs execution evidence (a source commit) to be auditable at all.
    doneTask(proj, t1);
    seedCommit(proj.root, t1, [{ path: "c.ts", insertions: 1, deletions: 0 }]);

    const r = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).toBe(0);
    const brief = loadBrief(proj.root, epicId);
    expect(brief.schema_version).toBe(2);
    const auditable = brief.auditable_tasks as Array<Record<string, unknown>>;
    const byId = new Map(auditable.map((a) => [a.task_id, a]));

    const a0 = byId.get(t0) as Record<string, unknown>;
    expect(a0.assigned_tier).toBe("high");
    expect(a0.assigned_model).toBe("opus");
    expect(a0.tier).toBe("low");
    expect(a0.model).toBe("sonnet");
    expect(a0.constraint).toBe("worker_provider=claude");

    const a1 = byId.get(t1) as Record<string, unknown>;
    expect(a1.assigned_tier).toBe("medium");
    expect(a1.assigned_model).toBe("opus");
    expect(a1.tier).toBe("medium");
    expect(a1.model).toBe("opus");
    expect(a1.constraint).toBeNull();
  });
});

describe("selection-audit-brief gates", () => {
  const getProj = withProject("planctl-sab-gate-");

  test("no sidecar -> SIDECAR_MISSING, no brief written", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 1 });
    doneTask(proj, taskIds[0] as string);
    const r = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root],
      {
        cwd: proj.root,
        home: proj.home,
      },
    );
    expect(r.code).toBe(1);
    const err = parseCliOutput(r.output).error as Record<string, unknown>;
    expect(err.code).toBe("SIDECAR_MISSING");
    expect(existsSync(briefPath(proj.root, epicId))).toBe(false);
  });

  test("a second invocation skips idempotently (no rewrite, no commit); --force re-derives", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, { nTasks: 1 });
    const t0 = taskIds[0] as string;
    writeSidecar(proj.root, epicId, [{ task_id: t0 }]);
    doneTask(proj, t0);
    seedCommit(proj.root, t0, [{ path: "a.ts", insertions: 1, deletions: 0 }]);

    const first = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root],
      { cwd: proj.root, home: proj.home },
    );
    expect(first.code).toBe(0);
    const afterFirst = gitLogCount(proj.root);

    // A second invocation without --force is a pure idempotent skip: success,
    // no rewrite, no second commit — a re-close is not a re-audit.
    const second = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root],
      { cwd: proj.root, home: proj.home },
    );
    expect(second.code).toBe(0);
    const env2 = parseCliOutput(second.output);
    expect(env2.success).toBe(true);
    expect(env2.skipped).toBe(true);
    expect(gitLogCount(proj.root)).toBe(afterFirst);

    // --force re-derives, landing a new write + commit.
    seedCommit(proj.root, t0, [{ path: "b.ts", insertions: 2, deletions: 0 }]);
    const forced = runCli(
      ["selection-audit-brief", epicId, "--project", proj.root, "--force"],
      { cwd: proj.root, home: proj.home },
    );
    expect(forced.code).toBe(0);
    const envForced = parseCliOutput(forced.output);
    expect(envForced.success).toBe(true);
    expect(envForced.skipped).toBeUndefined();
    expect(gitLogCount(proj.root)).toBe(afterFirst + 1);
  });

  test("malformed id -> BAD_EPIC_ID", () => {
    const proj = getProj();
    const r = runCli(
      ["selection-audit-brief", "not-an-id", "--project", proj.root],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("BAD_EPIC_ID");
  });

  test("unknown epic -> EPIC_NOT_FOUND", () => {
    const proj = getProj();
    const r = runCli(
      ["selection-audit-brief", "fn-99-missing", "--project", proj.root],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).toBe(1);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("EPIC_NOT_FOUND");
  });
});
