/**
 * Background-aware claude stop gating (`findClaudeStopGated` via
 * `waitForTranscriptStop`) plus the run-capture message-preference coupling.
 *
 * A claude session can end a turn while background agents it launched are still
 * working; the harness later injects their results and the session runs the
 * turns that carry the real answer. A first-stop-wins parser captures the
 * premature turn. These tests drive the SETTLED-STOP gate against real
 * multi-line claude transcript JSONL (the pair-subcommands fixture pattern —
 * on-disk lines, small poll/stop overrides): a stop is accepted only when no
 * launched background agent is still outstanding AND no governing turn_duration
 * reports a nonzero pendingBackgroundAgentCount. Everything fails open — a
 * transcript with none of the markers behaves byte-identically to the plain
 * first-stop parser, and codex/pi are untouched.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ResolvedHandle,
  ShowLastMessageResult,
  VerbDeps,
  WaitForStopResult,
} from "../src/agent/pair-subcommands";
import {
  captureFromHandle,
  type RunCaptureDeps,
} from "../src/agent/run-capture";
import {
  findLastMessage,
  type TranscriptStop,
  type TranscriptWatchOptions,
  waitForTranscriptStop,
} from "../src/agent/transcript-watch";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "agent-transcript-bg-"));
}

const CWD = "/work/proj";
const SESSION = "sess-bg-1";

// ---- transcript line builders (real claude JSONL shapes) --------------------

const TS = new Date().toISOString();

/** A text-bearing assistant stop (the shape a real answer turn carries). */
function asstStop(text: string, stopReason = "end_turn"): unknown {
  return {
    timestamp: TS,
    type: "assistant",
    message: {
      role: "assistant",
      stop_reason: stopReason,
      content: [{ type: "text", text }],
    },
  };
}

/** A tool-use assistant turn — NOT a stop (stop_reason tool_use is excluded). */
function asstToolUse(): unknown {
  return {
    timestamp: TS,
    type: "assistant",
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: {} }],
    },
  };
}

/** A background-agent LAUNCH: user tool_result with an object toolUseResult. */
function launch(agentId: string): unknown {
  return {
    timestamp: TS,
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: "ok" }],
    },
    toolUseResult: {
      isAsync: true,
      status: "async_launched",
      agentId,
      description: "background research",
    },
  };
}

/** A FAILED launch: a STRING toolUseResult (with an is_error tool_result). The
 *  string embeds "async_launched" so the pre-filter parses it, proving the
 *  object-vs-string guard — not the pre-filter — excludes it. */
function failedLaunch(): unknown {
  return {
    timestamp: TS,
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", is_error: true, content: "launch failed" },
      ],
    },
    toolUseResult: "Error: async_launched attempt failed for the agent",
  };
}

