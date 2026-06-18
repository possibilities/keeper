/**
 * Conformance tests for the `keeper plan` in-process alias (`cli/plan.ts`).
 * Proves `keeper plan <verb>` is byte-compatible with a direct `planctl <verb>`
 * invocation now that the plan verb dispatcher runs IN-PROCESS (no child spawn):
 * argv forwarded verbatim (the `plan` token already stripped by the dispatcher),
 * stdin read off the inherited fd 0, exit code propagated, and the trailing
 * `planctl_invocation` NDJSON trailer surviving byte-intact.
 *
 * The golden conformance drives the REAL compiled `planctl` binary and asserts
 * byte-identical stdout/stderr/exit between `keeper plan <verb>` and
 * `planctl <verb>` end to end — covering read-only verbs, the help/usage
 * surfaces, exit-code propagation, and (in a fresh scratch repo) stdin
 * forwarding through a stdin-reading verb.
 *
 * This file is fast-tier-ignored (it spawns the keeper CLI + the planctl
 * binary); it runs only under `bun run test:full`.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEEPER = join(import.meta.dir, "..", "cli", "keeper.ts");
const BUN = process.execPath;

function spawn(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd,
    cwd: opts.cwd ?? process.cwd(),
    // Inherit the real env (HOME, PATH, …) so the planctl binary resolves its
    // config/roots and git finds its identity; per-call overrides win.
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.stdin != null ? { stdin: Buffer.from(opts.stdin) } : {}),
  });
  return {
    code: r.exitCode,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
}

/** Run the keeper CLI under bun, forwarding the given argv (the `plan`
 * subcommand routes through the in-process dispatcher). */
function keeper(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; stdin?: string } = {},
): { code: number; stdout: string; stderr: string } {
  return spawn([BUN, KEEPER, ...argv], opts);
}

