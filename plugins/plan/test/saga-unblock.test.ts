// Conformance spec for `keeper plan unblock <task_id>` — the resume mirror of
// block. unblock clears a blocked task to in_progress for a live or recent
// claimant and otherwise to todo, preserving the claim history
// (assignee/claimed_at/claim_note/evidence) and clearing blocked_reason. It
// errors (typed) on a task that is not currently blocked. Like block it
// mutates only the gitignored state/ overlay, so it lands ZERO commits.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  gitBaseline,
  gitLogCount,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  seedRuntime,
  withProject,
} from "./harness.ts";

// Read the gitignored runtime overlay a verb wrote.
function readRuntime(root: string, taskId: string): Record<string, unknown> {
  const path = join(root, ".keeper", "state", "tasks", `${taskId}.state.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function seedClaimantLifecycle(
  dbPath: string,
  taskId: string,
  state: "working" | "ended",
): void {
  const db = new Database(dbPath, { create: true });
  try {
    db.run(
      "CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT, hook_event TEXT, plan_op TEXT, plan_task_id TEXT)",
    );
    db.run("CREATE TABLE jobs (job_id TEXT PRIMARY KEY, state TEXT)");
    db.run(
      "CREATE TABLE reducer_state (id INTEGER PRIMARY KEY, last_event_id INTEGER)",
    );
    db.run(
      "INSERT INTO events (id, session_id, hook_event, plan_op, plan_task_id) VALUES (1, 'claimant', 'PostToolUse', 'claim', ?)",
      [taskId],
    );
    db.run("INSERT INTO jobs (job_id, state) VALUES ('claimant', ?)", [state]);
    if (state === "ended") {
      db.run(
        "INSERT INTO events (id, session_id, hook_event) VALUES (2, 'claimant', 'SessionEnd')",
      );
    }
    db.run("INSERT INTO reducer_state (id, last_event_id) VALUES (1, ?)", [
      state === "ended" ? 2 : 1,
    ]);
  } finally {
    db.close();
  }
}

describe("unblock happy path", () => {
  const getProj = withProject("planctl-unblock-");

  test("blocked -> todo preserves claim history, clears reason, zero commit", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Unblock epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    // Seed a blocked runtime overlay carrying the full claim history.
    seedRuntime(proj.root, taskId, {
      status: "blocked",
      blocked_reason: "SPEC_UNCLEAR: needs a decision",
      assignee: "alice@example.com",
      claimed_at: "2026-06-24T00:00:00.000000Z",
      claim_note: "took it",
      evidence: "wip notes",
    });

    const before = gitLogCount(proj.root);
    const r = runCli(["unblock", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(true);
    expect(payload.task_id).toBe(taskId);
    expect(payload.status).toBe("todo");

    const rt = readRuntime(proj.root, taskId);
    expect(rt.status).toBe("todo");
    expect(rt.blocked_reason).toBeNull();
    // Claim history survives the resume.
    expect(rt.assignee).toBe("alice@example.com");
    expect(rt.claimed_at).toBe("2026-06-24T00:00:00.000000Z");
    expect(rt.claim_note).toBe("took it");
    expect(rt.evidence).toBe("wip notes");

    // Readonly verb — no commit lands.
    expect(gitLogCount(proj.root)).toBe(before);
    const inv = payload.plan_invocation as Record<string, unknown>;
    expect(inv.op).toBe("unblock");
    expect(inv.subject).toBeNull();
    expect(inv.files).toBeNull();
  });

  test("keeps a live claimant in progress so its done stamp lands with evidence", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Unblock live claimant",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const dbPath = join(proj.root, "keeper.db");
    seedClaimantLifecycle(dbPath, taskId, "working");
    seedRuntime(proj.root, taskId, {
      status: "blocked",
      blocked_reason: "AUDIT_READY: audit passed",
      assignee: "test@example.com",
      claimed_at: "2026-06-24T00:00:00.000000Z",
    });

    const unblocked = runCli(["unblock", taskId], {
      cwd: proj.root,
      home: proj.home,
      env: { KEEPER_DB: dbPath },
    });
    expect(unblocked.code).toBe(0);
    expect(parseCliOutput(unblocked.output).status).toBe("in_progress");
    expect(readRuntime(proj.root, taskId).status).toBe("in_progress");

    gitBaseline(proj.root);
    const evidence = { commits: ["abc123"], tests: ["bun test"], prs: [] };
    const done = runCli(
      [
        "done",
        taskId,
        "--summary",
        "audited completion",
        "--evidence",
        JSON.stringify(evidence),
      ],
      {
        cwd: proj.root,
        home: proj.home,
        env: { KEEPER_DB: dbPath },
      },
    );
    expect(done.code).toBe(0);
    expect(readRuntime(proj.root, taskId).status).toBe("done");
    expect(readRuntime(proj.root, taskId).evidence).toEqual(evidence);
  });

  test("resets a terminally proven claimant to todo", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Unblock dead claimant",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const dbPath = join(proj.root, "keeper.db");
    seedClaimantLifecycle(dbPath, taskId, "ended");
    seedRuntime(proj.root, taskId, {
      status: "blocked",
      blocked_reason: "waiting",
      assignee: "test@example.com",
    });

    const r = runCli(["unblock", taskId], {
      cwd: proj.root,
      home: proj.home,
      env: { KEEPER_DB: dbPath },
    });
    expect(r.code).toBe(0);
    expect(parseCliOutput(r.output).status).toBe("todo");
    expect(readRuntime(proj.root, taskId).status).toBe("todo");
  });

  test("round-trips with the block verb", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Unblock epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    const b = runCli(["block", taskId, "--reason", "waiting"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(b.code).toBe(0);
    expect(readRuntime(proj.root, taskId).status).toBe("blocked");

    const r = runCli(["unblock", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(readRuntime(proj.root, taskId).status).toBe("todo");
    expect(readRuntime(proj.root, taskId).blocked_reason).toBeNull();
  });
});

describe("unblock typed errors", () => {
  const getProj = withProject("planctl-unblock-err-");

  test("not-blocked task -> typed error, no write", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Unblock epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    // Task is freshly scaffolded — status todo, never blocked.

    const r = runCli(["unblock", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const payload = parseCliOutput(r.output);
    expect(payload.success).toBe(false);
    expect(payload.error as string).toContain("not blocked");
  });

  test("invalid task id -> typed error", () => {
    const proj = getProj();
    const r = runCli(["unblock", "not-a-task-id"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    expect(parseCliOutput(r.output).success).toBe(false);
  });
});
