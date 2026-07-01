/**
 * The blocking run-and-capture primitive (`src/agent/run-capture.ts`) + its two
 * additive verbs (`agent run` / `agent wait`), driven through main()'s dispatch.
 *
 * Decision A (uniform envelope) is the contract under test: ONE 9-key shape for
 * EVERY terminal state, the `outcome` closed set mapping to an exit code. Coverage:
 *  - the full-key-set snapshot (a forgotten field / missing schema_version fails);
 *  - `parseRunArgs` over its valid + malformed arms;
 *  - the compose helper (`captureFromHandle` / `composeRunCapture`) over every
 *    outcome with INJECTED wait/show/launch/now seams — no real subprocess;
 *  - `splitSubcommand` classification of the new `run`/`wait` tokens;
 *  - main()-driven `agent run` (faked tmux launch + a real on-disk transcript)
 *    and `agent wait`, asserting a single JSON line + the mapped exit code.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitSubcommand } from "../src/agent/dispatch";
import { main } from "../src/agent/main";
import type {
  ResolvedHandle,
  ShowLastMessageResult,
  VerbDeps,
  WaitForStopResult,
} from "../src/agent/pair-subcommands";
import {
  buildRunCaptureEnvelope,
  captureFromHandle,
  composeRunCapture,
  parseRunArgs,
  RUN_CAPTURE_SCHEMA_VERSION,
  type RunCaptureDeps,
  type RunLaunchResult,
  runCaptureExitCode,
} from "../src/agent/run-capture";
import { expectExit, makeHarness } from "./helpers/agent-main-harness";

const ENVELOPE_KEYS = [
  "agent",
  "elapsed_seconds",
  "handle",
  "message",
  "message_found",
  "outcome",
  "resume_target",
  "schema_version",
  "transcript_path",
] as const;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-run-capture-test-"));
}

const VERB_DEPS: VerbDeps = { env: {}, homeDir: "/fake-home" };

function handle(sessionId: string | null = "sess-1"): ResolvedHandle {
  return {
    agent: "claude",
    cwd: "/work/proj",
    sessionId,
    startedAtMs: 0,
    transcriptPath: null,
    stopTimeoutMs: null,
  };
}

/** A RunCaptureDeps whose wait/show are canned and whose clock is fixed. */
function seams(opts: {
  wait: WaitForStopResult;
  show: ShowLastMessageResult;
  now?: number;
}): RunCaptureDeps {
  return {
    waitForStop: async () => opts.wait,
    showLastMessage: async () => opts.show,
    now: () => opts.now ?? 0,
  };
}

const STOP = {
  agent: "claude" as const,
  eventType: "assistant",
  reason: "end_turn",
  timestamp: null,
  message: "the answer",
};

describe("buildRunCaptureEnvelope — full key set + exit codes", () => {
  test("every outcome carries EXACTLY the 9 contract keys", () => {
    for (const outcome of [
      "completed",
      "no_message",
      "timed_out",
      "no_transcript",
      "launch_failed",
      "bad_args",
    ] as const) {
      const { envelope } = buildRunCaptureEnvelope({ outcome });
      expect(Object.keys(envelope).sort()).toEqual([...ENVELOPE_KEYS]);
      expect(envelope.schema_version).toBe(RUN_CAPTURE_SCHEMA_VERSION);
    }
  });

  test("a fully-populated completed envelope round-trips its fields", () => {
    const { envelope, exitCode } = buildRunCaptureEnvelope({
      outcome: "completed",
      agent: "claude",
      handle: "tmux-1",
      transcriptPath: "/t.jsonl",
      resumeTarget: "sess-1",
      message: "hi",
      messageFound: true,
      elapsedSeconds: 2.5,
    });
    expect(envelope).toEqual({
      schema_version: 1,
      agent: "claude",
      handle: "tmux-1",
      transcript_path: "/t.jsonl",
      resume_target: "sess-1",
      message: "hi",
      message_found: true,
      elapsed_seconds: 2.5,
      outcome: "completed",
    });
    expect(exitCode).toBe(0);
  });

  test("a failure envelope still emits, nulls where unknown", () => {
    const { envelope, exitCode } = buildRunCaptureEnvelope({
      outcome: "launch_failed",
      agent: "codex",
    });
    expect(envelope).toEqual({
      schema_version: 1,
      agent: "codex",
      handle: null,
      transcript_path: null,
      resume_target: null,
      message: null,
      message_found: false,
      elapsed_seconds: null,
      outcome: "launch_failed",
    });
    expect(exitCode).toBe(1);
  });

  test("outcome → exit code mapping is the closed set", () => {
    expect(runCaptureExitCode("completed")).toBe(0);
    expect(runCaptureExitCode("no_message")).toBe(0);
    expect(runCaptureExitCode("timed_out")).toBe(4);
    expect(runCaptureExitCode("no_transcript")).toBe(4);
    expect(runCaptureExitCode("launch_failed")).toBe(1);
    expect(runCaptureExitCode("bad_args")).toBe(2);
  });
});

