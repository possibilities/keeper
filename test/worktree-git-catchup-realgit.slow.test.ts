/**
 * Real-git safety proof for the stale-aware post-ref-advance catch-up in
 * mergeLaneBaseIntoDefault (decision B) — the one tier the faked GitRunner CANNOT
 * give. The fast fake only asserts the argv shape (`update-index --really-refresh`
 * then `read-tree -m -u <preMergeTip> <newTip>`); the two-tree `read-tree` merge
 * semantics — advance stale paths, preserve unrelated local edits byte-identical, and
 * abort the WHOLE op with zero writes on a path both upstream-changed AND
 * locally-edited — are only provable against real git.
 *
 * Gated on `KEEPER_RUN_SLOW`. There is no root real-git harness, so the minimal
 * git-isolation + init/commit/remote plumbing is inlined here (modeled on
 * test/worktree-git-premerge-realgit.slow.test.ts). A bare origin with an upstream
 * push target makes the plumbing pipeline advance the ref and reach the catch-up;
 * per-repo config keeps the behavior deterministic regardless of the host gitconfig.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktreeDriver,
  mergeLaneBaseIntoDefault,
} from "../src/autopilot-worker";
import { gitExec } from "../src/commit-work/git-exec";
import { worktreePathFor } from "../src/worktree-plan";

const SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined;

const BASE_BRANCH = "keeper/epic/fn-1-foo";
const DEFAULT_BRANCH = "main";

// changed.ts is advanced by the base branch (C0 → C1); untouched.ts is never touched
// by the merge, so a local edit to it is the "unrelated edit" the catch-up must heal
// around.
const CHANGED_0 = "shared\nold-line\n";
const CHANGED_1 = "shared\nNEW-LINE-FROM-BASE\n";
const UNTOUCHED_0 = "keep\nme\n";

/** The discovery-var-stripped env (parity with the production `gitExec`). */
function isoEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (
      v !== undefined &&
      k !== "GIT_DIR" &&
      k !== "GIT_WORK_TREE" &&
      k !== "GIT_INDEX_FILE" &&
      k !== "GIT_COMMON_DIR"
    ) {
      env[k] = v;
    }
  }
  return env;
}

function git(args: string[], cwd: string): string {
  const res = Bun.spawnSync(["git", ...args], { cwd, env: isoEnv() });
  if (!res.success) {
    throw new Error(
      `git ${args.join(" ")} @ ${cwd} failed (${res.exitCode}): ${res.stderr.toString()}`,
    );
  }
  return res.stdout.toString();
}

/** A no-op flock acquirer — the real flock-around-merge contract is out of scope here. */
const stubLock = () => ({ release() {} });

