// Unit tests for plugin/hooks/subagent-stop-guard.ts.
//
// Two layers: (1) the pure classifiers — BLOCKED multiline match, transcript
// TASK_ID extraction (string + block-list content shapes), and the Phase 2b
// nudge map — exercised in-process; (2) the decision ladder driven through a
// real subprocess against a temp HOME and a keeper shim on PATH, so the
// fail-open short-circuits and the reconcile block/allow paths are covered with
// the true stdin/stdout discipline. The shim touches a sentinel on every call,
// letting us assert "zero keeper subprocesses" for the short-circuits.

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

import { sessionDirtyCount } from "../plugin/hooks/lib.ts";
import {
  BLOCKED_PATTERN,
  extractTaskId,
  taskIdFromTranscript,
  VERDICT_NUDGE,
} from "../plugin/hooks/subagent-stop-guard.ts";

describe("BLOCKED_PATTERN", () => {
  const positives = [
    "BLOCKED: SPEC_UNCLEAR",
    "  BLOCKED: TOOLING_FAILURE",
    "Implemented: x\nFiles: y\nBLOCKED: DEPENDENCY_BLOCKED\nTask: z",
    "\nBLOCKED: SCOPE_EXCEEDED",
  ];
  for (const msg of positives) {
    test(`matches: ${JSON.stringify(msg).slice(0, 40)}`, () => {
      expect(BLOCKED_PATTERN.test(msg)).toBe(true);
    });
  }

  const negatives = [
    "Implemented: the BLOCKED: prose mid-line is not a typed return",
    "this is not blocked at all",
    "blocked: lowercase is not the typed marker",
    "",
  ];
  for (const msg of negatives) {
    test(`rejects: ${JSON.stringify(msg).slice(0, 40)}`, () => {
      expect(BLOCKED_PATTERN.test(msg)).toBe(false);
    });
  }
});

describe("extractTaskId", () => {
  test("pulls TASK_ID from a string content body", () => {
    const body = "Implement a plan task.\n\nTASK_ID: fn-9-x.3\nEPIC_ID: fn-9-x";
    expect(extractTaskId(body)).toBe("fn-9-x.3");
  });

  test("pulls TASK_ID from a list of content blocks", () => {
    const content = [
      { type: "text", text: "preamble" },
      { type: "text", text: "TASK_ID: fn-9-x.3\nPLAN_CLI: keeper plan" },
    ];
    expect(extractTaskId(content)).toBe("fn-9-x.3");
  });

  test("returns null when no TASK_ID line is present", () => {
    expect(extractTaskId("just some prose, no task id")).toBeNull();
  });

  test("returns null for a non-string, non-array content", () => {
    expect(extractTaskId({ foo: "bar" })).toBeNull();
    expect(extractTaskId(null)).toBeNull();
  });

  test("ignores a TASK_ID substring that is not a line start", () => {
    expect(extractTaskId("see MY_TASK_ID: fn-9-x.3 in the docs")).toBeNull();
  });
});

describe("VERDICT_NUDGE", () => {
  test("in_progress_committed names the task and points at done", () => {
    const nudge = VERDICT_NUDGE.in_progress_committed?.("fn-1-x.2");
    expect(nudge).toContain("fn-1-x.2");
    expect(nudge).toContain("keeper plan done");
  });

  test("in_progress_uncommitted carries the finish-implementation nudge", () => {
    const nudge = VERDICT_NUDGE.in_progress_uncommitted?.("fn-1-x.2");
    expect(nudge).toContain("fn-1-x.2");
    expect(nudge).toContain("keeper commit-work");
  });

  test("state_uncommitted points at a done re-run", () => {
    const nudge = VERDICT_NUDGE.state_uncommitted?.("fn-1-x.2");
    expect(nudge).toContain("fn-1-x.2");
    expect(nudge).toContain("keeper plan done");
  });

  test("not_started maps to null — never a trap", () => {
    expect(VERDICT_NUDGE.not_started?.("fn-1-x.2")).toBeNull();
  });
});

