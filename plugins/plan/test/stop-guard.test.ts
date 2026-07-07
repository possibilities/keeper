// Unit tests for plugin/hooks/stop-guard.ts.
//
// Two layers: (1) the pure classifiers — the close typed-stop allow patterns and
// the work/close block reason wording — exercised in-process; (2) the decision
// ladder driven through a real subprocess against a temp HOME and a keeper shim
// on PATH, so the hot-path short-circuit, the work reconcile block/allow paths,
// and the lenient close branch are covered with the true stdin/stdout
// discipline. The shim touches a sentinel on every call, letting us assert "zero
// keeper subprocesses" for the no-marker hot path and the close branch.

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
  childInFlight,
  closeBlockReason,
  closeStopAllowed,
  workBlockReason,
} from "../plugin/hooks/stop-guard.ts";

describe("closeStopAllowed", () => {
  const allowed: [string, string][] = [
    [
      "BLOCKED: line-start escalation",
      "BLOCKED: TOOLING_FAILURE — auditor down",
    ],
    [
      "BLOCKED: after a leading newline (multiline)",
      "Some preamble.\n  BLOCKED: TOOLING_FAILURE",
    ],
    ["QUESTION: relay", "QUESTION: should the schema bump major?"],
    [
      "surfaced typed-error envelope",
      'Surfacing verbatim: {"success": false, "error": {"code": "STALE_ARTIFACTS"}}',
    ],
    [
      "fatal-halt report",
      "Halted `fn-1-x`. fatal finding: data loss. epic NOT closed.",
    ],
    [
      "partial-followup surface",
      "Partial follow-up for `fn-1-x` (expected 3 tasks, found 1).",
    ],
  ];
  for (const [label, message] of allowed) {
    test(`allows: ${label}`, () => {
      expect(closeStopAllowed(message)).toBe(true);
    });
  }

  const denied: [string, unknown][] = [
    ["a bare mid-saga stop", "Closed the audit phase, agents returned."],
    [
      "blocked mid-line is not a typed return",
      "The work is blocked: but this is prose, lowercase too",
    ],
    ["empty string", ""],
    ["non-string content", { foo: "bar" }],
    ["undefined", undefined],
  ];
  for (const [label, message] of denied) {
    test(`denies: ${label}`, () => {
      expect(closeStopAllowed(message)).toBe(false);
    });
  }
});

describe("workBlockReason", () => {
  test("names the task, the verdict, and the resume ladder", () => {
    const reason = workBlockReason("fn-1-x.2", "in_progress_uncommitted");
    expect(reason).toContain("fn-1-x.2");
    expect(reason).toContain("in_progress_uncommitted");
    expect(reason).toContain("keeper plan worker resume fn-1-x.2");
    expect(reason).toContain("never edit or commit");
  });
});

describe("closeBlockReason", () => {
  test("names the epic, the finalize call, and the no-commit rule", () => {
    const reason = closeBlockReason("fn-1-x");
    expect(reason).toContain("fn-1-x");
    expect(reason).toContain("close-finalize fn-1-x --project");
    expect(reason).toContain("Never write or commit");
  });

  test("names the await case and tells an awaiting closer not to poll or finalize early", () => {
    const reason = closeBlockReason("fn-1-x");
    expect(reason).toContain("awaiting a subagent");
    expect(reason).toContain("end the turn");
    expect(reason).toMatch(/do NOT poll/i);
    expect(reason).toContain("finalize early");
  });
});

