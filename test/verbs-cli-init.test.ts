// Engine-agnostic conformance spec for the top-level CLI surface + `init` —
// translated from tests/test_cli.py and tests/test_init.py, every node mapped
// by a source-comment. cli: --help shape + the removed-subcommand guards
// (scout / interview / config). init: the advice-file drop (CLAUDE.md +
// relative AGENTS.md symlink, byte-equal to the exported CLAUDE_MD_CONTENT),
// idempotent human-edit preservation, backfill, the no-session-id self-commit,
// the idempotent no-empty-commit re-run, and the non-git write path.
//
// init's commit assertions drive real git (the pytest real_git mark); the
// harness withGitRepo seeds the repo, runCli drives init under its own HOME.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { SCHEMA_VERSION } from "../src/models.ts";
import { serializeStateJson } from "../src/store.ts";
import { CLAUDE_MD_CONTENT } from "../src/verbs/init.ts";
import {
  gitHeadMessage,
  gitInit,
  gitLogCount,
  runCli,
  withGitRepo,
  withTmpdir,
} from "./harness.ts";

const SID = { CLAUDE_CODE_SESSION_ID: "test-cli-init" };

// ---------------------------------------------------------------------------
// cli --help + removed-subcommand guards
// ---------------------------------------------------------------------------