describe("parseRunArgs", () => {
  test("<cli> <prompt> parses, stop-timeout absent → null, read-only false", () => {
    expect(parseRunArgs(["claude", "say hi"])).toEqual({
      ok: true,
      cli: "claude",
      prompt: "say hi",
      stopTimeoutMs: null,
      readOnly: false,
    });
  });

  test("--stop-timeout-ms space + equals forms parse", () => {
    expect(
      parseRunArgs(["codex", "p", "--stop-timeout-ms", "1800000"]),
    ).toEqual({
      ok: true,
      cli: "codex",
      prompt: "p",
      stopTimeoutMs: 1_800_000,
      readOnly: false,
    });
    expect(parseRunArgs(["pi", "p", "--stop-timeout-ms=1500"])).toEqual({
      ok: true,
      cli: "pi",
      prompt: "p",
      stopTimeoutMs: 1500,
      readOnly: false,
    });
  });

  test("--read-only sets readOnly true (exact-match, any position)", () => {
    expect(parseRunArgs(["claude", "explore", "--read-only"])).toEqual({
      ok: true,
      cli: "claude",
      prompt: "explore",
      stopTimeoutMs: null,
      readOnly: true,
    });
    // Exact-match: it is accepted before a positional, not swallowed as one.
    expect(parseRunArgs(["codex", "--read-only", "explore"])).toEqual({
      ok: true,
      cli: "codex",
      prompt: "explore",
      stopTimeoutMs: null,
      readOnly: true,
    });
    // Composes with --stop-timeout-ms.
    expect(
      parseRunArgs(["pi", "p", "--read-only", "--stop-timeout-ms", "1500"]),
    ).toEqual({
      ok: true,
      cli: "pi",
      prompt: "p",
      stopTimeoutMs: 1500,
      readOnly: true,
    });
  });

  test("a --read-only lookalike is still an unknown flag (exact-match only)", () => {
    const res = parseRunArgs(["claude", "p", "--read-onlyx"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("unknown flag");
    }
  });

  test.each([
    [["banana", "p"], "<cli> must be"],
    [[], "<cli> must be"],
    [["claude"], "missing <prompt>"],
    [["claude", "p", "extra"], "unexpected extra argument"],
    [["claude", "p", "--bogus"], "unknown flag"],
    [["claude", "p", "--stop-timeout-ms", "abc"], "must be a positive integer"],
    [["claude", "p", "--stop-timeout-ms"], "requires a value"],
  ] as const)("rejects %p", (rest, needle) => {
    const res = parseRunArgs([...rest]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(needle);
    }
  });
});

describe("captureFromHandle — outcome matrix (injected seams)", () => {
  test("stop seen + message found → completed (exit 0)", async () => {
    const { envelope, exitCode } = await captureFromHandle(
      seams({
        wait: { ok: true, transcriptPath: "/t.jsonl", stop: STOP },
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "the answer",
          found: true,
        },
        now: 0,
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-1", agent: "claude", startMs: 0 },
    );
    expect(envelope).toMatchObject({
      outcome: "completed",
      message: "the answer",
      message_found: true,
      transcript_path: "/t.jsonl",
      resume_target: "sess-1",
      handle: "tmux-1",
      agent: "claude",
    });
    expect(exitCode).toBe(0);
  });

  test("stop seen + no message (tool-only final turn) → no_message (exit 0)", async () => {
    const { envelope, exitCode } = await captureFromHandle(
      seams({
        wait: {
          ok: true,
          transcriptPath: "/t.jsonl",
          stop: { ...STOP, message: null },
        },
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: null,
          found: false,
        },
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-2", agent: "claude", startMs: 0 },
    );
    expect(envelope).toMatchObject({
      outcome: "no_message",
      message: null,
      message_found: false,
    });
    expect(exitCode).toBe(0);
  });

  test("wait times out but transcript resolves → timed_out + partial (exit 4)", async () => {
    const { envelope, exitCode } = await captureFromHandle(
      seams({
        wait: {
          ok: false,
          error: "timed out waiting for transcript stop after 50ms (caller)",
        },
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "partial so far",
          found: true,
        },
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-3", agent: "claude", startMs: 0 },
    );
    expect(envelope).toMatchObject({
      outcome: "timed_out",
      message: "partial so far",
      message_found: true,
      transcript_path: "/t.jsonl",
    });
    expect(exitCode).toBe(4);
  });

  test("transcript never appears → no_transcript (exit 4)", async () => {
    const { envelope, exitCode } = await captureFromHandle(
      seams({
        wait: { ok: false, error: "timed out waiting for transcript path" },
        show: { ok: false, error: "timed out waiting for transcript path" },
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-4", agent: "claude", startMs: 0 },
    );
    expect(envelope).toMatchObject({
      outcome: "no_transcript",
      message: null,
      transcript_path: null,
    });
    expect(exitCode).toBe(4);
  });

  test("resume_target is null for a codex handle (no pinned session id)", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: {
          ok: true,
          transcriptPath: "/t.jsonl",
          stop: { ...STOP, agent: "codex" },
        },
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "done",
          found: true,
        },
      }),
      VERB_DEPS,
      {
        handle: { ...handle(null), agent: "codex" },
        handleId: "tmux-c",
        agent: "codex",
        startMs: 0,
      },
    );
    expect(envelope.resume_target).toBeNull();
    expect(envelope.outcome).toBe("completed");
  });

  test("elapsed_seconds is the now()-startMs delta, rounded to tenths", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: { ok: true, transcriptPath: "/t.jsonl", stop: STOP },
        show: { ok: true, transcriptPath: "/t.jsonl", text: "x", found: true },
        now: 3550,
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-5", agent: "claude", startMs: 1000 },
    );
    // (3550 - 1000) / 1000 = 2.55 → rounded to tenths = 2.6.
    expect(envelope.elapsed_seconds).toBe(2.6);
  });
});

