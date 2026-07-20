// Unit tests for plugin/hooks/commit-guard.ts.
//
// Two layers: (1) the commit-pattern regex true/false table — the load-bearing
// classifier — exercised in-process; (2) the decision ladder driven through a
// real subprocess against a temp HOME and a keeper shim on PATH, so the
// fail-open short-circuits and the reconcile deny/allow paths are covered with
// the true stdin/stdout discipline. The shim touches a sentinel file on every
// call, letting us assert "zero keeper subprocesses" for the short-circuits.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isClaimedTaskCommitWork,
  isCommitCommand,
} from "../plugin/hooks/commit-guard.ts";

describe("isCommitCommand", () => {
  const positives = [
    "git commit -m x",
    "keeper commit-work 'feat: x'",
    "cd x && git commit -m y",
    "cd x && keeper commit-work msg",
    "git add . ; git commit -m y",
    "git add . || git commit -m y",
    "make build | git commit -m y", // pipe boundary (degenerate but in-spec)
    "FOO=bar git commit -m y",
    "FOO=bar BAZ=qux keeper commit-work m",
    "sudo git commit -m y",
    "env GIT_AUTHOR_NAME=x git commit -m y",
    "$(git commit -m y)",
    "  git commit -m y",
    "git\tcommit -m y",
  ];
  for (const cmd of positives) {
    test(`matches: ${cmd}`, () => {
      expect(isCommitCommand(cmd)).toBe(true);
    });
  }

  const negatives = [
    'echo "git commit"',
    "echo 'keeper commit-work'",
    "git status",
    "git log --grep 'git commit'",
    "gitcommit -m y", // no word boundary
    "git committed", // trailing word — \b stops the token, but 'commit'+'ted'…
    "keeper commit",
    "keeper commitwork",
    "mygit commit -m y",
    "ls -la",
  ];
  for (const cmd of negatives) {
    test(`rejects: ${cmd}`, () => {
      expect(isCommitCommand(cmd)).toBe(false);
    });
  }
});

