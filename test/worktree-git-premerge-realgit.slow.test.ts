/**
 * Real-git safety proof for the fan-in pre-merge lossless clean (fn-1123.1) — the
 * one tier the faked GitRunner CANNOT give. It reproduces the fn-1106.7 incident
 * shape (a base lane worktree dirtied with content identical to the incoming rib)
 * against REAL git and proves the clean is LOSSLESS under `.gitattributes` eol
 * normalization and a mode-only flip, exercising the real `git hash-object --path`
 * filter + the real commit-work flock.
 *
 * Gated on `KEEPER_RUN_SLOW` (the root slow tier). There is no root real-git
 * harness, so the minimal git-isolation + init/commit/worktree-add plumbing is
 * inlined here (modeled on plugins/plan/test/harness.ts). Per-repo config
 * (`user.*`, `commit.gpgsign`, `core.autocrlf`, `core.filemode`) + a committed
 * `.gitattributes` keep the behavior deterministic regardless of the host's global
 * gitconfig, so the production `gitExec` (which inherits process.env) sees the same
 * config the setup does.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitExec } from "../src/commit-work/git-exec";
import {
  classifyPremergeRedundancy,
  losslessPremergeClean,
} from "../src/worktree-git";

const SLOW_ENABLED = process.env.KEEPER_RUN_SLOW !== undefined;

const BASE_BRANCH = "keeper/epic/fn-1-foo";
const RIB_BRANCH = "keeper/epic/fn-1-foo--fn-1-foo.2";
const A = "alpha\nbeta\ngamma\n"; // base HEAD content
const B = "alpha\nBETA-CHANGED\ngamma\n"; // rib (incoming) content
const B_CRLF = B.replace(/\n/g, "\r\n"); // same content, CRLF bytes

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

function statusPorcelain(cwd: string): string {
  return git(["status", "--porcelain"], cwd).trim();
}

describe.skipIf(!SLOW_ENABLED)(
  "fan-in pre-merge lossless clean (real git)",
  () => {
    let main = "";
    let base = "";

    beforeEach(() => {
      main = mkdtempSync(join(tmpdir(), "kpr-premerge-main-"));
      git(["init", "-q", "-b", "main"], main);
      git(["config", "user.email", "test@keeper.local"], main);
      git(["config", "user.name", "Keeper Test"], main);
      git(["config", "commit.gpgsign", "false"], main);
      git(["config", "core.autocrlf", "false"], main); // deterministic checkout eol
      git(["config", "core.filemode", "true"], main); // track the mode-flip
      // `.gitattributes` forces text normalization so a CRLF working tree filters to
      // the same LF blob a raw byte compare would miss.
      writeFileSync(join(main, ".gitattributes"), "*.ts text\n");
      writeFileSync(join(main, "foo.ts"), A);
      git(["add", "."], main);
      git(["commit", "-q", "-m", "seed"], main);
      // The epic base branch, then a rib forked off it that CHANGES foo.ts → B.
      git(["branch", BASE_BRANCH], main);
      git(["checkout", "-q", "-b", RIB_BRANCH], main);
      writeFileSync(join(main, "foo.ts"), B);
      git(["add", "foo.ts"], main);
      git(["commit", "-q", "-m", "rib changes foo"], main);
      git(["checkout", "-q", "main"], main);
      // The base lane worktree (checked out on the base branch, foo.ts == A).
      base = `${mkdtempSync(join(tmpdir(), "kpr-premerge-base-"))}-wt`;
      git(["worktree", "add", "-q", base, BASE_BRANCH], main);
    });

    afterEach(() => {
      try {
        git(["worktree", "remove", "--force", base], main);
      } catch {
        /* best effort */
      }
      rmSync(main, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    });

    test("a redundant leak (base dirtied with the rib's exact content) auto-cleans, then the merge re-applies it losslessly", async () => {
      // Reproduce the incident: the base worktree is dirtied with content IDENTICAL
      // to the incoming rib (bytes differ from base HEAD).
      writeFileSync(join(base, "foo.ts"), B);
      expect(statusPorcelain(base)).not.toBe(""); // genuinely dirty

      const probe = await classifyPremergeRedundancy(base, RIB_BRANCH, gitExec);
      expect(probe).toEqual({ kind: "redundant", paths: ["foo.ts"] });

      const clean = await losslessPremergeClean(
        base,
        BASE_BRANCH,
        RIB_BRANCH,
        new Set(),
        gitExec,
      );
      expect(clean).toEqual({ kind: "ready" });
      // Restored to HEAD → clean tree, foo.ts == A.
      expect(statusPorcelain(base)).toBe("");
      expect(git(["show", "HEAD:foo.ts"], base)).toBe(A);

      // The fan-in merge now re-applies EXACTLY the leaked content — lossless.
      git(["merge", "--no-edit", "-q", RIB_BRANCH], base);
      expect(git(["show", "HEAD:foo.ts"], base).trimEnd()).toBe(B.trimEnd());
    });

    test("the filtered blob compare survives .gitattributes eol normalization (CRLF working tree vs the LF committed rib)", async () => {
      // The leak arrives with CRLF bytes — a RAW compare against the LF-committed rib
      // blob would falsely differ, but the `text` attribute normalizes both to LF.
      writeFileSync(join(base, "foo.ts"), B_CRLF);
      expect(statusPorcelain(base)).not.toBe(""); // content (not eol) differs from A

      const probe = await classifyPremergeRedundancy(base, RIB_BRANCH, gitExec);
      expect(probe).toEqual({ kind: "redundant", paths: ["foo.ts"] });

      const clean = await losslessPremergeClean(
        base,
        BASE_BRANCH,
        RIB_BRANCH,
        new Set(),
        gitExec,
      );
      expect(clean).toEqual({ kind: "ready" });
      expect(statusPorcelain(base)).toBe("");
    });

    test("a mode-only flip is NEVER discarded — even with redundant content it degrades to retry", async () => {
      // Content matches the rib (would be redundant), but the executable bit is
      // flipped — a working-tree mode change carries unique intent, so do-not-discard.
      writeFileSync(join(base, "foo.ts"), B);
      chmodSync(join(base, "foo.ts"), 0o755);
      expect(statusPorcelain(base)).not.toBe("");

      const probe = await classifyPremergeRedundancy(base, RIB_BRANCH, gitExec);
      expect(probe.kind).toBe("not-redundant");

      const clean = await losslessPremergeClean(
        base,
        BASE_BRANCH,
        RIB_BRANCH,
        new Set(),
        gitExec,
      );
      expect(clean.kind).toBe("retry");
      // The dirt is UNTOUCHED — nothing was restored.
      expect(statusPorcelain(base)).not.toBe("");
    });

    test("an untracked file poisons the set — the base is never discarded", async () => {
      writeFileSync(join(base, "foo.ts"), B); // redundant on its own
      writeFileSync(join(base, "scratch.txt"), "unsaved work\n"); // but untracked
      const probe = await classifyPremergeRedundancy(base, RIB_BRANCH, gitExec);
      expect(probe.kind).toBe("not-redundant");

      const clean = await losslessPremergeClean(
        base,
        BASE_BRANCH,
        RIB_BRANCH,
        new Set(),
        gitExec,
      );
      expect(clean.kind).toBe("retry");
      expect(statusPorcelain(base)).not.toBe("");
    });

    test("a redundant path attributed to a live job is preserved (do-not-discard)", async () => {
      writeFileSync(join(base, "foo.ts"), B);
      const clean = await losslessPremergeClean(
        base,
        BASE_BRANCH,
        RIB_BRANCH,
        new Set(["foo.ts"]), // a live worker owns this path
        gitExec,
      );
      expect(clean.kind).toBe("retry");
      expect(statusPorcelain(base)).not.toBe(""); // untouched
    });
  },
);