describe("composeRunCapture — launch seam", () => {
  function clock(values: number[]): () => number {
    let i = 0;
    return () => values[i++] ?? (values.at(-1) as number);
  }

  test("launch failure → launch_failed (exit 1), agent carried, no capture", async () => {
    let captured = false;
    const { envelope, exitCode } = await composeRunCapture(
      {
        waitForStop: async () => {
          captured = true;
          return { ok: true, transcriptPath: "/t", stop: STOP };
        },
        showLastMessage: async () => ({
          ok: true,
          transcriptPath: "/t",
          text: "x",
          found: true,
        }),
        now: () => 0,
        launch: (): RunLaunchResult => ({ ok: false, error: "tmux exploded" }),
      },
      VERB_DEPS,
      "claude",
    );
    expect(envelope).toMatchObject({
      outcome: "launch_failed",
      agent: "claude",
      handle: null,
      elapsed_seconds: null,
    });
    expect(exitCode).toBe(1);
    expect(captured).toBe(false);
  });

  test("launch success → capture runs, handle + elapsed from the launch", async () => {
    const { envelope, exitCode } = await composeRunCapture(
      {
        waitForStop: async () => ({
          ok: true,
          transcriptPath: "/t.jsonl",
          stop: STOP,
        }),
        showLastMessage: async () => ({
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "the answer",
          found: true,
        }),
        now: clock([1000, 4000]),
        launch: (): RunLaunchResult => ({
          ok: true,
          handle: handle("sess-run"),
          runId: "tmux-run-1",
        }),
      },
      VERB_DEPS,
      "claude",
    );
    expect(envelope).toMatchObject({
      outcome: "completed",
      handle: "tmux-run-1",
      resume_target: "sess-run",
      message: "the answer",
      elapsed_seconds: 3,
    });
    expect(exitCode).toBe(0);
  });
});

