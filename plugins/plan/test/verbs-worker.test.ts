// Engine-agnostic conformance spec for the three worker-loop mutating verbs —
// translated from tests/test_worker_verbs.py, every node mapped by a
// source-comment. claim / done / block: the success-envelope fields + runtime
// read-back, the typed-error / --force matrix (TASK_DONE never bypassed; the
// rest are), the ZERO-commit guarantee for claim+block, done's spec patch +
// worker_done_at stamp + exactly-one commit with the trailer block, and the
// session-id polarity (done fail-closed, claim fail-open).
//
// Every fixture is the CLI-free seedState builder + gitBaseline (the harness
// _git_seed port); assertions are on envelopes, .keeper/ files, and git log,
// never internals. The commit-asserting tests run real git via gitBaseline so
// the auto-commit is exercised honestly.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  gitBaseline,
  gitHeadMessage,
  gitLogCount,
  parseCliOutput,
  runCli,
  seedRuntime,
  seedState,
  withTmpdir,
} from "./harness.ts";

const SID = { CLAUDE_CODE_SESSION_ID: "test-worker-verbs" };
const FROZEN = "2026-06-06T00:00:00.000000Z";

// Read a task's runtime overlay off the gitignored state file, or null. Port of
// _runtime — disk read, no verb.
function runtime(root: string, taskId: string): Record<string, unknown> | null {
  const p = join(root, ".keeper", "state", "tasks", `${taskId}.state.json`);
  if (!existsSync(p)) {
    return null;
  }
  return JSON.parse(readFileSync(p, "utf-8"));
}

// Read a task's tracked definition JSON. Port of _task_def.
function taskDef(root: string, taskId: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(root, ".keeper", "tasks", `${taskId}.json`), "utf-8"),
  );
}

function specText(root: string, specId: string): string {
  return readFileSync(join(root, ".keeper", "specs", `${specId}.md`), "utf-8");
}

let root: string;
const getTmp = withTmpdir("planctl-worker-");
beforeEach(() => {
  root = getTmp();
});

// ---------------------------------------------------------------------------
// claim — success envelope + runtime read-back
// ---------------------------------------------------------------------------

