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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PresetCatalog } from "../src/agent/config";
import { splitSubcommand } from "../src/agent/dispatch";
import { main } from "../src/agent/main";
import type {
  ResolvedHandle,
  ShowLastMessageResult,
  VerbDeps,
  WaitForStopResult,
} from "../src/agent/pair-subcommands";
import type { ResumeDecision } from "../src/agent/resume-policy";
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
import {
  waitForTranscriptPath,
  waitForTranscriptStop,
} from "../src/agent/transcript-watch";
import { buildPanelLegArgv, type PanelMember } from "../src/pair/panel";
import {
  expectExit,
  flagValues,
  makeHarness,
} from "./helpers/agent-main-harness";

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
  resolveCodexResumeTarget?: (args: {
    transcriptPath: string;
  }) => string | null;
}): RunCaptureDeps {
  return {
    waitForStop: async () => opts.wait,
    showLastMessage: async () => opts.show,
    now: () => opts.now ?? 0,
    resolveCodexResumeTarget: opts.resolveCodexResumeTarget,
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
      "transcript_ambiguous",
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
    expect(runCaptureExitCode("transcript_ambiguous")).toBe(4);
    expect(runCaptureExitCode("launch_failed")).toBe(1);
    expect(runCaptureExitCode("bad_args")).toBe(2);
  });
});

/** An `ok:true` parseRunArgs result with the three additive flags defaulting to
 *  null — the byte-stability baseline every arm layers its overrides onto. */
function okParse(
  overrides: Partial<Extract<ReturnType<typeof parseRunArgs>, { ok: true }>>,
): Extract<ReturnType<typeof parseRunArgs>, { ok: true }> {
  return {
    ok: true,
    cli: "claude",
    prompt: "p",
    stopTimeoutMs: null,
    readOnly: false,
    systemFile: null,
    system: null,
    preset: null,
    model: null,
    effort: null,
    session: null,
    output: null,
    name: null,
    resume: null,
    ...overrides,
  };
}

