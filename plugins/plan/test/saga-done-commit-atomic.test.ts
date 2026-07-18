// Conformance spec for `done`'s durable-or-nothing state-file commit — the
// mid-merge shared-checkout window where git refuses a partial commit while the
// worker's done overlay is already on disk (and already read by the daemon as
// runtime_status: done). Two guarantees:
//
//  1. A failed commit UNWINDS: the spec patch, gitignored runtime overlay, and
//     tracked worker_done_at are all restored to their pre-done bytes, so no
//     half-stamped "done" the CLI cannot back out of survives, and a plain
//     `done` re-run once the merge completes recovers with no operator hand-edit.
//  2. An already-wedged shape (runtime overlay done, HEAD:<task.json> missing
//     worker_done_at — reconcile's STATE_UNCOMMITTED verdict) SELF-HEALS on a
//     `done` re-run: it re-commits the missing backing rather than the flat
//     "already done" refusal a durably-committed done still earns.
//
// Every fixture is the CLI-free seedState builder + gitBaseline (the committed
// HEAD baseline) + the fake VCS's one-shot commit failure (failNextCommit);
// assertions are on envelopes, .keeper/ files, and the fake git log.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { failNextCommit } from "./fake-vcs.ts";
import {
  fakeDirtyPaths,
  firstJsonPayload,
  gitBaseline,
  gitFilesInHead,
  gitLogCount,
  parseCliOutput,
  runCli,
  seedRuntime,
  seedState,
  withTmpdir,
} from "./harness.ts";

const SID = { CLAUDE_CODE_SESSION_ID: "test-done-atomic" };
const FROZEN = "2026-06-06T00:00:00.000000Z";
const MERGE_STDERR = "error: cannot do a partial commit during a merge";

