// Real-git proof that finalize DEGRADES GRACEFULLY on a shared main checkout — the
// slow-tier counterpart to the pure fake-runner finalize-degrade tests. Drives the
// production `createWorktreeDriver().finalizeEpic` against a real temp repo for the
// two cases a fake runner cannot fully prove on real git:
//   1. a DIRTY main checkout (human WIP) → skip-and-retry (retry:true), never a
//      stomp of the WIP and never a merge/teardown;
//   2. an IDEMPOTENT re-run after a partial (post-merge/post-push) teardown crash →
//      the already-merged base is a no-op merge and teardown RESUMES to completion.
//
// Gated describe.skipIf(!SLOW_ENABLED): the default `bun test` skips it; only the
// wired `bun run test:slow` (KEEPER_PLAN_RUN_SLOW=1) spawns the real `git`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktreeDriver,
  type WorktreeLaunchInfo,
} from "../../../src/autopilot-worker.ts";
import { SLOW_ENABLED } from "./harness.ts";

function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

/** Non-throwing git for tolerant teardown — a mid-cycle failure must not mask the
 * assertion that tripped it. */
function gitQuiet(args: string[], cwd: string): void {
  Bun.spawnSync(["git", ...args], { cwd });
}

function headSha(cwd: string): string {
  return git(["rev-parse", "HEAD"], cwd).trim();
}

/** Commit the epic done-state (`.keeper/epics/<id>.json` status:done) onto the lane
 * checked out at `lane` — the git-observable finalize trigger epicBaseHasDoneState
 * reads. */
function commitEpicDone(lane: string, epicId: string): void {
  mkdirSync(join(lane, ".keeper", "epics"), { recursive: true });
  writeFileSync(
    join(lane, ".keeper", "epics", `${epicId}.json`),
    `${JSON.stringify({ id: epicId, status: "done" })}\n`,
  );
  git(["add", "."], lane);
  git(["commit", "-q", "-m", `close: ${epicId} done`], lane);
}

