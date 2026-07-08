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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { autoCommitFromInvocation, CommitFailed } from "../src/commit.ts";
import { realGitVcs, resetVcs } from "../src/vcs.ts";
import { failNextCommit } from "./fake-vcs.ts";
import {
  fakeDirtyPaths,
  firstJsonPayload,
  git,
  gitBaseline,
  gitFilesInHead,
  gitLogCount,
  parseCliOutput,
  runCli,
  SLOW_ENABLED,
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

// A real-git subject: the fake VCS models `git add` as a no-op, so the staged
// half-stamp F1 fixes is invisible to the fast tier. The wired `bun run
// test:slow` (KEEPER_PLAN_RUN_SLOW=1) runs this against real git.
describe.skipIf(!SLOW_ENABLED)(
  "done — F1 real-git: the commit-failure unwind returns the index to HEAD",
  () => {
    let repo: string;

    beforeEach(() => {
      // resetVcs pins getVcs() to the real facade for autoCommitFromInvocation's
      // real stage + commit spawns (the surrounding fast tests install the fake).
      resetVcs();
      repo = realpathSync(mkdtempSync(join(tmpdir(), "planctl-done-f1-")));
      git(["init", "-q"], repo);
      git(["config", "user.email", "test@planctl.local"], repo);
      git(["config", "user.name", "Planctl Test"], repo);
      git(["config", "commit.gpgsign", "false"], repo);
    });

    afterEach(() => {
      if (repo) {
        rmSync(repo, { recursive: true, force: true });
      }
    });

    test("a mid-merge partial-commit refusal leaves a clean index after the unwind", () => {
      const taskId = "fn-1-real.1";
      const relTask = `.keeper/tasks/${taskId}.json`;
      const relSpec = `.keeper/specs/${taskId}.md`;
      const relRuntime = `.keeper/state/tasks/${taskId}.state.json`;
      const absTask = join(repo, relTask);
      const absSpec = join(repo, relSpec);

      // Committed baseline: the pre-done def (no worker_done_at) + the empty
      // four-H2 spec. HEAD carries exactly these bytes.
      mkdirSync(join(repo, ".keeper", "tasks"), { recursive: true });
      mkdirSync(join(repo, ".keeper", "specs"), { recursive: true });
      writeFileSync(join(repo, ".keeper", ".gitignore"), "state/\n", "utf-8");
      const baseTask = `{\n  "id": "${taskId}",\n  "worker_done_at": null\n}\n`;
      const baseSpec =
        "## Description\nx\n\n## Acceptance\n- [ ] x\n\n" +
        "## Done summary\n\n## Evidence\n";
      writeFileSync(absTask, baseTask, "utf-8");
      writeFileSync(absSpec, baseSpec, "utf-8");
      git(["add", "-A"], repo);
      git(["commit", "-q", "-m", "seed baseline"], repo);
      const headSha = git(["rev-parse", "HEAD"], repo).trim();

      // Put the repo mid-merge: a MERGE_HEAD makes git refuse a partial (pathspec)
      // commit exactly as the shared-checkout merge window does — reproduced by
      // writing the ref directly so the subject stays the refusal, not the merge.
      writeFileSync(join(repo, ".git", "MERGE_HEAD"), `${headSha}\n`, "utf-8");

      // done's on-disk writes: the done-version bytes (worker_done_at + a Done
      // summary) the verb stages before the pathspec commit.
      writeFileSync(
        absTask,
        `{\n  "id": "${taskId}",\n  "worker_done_at": "2026"\n}\n`,
        "utf-8",
      );
      writeFileSync(
        absSpec,
        "## Description\nx\n\n## Acceptance\n- [ ] x\n\n" +
          "## Done summary\nshipped\n\n## Evidence\n",
        "utf-8",
      );

      // The real commit machinery done runs: gitStage (`git add`) succeeds, then
      // the pathspec `git commit -F - -- <files>` is refused mid-merge.
      let caught: CommitFailed | null = null;
      try {
        autoCommitFromInvocation({
          files: [relTask, relSpec],
          op: "done",
          target: taskId,
          subject: `chore(plan): done ${taskId}`,
          state_repo: repo,
          repo_root: repo,
        });
      } catch (e) {
        caught = e as CommitFailed;
      }
      expect(caught).toBeInstanceOf(CommitFailed);
      expect((caught as CommitFailed).detail).toContain(
        "partial commit during a merge",
      );

      // The bug surface: after the refusal the done bytes sit STAGED in the index
      // — a later full-index merge-completion would sweep this half-stamp in.
      const stagedBefore = git(
        ["diff", "--cached", "--name-only"],
        repo,
      ).trim();
      expect(stagedBefore.split("\n").sort()).toEqual(
        [relSpec, relTask].sort(),
      );

      // The unwind (what done's onCommitFailure runs): restore the working-tree
      // bytes AND return the three state paths' index entries to HEAD. The
      // gitignored runtime-overlay path is a harmless no-op.
      writeFileSync(absTask, baseTask, "utf-8");
      writeFileSync(absSpec, baseSpec, "utf-8");
      realGitVcs.restoreIndexToHead(
        [absTask, absSpec, join(repo, relRuntime)],
        repo,
      );

      // F1: a clean index — the staged half-stamp is gone, so a merge-completion
      // commits nothing of the backed-out done, and the working tree is restored.
      expect(git(["diff", "--cached", "--name-only"], repo).trim()).toBe("");
      expect(readFileSync(absTask, "utf-8")).toBe(baseTask);
      expect(readFileSync(absSpec, "utf-8")).toBe(baseSpec);
      expect(
        git(["status", "--porcelain", "--", relTask, relSpec], repo).trim(),
      ).toBe("");
    });
  },
);