describe("claim success", () => {
  test("envelope fields + runtime overlay", () => {
    // test_worker_verbs.py::test_claim_success_envelope_and_runtime
    const [epicId, taskIds] = seedState(root, {
      epicId: "fn-1-claim",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    const r = runCli(["claim", taskId, "--project", root], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);

    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.task_id).toBe(taskId);
    expect(payload.epic_id).toBe(epicId);
    expect(payload.target_repo).toBe(root);
    expect(payload.primary_repo).toBe(root);
    expect(payload.tier).toBe("medium");
    expect(payload.worker_agent).toBe("plan:worker-opus-medium");
    const ts = payload.task_state as Record<string, unknown>;
    expect(ts.status).toBe("in_progress");
    expect(ts.outcome).toBe("CLAIMED");
    expect((payload.epic_state as Record<string, unknown>).status).toBe("open");
    expect(payload.brief_ref).toBe(
      join(root, ".keeper", "state", "briefs", `${taskId}.json`),
    );

    const rt = runtime(root, taskId);
    expect(rt).not.toBeNull();
    expect((rt as Record<string, unknown>).status).toBe("in_progress");
    expect((rt as Record<string, unknown>).assignee).toBe("test@example.com");
  });

  test("succeeds without a session id (fail-open)", () => {
    // test_worker_verbs.py::test_claim_succeeds_without_session_id
    const [, taskIds] = seedState(root, { epicId: "fn-2-claim", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const r = runCli(["claim", taskId, "--project", root], {
      cwd: root,
      env: { CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(r.code).toBe(0);
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "in_progress",
    );
  });
});

// ---------------------------------------------------------------------------
// claim — typed error envelopes + the --force matrix
// ---------------------------------------------------------------------------

describe("claim typed errors + --force matrix", () => {
  test("bad task id", () => {
    // test_worker_verbs.py::test_claim_bad_task_id
    const r = runCli(["claim", "not-a-task-id", "--project", root], {
      cwd: root,
      env: SID,
    });
    expect(r.code).not.toBe(0);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("BAD_TASK_ID");
  });

  test("task not found", () => {
    // test_worker_verbs.py::test_claim_task_not_found
    seedState(root, { epicId: "fn-3-claim", nTasks: 1 });
    const r = runCli(["claim", "fn-3-claim.9", "--project", root], {
      cwd: root,
      env: SID,
    });
    expect(r.code).not.toBe(0);
    expect(
      (parseCliOutput(r.output).error as Record<string, unknown>).code,
    ).toBe("TASK_NOT_FOUND");
  });

  test("TASK_DONE is never bypassed, even with --force", () => {
    // test_worker_verbs.py::test_claim_task_done_never_bypassed_even_with_force
    const [, taskIds] = seedState(root, { epicId: "fn-4-claim", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, { status: "done", assignee: "someone@x" });
    for (const extra of [[], ["--force"]]) {
      const r = runCli(["claim", taskId, "--project", root, ...extra], {
        cwd: root,
        env: SID,
      });
      expect(r.code).not.toBe(0);
      expect(
        (parseCliOutput(r.output).error as Record<string, unknown>).code,
      ).toBe("TASK_DONE");
      expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
        "done",
      );
    }
  });

  test("CLAIMED_BY_OTHER then --force takes over", () => {
    // test_worker_verbs.py::test_claim_claimed_by_other_then_force_takes_over
    const [, taskIds] = seedState(root, { epicId: "fn-5-claim", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "other@example.com",
    });

    const blocked = runCli(["claim", taskId, "--project", root], {
      cwd: root,
      env: SID,
    });
    expect(blocked.code).not.toBe(0);
    expect(
      (parseCliOutput(blocked.output).error as Record<string, unknown>).code,
    ).toBe("CLAIMED_BY_OTHER");
    expect((runtime(root, taskId) as Record<string, unknown>).assignee).toBe(
      "other@example.com",
    );

    const forced = runCli(["claim", taskId, "--project", root, "--force"], {
      cwd: root,
      env: SID,
    });
    expect(forced.code).toBe(0);
    const rt = runtime(root, taskId) as Record<string, unknown>;
    expect(rt.status).toBe("in_progress");
    expect(rt.assignee).toBe("test@example.com");
  });

  test("TASK_BLOCKED then --force bypasses", () => {
    // test_worker_verbs.py::test_claim_blocked_then_force_bypasses
    const [, taskIds] = seedState(root, { epicId: "fn-6-claim", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, { status: "blocked", blocked_reason: "stuck" });

    const blocked = runCli(["claim", taskId, "--project", root], {
      cwd: root,
      env: SID,
    });
    expect(blocked.code).not.toBe(0);
    expect(
      (parseCliOutput(blocked.output).error as Record<string, unknown>).code,
    ).toBe("TASK_BLOCKED");

    const forced = runCli(["claim", taskId, "--project", root, "--force"], {
      cwd: root,
      env: SID,
    });
    expect(forced.code).toBe(0);
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "in_progress",
    );
  });

  test("DEPS_UNMET names the unmet dep then --force bypasses", () => {
    // test_worker_verbs.py::test_claim_deps_unmet_then_force_bypasses
    const [, taskIds] = seedState(root, {
      epicId: "fn-7-claim",
      nTasks: 2,
      taskDeps: { 2: [1] },
    });
    const [depId, taskId] = taskIds as [string, string];

    const blocked = runCli(["claim", taskId, "--project", root], {
      cwd: root,
      env: SID,
    });
    expect(blocked.code).not.toBe(0);
    const err = parseCliOutput(blocked.output).error as Record<string, unknown>;
    expect(err.code).toBe("DEPS_UNMET");
    expect((err.details as Record<string, unknown>).unmet).toContain(depId);

    const forced = runCli(["claim", taskId, "--project", root, "--force"], {
      cwd: root,
      env: SID,
    });
    expect(forced.code).toBe(0);
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "in_progress",
    );
  });
});

// ---------------------------------------------------------------------------
// claim — ZERO commits (gitignored state only)
// ---------------------------------------------------------------------------

describe("claim ZERO commits", () => {
  test("claim mutates only gitignored state — no commit", () => {
    // test_worker_verbs.py::test_claim_produces_no_commit
    const [, taskIds] = seedState(root, { epicId: "fn-8-claim", nTasks: 1 });
    const taskId = taskIds[0] as string;
    gitBaseline(root);

    const before = gitLogCount(root);
    const r = runCli(["claim", taskId, "--project", root], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "in_progress",
    );
    expect(gitLogCount(root)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// block — state transition + ZERO commits
// ---------------------------------------------------------------------------

describe("block", () => {
  test("sets blocked + reason on disk", () => {
    // test_worker_verbs.py::test_block_sets_blocked_and_reason
    const [, taskIds] = seedState(root, { epicId: "fn-1-block", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });

    const r = runCli(["block", taskId, "--reason", "waiting on api"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    const rt = runtime(root, taskId) as Record<string, unknown>;
    expect(rt.status).toBe("blocked");
    expect(rt.blocked_reason).toBe("waiting on api");
  });

  test("block on a done task errors, state unchanged", () => {
    // test_worker_verbs.py::test_block_done_task_errors
    const [, taskIds] = seedState(root, { epicId: "fn-2-block", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, { status: "done", assignee: "test@example.com" });

    const r = runCli(["block", taskId, "--reason", "nope"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).not.toBe(0);
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "done",
    );
  });

  test("block mutates only gitignored state — no commit", () => {
    // test_worker_verbs.py::test_block_produces_no_commit
    const [, taskIds] = seedState(root, { epicId: "fn-3-block", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    gitBaseline(root);

    const before = gitLogCount(root);
    const r = runCli(["block", taskId, "--reason", "stuck"], {
      cwd: root,
      env: SID,
    });
    expect(r.code).toBe(0);
    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "blocked",
    );
    expect(gitLogCount(root)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// done — spec patch + worker_done_at stamp + exactly one commit
// ---------------------------------------------------------------------------

describe("done", () => {
  test("stamps + patches + commits exactly once with the trailer block", () => {
    // test_worker_verbs.py::test_done_stamps_patches_and_commits_once
    const [, taskIds] = seedState(root, { epicId: "fn-1-done", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });
    gitBaseline(root);

    const before = gitLogCount(root);
    // Frozen clock rides the subprocess env so worker_done_at == FROZEN.
    const r = runCli(
      ["done", taskId, "--summary", "shipped it", "--no-op-reason", "no code"],
      {
        cwd: root,
        env: { ...SID, KEEPER_PLAN_NOW: FROZEN },
      },
    );
    expect(r.code).toBe(0);

    expect((runtime(root, taskId) as Record<string, unknown>).status).toBe(
      "done",
    );
    expect(taskDef(root, taskId).worker_done_at).toBe(FROZEN);
    expect(specText(root, taskId)).toContain("shipped it");

    expect(gitLogCount(root)).toBe(before + 1);
    const msg = gitHeadMessage(root);
    expect(msg.split("\n")[0]).toBe(`chore(plan): done ${taskId}`);
    expect(msg).toContain("Planctl-Op: done");
    expect(msg).toContain(`Planctl-Target: ${taskId}`);
    expect(msg).toContain("Planctl-Prev-Op:");
    expect(msg).toContain(`Session-Id: ${SID.CLAUDE_CODE_SESSION_ID}`);
  });

  test("done without a session id fails closed", () => {
    // test_worker_verbs.py::test_done_without_session_id_fails_closed
    const [, taskIds] = seedState(root, { epicId: "fn-2-done", nTasks: 1 });
    const taskId = taskIds[0] as string;
    seedRuntime(root, taskId, {
      status: "in_progress",
      assignee: "test@example.com",
    });

    const r = runCli(
      ["done", taskId, "--summary", "x", "--no-op-reason", "no code"],
      {
        cwd: root,
        env: { CLAUDE_CODE_SESSION_ID: "" },
      },
    );
    expect(r.code).not.toBe(0);
  });
});