describe.skipIf(!SLOW_ENABLED)("worktree finalize degrade (real git)", () => {
  let main: string;
  let origin: string;
  const lanes: string[] = [];

  /** Reserve a unique worktree path then remove the dir so `worktree add` (which
   * wants a fresh path) can create it; track it for tolerant cleanup. */
  function reserveLane(): string {
    const lane = mkdtempSync(join(tmpdir(), "planctl-wt-final-lane-"));
    rmSync(lane, { recursive: true, force: true });
    lanes.push(lane);
    return lane;
  }

  function finalizeInfo(epicId: string, baseLane: string): WorktreeLaunchInfo {
    const base = `keeper/epic/${epicId}`;
    return {
      assignment: {
        nodeId: "__close__",
        isCloseSink: true,
        branch: base,
        worktreePath: baseLane,
        inherited: true,
        preMerges: [],
        assertBranch: base,
      },
      baseBranch: base,
      baseWorktreePath: baseLane,
      repoDir: main,
      laneOrder: [
        { nodeId: "__close__", branch: base, worktreePath: baseLane },
      ],
      parentBranch: base,
    };
  }

  beforeEach(() => {
    lanes.length = 0;
    main = mkdtempSync(join(tmpdir(), "planctl-wt-final-main-"));
    git(["init", "-q", "-b", "main"], main);
    git(["config", "user.email", "test@planctl.local"], main);
    git(["config", "user.name", "Planctl Test"], main);
    git(["config", "commit.gpgsign", "false"], main);
    writeFileSync(join(main, "README"), "seed\n");
    git(["add", "README"], main);
    git(["commit", "-q", "-m", "seed"], main);
    // A bare origin so a finalize push has a remote to fast-forward.
    origin = mkdtempSync(join(tmpdir(), "planctl-wt-final-origin-"));
    git(["init", "-q", "--bare", "-b", "main"], origin);
    git(["remote", "add", "origin", origin], main);
    git(["push", "-q", "-u", "origin", "main"], main);
  });

  afterEach(() => {
    for (const lane of lanes) {
      gitQuiet(["worktree", "remove", "--force", lane], main);
      rmSync(lane, { recursive: true, force: true });
    }
    gitQuiet(["worktree", "prune"], main);
    for (const dir of [main, origin]) {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("a DIRTY main checkout → skip-and-retry (retry:true), no merge, no teardown, WIP untouched", async () => {
    const epicId = "fn-985-dirty";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    // The producer hands the driver a realpath-normalized lane path; match it so
    // teardown's worktree-list path comparison lands on macOS (/var ↔ /private/var).
    const baseLane = realpathSync(reserved);
    commitEpicDone(baseLane, epicId);

    // The human has uncommitted work in the shared main checkout. Stage it so
    // the readiness check (status --porcelain --untracked-files=no) sees it as
    // dirty — an untracked-only tree is intentionally treated as clean now.
    writeFileSync(join(main, "human-wip.txt"), "do not stomp me\n");
    git(["add", "human-wip.txt"], main);
    const mainHeadBefore = headSha(main);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retry).toBe(true);
      expect(res.reason).toContain("worktree-finalize-dirty-checkout");
    }
    // The base was NOT merged into main, and the WIP is still there.
    expect(headSha(main)).toBe(mainHeadBefore);
    expect(Bun.file(join(main, "human-wip.txt")).size).toBeGreaterThan(0);
    // No teardown — the lane survives for a retry once the tree is clean.
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(true);
    expect(git(["branch", "--list", base], main).trim()).not.toBe("");
  });

  test("a NON-TURN-KEY push (origin unreachable) → skip-and-retry (retry:true), no merge, lane survives", async () => {
    // origin/main is a CACHED ancestor (ff-able) so the non-ff precheck passes —
    // but the bare remote is gone, so `git push --dry-run` fails. The turn-key
    // precheck must catch this BEFORE the merge and degrade to a non-sticky retry
    // with a DISTINCT, non-`worktree-recover*` reason — never merge-then-die.
    const epicId = "fn-988-noremote";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    const baseLane = realpathSync(reserved);
    commitEpicDone(baseLane, epicId);

    // Drop the bare origin out from under the (still-configured) remote: the cached
    // origin/main tracking ref + `remote get-url` survive, but the push cannot reach it.
    rmSync(origin, { recursive: true, force: true });
    const mainHeadBefore = headSha(main);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retry).toBe(true); // NON-sticky
      expect(res.reason).toContain("worktree-finalize-push-not-turn-key");
      expect(res.reason.startsWith("worktree-recover")).toBe(false);
    }
    // The base was NOT merged into main — never merge-then-die on the push.
    expect(headSha(main)).toBe(mainHeadBefore);
    // The lane survives for a retry once the remote is reachable again.
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(true);
    expect(git(["branch", "--list", base], main).trim()).not.toBe("");
  });

  test("a WOULD-CLOBBER untracked file (incoming tracked path ∩ main untracked) → skip-and-retry, no merge, file untouched", async () => {
    // The lane adds a NEW tracked file; main has an UNTRACKED file at the same
    // path. A real `git merge` hard-aborts ("untracked working tree files would be
    // overwritten"); the would-clobber precheck must catch it BEFORE the merge and
    // degrade to a non-sticky retry, never stomping the human's untracked content.
    const epicId = "fn-988-clobber";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    const baseLane = realpathSync(reserved);
    // The lane commits a new tracked file the merge would bring into main.
    writeFileSync(join(baseLane, "incoming.txt"), "from the lane\n");
    git(["add", "incoming.txt"], baseLane);
    git(["commit", "-q", "-m", "add incoming.txt"], baseLane);
    commitEpicDone(baseLane, epicId);
    // The human left an UNTRACKED file at the very path the merge would write.
    writeFileSync(
      join(main, "incoming.txt"),
      "human untracked — do not stomp\n",
    );
    const mainHeadBefore = headSha(main);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retry).toBe(true);
      expect(res.reason).toContain("worktree-finalize-would-clobber");
      expect(res.reason).toContain("incoming.txt");
    }
    // The base was NOT merged and the untracked content survives verbatim.
    expect(headSha(main)).toBe(mainHeadBefore);
    expect(await Bun.file(join(main, "incoming.txt")).text()).toBe(
      "human untracked — do not stomp\n",
    );
    // The lane survives for a retry once the path is cleared.
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(true);
    expect(git(["branch", "--list", base], main).trim()).not.toBe("");
  });

  test("a BENIGN untracked-only main checkout (no incoming overlap) → finalize merges + tears down", async () => {
    // fn-987 must not regress: an untracked file that NO incoming path collides
    // with stays clean — finalize merges the base and completes teardown.
    const epicId = "fn-988-benign";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    const baseLane = realpathSync(reserved);
    writeFileSync(join(baseLane, "incoming.txt"), "from the lane\n");
    git(["add", "incoming.txt"], baseLane);
    git(["commit", "-q", "-m", "add incoming.txt"], baseLane);
    commitEpicDone(baseLane, epicId);
    // A benign untracked file at a path the incoming tree never touches.
    writeFileSync(join(main, ".env"), "SECRET=1\n");

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
    );

    expect(res).toEqual({ ok: true });
    // The base merged (incoming.txt now tracked in main) and teardown completed.
    expect(git(["ls-files", "incoming.txt"], main).trim()).toBe("incoming.txt");
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(false);
    expect(git(["branch", "--list", base], main).trim()).toBe("");
  });

  test("an ORPHAN rib NOT in laneOrder (live-git enumerated) is torn down alongside the base", async () => {
    // A rib forked in a cycle the snapshot never saw — laneOrder carries only the
    // base. Teardown must enumerate the rib from live git (`for-each-ref`), and —
    // since it is an ancestor of default — prune both its worktree and its branch.
    const epicId = "fn-988-orphanrib";
    const base = `keeper/epic/${epicId}`;
    const rib = `keeper/epic/${epicId}--${epicId}.2`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    const baseLane = realpathSync(reserved);
    commitEpicDone(baseLane, epicId);
    // Provision the orphan rib worktree at HEAD (an ancestor of default) — it is
    // NEVER added to finalizeInfo.laneOrder.
    const ribReserved = reserveLane();
    git(["worktree", "add", "-b", rib, ribReserved, "HEAD"], main);
    const ribLane = realpathSync(ribReserved);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
    );

    expect(res).toEqual({ ok: true });
    // The orphan rib's worktree AND branch were pruned — nothing leaks.
    const wt = git(["worktree", "list", "--porcelain"], main);
    expect(wt.includes(ribLane)).toBe(false);
    expect(wt.includes(baseLane)).toBe(false);
    expect(git(["branch", "--list", rib], main).trim()).toBe("");
    expect(git(["branch", "--list", base], main).trim()).toBe("");
  });

  test("idempotent re-run after a post-push teardown crash → already-merged no-op merge + teardown resumes to completion", async () => {
    const epicId = "fn-985-idem";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    const baseLane = realpathSync(reserved);
    commitEpicDone(baseLane, epicId);

    // SIMULATE the prior run: the base was merged into main + pushed, but the worker
    // crashed BEFORE teardown — so the lane worktree + branch still linger.
    git(["merge", "--no-ff", "-m", "merge base into main", base], main);
    git(["push", "-q", "origin", "main"], main);
    const mainHeadAfterMerge = headSha(main);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
    );

    expect(res).toEqual({ ok: true });
    // The merge was idempotent (base already an ancestor) — main HEAD did not move.
    expect(headSha(main)).toBe(mainHeadAfterMerge);
    // Teardown RESUMED: the lingering base worktree + branch are gone, nothing leaks.
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(false);
    expect(git(["branch", "--list", base], main).trim()).toBe("");
  });
});