/** Cleanup tracker — every tmpdir created here is registered for teardown. */
const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) {
    try {
      rmSync(t, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe("keeper plan — byte-identical to direct planctl (real binary)", () => {
  test("`keeper plan detect` matches `planctl detect` (stdout/stderr/exit + trailer)", () => {
    const direct = spawn(["planctl", "detect"]);
    const shimmed = keeper(["plan", "detect"]);
    expect(shimmed.code).toBe(direct.code);
    expect(shimmed.stdout).toBe(direct.stdout);
    expect(shimmed.stderr).toBe(direct.stderr);
    // The planctl_invocation NDJSON trailer is the last stdout line — assert it
    // survived byte-intact through the in-process dispatch.
    const lastLine = shimmed.stdout.trimEnd().split("\n").at(-1) ?? "";
    expect(lastLine).toContain('"planctl_invocation"');
    const parsed = JSON.parse(lastLine);
    expect(parsed.planctl_invocation.op).toBe("detect");
  });

  test("`keeper plan --format human detect` matches `planctl --format human detect`", () => {
    const direct = spawn(["planctl", "--format", "human", "detect"]);
    const shimmed = keeper(["plan", "--format", "human", "detect"]);
    expect(shimmed.code).toBe(direct.code);
    expect(shimmed.stdout).toBe(direct.stdout);
    expect(shimmed.stderr).toBe(direct.stderr);
  });

  test("`keeper plan --help` matches `planctl --help` byte-for-byte (exit 0)", () => {
    const direct = spawn(["planctl", "--help"]);
    const shimmed = keeper(["plan", "--help"]);
    expect(shimmed.code).toBe(0);
    expect(direct.code).toBe(0);
    expect(shimmed.stdout).toBe(direct.stdout);
    expect(shimmed.stderr).toBe(direct.stderr);
  });

  test("bare `keeper plan` matches bare `planctl` (top-level help)", () => {
    const direct = spawn(["planctl"]);
    const shimmed = keeper(["plan"]);
    expect(shimmed.code).toBe(direct.code);
    expect(shimmed.stdout).toBe(direct.stdout);
    expect(shimmed.stderr).toBe(direct.stderr);
  });
});

describe("keeper plan — exit code propagation (real binary)", () => {
  test("an unknown verb propagates click's usage error + exit 2", () => {
    const direct = spawn(["planctl", "no-such-verb-zzz"]);
    const shimmed = keeper(["plan", "no-such-verb-zzz"]);
    expect(direct.code).toBe(2);
    expect(shimmed.code).toBe(2);
    expect(shimmed.stdout).toBe(direct.stdout);
    expect(shimmed.stderr).toBe(direct.stderr);
  });

  test("an invalid --format value propagates the usage error + exit 2", () => {
    const direct = spawn(["planctl", "--format", "bogus", "status"]);
    const shimmed = keeper(["plan", "--format", "bogus", "status"]);
    expect(direct.code).toBe(2);
    expect(shimmed.code).toBe(2);
    expect(shimmed.stdout).toBe(direct.stdout);
    expect(shimmed.stderr).toBe(direct.stderr);
  });
});

describe("keeper plan — stdin forwarding (real binary, scratch repo)", () => {
  /** Stand up a fresh git repo with an initialized planctl project + one
   * scaffolded epic/task. Returns the realpath'd repo dir. */
  function scratchRepo(): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "keeper-plan-shim-")));
    tmps.push(repo);
    const git = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", repo, ...args], {
        stdout: "ignore",
        stderr: "pipe",
      });
      if (!r.success) {
        throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
      }
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    // planctl's auto-commit needs a HEAD to build on.
    writeFileSync(join(repo, "README.md"), "scratch\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");

    const init = spawn(["planctl", "init"], { cwd: repo });
    if (init.code !== 0) {
      throw new Error(`planctl init failed: ${init.stderr}`);
    }
    const yaml = [
      "epic:",
      "  title: stdin fixture",
      "  spec: |",
      "    ## Overview",
      "    A stdin-forwarding fixture.",
      "tasks:",
      "  - title: First task",
      "    deps: []",
      "    tier: medium",
      "    spec: |",
      "      ## Description",
      "      Implement the thing.",
      "",
      "      ## Acceptance",
      "      - [ ] It works.",
      "",
      "      ## Done summary",
      "",
      "      ## Evidence",
      "",
    ].join("\n");
    const yamlPath = join(repo, "scaffold.yaml");
    writeFileSync(yamlPath, yaml);
    const scaf = spawn(["planctl", "scaffold", "--file", yamlPath], {
      cwd: repo,
    });
    if (scaf.code !== 0) {
      throw new Error(`planctl scaffold failed: ${scaf.stderr}`);
    }
    return repo;
  }

  test("piped stdin reaches a stdin-reading verb identically in-process", () => {
    // `task set-acceptance <task> --file -` reads the replacement section off
    // stdin. Each runtime drives its OWN fresh repo (identical setup), so a
    // byte-identical stdout/stderr/exit proves the in-process path consumed the
    // piped stdin exactly as the spawned binary does. The task id is the epic's
    // single child, `<epic>.1`.
    const epicId = "fn-1-stdin-fixture";
    const taskId = `${epicId}.1`;
    const payload = "- [ ] piped acceptance line\n- [ ] second line\n";

    const directRepo = scratchRepo();
    const direct = spawn(
      ["planctl", "task", "set-acceptance", taskId, "--file", "-"],
      { cwd: directRepo, stdin: payload },
    );

    const shimRepo = scratchRepo();
    const shimmed = keeper(
      ["plan", "task", "set-acceptance", taskId, "--file", "-"],
      { cwd: shimRepo, stdin: payload },
    );

    expect(direct.code).toBe(0);
    expect(shimmed.code).toBe(direct.code);
    expect(shimmed.stderr).toBe(direct.stderr);

    // The success line carries a per-repo planctl_invocation trailer
    // (repo_root / state_repo / touched_path_files are absolute tmp paths
    // unique to each scratch repo), so compare only the repo-invariant fields —
    // the verb's identity proves it processed the same piped stdin in both
    // runtimes.
    const directEnv = JSON.parse(direct.stdout.trim());
    const shimEnv = JSON.parse(shimmed.stdout.trim());
    expect(shimEnv.success).toBe(directEnv.success);
    expect(shimEnv.task_id).toBe(directEnv.task_id);
    expect(shimEnv.section).toBe(directEnv.section);
    expect(shimEnv.planctl_invocation.op).toBe(directEnv.planctl_invocation.op);
    expect(shimEnv.planctl_invocation.target).toBe(
      directEnv.planctl_invocation.target,
    );

    // The piped section landed in the spec — `cat` is format-free raw markdown,
    // repo-path-independent, so it must match byte-for-byte across both repos.
    const directCat = spawn(["planctl", "cat", taskId], { cwd: directRepo });
    const shimCat = keeper(["plan", "cat", taskId], { cwd: shimRepo });
    expect(shimCat.code).toBe(0);
    expect(shimCat.stdout).toBe(directCat.stdout);
    expect(shimCat.stdout).toContain("piped acceptance line");
  });
});
