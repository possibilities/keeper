// Real-git proof of the shared-main-checkout finalize contract — the slow-tier
// counterpart to the pure fake-runner finalize tests. Drives the production
// `createWorktreeDriver().finalizeEpic` against a real temp repo for the cases a fake
// runner cannot fully prove on real git:
//   1. the WORKING-TREE-FREE base merge LANDS regardless of a dirty / would-clobber
//      shared checkout (ADR 0008) while never stomping the human's uncommitted content;
//   2. a NON-TURN-KEY / OFF-BRANCH push degrades to a non-sticky retry-skip;
//   3. an IDEMPOTENT re-run after a partial teardown crash resumes to completion; and
//   4. the fn-1204 merge-suite gate (injected verdict): green merges + pushes + tears
//      down, red parks a visible sticky with local default UNMOVED and nothing pushed.
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
import {
  git,
  gitQuiet,
  realHeadSha as headSha,
  SLOW_ENABLED,
} from "./harness.ts";

/** Commit a real file onto the lane checked out at `lane` so its base branch is
 * AHEAD of default — the merge has something to land. The finalize gate reads the
 * epic done-state from the MAIN projection (`isEpicDone`, passed by the caller),
 * never the lane, so this commit's content is irrelevant to the gate; it exists
 * only to make the lane carry real commits. */