describe.skipIf(!SLOW_ENABLED)(
  "post-ref-advance stale-aware catch-up (real git)",
  () => {
    let origin = "";
    let main = "";
    let baseTip = "";
    let baseWorktree = "";

    beforeEach(() => {
      origin = mkdtempSync(join(tmpdir(), "kpr-catchup-origin-"));
      git(["init", "-q", "--bare", "-b", DEFAULT_BRANCH], origin);

      main = mkdtempSync(join(tmpdir(), "kpr-catchup-main-"));
      baseWorktree = worktreePathFor(main, BASE_BRANCH);
      git(["init", "-q", "-b", DEFAULT_BRANCH], main);
      git(["config", "user.email", "test@keeper.local"], main);
      git(["config", "user.name", "Keeper Test"], main);
      git(["config", "commit.gpgsign", "false"], main);
      git(["config", "core.autocrlf", "false"], main);
      git(["remote", "add", "origin", origin], main);
      writeFileSync(join(main, "changed.ts"), CHANGED_0);
      writeFileSync(join(main, "untouched.ts"), UNTOUCHED_0);
      git(["add", "."], main);
      git(["commit", "-q", "-m", "seed"], main);
      // Push -u sets the upstream so `@{push}` resolves (turn-key) and origin/<default>
      // matches local default (the FF precheck passes).
      git(["push", "-u", "-q", "origin", DEFAULT_BRANCH], main);

      // The epic base branch advances changed.ts (only) one commit ahead of default.
      git(["branch", BASE_BRANCH], main);
      git(["checkout", "-q", BASE_BRANCH], main);
      writeFileSync(join(main, "changed.ts"), CHANGED_1);
      git(["add", "changed.ts"], main);
      git(["commit", "-q", "-m", "base advances changed.ts"], main);
      baseTip = git(["rev-parse", "HEAD"], main).trim();
      // Restore the working tree to the default branch — the shared checkout the merge
      // must catch up. Its worktree still shows CHANGED_0 (the ref has not moved yet).
      git(["checkout", "-q", DEFAULT_BRANCH], main);
    });

    afterEach(() => {
      rmSync(baseWorktree, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
      rmSync(main, { recursive: true, force: true });
    });

    test("default-into-base refresh lands in the lane worktree and leaves finalize fast-forwardable", async () => {
      writeFileSync(join(main, "default-only.ts"), "new default work\n");
      git(["add", "default-only.ts"], main);
      git(["commit", "-q", "-m", "default advances"], main);
      const defaultTip = git(["rev-parse", "HEAD"], main).trim();
      git(["worktree", "add", "-q", baseWorktree, BASE_BRANCH], main);

      const result = await createWorktreeDriver(gitExec, stubLock).refreshBase(
        {
          epic_id: "fn-1-foo",
          repo_dir: main,
          behind_count: 1,
          merge_base_age_seconds: 90_000,
        },
        Math.floor(Date.now() / 1000),
      );

      expect(result).toEqual({ ok: true });
      expect(git(["rev-parse", "--abbrev-ref", "HEAD"], main).trim()).toBe(
        DEFAULT_BRANCH,
      );
      expect(
        git(["rev-parse", "--abbrev-ref", "HEAD"], baseWorktree).trim(),
      ).toBe(BASE_BRANCH);
      expect(
        Bun.spawnSync(
          ["git", "merge-base", "--is-ancestor", defaultTip, BASE_BRANCH],
          { cwd: main, env: isoEnv() },
        ).success,
      ).toBe(true);
      expect(
        git(["rev-list", "--parents", "-1", BASE_BRANCH], main)
          .trim()
          .split(" "),
      ).toHaveLength(3);
    });

    test("an unrelated local edit is preserved byte-identical while the stale path advances to the new tip (no desync seed)", async () => {
      // A human edit to untouched.ts — a path the merge never changes.
      const UNTOUCHED_EDIT = "keep\nME-EDITED-LOCALLY\n";
      writeFileSync(join(main, "untouched.ts"), UNTOUCHED_EDIT);

      let seeded = 0;
      const res = await mergeLaneBaseIntoDefault(
        main,
        BASE_BRANCH,
        DEFAULT_BRANCH,
        gitExec,
        stubLock,
        () => {
          seeded++;
        },
      );

      expect(res).toEqual({ kind: "merged" });
      // The ref advanced onto the base tip (pure fast-forward).
      expect(git(["rev-parse", "HEAD"], main).trim()).toBe(baseTip);
      // The stale path was caught up to the new tip…
      expect(readFileSync(join(main, "changed.ts"), "utf8")).toBe(CHANGED_1);
      // …while the unrelated local edit survived byte-identical.
      expect(readFileSync(join(main, "untouched.ts"), "utf8")).toBe(
        UNTOUCHED_EDIT,
      );
      // The catch-up applied, so the checkout carries the tip → no desync to seed.
      expect(seeded).toBe(0);
    });

    test("a path both upstream-changed and locally-edited aborts the whole catch-up with zero writes (still merged, desync seed fires)", async () => {
      // A human edit to changed.ts — the SAME path the base branch advances.
      const CHANGED_COLLIDE = "shared\nMY-UNCOMMITTED-EDIT\n";
      writeFileSync(join(main, "changed.ts"), CHANGED_COLLIDE);

      let seeded = 0;
      const res = await mergeLaneBaseIntoDefault(
        main,
        BASE_BRANCH,
        DEFAULT_BRANCH,
        gitExec,
        stubLock,
        () => {
          seeded++;
        },
      );

      // The ref advance already landed and the catch-up is best-effort, so the merge
      // outcome is still `merged`.
      expect(res).toEqual({ kind: "merged" });
      expect(git(["rev-parse", "HEAD"], main).trim()).toBe(baseTip);
      // The all-or-nothing abort left ZERO worktree writes: the colliding edit is
      // untouched (never clobbered), and the incidentally-clean path was not advanced.
      expect(readFileSync(join(main, "changed.ts"), "utf8")).toBe(
        CHANGED_COLLIDE,
      );
      expect(readFileSync(join(main, "untouched.ts"), "utf8")).toBe(
        UNTOUCHED_0,
      );
      // The checkout trails the advanced tip → exactly one desync seed fires.
      expect(seeded).toBe(1);
    });
  },
);