describe("childInFlight", () => {
  const running = {
    id: "a1",
    type: "subagent",
    status: "running",
    agent_type: "plan:quality-auditor",
  };
  const shellBusWatch = {
    id: "s1",
    type: "shell",
    status: "running",
    command: "keeper bus watch",
  };
  const cases: [string, unknown, boolean][] = [
    ["running subagent present", [running], true],
    [
      "running subagent alongside the shell bus-watch entry",
      [shellBusWatch, running],
      true,
    ],
    ["completed subagent only", [{ ...running, status: "completed" }], false],
    ["subagent with absent status", [{ id: "a1", type: "subagent" }], false],
    [
      "shell bus-watch entry only (non-empty, no subagent)",
      [shellBusWatch],
      false,
    ],
    [
      "running shell (not a subagent)",
      [{ ...shellBusWatch, type: "shell" }],
      false,
    ],
    ["null entry in the array", [null, running], true],
    [
      "malformed entries, no running subagent",
      [null, 7, "x", { type: "subagent" }],
      false,
    ],
    ["empty array", [], false],
    ["non-array (object)", { type: "subagent", status: "running" }, false],
    ["undefined", undefined, false],
    ["null", null, false],
  ];
  for (const [label, bg, expected] of cases) {
    test(`${label} → ${expected}`, () => {
      expect(childInFlight(bg)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// decision ladder — subprocess, temp HOME + keeper shim on PATH
// ---------------------------------------------------------------------------

const GUARD = join(import.meta.dir, "..", "plugin", "hooks", "stop-guard.ts");

let home: string;
let sessionsDir: string;
let binDir: string;
let sentinel: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-plan-stop-guard-"));
  sessionsDir = join(home, ".local", "state", "keeper", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  sentinel = join(home, "keeper-called");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const SESSION = "sess-stop";

function markerPath(): string {
  return join(sessionsDir, `${SESSION}.json`);
}

function writeWorkMarker(taskId: string): void {
  writeFileSync(
    markerPath(),
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

function writeCloseMarker(epicId: string): void {
  writeFileSync(
    markerPath(),
    JSON.stringify({
      schema_version: 1,
      session_id: SESSION,
      kind: "close",
      epic_id: epicId,
      created_at: "2026-06-11T00:00:00Z",
    }),
    "utf-8",
  );
}

// A POSIX sh shim, NOT a bun one: the guard's runPlanCli spawns this on PATH
// under a 5s timeout, and a nested bun cold-start races that budget under host
// contention (timeout → null envelope → guard fails open → empty stdout, so the
// block assertions see nothing). sh starts near-instantly, so runPlanCli always
// gets its envelope in time — the guard's real subprocess stdin/stdout contract
// is still exercised end-to-end. Touches the sentinel (proving reconcile ran),
// prints the envelope, exits.
function writePlanCliShim(envelope: unknown, exitCode = 0): void {
  const shim = join(binDir, "keeper");
  const sq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  writeFileSync(
    shim,
    `#!/bin/sh\n` +
      `: > ${sq(sentinel)}\n` +
      `printf '%s\\n' ${sq(JSON.stringify(envelope))}\n` +
      `exit ${exitCode}\n`,
    "utf-8",
  );
  chmodSync(shim, 0o755);
}

async function run(
  payload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  planCliCalled: boolean;
}> {
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
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code, planCliCalled: existsSync(sentinel) };
}

function stopPayload(extra: Record<string, unknown> = {}): unknown {
  return {
    hook_event_name: "Stop",
    session_id: SESSION,
    stop_hook_active: false,
    ...extra,
  };
}

describe("stop-guard ladder", () => {
  test("no marker → allow with zero keeper calls (hot path)", async () => {
    writePlanCliShim({ verdict: "in_progress_uncommitted" });

    const { stdout, code, planCliCalled } = await run(stopPayload());
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("bypass allows before any I/O — no keeper call", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "in_progress_uncommitted" });

    const { stdout, planCliCalled } = await run(stopPayload(), {
      KEEPER_PLAN_GUARD_BYPASS: "1",
    });
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("stop_hook_active true allows before any I/O (block-once)", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "in_progress_uncommitted" });

    const { stdout, planCliCalled } = await run(
      stopPayload({ stop_hook_active: true }),
    );
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  // --- work branch ---------------------------------------------------------

  test("work marker + in_progress_uncommitted → block with the checklist", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "in_progress_uncommitted" });

    const { stdout, code } = await run(stopPayload());
    expect(code).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("fn-1-x.2");
    expect(env.reason).toContain("not finished");
    expect(env.reason).toContain("keeper plan worker resume fn-1-x.2");
  });

  test("work marker + in-flight worker subagent → allow with zero keeper calls", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "in_progress_uncommitted" });

    const { stdout, planCliCalled } = await run(
      stopPayload({
        background_tasks: [
          {
            id: "s1",
            type: "shell",
            status: "running",
            command: "keeper bus watch",
          },
          {
            id: "a1",
            type: "subagent",
            status: "running",
            agent_type: "work:worker",
          },
        ],
      }),
    );
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("work marker + shell bus-watch only + unfinished verdict → block (worker-done catch preserved)", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "in_progress_uncommitted" });

    const { stdout, planCliCalled } = await run(
      stopPayload({
        background_tasks: [
          {
            id: "s1",
            type: "shell",
            status: "running",
            command: "keeper bus watch",
          },
          {
            id: "a1",
            type: "subagent",
            status: "completed",
            agent_type: "work:worker",
          },
        ],
      }),
    );
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("fn-1-x.2");
    expect(planCliCalled).toBe(true);
  });

  test("work marker + null probe → block AND a visible fail-open signal", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      dirty_session_files: null,
    });

    const { stdout, stderr } = await run(stopPayload());
    const env = JSON.parse(stdout.trim());
    // The block still stands on the verdict...
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("fn-1-x.2");
    // ...but the unreadable observable is announced, never silent.
    expect(stderr).toContain("session-files probe unreadable");
  });

  test("work marker + done → allow AND unlink the stale marker", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "done" });

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
    expect(existsSync(markerPath())).toBe(false);
  });

  test("work marker + blocked → allow AND unlink the stale marker", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "blocked" });

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
    expect(existsSync(markerPath())).toBe(false);
  });

  test("work marker + tooling_error → allow (fail open)", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "tooling_error" });

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
  });

  test("work marker + typed-error envelope (no verdict key) → allow", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ success: false, error: "task_not_found" }, 1);

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
  });

  // --- close branch --------------------------------------------------------

  test("close marker + bare mid-saga stop → block with the mid-saga reason", async () => {
    writeCloseMarker("fn-1-x");
    writePlanCliShim({ verdict: "ignored" });

    const { stdout, planCliCalled } = await run(
      stopPayload({
        last_assistant_message: "Audit phase done, agents returned.",
      }),
    );
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("fn-1-x");
    expect(env.reason).toContain("mid-saga");
    // The close branch never calls reconcile — its decision is message-only.
    expect(planCliCalled).toBe(false);
  });

  test("close marker + in-flight subagent → allow with zero keeper calls", async () => {
    writeCloseMarker("fn-1-x");
    writePlanCliShim({ verdict: "ignored" });

    const { stdout, planCliCalled } = await run(
      stopPayload({
        // A bare last message would otherwise block — the running subagent wins.
        last_assistant_message: "Spawned the auditor, awaiting its report.",
        background_tasks: [
          {
            id: "s1",
            type: "shell",
            status: "running",
            command: "keeper bus watch",
          },
          {
            id: "a1",
            type: "subagent",
            status: "running",
            agent_type: "plan:quality-auditor",
          },
        ],
      }),
    );
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("close marker + shell bus-watch only + bare message → block (genuine catch preserved)", async () => {
    writeCloseMarker("fn-1-x");
    writePlanCliShim({ verdict: "ignored" });

    const { stdout, planCliCalled } = await run(
      stopPayload({
        last_assistant_message: "Audit phase done, agents returned.",
        background_tasks: [
          {
            id: "s1",
            type: "shell",
            status: "running",
            command: "keeper bus watch",
          },
        ],
      }),
    );
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("mid-saga");
    expect(planCliCalled).toBe(false);
  });

  test("close marker + BLOCKED: last message → allow", async () => {
    writeCloseMarker("fn-1-x");
    const { stdout } = await run(
      stopPayload({
        last_assistant_message:
          "BLOCKED: TOOLING_FAILURE — auditor unreachable",
      }),
    );
    expect(stdout).toBe("");
  });

  test("close marker + QUESTION: last message → allow", async () => {
    writeCloseMarker("fn-1-x");
    const { stdout } = await run(
      stopPayload({ last_assistant_message: "QUESTION: bump major?" }),
    );
    expect(stdout).toBe("");
  });

  test("close marker + typed-error envelope surface → allow", async () => {
    writeCloseMarker("fn-1-x");
    const { stdout } = await run(
      stopPayload({
        last_assistant_message:
          'Surfacing: {"success": false, "error": {"code": "STALE_ARTIFACTS"}}',
      }),
    );
    expect(stdout).toBe("");
  });

  test("close marker + fatal-halt report → allow", async () => {
    writeCloseMarker("fn-1-x");
    const { stdout } = await run(
      stopPayload({
        last_assistant_message:
          "Halted `fn-1-x`. fatal finding: x. epic NOT closed.",
      }),
    );
    expect(stdout).toBe("");
  });

  test("close marker + partial-followup surface → allow", async () => {
    writeCloseMarker("fn-1-x");
    const { stdout } = await run(
      stopPayload({
        last_assistant_message:
          "Partial follow-up for `fn-1-x` (expected 3, found 1).",
      }),
    );
    expect(stdout).toBe("");
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