function commitLaneAhead(lane: string, epicId: string): void {
  mkdirSync(join(lane, ".keeper", "epics"), { recursive: true });
  writeFileSync(
    join(lane, ".keeper", "epics", `${epicId}.json`),
    `${JSON.stringify({ id: epicId, status: "done" })}\n`,
  );
  git(["add", "."], lane);
  git(["commit", "-q", "-m", `lane work: ${epicId}`], lane);
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

  test("a DIRTY main checkout NO LONGER blocks the working-tree-free base merge — it lands + tears down, the human's staged WIP untouched", async () => {
    const epicId = "fn-985-dirty";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    // The producer hands the driver a realpath-normalized lane path; match it so
    // teardown's worktree-list path comparison lands on macOS (/var ↔ /private/var).
    const baseLane = realpathSync(reserved);
    commitLaneAhead(baseLane, epicId);

    // The human has staged uncommitted work in the shared main checkout.
    writeFileSync(join(main, "human-wip.txt"), "do not stomp me\n");
    git(["add", "human-wip.txt"], main);
    const mainHeadBefore = headSha(main);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
      async () => true,
    );

    // ADR 0008: the base merge is WORKING-TREE-FREE — a `merge-tree`/`commit-tree`/
    // `update-ref`-CAS plumbing pipeline that never runs `git merge` in the checkout —
    // so a dirty shared checkout no longer blocks or corrupts it. Finalize lands the
    // merge and tears the lanes down, and the human's uncommitted WIP is never stomped.
    expect(res).toEqual({ ok: true });
    expect(headSha(main)).not.toBe(mainHeadBefore); // local default advanced
    expect(await Bun.file(join(main, "human-wip.txt")).text()).toBe(
      "do not stomp me\n",
    );
    // Teardown completed — nothing leaks.
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(false);
    expect(git(["branch", "--list", base], main).trim()).toBe("");
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
    commitLaneAhead(baseLane, epicId);

    // Drop the bare origin out from under the (still-configured) remote: the cached
    // origin/main tracking ref + `remote get-url` survive, but the push cannot reach it.
    rmSync(origin, { recursive: true, force: true });
    const mainHeadBefore = headSha(main);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
      async () => true,
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

  test("a WOULD-CLOBBER untracked file NO LONGER blocks the working-tree-free base merge — the ref advances + tears down, the untracked content survives verbatim", async () => {
    // The lane adds a NEW tracked file; main has an UNTRACKED file at the same path. A
    // real `git merge` would hard-abort, but the working-tree-free plumbing advances
    // refs/heads/main WITHOUT a `git merge` in the checkout, so it lands regardless; the
    // stale-aware catch-up then ABORTS all-or-nothing on the collision rather than stomp,
    // so the human's untracked content survives verbatim.
    const epicId = "fn-988-clobber";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    const baseLane = realpathSync(reserved);
    // The lane commits a new tracked file the merge would bring into main.
    writeFileSync(join(baseLane, "incoming.txt"), "from the lane\n");
    git(["add", "incoming.txt"], baseLane);
    git(["commit", "-q", "-m", "add incoming.txt"], baseLane);
    commitLaneAhead(baseLane, epicId);
    // The human left an UNTRACKED file at the very path the merge would write.
    writeFileSync(
      join(main, "incoming.txt"),
      "human untracked — do not stomp\n",
    );
    const mainHeadBefore = headSha(main);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
      async () => true,
    );

    // The merge LANDED (local default advanced + torn down) and the untracked content
    // survives verbatim — the catch-up aborted rather than overwrite it.
    expect(res).toEqual({ ok: true });
    expect(headSha(main)).not.toBe(mainHeadBefore); // local default advanced
    expect(await Bun.file(join(main, "incoming.txt")).text()).toBe(
      "human untracked — do not stomp\n",
    );
    // Teardown completed — nothing leaks.
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(false);
    expect(git(["branch", "--list", base], main).trim()).toBe("");
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
    commitLaneAhead(baseLane, epicId);
    // A benign untracked file at a path the incoming tree never touches.
    writeFileSync(join(main, ".env"), "SECRET=1\n");

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
      async () => true,
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
    commitLaneAhead(baseLane, epicId);
    // Provision the orphan rib worktree at HEAD (an ancestor of default) — it is
    // NEVER added to finalizeInfo.laneOrder.
    const ribReserved = reserveLane();
    git(["worktree", "add", "-b", rib, ribReserved, "HEAD"], main);
    const ribLane = realpathSync(ribReserved);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
      async () => true,
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
    commitLaneAhead(baseLane, epicId);

    // SIMULATE the prior run: the base was merged into main + pushed, but the worker
    // crashed BEFORE teardown — so the lane worktree + branch still linger.
    git(["merge", "--no-ff", "-m", "merge base into main", base], main);
    git(["push", "-q", "origin", "main"], main);
    const mainHeadAfterMerge = headSha(main);

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
      async () => true,
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

  // ── fn-1204 — the merge-suite gate (real git, injected suite verdict) ────────
  // The suite-run is an injected probe (the real scratch+suite run is exercised by the
  // production path, not a temp repo), but the merge / park / default-ref / teardown are
  // all REAL git: green advances local default + pushes + tears down; red leaves local
  // default UNMOVED with nothing pushed and the lane intact for a retry.

  test("fn-1204 a RED merge-suite gate parks a VISIBLE sticky with local default UNMOVED and nothing pushed", async () => {
    const epicId = "fn-1204-red";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    const baseLane = realpathSync(reserved);
    commitLaneAhead(baseLane, epicId);
    const mainHeadBefore = headSha(main);
    const originMainBefore = git(["rev-parse", "origin/main"], main).trim();

    // The prospective merge result's fast suite FAILS (a semantic merge conflict).
    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
      async () => true,
      async () => ({
        kind: "red",
        detail: "2 failing test(s): merged tree breaks",
      }),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      // A VISIBLE sticky (mirrors the non-ff arm), never a retry-skip.
      expect(res.retry).not.toBe(true);
      expect(res.reason.startsWith("worktree-finalize-suite-red:")).toBe(true);
    }
    // Local default NEVER advanced and origin was never pushed — no false
    // shared-checkout-desync, no rollback machinery.
    expect(headSha(main)).toBe(mainHeadBefore);
    expect(git(["rev-parse", "origin/main"], main).trim()).toBe(
      originMainBefore,
    );
    // The lane survives for a retry_dispatch once the conflict is reconciled.
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(true);
    expect(git(["branch", "--list", base], main).trim()).not.toBe("");
  });

  test("fn-1204 a GREEN merge-suite gate proceeds through the real merge+push path and tears the lane down", async () => {
    const epicId = "fn-1204-green";
    const base = `keeper/epic/${epicId}`;
    const reserved = reserveLane();
    git(["worktree", "add", "-b", base, reserved, "HEAD"], main);
    const baseLane = realpathSync(reserved);
    commitLaneAhead(baseLane, epicId);
    const laneTip = headSha(baseLane);
    let probeSawMerged: string | null = null;

    const res = await createWorktreeDriver().finalizeEpic(
      finalizeInfo(epicId, baseLane),
      async () => true,
      async (a) => {
        probeSawMerged = a.mergedCommit;
        return { kind: "green" };
      },
    );

    expect(res).toEqual({ ok: true });
    // A pure fast-forward: the gate saw (and the merge advanced to) the exact lane tip.
    expect(probeSawMerged).toBe(laneTip);
    expect(headSha(main)).toBe(laneTip);
    // Teardown completed — the lane worktree + branch are gone, nothing leaks.
    expect(
      git(["worktree", "list", "--porcelain"], main).includes(baseLane),
    ).toBe(false);
    expect(git(["branch", "--list", base], main).trim()).toBe("");
  });
});
