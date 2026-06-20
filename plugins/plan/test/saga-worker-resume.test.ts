// Conformance spec for `planctl worker resume <task_id>` — translated from
// tests/test_worker_resume.py, every node mapped by a source-comment
// (translated | cited | drop-with-reason). Resume is content-blind: it
// regenerates the out-of-band brief fresh and returns a typed envelope
// (brief_ref handle + a one-line process `nudge`) — no narrative prose, no
// `planctl cat` self-reference; it stays read-only (no commit) and never flips
// task state.
//
// The pytest module monkeypatches the verb's internal _read_git_state /
// _find_source_commit_sha probes; the bun port drives the REAL binary in a real
// withProject repo, where a fresh project naturally yields no source commit and
// a real git status — so the monkeypatched behavior is reproduced honestly
// rather than injected. The only node that genuinely requires in-process
// injection (a fabricated source-commit sha) is python_only and dropped.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runCli, scaffoldEpic, withProject } from "./harness.ts";

function briefPath(root: string, taskId: string): string {
  return join(root, ".keeper", "state", "briefs", `${taskId}.json`);
}

// Write the runtime sidecar directly, bypassing claim/done. Port of _set_status.
function setStatus(root: string, taskId: string, status: string): void {
  const p = join(root, ".keeper", "state", "tasks", `${taskId}.state.json`);
  writeFileSync(
    p,
    `${JSON.stringify({ status, updated_at: "2026-04-18T00:00:00Z" })}\n`,
    "utf-8",
  );
}

// The primary envelope is plain JSON on stdout with NO plan_invocation footer
// (resume is a plain-group read verb).
function envelope(out: string): Record<string, unknown> {
  return JSON.parse(out.trim());
}

