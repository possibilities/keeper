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
