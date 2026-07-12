// Conformance spec for `keeper plan audit gate-check <task_id>` — the
// read-only per-task audit-gate seam the content-blind /plan:work
// orchestrator polls between a flagged worker's commit and its done-stamp.
//
// gate-check derives the task's CURRENT commit set itself (the same
// deriveTaskCommitGroups seam submit-task uses) and compares it against the
// persisted per-task finding artifact's stamped commit_set_hash — tests seed
// the in-verb-read fixtures through the fake VCS (fakeSourceCommit) and the
// real audit_artifacts writer (writeTaskFinding), so the on-disk shape carries
// zero drift and the suite stays git-free in the default tier.

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

import {
  computeCommitSetHash,
  taskAuditDir,
  taskFindingPath,
  writeTaskFinding,
} from "../src/audit_artifacts.ts";
import { setGitBinaryPresent } from "./fake-vcs.ts";
import {
  fakeSourceCommit,
  parseCliOutput,
  runCli,
  scaffoldEpic,
  withProject,
} from "./harness.ts";

function gateCheck(
  proj: { root: string; home: string },
  taskId: string,
): { code: number; env: Record<string, unknown> } {
  const r = runCli(["audit", "gate-check", taskId, "--project", proj.root], {
    cwd: proj.root,
    home: proj.home,
  });
  return { code: r.code, env: parseCliOutput(r.output) };
}

describe("audit gate-check", () => {
  const getProj = withProject("planctl-audit-gate-check-");

  test("no finding artifact: exists false, not covering, null status", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Gate epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    const { code, env } = gateCheck(proj, taskId);
    expect(code).toBe(0);
    expect(env.exists).toBe(false);
    expect(env.covers_current_commits).toBe(false);
    expect(env.status).toBeNull();
    expect(env.finding_ref).toBe(taskFindingPath(proj.root, epicId, taskId));
  });

  test("single top-level JSON root (no trailing document)", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Gate epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const r = runCli(["audit", "gate-check", taskId, "--project", proj.root], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    // Exactly one JSON value on stdout: parsing the whole trimmed body must
    // succeed, and it must equal parsing just the first line.
    const trimmed = r.stdout.trim();
    expect(() => JSON.parse(trimmed)).not.toThrow();
    const firstLine = trimmed.split("\n")[0] as string;
    // compactJson prints the envelope as ONE line, so the whole body IS the
    // first line — a second root would make these diverge.
    expect(trimmed).toBe(firstLine);
  });

  test("a finding covering the current (empty) commit set reports covering", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Gate epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    // No source commit lands for this task, so the derived commit set is [] —
    // a finding stamped over the empty set should still round-trip as covering.
    writeTaskFinding(proj.root, epicId, taskId, {
      status: "clean",
      commits: [],
      findings: [],
    });

    const { code, env } = gateCheck(proj, taskId);
    expect(code).toBe(0);
    expect(env.exists).toBe(true);
    expect(env.covers_current_commits).toBe(true);
    expect(env.status).toBe("clean");
  });

  test("a new task-trailered commit flips covering to false", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Gate epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    writeTaskFinding(proj.root, epicId, taskId, {
      status: "clean",
      commits: [],
      findings: [],
    });
    expect(gateCheck(proj, taskId).env.covers_current_commits).toBe(true);

    fakeSourceCommit(proj.root, `fix(x): follow-up\n\nTask: ${taskId}`);

    const { env } = gateCheck(proj, taskId);
    expect(env.covers_current_commits).toBe(false);
    // The finding is still present with its stamped status — only the
    // coverage flag reacts to the moved commit set.
    expect(env.exists).toBe(true);
    expect(env.status).toBe("clean");
  });

  test("hash parity: a finding stamped over the SAME derived commits covers", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Gate epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    const sha = fakeSourceCommit(
      proj.root,
      `feat(x): do the thing\n\nTask: ${taskId}`,
    );
    const commits = [{ repo: proj.root, shas: [sha] }];
    writeTaskFinding(proj.root, epicId, taskId, {
      status: "mild",
      commits,
      findings: [{ fingerprint: "correctness:a.ts" }],
    });

    const { env } = gateCheck(proj, taskId);
    expect(env.covers_current_commits).toBe(true);
    expect(env.status).toBe("mild");
    // Independently reproduces the same hash the verb compares against.
    const path = taskFindingPath(proj.root, epicId, taskId);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.commit_set_hash).toBe(computeCommitSetHash(commits));
  });

  test("an out-of-enum top-level status clamps to null (still exists)", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Gate epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    writeTaskFinding(proj.root, epicId, taskId, {
      status: "bogus-status",
      commits: [],
      findings: [],
    });

    const { env } = gateCheck(proj, taskId);
    expect(env.exists).toBe(true);
    expect(env.status).toBeNull();
    // The hash still matches the empty commit set, independent of the
    // clamped status.
    expect(env.covers_current_commits).toBe(true);
  });

  test("an unparseable artifact clamps to unreadable: null status, not covering", () => {
    const proj = getProj();
    const { epicId, taskIds } = scaffoldEpic(proj, {
      title: "Gate epic",
      nTasks: 1,
    });
    const taskId = taskIds[0] as string;

    taskAuditDir(proj.root, epicId);
    const path = taskFindingPath(proj.root, epicId, taskId);
    writeFileSync(path, "{not json", "utf-8");

    const { env } = gateCheck(proj, taskId);
    expect(env.exists).toBe(true);
    expect(env.status).toBeNull();
    expect(env.covers_current_commits).toBe(false);
  });

  test("git-unavailable environment yields a typed tooling error, not a fabricated envelope", () => {
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Gate epic", nTasks: 1 });
    const taskId = taskIds[0] as string;

    setGitBinaryPresent(false);
    try {
      const r = runCli(
        ["audit", "gate-check", taskId, "--project", proj.root],
        { cwd: proj.root, home: proj.home },
      );
      expect(r.code).toBe(1);
      const env = parseCliOutput(r.output);
      expect(env.success).toBe(false);
      const error = env.error as Record<string, unknown>;
      expect(error.code).toBe("GIT_UNAVAILABLE");
      // Fail-closed: no fabricated covering/status data on the error path.
      expect("covers_current_commits" in env).toBe(false);
    } finally {
      setGitBinaryPresent(true);
    }
  });

  test("BAD_TASK_ID for a garbage id", () => {
    const proj = getProj();
    const r = runCli(
      ["audit", "gate-check", "not-a-task-id", "--project", proj.root],
      { cwd: proj.root, home: proj.home },
    );
    expect(r.code).toBe(1);
    const env = parseCliOutput(r.output);
    expect((env.error as Record<string, unknown>).code).toBe("BAD_TASK_ID");
  });
});