describe("splitSubcommand classifies the new verbs", () => {
  test("run <cli> <prompt> → run-capture", () => {
    expect(splitSubcommand(["run", "claude", "say hi"])).toEqual({
      kind: "run-capture",
      rest: ["claude", "say hi"],
    });
  });

  test("wait <handle> → wait-capture", () => {
    expect(
      splitSubcommand(["wait", "tmux-1", "--stop-timeout-ms", "5000"]),
    ).toEqual({
      kind: "wait-capture",
      rest: ["tmux-1", "--stop-timeout-ms", "5000"],
    });
  });

  test("bare run / wait keep an empty rest (handler mints bad_args)", () => {
    expect(splitSubcommand(["run"])).toEqual({ kind: "run-capture", rest: [] });
    expect(splitSubcommand(["wait"])).toEqual({
      kind: "wait-capture",
      rest: [],
    });
  });
});

/** Parse the single JSON line the run-capture verbs emit on stdout. */
function parseEnvelope(out: string[]): Record<string, unknown> {
  const lines = out.join("").trim().split("\n");
  expect(lines.length).toBe(1);
  return JSON.parse(lines[0] as string) as Record<string, unknown>;
}

function writeClaudeTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  text: string,
): string {
  const dir = join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      },
    })}\n`,
  );
  return path;
}

function writeRunJson(
  stateDir: string,
  runId: string,
  data: Record<string, unknown>,
): void {
  const dir = join(stateDir, "tmux-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(data, null, 2)}\n`);
}

describe("main() — agent run (faked tmux launch + real transcript)", () => {
  test("composes launch→wait→show, emits ONE completed JSON line, exit 0", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const transcriptPath = writeClaudeTranscript(
      home,
      cwd,
      sessionId,
      "hello from the partner",
    );
    const h = makeHarness({
      argv: ["run", "claude", "say hi"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 1, stdout: "", stderr: "no session" };
        }
        // new-session and new-window both report the created target.
        return {
          exitCode: 0,
          stdout: "keeper agent\x01@1\x01%1\n",
          stderr: "",
        };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(parseEnvelope(h.out)).toEqual({
      schema_version: 1,
      agent: "claude",
      handle: `tmux-${sessionId}`,
      transcript_path: transcriptPath,
      resume_target: sessionId,
      message: "hello from the partner",
      message_found: true,
      elapsed_seconds: 0,
      outcome: "completed",
    });
    // No spawn fired in-process — the launch is the detached tmux pane only.
    expect(h.spawned.length).toBe(0);
  });

  test("an unknown <cli> exits bad_args (2) with the uniform envelope", async () => {
    const h = makeHarness({
      argv: ["run", "banana", "hi"],
      rawArgv: true,
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({
      schema_version: 1,
      outcome: "bad_args",
      agent: null,
      handle: null,
    });
    expect(h.err.join("")).toContain("<cli> must be");
  });
});

describe("main() — agent wait", () => {
  test("captures an existing handle into the same envelope (exit 0)", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const transcriptPath = writeClaudeTranscript(
      home,
      cwd,
      sessionId,
      "final answer here",
    );
    writeRunJson(stateDir, "tmux-w1", {
      agent: "claude",
      cwd,
      transcriptSessionId: sessionId,
      startedAtMs: 0,
    });
    const h = makeHarness({
      argv: ["wait", "tmux-w1"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(parseEnvelope(h.out)).toEqual({
      schema_version: 1,
      agent: "claude",
      handle: "tmux-w1",
      transcript_path: transcriptPath,
      resume_target: sessionId,
      message: "final answer here",
      message_found: true,
      elapsed_seconds: 0,
      outcome: "completed",
    });
  });

  test("an unresolvable handle exits bad_args (2)", async () => {
    const h = makeHarness({
      argv: ["wait", "tmux-nope"],
      rawArgv: true,
      launcherStateDir: tempDir(),
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({
      schema_version: 1,
      outcome: "bad_args",
    });
  });
});