describe("sessionDirtyCount", () => {
  test("a non-negative count reads through", () => {
    expect(sessionDirtyCount({ dirty_session_files: 0 })).toBe(0);
    expect(sessionDirtyCount({ dirty_session_files: 3 })).toBe(3);
  });

  test("null is the fail-open marker", () => {
    expect(sessionDirtyCount({ dirty_session_files: null })).toBeNull();
  });

  test("an absent field / null envelope is unknown (undefined)", () => {
    expect(sessionDirtyCount({ verdict: "done" })).toBeUndefined();
    expect(sessionDirtyCount(null)).toBeUndefined();
  });

  test("a non-numeric or negative shape degrades to unknown", () => {
    expect(sessionDirtyCount({ dirty_session_files: "2" })).toBeUndefined();
    expect(sessionDirtyCount({ dirty_session_files: -1 })).toBeUndefined();
    expect(
      sessionDirtyCount({ dirty_session_files: Number.NaN }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// transcript fallback parser — temp file, bounded read, defensive shapes
// ---------------------------------------------------------------------------

describe("taskIdFromTranscript", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keeper-plan-transcript-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeTranscript(lines: unknown[]): string {
    const path = join(dir, "transcript.jsonl");
    writeFileSync(
      path,
      lines.map((l) => JSON.stringify(l)).join("\n"),
      "utf-8",
    );
    return path;
  }

  test("extracts TASK_ID from the first user message (string content)", async () => {
    const path = writeTranscript([
      { type: "custom-title", customTitle: "x" },
      {
        type: "user",
        message: {
          role: "user",
          content: "Resume a plan task.\n\nTASK_ID: fn-7-y.4\nEPIC_ID: fn-7-y",
        },
      },
    ]);
    expect(await taskIdFromTranscript(path)).toBe("fn-7-y.4");
  });

  test("extracts TASK_ID from a block-list user message", async () => {
    const path = writeTranscript([
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "TASK_ID: fn-7-y.4\nmore" }],
        },
      },
    ]);
    expect(await taskIdFromTranscript(path)).toBe("fn-7-y.4");
  });

  test("returns null when the first user message has no TASK_ID", async () => {
    const path = writeTranscript([
      { type: "user", message: { role: "user", content: "no id here" } },
      {
        type: "user",
        message: { role: "user", content: "TASK_ID: fn-7-y.4" },
      },
    ]);
    // Only the FIRST user message is inspected — the later id is not consulted.
    expect(await taskIdFromTranscript(path)).toBeNull();
  });

  test("returns null for a missing file", async () => {
    expect(await taskIdFromTranscript(join(dir, "absent.jsonl"))).toBeNull();
  });

  test("returns null for a non-string path", async () => {
    expect(await taskIdFromTranscript(undefined)).toBeNull();
    expect(await taskIdFromTranscript(42)).toBeNull();
  });

  test("survives a leading non-JSON line without throwing", async () => {
    const path = join(dir, "junk.jsonl");
    writeFileSync(
      path,
      `{not json\n${JSON.stringify({
        type: "user",
        message: { role: "user", content: "TASK_ID: fn-7-y.4" },
      })}`,
      "utf-8",
    );
    // The truncated/garbage first line stops the scan defensively → null.
    expect(await taskIdFromTranscript(path)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decision ladder — subprocess, temp HOME + keeper shim on PATH
// ---------------------------------------------------------------------------

const GUARD = join(
  import.meta.dir,
  "..",
  "plugin",
  "hooks",
  "subagent-stop-guard.ts",
);

let home: string;
let sessionsDir: string;
let binDir: string;
let sentinel: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "keeper-plan-subagent-guard-"));
  sessionsDir = join(home, ".local", "state", "keeper", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  sentinel = join(home, "keeper-called");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const SESSION = "sess-subagent";

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
    hook_event_name: "SubagentStop",
    session_id: SESSION,
    agent_id: "agent-7",
    agent_type: "plan:worker-opus-medium",
    stop_hook_active: false,
    ...extra,
  };
}

describe("subagent-stop-guard ladder", () => {
  test("blocks on in_progress_uncommitted with the matching nudge naming the task", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, code } = await run(stopPayload());
    expect(code).toBe(0);
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("fn-1-x.2");
    expect(env.reason).toContain("keeper commit-work");
  });

  test("blocks on in_progress_committed pointing at keeper plan done", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "in_progress_committed", task_id: "fn-1-x.2" });

    const { stdout } = await run(stopPayload());
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("keeper plan done fn-1-x.2");
  });

  test("in_progress_committed + dirty session files → the finish-and-commit nudge", async () => {
    // The observable overrides the verdict inference: a source commit landed but
    // the lane still carries undischarged files, so "run done" would strand them.
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_committed",
      task_id: "fn-1-x.2",
      dirty_session_files: 2,
    });

    const { stdout } = await run(stopPayload());
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("keeper commit-work");
  });

  test("in_progress_committed + zero dirty files stays the done nudge", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_committed",
      task_id: "fn-1-x.2",
      dirty_session_files: 0,
    });

    const { stdout } = await run(stopPayload());
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("keeper plan done fn-1-x.2");
  });

  test("in_progress_committed + null probe → done nudge AND a visible fail-open signal", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_committed",
      task_id: "fn-1-x.2",
      dirty_session_files: null,
    });

    const { stdout, stderr } = await run(stopPayload());
    const env = JSON.parse(stdout.trim());
    // Fail-open: an unreadable probe never upgrades the nudge — the verdict wins.
    expect(env.reason).toContain("keeper plan done fn-1-x.2");
    // ...but the open is announced on stderr, never silent.
    expect(stderr).toContain("session-files probe unreadable");
    expect(stderr).toContain("fn-1-x.2");
  });

  test("blocks on state_uncommitted", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "state_uncommitted", task_id: "fn-1-x.2" });

    const env = JSON.parse((await run(stopPayload())).stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("state commit");
  });

  test("BLOCKED: last_assistant_message allows before any I/O", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, planCliCalled } = await run(
      stopPayload({ last_assistant_message: "BLOCKED: SPEC_UNCLEAR\nTask: x" }),
    );
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("stop_hook_active true allows before any I/O (block-once)", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, planCliCalled } = await run(
      stopPayload({ stop_hook_active: true }),
    );
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("done verdict allows AND unlinks the stale marker", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "done", task_id: "fn-1-x.2" });

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
    expect(existsSync(join(sessionsDir, `${SESSION}.json`))).toBe(false);
  });

  test("blocked verdict allows (preserves marker — clearing is done/block's job)", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "blocked", task_id: "fn-1-x.2" });

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
  });

  test("not_started verdict allows — never trap an unstarted task", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "not_started", task_id: "fn-1-x.2" });

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
  });

  test("tooling_error verdict fails open", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ verdict: "tooling_error", task_id: "fn-1-x.2" });

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
  });

  test("typed-error envelope (no verdict key) fails open", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({ success: false, error: "task_not_found" }, 1);

    const { stdout } = await run(stopPayload());
    expect(stdout).toBe("");
  });

  test("falls back to the transcript TASK_ID when no marker is present", async () => {
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "TASK_ID: fn-3-z.1\nEPIC_ID: fn-3-z",
        },
      }),
      "utf-8",
    );
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-3-z.1",
    });

    const { stdout } = await run(
      stopPayload({ agent_transcript_path: transcript }),
    );
    const env = JSON.parse(stdout.trim());
    expect(env.decision).toBe("block");
    expect(env.reason).toContain("fn-3-z.1");
  });

  test("no marker and no resolvable transcript task id allows", async () => {
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, planCliCalled } = await run(stopPayload());
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("close-kind marker is ignored, falls through to transcript (none) → allow", async () => {
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

    const { stdout, planCliCalled } = await run(stopPayload());
    expect(stdout).toBe("");
    expect(planCliCalled).toBe(false);
  });

  test("bypass allows before any I/O — no keeper call", async () => {
    writeWorkMarker("fn-1-x.2");
    writePlanCliShim({
      verdict: "in_progress_uncommitted",
      task_id: "fn-1-x.2",
    });

    const { stdout, planCliCalled } = await run(stopPayload(), {
      KEEPER_PLAN_GUARD_BYPASS: "1",
    });
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