describe("parseRunArgs", () => {
  test("<cli> <prompt> parses, stop-timeout absent → null, read-only false", () => {
    expect(parseRunArgs(["claude", "say hi"])).toEqual(
      okParse({ prompt: "say hi" }),
    );
  });

  test("--stop-timeout space + equals forms parse (unit-required duration)", () => {
    expect(parseRunArgs(["codex", "p", "--stop-timeout", "30m"])).toEqual(
      okParse({ cli: "codex", stopTimeoutMs: 1_800_000 }),
    );
    expect(parseRunArgs(["pi", "p", "--stop-timeout=1500ms"])).toEqual(
      okParse({ cli: "pi", stopTimeoutMs: 1500 }),
    );
  });

  test("the retired --stop-timeout-ms spelling hard-fails as an unknown flag", () => {
    const r = parseRunArgs(["codex", "p", "--stop-timeout-ms", "1800000"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown flag");
  });

  test("--read-only sets readOnly true (exact-match, any position)", () => {
    expect(parseRunArgs(["claude", "explore", "--read-only"])).toEqual(
      okParse({ prompt: "explore", readOnly: true }),
    );
    // Exact-match: it is accepted before a positional, not swallowed as one.
    expect(parseRunArgs(["codex", "--read-only", "explore"])).toEqual(
      okParse({ cli: "codex", prompt: "explore", readOnly: true }),
    );
    // Composes with --stop-timeout.
    expect(
      parseRunArgs(["pi", "p", "--read-only", "--stop-timeout", "1500ms"]),
    ).toEqual(okParse({ cli: "pi", readOnly: true, stopTimeoutMs: 1500 }));
  });

  test("--system-file / --system parse as value flags (split + = forms)", () => {
    expect(
      parseRunArgs(["claude", "p", "--system-file", "/tmp/sys.txt"]),
    ).toEqual(okParse({ systemFile: "/tmp/sys.txt" }));
    expect(parseRunArgs(["codex", "p", "--system-file=/tmp/sys.txt"])).toEqual(
      okParse({ cli: "codex", systemFile: "/tmp/sys.txt" }),
    );
    // Inline text, both spellings; composes with the other flags.
    expect(
      parseRunArgs(["pi", "p", "--system", "be terse", "--read-only"]),
    ).toEqual(okParse({ cli: "pi", readOnly: true, system: "be terse" }));
    expect(parseRunArgs(["claude", "p", "--system=be terse"])).toEqual(
      okParse({ system: "be terse" }),
    );
  });

  test("--preset / --session / --output parse as value flags (split + = forms)", () => {
    expect(
      parseRunArgs(["claude", "p", "--preset", "claude::opus::high"]),
    ).toEqual(okParse({ preset: "claude::opus::high" }));
    expect(parseRunArgs(["codex", "p", "--preset=codex::gpt::high"])).toEqual(
      okParse({ cli: "codex", preset: "codex::gpt::high" }),
    );
    expect(parseRunArgs(["claude", "p", "--session", "panels"])).toEqual(
      okParse({ session: "panels" }),
    );
    expect(parseRunArgs(["pi", "p", "--session=grp"])).toEqual(
      okParse({ cli: "pi", session: "grp" }),
    );
    expect(parseRunArgs(["claude", "p", "--output", "/tmp/leg.json"])).toEqual(
      okParse({ output: "/tmp/leg.json" }),
    );
    expect(parseRunArgs(["claude", "p", "--output=/tmp/o.yaml"])).toEqual(
      okParse({ output: "/tmp/o.yaml" }),
    );
    expect(
      parseRunArgs(["claude", "p", "--name", "panel::smoke::opus"]),
    ).toEqual(okParse({ name: "panel::smoke::opus" }));
    expect(parseRunArgs(["pi", "p", "--name=panel::smoke::pi"])).toEqual(
      okParse({ cli: "pi", name: "panel::smoke::pi" }),
    );
    // All three compose with each other and the existing posture flags.
    expect(
      parseRunArgs([
        "claude",
        "p",
        "--preset",
        "claude::opus::high",
        "--session",
        "panels",
        "--output",
        "/tmp/leg.json",
        "--read-only",
      ]),
    ).toEqual(
      okParse({
        preset: "claude::opus::high",
        session: "panels",
        output: "/tmp/leg.json",
        readOnly: true,
      }),
    );
  });

  test("--model / --effort parse as value flags (split + = forms)", () => {
    expect(parseRunArgs(["codex", "p", "--model", "gpt-5"])).toEqual(
      okParse({ cli: "codex", model: "gpt-5" }),
    );
    expect(parseRunArgs(["claude", "p", "--model=opus"])).toEqual(
      okParse({ model: "opus" }),
    );
    expect(parseRunArgs(["codex", "p", "--effort", "high"])).toEqual(
      okParse({ cli: "codex", effort: "high" }),
    );
    expect(parseRunArgs(["codex", "p", "--effort=low"])).toEqual(
      okParse({ cli: "codex", effort: "low" }),
    );
    // Compose with a preset (explicit override rides alongside the preset name).
    expect(
      parseRunArgs([
        "codex",
        "p",
        "--preset",
        "codex::gpt::high",
        "--model",
        "gpt-5",
      ]),
    ).toEqual(
      okParse({ cli: "codex", preset: "codex::gpt::high", model: "gpt-5" }),
    );
  });

  test("--resume parses as a value flag (split + = forms), distinct from --session", () => {
    expect(parseRunArgs(["claude", "p", "--resume", "reviewer"])).toEqual(
      okParse({ resume: "reviewer" }),
    );
    expect(parseRunArgs(["codex", "p", "--resume=abc-123"])).toEqual(
      okParse({ cli: "codex", resume: "abc-123" }),
    );
    // --session (tmux GROUPING) and --resume (continue a conversation) are
    // independent axes — both parse, neither swallows the other.
    expect(
      parseRunArgs(["claude", "p", "--session", "grp", "--resume", "rev"]),
    ).toEqual(okParse({ session: "grp", resume: "rev" }));
  });

  test("--system-file + --system together → bad_args (one input, two spellings)", () => {
    const res = parseRunArgs([
      "claude",
      "p",
      "--system-file",
      "/tmp/sys.txt",
      "--system",
      "inline",
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("cannot combine --system-file and --system");
    }
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
    [["claude", "p", "--stop-timeout", "abc"], "not a valid duration"],
    [["claude", "p", "--stop-timeout", "1500"], "needs a unit"],
    [["claude", "p", "--stop-timeout"], "requires a value"],
    [["claude", "p", "--stop-timeout-ms", "1500"], "unknown flag"],
    [["claude", "p", "--system-file"], "--system-file requires a value"],
    [["claude", "p", "--system"], "--system requires a value"],
    [["claude", "p", "--preset"], "--preset requires a value"],
    [["claude", "p", "--session"], "--session requires a value"],
    [["claude", "p", "--output"], "--output requires a value"],
    [["claude", "p", "--name"], "--name requires a value"],
    [["claude", "p", "--resume"], "--resume requires a value"],
  ] as const)("rejects %p", (rest, needle) => {
    const res = parseRunArgs([...rest]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain(needle);
    }
  });
});

describe("panel leg argv round-trips through the real run-capture parser", () => {
  // The drift guard: a builder-output-only test passes while `parseRunArgs`
  // rejects the flag — the exact bug that killed panels. This feeds each
  // harness's `buildPanelLegArgv` output through the SAME two surfaces the
  // launcher does (splitSubcommand → parseRunArgs) and fails if they diverge.
  const SLUG = "smoke-slug";
  const members: PanelMember[] = [
    { name: "opus", harness: "claude" },
    { name: "gpt5", harness: "codex", model: "gpt-5", effort: "high" },
    { name: "pi-fast", harness: "pi" },
  ];

  for (const member of members) {
    test(`${member.harness} leg parses ok with the panel name`, () => {
      const argv = buildPanelLegArgv({
        keeperBin: "/abs/bun",
        keeperAgentPath: "/abs/cli/keeper.ts",
        prompt: "weigh in",
        member,
        slug: SLUG,
        yamlPath: "/tmp/leg.json",
        stopTimeoutMs: 1_800_000,
      });
      // The top-level keeper dispatcher consumes `[<bun>, <keeper.ts>, "agent"]`
      // before `agent` main() ever calls splitSubcommand — mirror that boundary.
      expect(argv[2]).toBe("agent");
      const dispatch = splitSubcommand(argv.slice(3));
      expect(dispatch.kind).toBe("run-capture");
      if (dispatch.kind !== "run-capture") {
        throw new Error("expected run-capture dispatch");
      }
      const parsed = parseRunArgs(dispatch.rest);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        throw new Error(`parseRunArgs rejected the leg: ${parsed.error}`);
      }
      expect(parsed.cli).toBe(member.harness);
      expect(parsed.name).toBe(`panel::${SLUG}::${member.name}`);
    });
  }
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

  test("concurrent same-cwd collision → transcript_ambiguous (exit 4), never a foreign answer", async () => {
    const { envelope, exitCode } = await captureFromHandle(
      seams({
        wait: {
          ok: false,
          reason: "ambiguous",
          error: "transcript ambiguous: multiple concurrent same-cwd sessions",
        },
        show: {
          ok: false,
          reason: "ambiguous",
          error: "transcript ambiguous: multiple concurrent same-cwd sessions",
        },
      }),
      VERB_DEPS,
      {
        handle: { ...handle(null), agent: "codex" },
        handleId: "tmux-amb",
        agent: "codex",
        startMs: 0,
      },
    );
    expect(envelope).toMatchObject({
      outcome: "transcript_ambiguous",
      message: null,
      transcript_path: null,
      resume_target: null,
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

  test("codex resume_target is discovered from the transcript via the seam (completed)", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: {
          ok: true,
          transcriptPath: "/rollout.jsonl",
          stop: { ...STOP, agent: "codex" },
        },
        show: {
          ok: true,
          transcriptPath: "/rollout.jsonl",
          text: "done",
          found: true,
        },
        resolveCodexResumeTarget: ({ transcriptPath }) => {
          expect(transcriptPath).toBe("/rollout.jsonl");
          return "codex-uuid-1";
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
    expect(envelope.outcome).toBe("completed");
    expect(envelope.resume_target).toBe("codex-uuid-1");
  });

  test("codex resume_target is discovered on a timed_out partial", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: { ok: false, error: "timed out waiting for transcript stop" },
        show: {
          ok: true,
          transcriptPath: "/rollout.jsonl",
          text: "partial",
          found: true,
        },
        resolveCodexResumeTarget: () => "codex-uuid-2",
      }),
      VERB_DEPS,
      {
        handle: { ...handle(null), agent: "codex" },
        handleId: "tmux-c",
        agent: "codex",
        startMs: 0,
      },
    );
    expect(envelope.outcome).toBe("timed_out");
    expect(envelope.resume_target).toBe("codex-uuid-2");
  });

  test("codex no_transcript stays null — the seam is never consulted", async () => {
    let called = false;
    const { envelope } = await captureFromHandle(
      seams({
        wait: { ok: false, error: "timed out waiting for transcript path" },
        show: { ok: false, error: "timed out waiting for transcript path" },
        resolveCodexResumeTarget: () => {
          called = true;
          return "should-not-happen";
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
    expect(envelope.outcome).toBe("no_transcript");
    expect(envelope.resume_target).toBeNull();
    expect(called).toBe(false);
  });

  test("claude keeps handle.sessionId even when the codex seam is bound", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: { ok: true, transcriptPath: "/t.jsonl", stop: STOP },
        show: { ok: true, transcriptPath: "/t.jsonl", text: "x", found: true },
        resolveCodexResumeTarget: () => "codex-uuid-should-be-ignored",
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-6", agent: "claude", startMs: 0 },
    );
    expect(envelope.resume_target).toBe("sess-1");
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
    expect(splitSubcommand(["wait", "tmux-1", "--stop-timeout", "5s"])).toEqual(
      {
        kind: "wait-capture",
        rest: ["tmux-1", "--stop-timeout", "5s"],
      },
    );
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

  /** A harness whose faked tmux + on-disk claude transcript let a `claude` run
   *  compose to `completed`. Extra `agent run` flags go before the positionals. */
  function completedRunHarness(
    flags: string[],
    presetCatalog?: PresetCatalog,
  ): { h: ReturnType<typeof makeHarness>; transcriptPath: string } {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const transcriptPath = writeClaudeTranscript(home, cwd, sessionId, "done");
    const h = makeHarness({
      argv: ["run", ...flags, "claude", "say hi"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      presetCatalog,
      tmuxCommand: (cmd) =>
        cmd.includes("has-session")
          ? { exitCode: 1, stdout: "", stderr: "no session" }
          : { exitCode: 0, stdout: "keeper agent\x01@1\x01%1\n", stderr: "" },
    });
    return { h, transcriptPath };
  }

  test("--name threads end-to-end to the tmux window name (-n)", async () => {
    const { h } = completedRunHarness(["--name", "panel::smoke::opus"]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    // The window-name knob (`-n`) carries the name on the tmux launch as a
    // discrete flag token — uniform across harnesses, and the one seam observable
    // here (the harness-native `--name` rides in the launch script, byte-pinned by
    // the launch-config goldens). This proves posture.name → options.windowName.
    const windowNames = h.tmuxCommands.flatMap((cmd) => flagValues(cmd, "-n"));
    expect(windowNames).toContain("panel::smoke::opus");
  });

  test("--preset triple with a matching harness validates and composes to completed", async () => {
    const { h } = completedRunHarness(["--preset", "claude::opus::high"]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "completed" });
    // A launch actually fired — the triple validation passed, not short-circuited.
    expect(h.tmuxCommands.length).toBeGreaterThan(0);
  });

  test("--preset triple whose harness disagrees with <cli> is bad_args, no launch", async () => {
    const { h } = completedRunHarness(["--preset", "codex::gpt::high"]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    expect(h.err.join("")).toContain("pins harness codex");
    // Validation short-circuits BEFORE any tmux launch.
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("a malformed --preset triple is bad_args (exit 2)", async () => {
    const { h } = completedRunHarness(["--preset", "nope"]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("--output writes the SAME completed envelope atomically (no .tmp left)", async () => {
    const outDir = tempDir();
    const outPath = join(outDir, "leg.json");
    const { h } = completedRunHarness(["--output", outPath]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    const stdoutEnvelope = parseEnvelope(h.out);
    expect(stdoutEnvelope).toMatchObject({ outcome: "completed" });
    // The file carries the EXACT same envelope the stdout sink emitted.
    expect(existsSync(outPath)).toBe(true);
    const fileEnvelope = JSON.parse(readFileSync(outPath, "utf8"));
    expect(fileEnvelope).toEqual(stdoutEnvelope);
    // The atomic temp file was renamed away — only the final path remains.
    expect(readdirSync(outDir)).toEqual(["leg.json"]);
  });

  test("--output writes the result file on a FAIL outcome (bad_args) too", async () => {
    const outDir = tempDir();
    const outPath = join(outDir, "leg.json");
    // A mismatched --preset triple is a deterministic fail outcome that still knows
    // the --output path (write-on-EVERY-outcome, exit-code-independent).
    const { h } = completedRunHarness([
      "--preset",
      "codex::gpt::high",
      "--output",
      outPath,
    ]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(existsSync(outPath)).toBe(true);
    const fileEnvelope = JSON.parse(readFileSync(outPath, "utf8")) as {
      outcome: string;
    };
    expect(fileEnvelope.outcome).toBe("bad_args");
  });

  test("--output onto a missing parent dir is the path's own bad_args (exit 2)", async () => {
    const outPath = join(tempDir(), "no-such-subdir", "leg.json");
    const { h } = completedRunHarness(["--output", outPath]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(existsSync(outPath)).toBe(false);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    expect(h.err.join("")).toContain("cannot write --output");
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

/** One codex rollout `task_complete` stop line, timestamped for the watermark. */
function codexTaskComplete(message: string, timestamp: string): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp,
    payload: { type: "task_complete", last_agent_message: message },
  });
}

/**
 * Write a codex rollout under `<codexHome>/sessions/YYYY/MM/DD/rollout-…-<uuid>.jsonl`
 * with a session_meta head (created FAR in the past by default, so the fresh-launch
 * created-at floor rejects it) followed by the given stop lines. Returns the path.
 */
function writeCodexRollout(
  codexHome: string,
  uuid: string,
  eventLines: string[],
  opts: { metaCreatedAt?: string; cwd?: string } = {},
): string {
  const dir = join(codexHome, "sessions", "2026", "07", "10");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-10T12-00-00-${uuid}.jsonl`);
  const meta = JSON.stringify({
    type: "session_meta",
    timestamp: opts.metaCreatedAt ?? "2000-01-01T00:00:00.000Z",
    payload: {
      id: uuid,
      cwd: opts.cwd ?? "/work/proj",
      originator: "codex-tui",
    },
  });
  writeFileSync(path, `${[meta, ...eventLines].join("\n")}\n`);
  return path;
}

describe("resume codex transcript discovery + watermark (fixtures)", () => {
  const CWD = "/work/proj";

  test("isResume resolves a pre-existing rollout by uuid, bypassing the created-at floor", async () => {
    const home = tempDir();
    const codexHome = join(home, ".codex");
    const uuid = "11111111-1111-1111-1111-111111111111";
    const rollout = writeCodexRollout(codexHome, uuid, [
      codexTaskComplete("prior answer", "2026-07-10T11:00:00.000Z"),
    ]);

    const resolved = await waitForTranscriptPath({
      agent: "codex",
      cwd: CWD,
      env: { CODEX_HOME: codexHome },
      homeDir: home,
      startedAtMs: Date.now(),
      sessionId: uuid,
      isResume: true,
      pathTimeoutMs: 200,
    });

    expect(resolved).toEqual({ ok: true, path: rollout });
  });

  test("the FRESH codex path rejects the same rollout (created-at floor) — the resume branch is additive", async () => {
    const home = tempDir();
    const codexHome = join(home, ".codex");
    const uuid = "22222222-2222-2222-2222-222222222222";
    writeCodexRollout(codexHome, uuid, [
      codexTaskComplete("prior answer", "2026-07-10T11:00:00.000Z"),
    ]);

    // Same file, same uuid, but a FRESH launch (isResume false): the rollout's
    // session-start predates the launch, so the created-at floor refuses to
    // attribute it — a retryable path timeout, never a wrong-file guess.
    const resolved = await waitForTranscriptPath({
      agent: "codex",
      cwd: CWD,
      env: { CODEX_HOME: codexHome },
      homeDir: home,
      startedAtMs: Date.now(),
      sessionId: uuid,
      isResume: false,
      pathTimeoutMs: 200,
    });

    expect(resolved.ok).toBe(false);
  });

  test("the stop-scan anchors PAST the pre-resume stop (watermark returns the new answer)", async () => {
    const home = tempDir();
    const codexHome = join(home, ".codex");
    const uuid = "33333333-3333-3333-3333-333333333333";
    const path = writeCodexRollout(codexHome, uuid, [
      codexTaskComplete("PRE-RESUME ANSWER", "2026-07-10T11:59:00.000Z"),
      codexTaskComplete("POST-RESUME ANSWER", "2026-07-10T12:00:10.000Z"),
    ]);

    const stop = await waitForTranscriptStop({
      agent: "codex",
      cwd: CWD,
      env: { CODEX_HOME: codexHome },
      homeDir: home,
      startedAtMs: Date.parse("2026-07-10T12:00:00.000Z"),
      sessionId: uuid,
      isResume: true,
      transcriptPath: path,
      stopTimeoutMs: 1000,
    });

    expect(stop.ok).toBe(true);
    if (stop.ok) {
      expect(stop.stop.message).toBe("POST-RESUME ANSWER");
    }
  });

  test("the watermark is load-bearing: with startedAtMs=0 the SAME scan returns the pre-resume stop", async () => {
    const home = tempDir();
    const codexHome = join(home, ".codex");
    const uuid = "44444444-4444-4444-4444-444444444444";
    const path = writeCodexRollout(codexHome, uuid, [
      codexTaskComplete("PRE-RESUME ANSWER", "2026-07-10T11:59:00.000Z"),
      codexTaskComplete("POST-RESUME ANSWER", "2026-07-10T12:00:10.000Z"),
    ]);

    // No watermark (startedAtMs=0): the first stop in the file — the OLD one — is
    // captured. This is exactly the bug the resume watermark prevents.
    const stop = await waitForTranscriptStop({
      agent: "codex",
      cwd: CWD,
      env: { CODEX_HOME: codexHome },
      homeDir: home,
      startedAtMs: 0,
      sessionId: uuid,
      isResume: true,
      transcriptPath: path,
      stopTimeoutMs: 1000,
    });

    expect(stop.ok).toBe(true);
    if (stop.ok) {
      expect(stop.stop.message).toBe("PRE-RESUME ANSWER");
    }
  });
});

/** A faked-tmux command runner that reports a created session/window. */
function fakeTmux(cmd: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  return cmd.includes("has-session")
    ? { exitCode: 1, stdout: "", stderr: "no session" }
    : { exitCode: 0, stdout: "keeper agent\x01@1\x01%1\n", stderr: "" };
}

/** A ResumeDecision `ok` fixture with the two fields under test filled in. */
function okDecision(
  over: Partial<Extract<ResumeDecision, { kind: "ok" }>>,
): ResumeDecision {
  return {
    kind: "ok",
    job_id: "job-1",
    harness: "claude",
    resume_target: "parent",
    cwd: "/work/proj",
    title: "reviewer",
    ...over,
  };
}

describe("main() — agent run --resume", () => {
  test("claude resume: composes a resume launch, captures the CHILD transcript, resume_target = the new child id", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    // The recorded resume cwd differs from the caller cwd — resume is cwd-scoped.
    const resumeCwd = mkdtempSync(join(tmpdir(), "resume-cwd-"));
    const parentUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const childUuid = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const transcriptPath = writeClaudeTranscript(
      home,
      resumeCwd,
      childUuid,
      "resumed answer",
    );

    let seenTarget: string | undefined;
    let seenHarness: string | undefined;
    const h = makeHarness({
      argv: ["run", "claude", "follow up", "--resume", "reviewer"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd: "/caller/elsewhere",
      randomUuid: () => childUuid,
      resolveResumeDecision: (target, requireHarness) => {
        seenTarget = target;
        seenHarness = requireHarness;
        return okDecision({
          harness: "claude",
          resume_target: parentUuid,
          cwd: resumeCwd,
        });
      },
      tmuxCommand: fakeTmux,
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    // The <cli> positional is passed as the required harness so a same-name match
    // on another CLI would mismatch rather than launch the wrong harness.
    expect(seenTarget).toBe("reviewer");
    expect(seenHarness).toBe("claude");
    expect(parseEnvelope(h.out)).toMatchObject({
      outcome: "completed",
      agent: "claude",
      // The POST-resume id — the freshly-forked child, distinct from the parent,
      // so feeding it back continues the newer lineage.
      resume_target: childUuid,
      message: "resumed answer",
      transcript_path: transcriptPath,
    });
    // A launch actually fired in the RECORDED cwd (not the caller cwd).
    expect(h.tmuxCommands.length).toBeGreaterThan(0);
  });

  test("codex resume: discovers the rollout by uuid, resume_target = the unchanged rollout uuid", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const codexHome = join(home, ".codex");
    const resumeCwd = mkdtempSync(join(tmpdir(), "resume-cwd-"));
    const uuid = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    writeCodexRollout(
      codexHome,
      uuid,
      [
        codexTaskComplete("PRE answer", "2026-07-10T11:00:00.000Z"),
        codexTaskComplete("NEW answer", "2026-07-10T12:00:10.000Z"),
      ],
      { cwd: resumeCwd },
    );
    const startedAtMs = Date.parse("2026-07-10T12:00:00.000Z");

    const h = makeHarness({
      argv: ["run", "codex", "again", "--resume", uuid],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      env: { CODEX_HOME: codexHome },
      cwd: "/caller/elsewhere",
      now: () => startedAtMs,
      resolveResumeDecision: () =>
        okDecision({
          harness: "codex",
          resume_target: uuid,
          cwd: resumeCwd,
          title: null,
        }),
      tmuxCommand: fakeTmux,
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(parseEnvelope(h.out)).toMatchObject({
      outcome: "completed",
      agent: "codex",
      resume_target: uuid,
      message: "NEW answer",
    });
  });

  test("harness mismatch → bad_args naming both harnesses, no launch", async () => {
    const h = makeHarness({
      argv: ["run", "codex", "hi", "--resume", "reviewer"],
      rawArgv: true,
      resolveResumeDecision: () => ({
        kind: "harness-mismatch",
        job_id: "job-1",
        harness: "claude",
        require_harness: "codex",
        title: "reviewer",
      }),
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    const err = h.err.join("");
    expect(err).toContain("did not resolve to a codex");
    expect(err).toContain("claude");
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("unknown target → bad_args, no launch", async () => {
    const h = makeHarness({
      argv: ["run", "claude", "hi", "--resume", "ghost"],
      rawArgv: true,
      resolveResumeDecision: () => ({ kind: "unknown", target: "ghost" }),
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    expect(h.err.join("")).toContain(
      "no partner session found matching 'ghost'",
    );
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("live target → bad_args pointing at keeper bus chat send, no launch", async () => {
    const h = makeHarness({
      argv: ["run", "claude", "hi", "--resume", "reviewer"],
      rawArgv: true,
      resolveResumeDecision: () => ({
        kind: "live",
        job_id: "job-9",
        harness: "claude",
        title: "reviewer",
      }),
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    const err = h.err.join("");
    expect(err).toContain("LIVE");
    expect(err).toContain("keeper bus chat send job-9");
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("config flags alongside --resume → bad_args BEFORE the resolver is consulted, envelope written to --output", async () => {
    const outDir = tempDir();
    const outPath = join(outDir, "leg.json");
    let consulted = false;
    const h = makeHarness({
      argv: [
        "run",
        "claude",
        "hi",
        "--resume",
        "reviewer",
        "--model",
        "opus",
        "--output",
        outPath,
      ],
      rawArgv: true,
      resolveResumeDecision: () => {
        consulted = true;
        return { kind: "unknown", target: "reviewer" };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    expect(h.err.join("")).toContain("cannot be combined with --resume");
    expect(consulted).toBe(false);
    // The result-file sink still gets the bad_args envelope (write-on-every-outcome).
    expect(existsSync(outPath)).toBe(true);
    const fileEnvelope = JSON.parse(readFileSync(outPath, "utf8")) as {
      outcome: string;
    };
    expect(fileEnvelope.outcome).toBe("bad_args");
    expect(h.tmuxCommands.length).toBe(0);
  });
});
