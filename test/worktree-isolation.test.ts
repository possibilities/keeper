import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "../src/commit-work/git-exec";
import {
  mergeReadiness,
  probeLosslesslyCleanableUntracked,
  WORKTREE_DEP_LINK_NAME,
  worktreeDepLinkTarget,
} from "../src/worktree-git";

const BRANCH = "keeper/epic/example";
const INCOMING = "keeper/epic/incoming";

function fakeReadinessGit(untracked: string[], incoming: string[]): GitRunner {
  return async (args) => {
    if (
      args[0] === "rev-parse" &&
      args.some((arg) =>
        ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"].includes(arg),
      )
    ) {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (
      args[0] === "rev-parse" &&
      args.includes("--path-format=absolute") &&
      args.includes("--git-dir")
    ) {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "status") {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (
      args[0] === "rev-parse" &&
      args[1] === "--abbrev-ref" &&
      args[2] === "HEAD"
    ) {
      return { code: 0, stdout: `${BRANCH}\n`, stderr: "" };
    }
    if (args[0] === "ls-files") {
      return {
        code: 0,
        stdout: untracked.length > 0 ? `${untracked.join("\n")}\n` : "",
        stderr: "",
      };
    }
    if (args[0] === "ls-tree") {
      return {
        code: 0,
        stdout: incoming.length > 0 ? `${incoming.join("\n")}\n` : "",
        stderr: "",
      };
    }
    throw new Error(`unexpected git command: ${args.join(" ")}`);
  };
}

async function withLane(
  linkTarget: (source: string) => string,
  run: (source: string, lane: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "keeper-worktree-isolation-"));
  const source = join(root, "repo");
  const lane = join(root, "lane");
  mkdirSync(source);
  mkdirSync(lane);
  symlinkSync(linkTarget(source), join(lane, WORKTREE_DEP_LINK_NAME), "dir");
  try {
    await run(source, lane);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("fan-in readiness ignores a byte-identical dependency plant", async () => {
  await withLane(worktreeDepLinkTarget, async (source, lane) => {
    const git = fakeReadinessGit(
      [WORKTREE_DEP_LINK_NAME],
      [WORKTREE_DEP_LINK_NAME],
    );
    expect(await probeLosslesslyCleanableUntracked(lane, source, git)).toEqual({
      kind: "cleanable",
    });
    expect(
      await mergeReadiness(lane, BRANCH, git, INCOMING, undefined, source),
    ).toEqual({ kind: "ready" });
  });
});

test("fan-in readiness names only real untracked work beside the plant", async () => {
  await withLane(worktreeDepLinkTarget, async (source, lane) => {
    writeFileSync(join(lane, "notes.txt"), "work\n");
    const git = fakeReadinessGit(
      [WORKTREE_DEP_LINK_NAME, "notes.txt"],
      [WORKTREE_DEP_LINK_NAME, "notes.txt"],
    );
    expect(await probeLosslesslyCleanableUntracked(lane, source, git)).toEqual({
      kind: "would-clobber",
      paths: ["notes.txt"],
    });
    expect(
      await mergeReadiness(lane, BRANCH, git, INCOMING, undefined, source),
    ).toEqual({
      kind: "would-clobber",
      paths: ["notes.txt"],
    });
  });
});

test("fan-in readiness blocks a retargeted dependency link", async () => {
  await withLane(
    (source) => join(source, "other-node-modules"),
    async (source, lane) => {
      const git = fakeReadinessGit(
        [WORKTREE_DEP_LINK_NAME],
        [WORKTREE_DEP_LINK_NAME],
      );
      expect(
        await probeLosslesslyCleanableUntracked(lane, source, git),
      ).toEqual({
        kind: "would-clobber",
        paths: [WORKTREE_DEP_LINK_NAME],
      });
      expect(
        await mergeReadiness(lane, BRANCH, git, INCOMING, undefined, source),
      ).toEqual({
        kind: "would-clobber",
        paths: [WORKTREE_DEP_LINK_NAME],
      });
    },
  );
});