describe("worker resume", () => {
  const getProj = withProject("planctl-resume-");

  test("typed envelope: brief_ref + nudge + repos, no prose", () => {
    // test_worker_resume.py::test_worker_resume_typed_envelope
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Test epic", nTasks: 1 });
    const taskId = taskIds[0] as string;

    const r = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    const payload = envelope(r.stdout);
    expect(payload.success).toBe(true);
    expect(payload.task_id).toBe(taskId);
    expect("status" in payload).toBe(true);
    expect("tier" in payload).toBe(true);
    expect("target_repo" in payload).toBe(true);
    expect("primary_repo" in payload).toBe(true);

    // brief_ref is absolute + present, pointing at the regenerated brief.
    const briefRef = payload.brief_ref as string;
    expect(briefRef.startsWith("/")).toBe(true);
    expect(existsSync(briefRef)).toBe(true);

    // nudge is a one-line process string — no spec prose, no planctl cat.
    const nudge = payload.nudge as string;
    expect(nudge.includes("\n")).toBe(false);
    expect(nudge.includes(taskId)).toBe(true);
    expect(nudge.includes("BRIEF_REF")).toBe(true);
    expect(nudge.includes("planctl cat")).toBe(false);

    // No narrative prose anywhere in the envelope.
    expect("prompt" in payload).toBe(false);
    expect(r.stdout.includes("planctl cat")).toBe(false);
    expect(r.stdout.includes("**Files:**")).toBe(false);
    expect(r.stdout.includes("Files changed:")).toBe(false);
    expect(r.stdout.includes("CONTEXT:")).toBe(false);
  });

  test("regenerates the brief fresh on each entry", () => {
    // test_worker_resume.py::test_worker_resume_regenerates_brief_fresh
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Test epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const bp = briefPath(proj.root, taskId);

    const r1 = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r1.code).toBe(0);
    const first = readFileSync(bp, "utf-8");

    // Corrupt the brief, resume again — it must be overwritten fresh.
    writeFileSync(bp, "CORRUPT", "utf-8");
    const r2 = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r2.code).toBe(0);
    const second = readFileSync(bp, "utf-8");
    expect(second).not.toBe("CORRUPT");
    const parsed = JSON.parse(second) as Record<string, unknown>;
    expect(parsed.task_id).toBe(taskId);
    expect(parsed.schema_version).toBe(1);
    expect((JSON.parse(first) as Record<string, unknown>).task_id).toBe(taskId);
  });

  test("read-only: regenerating the brief lands no commit", () => {
    // test_worker_resume.py::test_worker_resume_no_commit_lands
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Test epic", nTasks: 1 });
    const taskId = taskIds[0] as string;

    const head = () =>
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: proj.root })
        .stdout.toString()
        .trim();
    const before = head();
    const r = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(head()).toBe(before);
  });

  // test_worker_resume.py::test_worker_resume_source_commit_sha_in_nudge
  //   -> DROP (python_only): monkeypatches _find_source_commit_sha to return a
  //      fabricated sha ("abc1234") with no backing commit — an in-process
  //      injection that cannot cross the subprocess boundary. The real
  //      source-commit discovery path (the same findSourceCommitSha grep) is
  //      cross-engine covered by saga-find-task-commit.test.ts +
  //      src-git-lookup.test.ts.

  test("unknown task id -> typed error (exit non-zero)", () => {
    // test_worker_resume.py::test_worker_resume_unknown_task_id
    const proj = getProj();
    const r = runCli(["worker", "resume", "fn-99-ghost.9"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).not.toBe(0);
    const payload = envelope(r.stdout);
    expect(payload.success).toBe(false);
    expect((payload.error as string).includes("fn-99-ghost.9")).toBe(true);
  });

  test("worker group --help lists resume", () => {
    // test_worker_resume.py::test_worker_resume_group_help
    const proj = getProj();
    const r = runCli(["worker", "--help"], { cwd: proj.root, home: proj.home });
    expect(r.code).toBe(0);
    expect(r.stdout.includes("resume")).toBe(true);
  });

  test("done task: envelope emitted, state NOT flipped", () => {
    // test_worker_resume.py::test_worker_resume_done_task_does_not_flip
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Test epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    setStatus(proj.root, taskId, "done");

    const r = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(r.stderr.includes("'done'")).toBe(true);

    const statePath = join(
      proj.root,
      ".keeper",
      "state",
      "tasks",
      `${taskId}.state.json`,
    );
    expect(
      (JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>)
        .status,
    ).toBe("done");
    expect(envelope(r.stdout).status).toBe("done");
  });

  test("in_progress task is a no-op (sidecar unchanged)", () => {
    // test_worker_resume.py::test_worker_resume_in_progress_is_noop
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Test epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    setStatus(proj.root, taskId, "in_progress");
    const statePath = join(
      proj.root,
      ".keeper",
      "state",
      "tasks",
      `${taskId}.state.json`,
    );
    const before = readFileSync(statePath, "utf-8");

    const r = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });

  test("persisted non-null tier rides envelope + stderr note", () => {
    // test_worker_resume.py::test_worker_resume_tier_set_rides_envelope
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Test epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    const setTier = runCli(["task", "set-tier", taskId, "--tier", "high"], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(setTier.code).toBe(0);

    const r = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(r.stderr.includes(`Note: task ${taskId} tier is 'high'`)).toBe(true);
    const payload = envelope(r.stdout);
    for (const k of [
      "success",
      "task_id",
      "status",
      "tier",
      "brief_ref",
      "nudge",
      "target_repo",
      "primary_repo",
      "worker_agent",
    ]) {
      expect(k in payload).toBe(true);
    }
    expect(payload.tier).toBe("high");
    expect(payload.worker_agent).toBe("plan:worker-high");
  });

  test("null persisted tier emits raw None note + explicit JSON null", () => {
    // test_worker_resume.py::test_worker_resume_tier_null_emits_raw_note
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Test epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    // Hand-null the tracked tier to simulate a legacy on-disk record.
    const taskPath = join(proj.root, ".keeper", "tasks", `${taskId}.json`);
    const def = JSON.parse(readFileSync(taskPath, "utf-8")) as Record<
      string,
      unknown
    >;
    def.tier = null;
    writeFileSync(taskPath, JSON.stringify(def), "utf-8");

    const r = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(r.stderr.includes(`Note: task ${taskId} tier is None`)).toBe(true);
    expect(r.stderr.includes("cold-resume heuristic")).toBe(false);
    const payload = envelope(r.stdout);
    expect("tier" in payload).toBe(true);
    expect(payload.tier).toBeNull();
    expect(payload.worker_agent).toBeNull();
  });

  test("blocked task: warns but state not flipped", () => {
    // test_worker_resume.py::test_worker_resume_blocked_warns_leaves_alone
    const proj = getProj();
    const { taskIds } = scaffoldEpic(proj, { title: "Test epic", nTasks: 1 });
    const taskId = taskIds[0] as string;
    setStatus(proj.root, taskId, "blocked");

    const r = runCli(["worker", "resume", taskId], {
      cwd: proj.root,
      home: proj.home,
    });
    expect(r.code).toBe(0);
    expect(r.stderr.includes("'blocked'")).toBe(true);
    const statePath = join(
      proj.root,
      ".keeper",
      "state",
      "tasks",
      `${taskId}.state.json`,
    );
    expect(
      (JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>)
        .status,
    ).toBe("blocked");
  });
});
