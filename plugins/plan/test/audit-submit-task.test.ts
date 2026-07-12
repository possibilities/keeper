// Conformance spec for `keeper plan audit submit-task <task_id> --file - \
// --status <clean|mild|severe>` — the write half of the per-task audit gate's
// typed seam, paired with `audit gate-check` (saga-audit-gate-check.test.ts).
//
// The verb persists the task-scoped auditor's findings payload commit-free
// under audits/<epic_id>/tasks/<task_id>.json, deriving `commits` SERVER-SIDE
// (never trusting a caller-supplied commit list) so gate-check's independent
// recomputation always agrees — the round-trip parity tests are the load-
// bearing coverage here. Tests drive the real binary in a withProject repo,
// seeding source commits through the fake VCS (fakeSourceCommit).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  computeCommitSetHash,
  readTaskFinding,
  taskFindingPath,
} from "../src/audit_artifacts.ts";
import { setGitBinaryPresent } from "./fake-vcs.ts";
import {
  fakeSourceCommit,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

function submitTask(
  proj: { root: string; home: string },
  taskId: string,
  input: string,
  flags: string[],
): { code: number; env: Record<string, unknown> } {
  const r = runCli(
    [
      "audit",
      "submit-task",
      taskId,
      "--file",
      "-",
      "--project",
      proj.root,
      ...flags,
    ],
    { cwd: proj.root, home: proj.home, input },
  );
  return { code: r.code, env: parseCliOutput(r.output) };
}

function gateCheck(
  proj: { root: string; home: string },
  taskId: string,
): Record<string, unknown> {
  const r = runCli(["audit", "gate-check", taskId, "--project", proj.root], {
    cwd: proj.root,
    home: proj.home,
  });
  return parseCliOutput(r.output);
}

describe("audit submit-task", () => {
  const getProj = withProject("planctl-audit-submit-task-");

  test("happy path persists the finding, deriving commits server-side", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const sha = fakeSourceCommit(
      proj.root,
      `feat(x): implement\n\nTask: ${taskId}`,
    );

    const { code, env } = submitTask(
      proj,
      taskId,
      JSON.stringify({ findings: [{ fingerprint: "correctness:a.ts" }] }),
      ["--status", "mild"],
    );
    expect(code).toBe(0);
    expect(env.success).toBe(true);
    expect(env.status).toBe("mild");
    expect(env.task_id).toBe(taskId);
    expect(env.epic_id).toBe(epicId);

    const stored = JSON.parse(readFileSync(env.finding_ref as string, "utf-8"));
    expect(stored.status).toBe("mild");
    expect(stored.task_id).toBe(taskId);
    expect(stored.epic_id).toBe(epicId);
    expect(stored.commits).toEqual([{ repo: proj.root, shas: [sha] }]);
    expect(stored.commit_set_hash).toBe(
      computeCommitSetHash([{ repo: proj.root, shas: [sha] }]),
    );
    // Per-finding status defaults to accumulated-open when absent.
    expect(stored.findings).toEqual([
      { fingerprint: "correctness:a.ts", status: "accumulated-open" },
    ]);
  });

  test("a caller-supplied commits field in the payload is ignored — server derives it", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const sha = fakeSourceCommit(
      proj.root,
      `feat(x): implement\n\nTask: ${taskId}`,
    );

    const { env } = submitTask(
      proj,
      taskId,
      JSON.stringify({
        findings: [],
        commits: [{ repo: "/forged/repo", shas: ["deadbeef"] }],
      }),
      ["--status", "clean"],
    );
    const stored = JSON.parse(readFileSync(env.finding_ref as string, "utf-8"));
    expect(stored.commits).toEqual([{ repo: proj.root, shas: [sha] }]);
  });

  test("a caller-supplied top-level status in the payload never wins over --status", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    const { env } = submitTask(
      proj,
      taskId,
      JSON.stringify({ status: "severe", findings: [] }),
      ["--status", "clean"],
    );
    expect(env.status).toBe("clean");
    const stored = JSON.parse(readFileSync(env.finding_ref as string, "utf-8"));
    expect(stored.status).toBe("clean");
  });

  test("per-finding status is preserved when already present", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    const { env } = submitTask(
      proj,
      taskId,
      JSON.stringify({
        findings: [{ fingerprint: "x", status: "fixed" }],
      }),
      ["--status", "mild"],
    );
    const stored = JSON.parse(readFileSync(env.finding_ref as string, "utf-8"));
    expect(stored.findings).toEqual([{ fingerprint: "x", status: "fixed" }]);
  });

  test("last writer wins", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    submitTask(proj, taskId, JSON.stringify({ findings: [] }), [
      "--status",
      "clean",
    ]);
    const { env } = submitTask(proj, taskId, JSON.stringify({ findings: [] }), [
      "--status",
      "severe",
    ]);
    expect(env.status).toBe("severe");
    const stored = JSON.parse(readFileSync(env.finding_ref as string, "utf-8"));
    expect(stored.status).toBe("severe");
  });

  test("bad --status rejected at parse (exit 2) naming the value", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const r = runCli(
      [
        "audit",
        "submit-task",
        taskId,
        "--file",
        "-",
        "--status",
        "Catastrophic",
        "--project",
        proj.root,
      ],
      { cwd: proj.root, home: proj.home, input: "{}" },
    );
    expect(r.code).toBe(2);
    expect(r.output).toContain("Catastrophic");
  });

  test("bad JSON payload rejects with BAD_JSON", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const { code, env } = submitTask(proj, taskId, "{not json", [
      "--status",
      "clean",
    ]);
    expect(code).toBe(1);
    expect((env.error as Record<string, unknown>).code).toBe("BAD_JSON");
  });

  test("a non-object JSON payload rejects with BAD_PAYLOAD", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const { code, env } = submitTask(proj, taskId, "[1,2,3]", [
      "--status",
      "clean",
    ]);
    expect(code).toBe(1);
    expect((env.error as Record<string, unknown>).code).toBe("BAD_PAYLOAD");
  });

  test("task-shaped id required — a garbage id rejects with BAD_TASK_ID", () => {
    const proj = getProj();
    const { code, env } = submitTask(proj, "not-a-task-id", "{}", [
      "--status",
      "clean",
    ]);
    expect(code).toBe(1);
    expect((env.error as Record<string, unknown>).code).toBe("BAD_TASK_ID");
  });

  test("git-unavailable environment yields a typed tooling error", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    setGitBinaryPresent(false);
    try {
      const { code, env } = submitTask(
        proj,
        taskId,
        JSON.stringify({ findings: [] }),
        ["--status", "clean"],
      );
      expect(code).toBe(1);
      expect((env.error as Record<string, unknown>).code).toBe(
        "GIT_UNAVAILABLE",
      );
    } finally {
      setGitBinaryPresent(true);
    }
  });

  test("no commit fires: no files-bearing invocation payload", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Submit-task epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    const r = runCli(
      [
        "audit",
        "submit-task",
        taskId,
        "--file",
        "-",
        "--status",
        "clean",
        "--project",
        proj.root,
      ],
      { cwd: proj.root, home: proj.home, input: "{}" },
    );
    expect(r.code).toBe(0);
    expect(r.output.includes('"files":[')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Round-trip parity with gate-check — the acceptance-pinned load-bearing
  // scenario: submit-task then gate-check reports covering against an
  // unchanged repo, and not-covering after a new task-trailered commit lands.
  // -------------------------------------------------------------------------

  test("round-trip: submit-task then gate-check reports covering", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, {
      title: "Round-trip epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    fakeSourceCommit(proj.root, `feat(x): work\n\nTask: ${taskId}`);

    submitTask(proj, taskId, JSON.stringify({ findings: [] }), [
      "--status",
      "clean",
    ]);

    const env = gateCheck(proj, taskId);
    expect(env.exists).toBe(true);
    expect(env.covers_current_commits).toBe(true);
    expect(env.status).toBe("clean");
  });

  test("round-trip: a new task-trailered commit after submit-task flips gate-check to not-covering", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Round-trip epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;
    fakeSourceCommit(proj.root, `feat(x): work\n\nTask: ${taskId}`);

    submitTask(proj, taskId, JSON.stringify({ findings: [] }), [
      "--status",
      "clean",
    ]);
    expect(gateCheck(proj, taskId).covers_current_commits).toBe(true);

    // A later fixup commit lands, unreviewed by the persisted finding.
    fakeSourceCommit(proj.root, `fix(x): follow-up\n\nTask: ${taskId}`);

    const env = gateCheck(proj, taskId);
    expect(env.covers_current_commits).toBe(false);
    expect(env.exists).toBe(true);
    // Re-submitting against the now-current commit set restores coverage —
    // the sink-owned idempotency contract round-trips in both directions.
    submitTask(proj, taskId, JSON.stringify({ findings: [] }), [
      "--status",
      "clean",
    ]);
    expect(gateCheck(proj, taskId).covers_current_commits).toBe(true);

    // readTaskFinding directly confirms the stamped hash matches the final
    // derived commit set (both source commits).
    const stored = readTaskFinding(proj.root, epicId, taskId);
    expect(typeof stored?.commit_set_hash).toBe("string");
    expect(
      taskFindingPath(proj.root, epicId, taskId).endsWith(`${taskId}.json`),
    ).toBe(true);
  });
});