/** A queue-operation retire (mid-turn shape, any operation, top-level content). */
function queueRetire(taskId: string, status = "completed"): unknown {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: TS,
    sessionId: SESSION,
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<output-file>/t/${taskId}.output</output-file>\n<status>${status}</status>\n<summary>done</summary>`,
  };
}

/** An injected task-notification retire (user line, string message.content). */
function notifyRetire(taskId: string, status = "completed"): unknown {
  return {
    timestamp: TS,
    type: "user",
    message: {
      role: "user",
      content: `<task-id>${taskId}</task-id>\n<output-file>/t/${taskId}.output</output-file>\n<status>${status}</status>`,
    },
  };
}

/** A turn_duration line; a numeric count arg carries pendingBackgroundAgentCount,
 *  omitted leaves the field absent (fail-open, no count constraint). */
function turnDuration(count?: number): unknown {
  const line: Record<string, unknown> = {
    timestamp: TS,
    type: "system",
    subtype: "turn_duration",
    durationMs: 1000,
  };
  if (count !== undefined) {
    line.pendingBackgroundAgentCount = count;
  }
  return line;
}

function writeTranscript(home: string, lines: unknown[]): string {
  const dir = join(home, ".claude", "projects", CWD.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

function waitOpts(
  transcriptPath: string,
  stopTimeoutMs: number,
): TranscriptWatchOptions & { transcriptPath: string } {
  return {
    agent: "claude",
    cwd: CWD,
    env: {},
    homeDir: "/fake-home",
    startedAtMs: 0,
    sessionId: SESSION,
    transcriptPath,
    pollIntervalMs: 10,
    stopTimeoutMs,
  };
}

/** Resolve a stop or fail loudly (accept cases resolve on the first poll). */
async function expectStop(
  transcriptPath: string,
  stopTimeoutMs = 2000,
): Promise<TranscriptStop> {
  const outcome = await waitForTranscriptStop(
    waitOpts(transcriptPath, stopTimeoutMs),
  );
  if (!outcome.ok) {
    throw new Error("expected a settled stop, got timed-out");
  }
  return outcome.stop;
}

/** Assert the wait never accepts a stop within a short bounded budget. */
async function expectTimeout(transcriptPath: string): Promise<void> {
  const outcome = await waitForTranscriptStop(waitOpts(transcriptPath, 120));
  expect(outcome.ok).toBe(false);
}

// ---- the gate --------------------------------------------------------------

describe("findClaudeStopGated — background-agent quiescence", () => {
  test("(a) launch + premature end_turn (pending nonempty) is NOT accepted", async () => {
    const path = writeTranscript(tempHome(), [
      launch("A"),
      asstStop("The research is still running, but here is a partial"),
    ]);
    await expectTimeout(path);
    // The partial IS retrievable for the timed_out envelope — findLastMessage is
    // deliberately ungated (it reports the latest, in-flight or not).
    const last = findLastMessage("claude", path);
    expect(last.text).toBe(
      "The research is still running, but here is a partial",
    );
  });

  test("(b) retire via queue-operation only, then a later stop, is accepted", async () => {
    const path = writeTranscript(tempHome(), [
      launch("A"),
      queueRetire("A", "completed"),
      asstStop("the consolidated final answer"),
    ]);
    const stop = await expectStop(path);
    expect(stop.message).toBe("the consolidated final answer");
    expect(stop.reason).toBe("end_turn");
  });

  test("(c) retire via injected task-notification; the LATER turn's text is captured", async () => {
    const path = writeTranscript(tempHome(), [
      launch("A"),
      asstStop("premature: research still running"),
      turnDuration(1),
      notifyRetire("A", "failed"),
      asstStop("the real consolidated answer after retire"),
    ]);
    const stop = await expectStop(path);
    expect(stop.message).toBe("the real consolidated answer after retire");
  });

  test("(d) a FAILED launch (string toolUseResult) never enters the pending set", async () => {
    const path = writeTranscript(tempHome(), [
      failedLaunch(),
      asstStop("answer despite the failed launch"),
    ]);
    const stop = await expectStop(path);
    expect(stop.message).toBe("answer despite the failed launch");
  });

  test("(e) a task-id notification with no matching launch is a no-op", async () => {
    // Alone, descendant/bash notifications never gate.
    const clean = writeTranscript(tempHome(), [
      notifyRetire("descendant-x", "completed"),
      queueRetire("bash-y", "killed"),
      asstStop("plain answer"),
    ]);
    expect((await expectStop(clean)).message).toBe("plain answer");

    // And a non-member retire never clears a genuine outstanding launch.
    const stillPending = writeTranscript(tempHome(), [
      launch("A"),
      notifyRetire("B", "completed"),
      asstStop("premature while A still pending"),
    ]);
    await expectTimeout(stillPending);
  });

  test("(f) a nonzero pendingBackgroundAgentCount blocks; an absent field does not", async () => {
    // Count-only block: pending is EMPTY (no launch), so ONLY the count gates.
    const blocked = writeTranscript(tempHome(), [
      asstStop("premature answer"),
      turnDuration(3),
    ]);
    await expectTimeout(blocked);

    // A turn_duration lacking the field imposes no constraint (fail-open).
    const unconstrained = writeTranscript(tempHome(), [
      asstStop("clean answer"),
      turnDuration(),
    ]);
    expect((await expectStop(unconstrained)).message).toBe("clean answer");

    // A zero count is settled, not blocking.
    const zero = writeTranscript(tempHome(), [
      asstStop("zero-count answer"),
      turnDuration(0),
    ]);
    expect((await expectStop(zero)).message).toBe("zero-count answer");
  });

  test("(g) a background-free transcript is byte-identical to the first-stop parser", async () => {
    // A plain text-bearing end_turn: same stop shape + message as today.
    const plain = writeTranscript(tempHome(), [asstStop("just the answer")]);
    const stop = await expectStop(plain);
    expect(stop).toMatchObject({
      agent: "claude",
      eventType: "assistant",
      reason: "end_turn",
      message: "just the answer",
    });
    expect(findLastMessage("claude", plain).text).toBe("just the answer");

    // A tool-only turn then a structural turn_duration: the turn_duration is the
    // accepted structural stop (message null), exactly as the old parser found.
    const structural = writeTranscript(tempHome(), [
      asstToolUse(),
      turnDuration(),
    ]);
    const structStop = await expectStop(structural);
    expect(structStop.eventType).toBe("turn_duration");
    expect(structStop.message).toBeNull();
  });

  test("incident spine: premature stop → retire → real answer (red→green)", async () => {
    // The production incident, distilled: a background launch, a premature
    // end_turn ("still running"), the harness's nonzero count, the retire, then
    // the genuine consolidated answer. The OLD first-stop parser returns the
    // premature turn (its message would fail this assertion); the gate returns
    // the settled answer.
    const path = writeTranscript(tempHome(), [
      asstToolUse(),
      launch("af8d09b268feade72"),
      asstStop("The research is still running, but my recommendations…"),
      turnDuration(8),
      queueRetire("af8d09b268feade72", "failed"),
      notifyRetire("af8d09b268feade72", "failed"),
      asstStop("Research came back clean — every citation checks out."),
    ]);
    const stop = await expectStop(path);
    expect(stop.message).toBe(
      "Research came back clean — every citation checks out.",
    );
    expect(stop.message).not.toContain("still running");
  });
});

// ---- codex/pi regression: the gate is claude-only ---------------------------

describe("non-claude stop arms are unchanged", () => {
  test("codex first task_complete is accepted (no quiescence gate)", async () => {
    const home = tempHome();
    const now = new Date();
    const dir = join(
      home,
      ".codex",
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "rollout-test.jsonl");
    writeFileSync(
      path,
      `${[
        JSON.stringify({
          timestamp: TS,
          type: "session_meta",
          payload: { id: "codex-1", cwd: CWD },
        }),
        JSON.stringify({
          timestamp: TS,
          type: "event_msg",
          payload: { type: "task_complete", last_agent_message: "codex done" },
        }),
      ].join("\n")}\n`,
    );
    const outcome = await waitForTranscriptStop({
      agent: "codex",
      cwd: CWD,
      env: {},
      homeDir: home,
      startedAtMs: 0,
      sessionId: null,
      transcriptPath: path,
      pollIntervalMs: 10,
      stopTimeoutMs: 2000,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.stop.message).toBe("codex done");
    }
  });
});

// ---- capture coupling ------------------------------------------------------

const VERB_DEPS: VerbDeps = { env: {}, homeDir: "/fake-home" };

function handle(agent: ResolvedHandle["agent"] = "claude"): ResolvedHandle {
  return {
    agent,
    cwd: CWD,
    sessionId: agent === "claude" ? SESSION : null,
    startedAtMs: 0,
    transcriptPath: null,
    stopTimeoutMs: null,
  };
}

function seams(opts: {
  wait: WaitForStopResult;
  show: ShowLastMessageResult;
}): RunCaptureDeps {
  return {
    waitForStop: async () => opts.wait,
    showLastMessage: async () => opts.show,
    now: () => 0,
  };
}

describe("captureFromHandle — claude prefers the gated stop's text", () => {
  test("(h) claude blesses the gated stop over a later-resume re-scan", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: {
          ok: true,
          transcriptPath: "/t.jsonl",
          stop: {
            agent: "claude",
            eventType: "assistant",
            reason: "end_turn",
            timestamp: null,
            message: "the blessed consolidated answer",
          },
        },
        // A later human-resume turn displaced the whole-file last message.
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "a displacing later-turn scribble",
          found: true,
        },
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-h", agent: "claude", startMs: 0 },
    );
    expect(envelope.message).toBe("the blessed consolidated answer");
    expect(envelope.message_found).toBe(true);
    expect(envelope.outcome).toBe("completed");
  });

  test("(h) a structural claude stop (null text) falls back to the re-scan", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: {
          ok: true,
          transcriptPath: "/t.jsonl",
          stop: {
            agent: "claude",
            eventType: "turn_duration",
            reason: "turn_duration",
            timestamp: null,
            message: null,
          },
        },
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "re-scanned assistant text",
          found: true,
        },
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-h2", agent: "claude", startMs: 0 },
    );
    expect(envelope.message).toBe("re-scanned assistant text");
    expect(envelope.outcome).toBe("completed");
  });

  test("codex keeps the re-scan-first preference (regression)", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: {
          ok: true,
          transcriptPath: "/t.jsonl",
          stop: {
            agent: "codex",
            eventType: "task_complete",
            reason: "task_complete",
            timestamp: null,
            message: "the stop-event text",
          },
        },
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "the show-last-message text",
          found: true,
        },
      }),
      VERB_DEPS,
      {
        handle: handle("codex"),
        handleId: "tmux-h3",
        agent: "codex",
        startMs: 0,
      },
    );
    expect(envelope.message).toBe("the show-last-message text");
  });
});