describe("cli --help", () => {
  const getTmp = withTmpdir("planctl-cli-help-");

  test("exit 0 and names planctl", () => {
    // test_cli.py::test_cli_help
    const r = runCli(["--help"], { cwd: getTmp() });
    expect(r.code).toBe(0);
    expect(r.output.toLowerCase()).toContain("planctl");
  });

  test("no scout / interview subcommands (removed surfaces)", () => {
    // test_cli.py::test_cli_help_no_scout_or_interview_subcommands
    const r = runCli(["--help"], { cwd: getTmp() });
    expect(r.code).toBe(0);
    expect(r.output.toLowerCase()).not.toContain("scout");
    expect(r.output.toLowerCase()).not.toContain("interview");
  });

  test("no config subcommand in the Commands section", () => {
    // test_cli.py::test_cli_help_no_config_subcommand
    const r = runCli(["--help"], { cwd: getTmp() });
    expect(r.code).toBe(0);
    const m = r.stdout.match(/^Commands:\n((?: .*\n?)+)/m);
    expect(m).not.toBeNull();
    const body = (m as RegExpMatchArray)[1] as string;
    // Each command line is two-space indent + the name.
    expect(/^ {2}config\b/m.test(body)).toBe(false);
  });

  test("`config show` errors as an unknown command", () => {
    // test_cli.py::test_cli_config_show_errors_as_unknown_command
    const r = runCli(["config", "show"], { cwd: getTmp() });
    expect(r.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// init — advice-file drop, idempotency, self-commit
// ---------------------------------------------------------------------------

describe("init advice-file drop", () => {
  let repo: string;
  let home: string;
  const getRepo = withGitRepo("planctl-init-");
  const getHome = withTmpdir("planctl-init-home-");
  beforeEach(() => {
    repo = getRepo();
    home = getHome();
    const r = runCli(["init"], { cwd: repo, home, env: SID });
    expect(r.code).toBe(0);
  });

  test("drops CLAUDE.md byte-equal to the exported content", () => {
    // test_init.py::test_init_drops_claude_md
    const claudeMd = join(repo, ".planctl", "CLAUDE.md");
    expect(existsSync(claudeMd)).toBe(true);
    expect(readFileSync(claudeMd, "utf-8")).toBe(CLAUDE_MD_CONTENT);
  });

  test("drops AGENTS.md as a relative symlink to CLAUDE.md", () => {
    // test_init.py::test_init_drops_agents_md_as_relative_symlink
    const agentsMd = join(repo, ".planctl", "AGENTS.md");
    expect(lstatSync(agentsMd).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentsMd)).toBe("CLAUDE.md");
    expect(readFileSync(agentsMd, "utf-8")).toBe(CLAUDE_MD_CONTENT);
  });

  test("idempotent: a human-edited CLAUDE.md is preserved", () => {
    // test_init.py::test_init_is_idempotent_and_preserves_human_edits
    const claudeMd = join(repo, ".planctl", "CLAUDE.md");
    const custom = "# my notes\nthe human modified this file\n";
    writeFileSync(claudeMd, custom, "utf-8");
    const r = runCli(["init"], { cwd: repo, home, env: SID });
    expect(r.code).toBe(0);
    expect(readFileSync(claudeMd, "utf-8")).toBe(custom);
  });
});

describe("init backfill + commit semantics", () => {
  const getTmp = withTmpdir("planctl-init-bf-");
  const getHome = withTmpdir("planctl-init-bfhome-");

  test("backfills an existing pre-advice project", () => {
    // test_init.py::test_init_backfills_existing_project
    const dir = getTmp();
    const home = getHome();
    const planctlDir = join(dir, ".planctl");
    for (const sub of [
      "epics",
      "specs",
      "tasks",
      "state/tasks",
      "state/locks",
    ]) {
      mkdirSync(join(planctlDir, sub), { recursive: true });
    }
    writeFileSync(
      join(planctlDir, "meta.json"),
      serializeStateJson({ schema_version: SCHEMA_VERSION }),
      "utf-8",
    );
    writeFileSync(join(planctlDir, ".gitignore"), "state/\n", "utf-8");
    expect(existsSync(join(planctlDir, "CLAUDE.md"))).toBe(false);

    const r = runCli(["init"], {
      cwd: dir,
      home,
      env: { CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(join(planctlDir, "CLAUDE.md"), "utf-8")).toBe(
      CLAUDE_MD_CONTENT,
    );
    expect(lstatSync(join(planctlDir, "AGENTS.md")).isSymbolicLink()).toBe(
      true,
    );
    expect(readlinkSync(join(planctlDir, "AGENTS.md"))).toBe("CLAUDE.md");
  });

  test("self-commits its bootstrap files without a session id", () => {
    // test_init.py::test_init_self_commits_without_session_id
    const dir = getTmp();
    const home = getHome();
    gitInit(dir);
    writeFileSync(join(dir, "README.md"), "# repo\n", "utf-8");
    git(["add", "README.md"], dir);
    git(["commit", "-q", "-m", "chore: initial commit"], dir);

    const before = gitLogCount(dir);
    const r = runCli(["init"], {
      cwd: dir,
      home,
      env: { CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(r.code).toBe(0);
    expect(gitLogCount(dir)).toBe(before + 1);
    const msg = gitHeadMessage(dir);
    expect(msg.split("\n")[0]).toBe(`chore(planctl): init ${baseName(dir)}`);
    expect(msg).not.toContain("Session-Id:");

    const tracked = git(["ls-files", ".planctl/"], dir);
    for (const f of [
      ".planctl/meta.json",
      ".planctl/.gitignore",
      ".planctl/CLAUDE.md",
      ".planctl/AGENTS.md",
    ]) {
      expect(tracked).toContain(f);
    }
    expect(git(["status", "--porcelain"], dir).trim()).toBe("");
  });

  test("a no-op re-run creates no commit (no empty commit)", () => {
    // test_init.py::test_init_idempotent_rerun_creates_no_commit
    const dir = getTmp();
    const home = getHome();
    gitInit(dir);
    writeFileSync(join(dir, "README.md"), "# repo\n", "utf-8");
    git(["add", "README.md"], dir);
    git(["commit", "-q", "-m", "chore: initial commit"], dir);

    expect(
      runCli(["init"], { cwd: dir, home, env: { CLAUDE_CODE_SESSION_ID: "" } })
        .code,
    ).toBe(0);
    const afterFirst = gitLogCount(dir);
    const second = runCli(["init"], {
      cwd: dir,
      home,
      env: { CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(second.code).toBe(0);
    expect(gitLogCount(dir)).toBe(afterFirst);
    expect(git(["status", "--porcelain"], dir).trim()).toBe("");
  });

  test("outside a git work tree, writes files without committing", () => {
    // test_init.py::test_init_in_non_git_dir_writes_files_without_commit
    const dir = getTmp();
    const home = getHome();
    const r = runCli(["init"], {
      cwd: dir,
      home,
      env: { CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(r.code).toBe(0);
    const planctlDir = join(dir, ".planctl");
    expect(existsSync(join(planctlDir, "meta.json"))).toBe(true);
    expect(readFileSync(join(planctlDir, "CLAUDE.md"), "utf-8")).toBe(
      CLAUDE_MD_CONTENT,
    );
    expect(lstatSync(join(planctlDir, "AGENTS.md")).isSymbolicLink()).toBe(
      true,
    );
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });
});

// Local git runner (the init commit tests need ls-files / status reads beyond
// the harness's count/message helpers).
function git(args: string[], cwd: string): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd });
  if ((proc.exitCode ?? -1) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${Buffer.from(proc.stderr).toString()}`,
    );
  }
  return Buffer.from(proc.stdout).toString("utf-8");
}

function baseName(p: string): string {
  return p.split("/").filter(Boolean).pop() as string;
}