describe("isClaimedTaskCommitWork", () => {
  const taskId = "fn-1383-rail.1";

  for (const command of [
    `keeper commit-work --task-id ${taskId} "feat: land work"`,
    `keeper commit-work --task-id=${taskId} --message-file /tmp/message`,
    `cd /lane && keeper commit-work --task-id '${taskId}' --preview-files`,
  ]) {
    test(`admits exact operator shape: ${command}`, () => {
      expect(isClaimedTaskCommitWork(command, taskId)).toBe(true);
    });
  }

  for (const command of [
    `keeper commit-work "feat: no attribution"`,
    `keeper commit-work "--task-id ${taskId}"`,
    `keeper commit-work --task-id fn-1383-rail.10 "feat: wrong task"`,
    `keeper commit-work --message-file /tmp/message --task-id ${taskId}`,
    `keeper commit-work --task-id ${taskId} x && git commit -m forged`,
    `keeper commit-work --task-id ${taskId} x; keeper commit-work --task-id ${taskId} y`,
  ]) {
    test(`rejects non-exact operator shape: ${command}`, () => {
      expect(isClaimedTaskCommitWork(command, taskId)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// decision ladder — subprocess, temp HOME + keeper shim on PATH
// ---------------------------------------------------------------------------

const GUARD = join(import.meta.dir, "..", "plugin", "hooks", "commit-guard.ts");

let home: string;
let sessionsDir: string;
let binDir: string;
let sentinel: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-plan-commit-guard-"));
  sessionsDir = join(home, ".local", "state", "keeper", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  sentinel = join(home, "keeper-called");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const SESSION = "sess-commit";

function writeWorkMarker(taskId: string): void {
  writeFileSync(
    join(sessionsDir, `${SESSION}.json`),
    JSON.stringify({
      schema_version: 1,
      session_id: SESSION,
      kind: "work",
      task_id: taskId,
      created_at: "2026-06-11T00:00:00Z",
    }),
    "utf-8",
  );
}

/** Drop a `keeper` shim that touches the sentinel and prints `envelope` as its
 * last stdout line. `exitCode` lets a test model a non-zero reconcile. */
function writePlanCliShim(envelope: unknown, exitCode = 0): void {
  const shim = join(binDir, "keeper");
  writeFileSync(
    shim,
    `#!/usr/bin/env bun\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(sentinel)}, "1");\n` +
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(envelope)}\n`)});\n` +
      `process.exit(${exitCode});\n`,
    "utf-8",
  );
  chmodSync(shim, 0o755);
}

async function run(
  payload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; code: number; planCliCalled: boolean }> {
  const proc = Bun.spawn(["bun", GUARD], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      ...extraEnv,
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { stdout, code, planCliCalled: existsSync(sentinel) };
}

function bashPayload(extra: Record<string, unknown> = {}): unknown {
  return {
    hook_event_name: "PreToolUse",
    session_id: SESSION,
    tool_name: "Bash",
    tool_input: { command: "git commit -m y" },
    ...extra,
  };
}

describe("commit-guard ladder", () => {
  test("denies main-context git commit while the task reconciles in_progress", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, code } = await run(bashPayload());
    expect(code).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(env.hookSpecificOutput.permissionDecisionReason).toContain(
      "fn-1-x.2",
    );
  });

  test("denies compound and wrapped main-context commit commands", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "in_progress_committed", task_id: "fn-1-x.2" });

    for (const command of [
      "cd sub && git commit -m y",
      `sh -c 'keeper commit-work --task-id fn-1-x.2 "fix: x"'`,
    ]) {
      rmSync(sentinel, { force: true });
      const { stdout, code } = await run(
        bashPayload({ tool_input: { command } }),
      );
      expect(code).toBe(0);
      expect(
        JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    }
  });

  test("passes for the selected work:worker without a reconcile call", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, code, planCliCalled } = await run(
      bashPayload({ agent_id: "agent-7", agent_type: "work:worker" }),
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  for (const [label, command] of [
    ["direct Git", "git commit -m y"],
    [
      "command plus absolute Keeper path",
      'command /usr/local/bin/keeper commit-work --task-id fn-1-x.2 "fix: x"',
    ],
    ["sh -c", `sh -c 'keeper commit-work --task-id fn-1-x.2 "fix: x"'`],
    ["backticks", '`keeper commit-work --task-id fn-1-x.2 "fix: x"`'],
  ]) {
    test(`denies generic-subagent laundering via ${label}`, async () => {
      writeWorkMarker("fn-1-x.2");
      writePlanCliShim({
        verdict: "in_progress_uncommitted",
        task_id: "fn-1-x.2",
      });

      const { stdout, code, planCliCalled } = await run(
        bashPayload({
          agent_id: "agent-7",
          agent_type: "general-purpose",
          tool_input: { command },
        }),
      );
      expect(code).toBe(0);
      expect(planCliCalled).toBe(true);
      expect(
        JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    });
  }

  test("admits a main-context operator with the live exact-task claim", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, code, planCliCalled } = await run(
      bashPayload({
        tool_input: {
          command:
            'keeper commit-work --task-id fn-1-x.2 "fix(rail): land verified work"',
        },
      }),
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(true);
  });

  test("denies main-context commit-work without the exact claimed Task id", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    for (const command of [
      'keeper commit-work "fix(rail): unattributed"',
      'keeper commit-work --task-id fn-1-x.3 "fix(rail): wrong task"',
    ]) {
      rmSync(sentinel, { force: true });
      const { stdout, code, planCliCalled } = await run(
        bashPayload({ tool_input: { command } }),
      );
      expect(code).toBe(0);
      expect(planCliCalled).toBe(true);
      expect(
        JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
      ).toBe("deny");
    }
  });

  test("done reconcile allows AND unlinks the stale marker", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "done", task_id: "fn-1-x.2" });

    const { stdout, code } = await run(bashPayload());
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(existsSync(join(sessionsDir, `${SESSION}.json`))).toBe(false);
  });

  test("blocked reconcile allows AND unlinks the stale marker", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "blocked", task_id: "fn-1-x.2" });

    const { stdout } = await run(bashPayload());
    expect(stdout).toBe("");
    expect(existsSync(join(sessionsDir, `${SESSION}.json`))).toBe(false);
  });

  test("tooling_error verdict fails open (allow, marker preserved)", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "tooling_error", task_id: "fn-1-x.2" });

    const { stdout } = await run(bashPayload());
    expect(stdout).toBe("");
    expect(existsSync(join(sessionsDir, `${SESSION}.json`))).toBe(true);
  });

  test("typed-error envelope (no verdict key) fails open", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ success: false, error: "task_not_found" }, 1);

    const { stdout } = await run(bashPayload());
    expect(stdout).toBe("");
  });

  test("KEEPER_PLAN_GUARD_BYPASS cannot bypass the commit rail", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, planCliCalled } = await run(bashPayload(), {
      KEEPER_PLAN_GUARD_BYPASS: "1",
    });
    expect(planCliCalled).toBe(true);
    expect(
      JSON.parse(stdout.trim()).hookSpecificOutput.permissionDecision,
    ).toBe("deny");
  });

  test("non-commit Bash payload produces zero keeper subprocesses", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, planCliCalled } = await run(
      bashPayload({ tool_input: { command: "git status" } }),
    );
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("non-Bash tool passes without touching the marker or keeper", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, planCliCalled } = await run(
      bashPayload({ tool_name: "Read", tool_input: { file_path: "/x" } }),
    );
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("absent marker passes without a keeper call", async () => {
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });
    const { stdout, planCliCalled } = await run(bashPayload());
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("close-kind marker is ignored (work-only guard)", async () => {
    writeFileSync(
      join(sessionsDir, `${SESSION}.json`),
      JSON.stringify({
        schema_version: 1,
        session_id: SESSION,
        kind: "close",
        epic_id: "fn-1-x",
        created_at: "2026-06-11T00:00:00Z",
      }),
      "utf-8",
    );
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });
    const { stdout, planCliCalled } = await run(bashPayload());
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("unparseable stdin fails open", async () => {
    const proc = Bun.spawn(["bun", GUARD], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home },
    });
    proc.stdin.write("{not json");
    await proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