function runtime(root: string, taskId: string): Record<string, unknown> | null {
  const p = join(root, ".keeper", "state", "tasks", `${taskId}.state.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
}

function taskDef(root: string, taskId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, ".keeper", "tasks", `${taskId}.json`), "utf-8"),
  );
}

function specText(root: string, taskId: string): string {
  return readFileSync(join(root, ".keeper", "specs", `${taskId}.md`), "utf-8");
}

let root: string;
const getTmp = withTmpdir("planctl-done-atomic-");
beforeEach(() => {
  root = getTmp();
});

describe("done — commit failure unwinds the half-stamp", () => {
  test("the mid-merge window loud-fails and leaves no durable done", () => {
    const [, taskIds] = seedState(root, { epicId: "fn-1-atomic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    gitBaseline(root);

    // Arm the mid-merge commit failure (armed AFTER gitBaseline, which resets it).
    failNextCommit(root, MERGE_STDERR);

    const r = runCli(["done", taskId, "--summary", "shipped it"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).not.toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("commit_failed");
    // The exact git reason surfaces verbatim — the mid-merge window is explicit,
    // not a generic failure.
    expect(JSON.stringify(payload.details)).toContain(
      "partial commit during a merge",
    );

    // No half-stamp: the three state files are back to their pre-done bytes
    // (the normalized baseline defaults worker_done_at to null — never a stamp).
    expect(taskDef(root, taskId).worker_done_at).toBeNull();
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "in_progress",
    );
    expect(specText(root, taskId)).not.toContain("shipped it");
    // A clean tree — nothing left dirty for the daemon to fold as done.
    expect(fakeDirtyPaths(root)).toEqual([]);
  });

  test("a plain re-run after the failed commit recovers with no hand-edit", () => {
    const [, taskIds] = seedState(root, { epicId: "fn-2-atomic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    gitBaseline(root);
    failNextCommit(root, MERGE_STDERR);

    const failed = runCli(["done", taskId, "--summary", "shipped it"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(failed.code).not.toBe(0);

    // The merge completed; a plain `done` re-run (no failure armed) commits.
    const before = gitLogCount(root);
    const r = runCli(["done", taskId, "--summary", "shipped it"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    expect(firstJsonPayload(r.output).success).toBe(true);
    expect(taskDef(root, taskId).worker_done_at).toBe(FROZEN);
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "done",
    );
    expect(gitLogCount(root)).toBe(before + 1);
    expect(gitFilesInHead(root)).toContain(`.keeper/tasks/${taskId}.json`);
  });
});

describe("done — self-heal an uncommitted (STATE_UNCOMMITTED) wedge", () => {
  test("a re-run re-commits the missing backing instead of refusing", () => {
    const [, taskIds] = seedState(root, { epicId: "fn-3-atomic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    // Committed HEAD = the def WITHOUT worker_done_at.
    gitBaseline(root);
    // The wedge: the runtime overlay reads done, but HEAD:<task.json> carries no
    // worker_done_at (the prior done's commit was lost).
    seedRuntime(root, taskId, {
      status: "done",
      assignee: "test@example.com",
    });

    const before = gitLogCount(root);
    const r = runCli(["done", taskId, "--summary", "recovered"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    const payload = firstJsonPayload(r.output);
    expect(payload.success).toBe(true);
    expect(payload.status).toBe("done");
    // The backing now lands: worker_done_at on disk + exactly one new commit
    // carrying the def, so a follow-up reconcile reads DONE, not STATE_UNCOMMITTED.
    expect(taskDef(root, taskId).worker_done_at).toBe(FROZEN);
    expect(gitLogCount(root)).toBe(before + 1);
    expect(gitFilesInHead(root)).toContain(`.keeper/tasks/${taskId}.json`);
  });

  test("a heal re-run with no --summary preserves the existing Done summary", () => {
    const [, taskIds] = seedState(root, { epicId: "fn-4-atomic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    // Simulate the failed attempt's on-disk spec patch (the wedge kept it dirty).
    const specPath = join(root, ".keeper", "specs", `${taskId}.md`);
    const patched = readFileSync(specPath, "utf-8").replace(
      "## Done summary\n",
      "## Done summary\n\nlanded on the epic branch\n",
    );
    writeFileSync(specPath, patched, "utf-8");
    gitBaseline(root);
    seedRuntime(root, taskId, {
      status: "done",
      assignee: "test@example.com",
    });

    const r = runCli(["done", taskId], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    expect(specText(root, taskId)).toContain("landed on the epic branch");
  });

  test("a heal re-run with no --evidence preserves the Evidence section + overlay", () => {
    const [, taskIds] = seedState(root, { epicId: "fn-6-atomic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    // The wedge kept the prior done's recovered `## Evidence` section on disk.
    const specPath = join(root, ".keeper", "specs", `${taskId}.md`);
    const patched = readFileSync(specPath, "utf-8").replace(
      "## Evidence\n",
      "## Evidence\n\n- Commits: abc1234\n- Tests: bun test green\n",
    );
    writeFileSync(specPath, patched, "utf-8");
    gitBaseline(root);
    // ...and the runtime overlay carries the prior done's evidence object.
    const priorEvidence = {
      commits: ["abc1234"],
      tests: ["bun test green"],
      prs: [],
    };
    seedRuntime(root, taskId, {
      status: "done",
      assignee: "test@example.com",
      evidence: priorEvidence,
    });

    const r = runCli(["done", taskId], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).toBe(0);
    // The recorded Evidence bullets survive — a --evidence-less heal must not
    // blank them (F2), just as the Done summary is preserved above.
    const spec = specText(root, taskId);
    expect(spec).toContain("- Commits: abc1234");
    expect(spec).toContain("- Tests: bun test green");
    // The runtime overlay evidence survives too (not reset to the empty default).
    expect((runtime(root, taskId) as Record<string, unknown>).evidence).toEqual(
      priorEvidence,
    );
  });

  test("a heal whose own re-commit fails mid-merge is an idempotent no-op", () => {
    const [, taskIds] = seedState(root, { epicId: "fn-7-atomic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    // Pre-heal wedge on disk: recovered Evidence, HEAD lacks worker_done_at.
    const specPath = join(root, ".keeper", "specs", `${taskId}.md`);
    const patched = readFileSync(specPath, "utf-8").replace(
      "## Evidence\n",
      "## Evidence\n\n- Commits: def5678\n",
    );
    writeFileSync(specPath, patched, "utf-8");
    gitBaseline(root);
    seedRuntime(root, taskId, {
      status: "done",
      assignee: "test@example.com",
      evidence: { commits: ["def5678"], tests: [], prs: [] },
    });
    const taskJsonPath = join(root, ".keeper", "tasks", `${taskId}.json`);
    const specBefore = readFileSync(specPath, "utf-8");
    const taskJsonBefore = readFileSync(taskJsonPath, "utf-8");

    // The heal's own re-commit hits the same mid-merge refusal.
    failNextCommit(root, MERGE_STDERR);
    const before = gitLogCount(root);
    const r = runCli(["done", taskId], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r.code).not.toBe(0);
    expect(firstJsonPayload(r.output).error).toBe("commit_failed");

    // Restore-to-already-done no-op: the wedge is byte-for-byte unchanged — no
    // new commit, HEAD:<task.json> still lacks worker_done_at, the overlay still
    // reads done, and the recovered Evidence survives, so a later plain re-run
    // still heals cleanly.
    expect(gitLogCount(root)).toBe(before);
    expect(taskDef(root, taskId).worker_done_at).toBeNull();
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "done",
    );
    expect(readFileSync(specPath, "utf-8")).toBe(specBefore);
    expect(readFileSync(taskJsonPath, "utf-8")).toBe(taskJsonBefore);
  });

  test("a durably-committed done still refuses (idempotency guard preserved)", () => {
    const [, taskIds] = seedState(root, { epicId: "fn-5-atomic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    gitBaseline(root);

    // First done commits worker_done_at into HEAD.
    const r1 = runCli(["done", taskId, "--summary", "shipped"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r1.code).toBe(0);
    const afterFirst = gitLogCount(root);

    // Second done: HEAD now carries the durable backing → "already done", no
    // heal, no new commit.
    const r2 = runCli(["done", taskId, "--summary", "again"], {
      cwd: root,
      env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
    });
    expect(r2.code).not.toBe(0);
    expect(String(parseCliOutput(r2.output).error)).toContain("already done");
    expect(gitLogCount(root)).toBe(afterFirst);
  });
});
