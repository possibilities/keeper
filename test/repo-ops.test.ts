import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type CommandResult,
  type CommandRunner,
  canonicalizeRemoteUrl,
  cloneRepo,
  createRepo,
  forkRepo,
  parseRepoInput,
  RepoOpsError,
  resolveSpecialOwner,
} from "../src/repo-ops";

class FakeRunner implements CommandRunner {
  calls: Array<{ argv: readonly string[]; cwd?: string }> = [];
  private responses: Array<{
    match: (argv: readonly string[]) => boolean;
    result: CommandResult;
  }> = [];

  add(
    match: (argv: readonly string[]) => boolean,
    result: CommandResult,
  ): void {
    this.responses.push({ match, result });
  }

  run(argv: readonly string[], opts?: { cwd?: string }): CommandResult {
    this.calls.push({ argv, cwd: opts?.cwd });
    const hit = this.responses.find((r) => r.match(argv));
    if (hit) return hit.result;
    return { code: 0, stdout: "", stderr: "" };
  }
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): CommandResult => ({
  code: 1,
  stdout: "",
  stderr,
});
const cmd =
  (...parts: string[]) =>
  (argv: readonly string[]) =>
    parts.every((part, i) => argv[i] === part);

function withTmp<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "keeper-repo-ops-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("repo input parsing", () => {
  test("accepts slug and GitHub URL forms", () => {
    expect(parseRepoInput("anthropics/claude-code")).toEqual({
      owner: "anthropics",
      name: "claude-code",
    });
    expect(
      parseRepoInput("https://github.com/anthropics/claude-code.git"),
    ).toEqual({
      owner: "anthropics",
      name: "claude-code",
    });
    expect(parseRepoInput("git@github.com:anthropics/claude-code.git")).toEqual(
      {
        owner: "anthropics",
        name: "claude-code",
      },
    );
    expect(
      parseRepoInput("ssh://git@github.com/anthropics/claude-code.git"),
    ).toEqual({
      owner: "anthropics",
      name: "claude-code",
    });
  });

  test("rejects bare names and canonicalizes remotes", () => {
    expect(() => parseRepoInput("claude-code")).toThrow(RepoOpsError);
    expect(
      canonicalizeRemoteUrl("git@github.com:ANTHROPICS/Claude-Code.git"),
    ).toBe("https://github.com/anthropics/claude-code");
  });
});

describe("repo owner resolution", () => {
  test("uses git config before gh api", () => {
    const runner = new FakeRunner();
    runner.add(cmd("git", "config"), ok("possibilities\n"));
    expect(resolveSpecialOwner(runner)).toBe("possibilities");
    expect(runner.calls).toHaveLength(1);
  });

  test("falls back to gh api", () => {
    const runner = new FakeRunner();
    runner.add(cmd("git", "config"), fail());
    runner.add(cmd("gh", "api", "user"), ok("possibilities\n"));
    expect(resolveSpecialOwner(runner)).toBe("possibilities");
  });
});

describe("repo lifecycle command plans", () => {
  test("clone routes a non-fork to <owner>--<name> under the clone root", () => {
    withTmp((root) => {
      const runner = new FakeRunner();
      runner.add(cmd("git", "config"), ok("possibilities\n"));
      runner.add(
        cmd("gh", "repo", "view"),
        ok(
          JSON.stringify({
            owner: { login: "anthropics" },
            name: "claude-code",
            isFork: false,
          }),
        ),
      );
      const result = cloneRepo({
        input: "anthropics/claude-code",
        destinationRoot: root,
        runner,
      });
      expect(result.primary_path).toBe(join(root, "anthropics--claude-code"));
      expect(
        runner.calls.some((c) =>
          c.argv.join(" ").includes("gh repo clone anthropics/claude-code"),
        ),
      ).toBe(true);
    });
  });

  test("clone routes a self-owned fork to primary plus upstream sibling", () => {
    withTmp((root) => {
      const runner = new FakeRunner();
      runner.add(cmd("git", "config"), ok("possibilities\n"));
      runner.add(
        cmd("gh", "repo", "view"),
        ok(
          JSON.stringify({
            owner: { login: "possibilities" },
            name: "prise",
            isFork: true,
            parent: { owner: { login: "rockorager" }, name: "prise" },
            defaultBranchRef: { name: "main" },
          }),
        ),
      );
      runner.add(
        (argv) => argv.join(" ").includes("remote get-url upstream"),
        fail("none"),
      );
      const result = cloneRepo({
        input: "possibilities/prise",
        destinationRoot: root,
        runner,
      });
      expect(result.primary_path).toBe(join(root, "possibilities--prise"));
      expect(result.sibling_path).toBe(join(root, "rockorager--prise"));
      expect(
        runner.calls.some((c) =>
          c.argv
            .join(" ")
            .includes(
              "remote add upstream https://github.com/rockorager/prise.git",
            ),
        ),
      ).toBe(true);
    });
  });

  test("fork ensures the fork then delegates through clone", () => {
    withTmp((root) => {
      const runner = new FakeRunner();
      runner.add(cmd("git", "config"), ok("possibilities\n"));
      runner.add(
        (argv) => argv.join(" ") === "gh api repos/possibilities/prise",
        fail("404"),
      );
      runner.add(
        cmd("gh", "repo", "view"),
        ok(
          JSON.stringify({
            owner: { login: "possibilities" },
            name: "prise",
            isFork: true,
            parent: { owner: { login: "rockorager" }, name: "prise" },
            defaultBranchRef: { name: "main" },
          }),
        ),
      );
      runner.add(
        (argv) => argv.join(" ").includes("remote get-url upstream"),
        fail("none"),
      );
      const result = forkRepo({
        input: "rockorager/prise",
        destinationRoot: root,
        runner,
      });
      expect(result.forked).toBe(true);
      expect(
        runner.calls.some(
          (c) =>
            c.argv.join(" ") === "gh repo fork rockorager/prise --clone=false",
        ),
      ).toBe(true);
    });
  });

  test("create initializes, commits, and creates the GitHub repo under create root", () => {
    withTmp((root) => {
      const runner = new FakeRunner();
      runner.add(cmd("git", "config"), ok("possibilities\n"));
      const result = createRepo({
        name: "new-tool",
        destinationRoot: root,
        runner,
      });
      expect(result.path).toBe(join(root, "new-tool"));
      expect(runner.calls.map((c) => c.argv.slice(0, 3).join(" "))).toContain(
        "git init -b",
      );
      expect(
        runner.calls.some((c) =>
          c.argv.join(" ").includes("gh repo create possibilities/new-tool"),
        ),
      ).toBe(true);
    });
  });
});
