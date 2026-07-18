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

import { describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
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
import { launchToResolvedHandle } from "../src/agent/launch-handle";
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
  buildRunControlArtifact,
  cancelOwnedRunFromControlArtifact,
  cancelRunFromControlArtifact,
  captureFromHandle,
  captureLivePartnerResponse,
  composeRunCapture,
  createExactRunTeardown,
  isRunControlArtifact,
  parseRunArgs,
  RUN_CAPTURE_SCHEMA_VERSION,
  type RunCaptureDeps,
  type RunControlArtifact,
  type RunControlOwner,
  type RunLaunchResult,
  runCaptureExitCode,
} from "../src/agent/run-capture";
import * as tmuxLaunch from "../src/agent/tmux-launch";
import { findLastMessage } from "../src/agent/transcript-watch";
import { BusSendAttemptError } from "../src/bus-artifact";
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
      "transcript_ambiguous",
      "partner_died",
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
      agent: "pi",
    });
    expect(envelope).toEqual({
      schema_version: 1,
      agent: "pi",
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
    expect(runCaptureExitCode("partner_died")).toBe(4);
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
    reapWindowOnTerminal: false,
    systemFile: null,
    system: null,
    preset: null,
    model: null,
    effort: null,
    session: null,
    output: null,
    name: null,
    resume: null,
    control: null,
    ...overrides,
  };
}

describe("parseRunArgs", () => {
  test("<cli> <prompt> parses, stop-timeout absent → null, read-only false", () => {
    expect(parseRunArgs(["claude", "say hi"])).toEqual(
      okParse({ prompt: "say hi" }),
    );
  });

  test("--reap-window-on-terminal parses to the one-shot posture", () => {
    expect(parseRunArgs(["claude", "p", "--reap-window-on-terminal"])).toEqual(
      okParse({ reapWindowOnTerminal: true }),
    );
  });

  test("grammar accepts exactly Claude and Pi harnesses", () => {
    expect(parseRunArgs(["pi", "say hi"])).toEqual(
      okParse({ cli: "pi", prompt: "say hi" }),
    );
    for (const retired of ["codex", "hermes"]) {
      const result = parseRunArgs([retired, "say hi"]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("<cli> must be claude|pi");
    }
  });

  test("--stop-timeout space + equals forms parse (unit-required duration)", () => {
    expect(parseRunArgs(["claude", "p", "--stop-timeout", "30m"])).toEqual(
      okParse({ stopTimeoutMs: 1_800_000 }),
    );
    expect(parseRunArgs(["pi", "p", "--stop-timeout=1500ms"])).toEqual(
      okParse({ cli: "pi", stopTimeoutMs: 1500 }),
    );
  });

  test("the retired --stop-timeout-ms spelling hard-fails as an unknown flag", () => {
    const r = parseRunArgs(["pi", "p", "--stop-timeout-ms", "1800000"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown flag");
  });

  test("--read-only sets readOnly true (exact-match, any position)", () => {
    expect(parseRunArgs(["claude", "explore", "--read-only"])).toEqual(
      okParse({ prompt: "explore", readOnly: true }),
    );
    // Exact-match: it is accepted before a positional, not swallowed as one.
    expect(parseRunArgs(["pi", "--read-only", "explore"])).toEqual(
      okParse({ cli: "pi", prompt: "explore", readOnly: true }),
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
    expect(parseRunArgs(["pi", "p", "--system-file=/tmp/sys.txt"])).toEqual(
      okParse({ cli: "pi", systemFile: "/tmp/sys.txt" }),
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
    expect(
      parseRunArgs(["pi", "p", "--preset=pi::openai-codex/gpt-5::high"]),
    ).toEqual(okParse({ cli: "pi", preset: "pi::openai-codex/gpt-5::high" }));
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
    expect(parseRunArgs(["pi", "p", "--model", "openai-codex/gpt-5"])).toEqual(
      okParse({ cli: "pi", model: "openai-codex/gpt-5" }),
    );
    expect(parseRunArgs(["claude", "p", "--model=opus"])).toEqual(
      okParse({ model: "opus" }),
    );
    expect(parseRunArgs(["pi", "p", "--effort", "high"])).toEqual(
      okParse({ cli: "pi", effort: "high" }),
    );
    expect(parseRunArgs(["pi", "p", "--effort=low"])).toEqual(
      okParse({ cli: "pi", effort: "low" }),
    );
    // Compose with a preset (explicit override rides alongside the preset name).
    expect(
      parseRunArgs([
        "pi",
        "p",
        "--preset",
        "pi::openai-codex/gpt-5::high",
        "--model",
        "openai-codex/gpt-5",
      ]),
    ).toEqual(
      okParse({
        cli: "pi",
        preset: "pi::openai-codex/gpt-5::high",
        model: "openai-codex/gpt-5",
      }),
    );
  });

  test("caller-owned control parses only with its exact owner tuple", () => {
    const owner = { request_id: "req-1", member: "claude#1", attempt: 2 };
    expect(
      parseRunArgs([
        "claude",
        "p",
        "--control",
        "/panel/claude.control.json",
        "--control-owner",
        JSON.stringify(owner),
      ]),
    ).toEqual(
      okParse({
        control: { path: "/panel/claude.control.json", owner },
      }),
    );
    const missingOwner = parseRunArgs([
      "claude",
      "p",
      "--control",
      "/panel/control.json",
    ]);
    expect(missingOwner.ok).toBe(false);
    const malformedOwner = parseRunArgs([
      "claude",
      "p",
      "--control",
      "/panel/control.json",
      "--control-owner",
      "{}",
    ]);
    expect(malformedOwner.ok).toBe(false);
  });

  test("--resume parses as a value flag (split + = forms), distinct from --session", () => {
    expect(parseRunArgs(["claude", "p", "--resume", "reviewer"])).toEqual(
      okParse({ resume: "reviewer" }),
    );
    expect(parseRunArgs(["pi", "p", "--resume=abc-123"])).toEqual(
      okParse({ cli: "pi", resume: "abc-123" }),
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
    [["claude", "p", "--control"], "--control requires a value"],
    [["claude", "p", "--control-owner"], "--control-owner requires a value"],
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
    {
      name: "gpt5",
      harness: "pi",
      model: "openai-codex/gpt-5",
      effort: "high",
    },
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

  test("stop seen + found-but-empty message → no_message, never completed", async () => {
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
          found: true,
        },
      }),
      VERB_DEPS,
      {
        handle: { ...handle(), agent: "pi" },
        handleId: "tmux-2",
        agent: "pi",
        startMs: 0,
      },
    );
    expect(envelope).toMatchObject({
      outcome: "no_message",
      message: null,
      message_found: true,
    });
    expect(exitCode).toBe(0);
  });

  test("wait times out but transcript resolves → timed_out + partial (exit 4)", async () => {
    const { envelope, exitCode } = await captureFromHandle(
      seams({
        wait: {
          ok: false,
          error: "timed out waiting for transcript stop after 50ms (caller)",
          transcriptPath: "/t.jsonl",
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

  test("timed_out surfaces 'live' liveness from the wait re-probe (envelope stays nine-key)", async () => {
    const result = await captureFromHandle(
      seams({
        wait: {
          ok: false,
          reason: "timeout",
          error: "timed out waiting for transcript stop after 50ms (caller)",
          transcriptPath: "/t.jsonl",
          liveness: "live",
        },
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "partial so far",
          found: true,
        },
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-live", agent: "claude", startMs: 0 },
    );
    expect(result.envelope.outcome).toBe("timed_out");
    expect(result.timeoutLiveness).toBe("live");
    // The liveness rides BESIDE the envelope — the wire contract is still 9 keys.
    expect(Object.keys(result.envelope).sort()).toEqual([...ENVELOPE_KEYS]);
    expect(result.envelope.message).toBe("partial so far");
  });

  test("timed_out with no wait liveness defaults timeoutLiveness to 'unknown'", async () => {
    const result = await captureFromHandle(
      seams({
        wait: {
          ok: false,
          error: "timed out waiting for transcript stop after 50ms (caller)",
          transcriptPath: "/t.jsonl",
        },
        show: {
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "partial so far",
          found: true,
        },
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-unk", agent: "claude", startMs: 0 },
    );
    expect(result.envelope.outcome).toBe("timed_out");
    expect(result.timeoutLiveness).toBe("unknown");
  });

  test("a non-timeout outcome carries no timeoutLiveness hint", async () => {
    const result = await captureFromHandle(
      seams({
        wait: { ok: true, transcriptPath: "/t.jsonl", stop: STOP },
        show: { ok: true, transcriptPath: "/t.jsonl", text: "x", found: true },
      }),
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-done", agent: "claude", startMs: 0 },
    );
    expect(result.envelope.outcome).toBe("completed");
    expect(result.timeoutLiveness).toBeUndefined();
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
        handle: { ...handle(null), agent: "pi" },
        handleId: "tmux-amb",
        agent: "pi",
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

  test("proven terminal lifecycle → partner_died with no stale message scan", async () => {
    let showCalls = 0;
    const { envelope, exitCode } = await captureFromHandle(
      {
        waitForStop: async () => ({
          ok: false,
          reason: "partner_died",
          error: "partner died",
          transcriptPath: "/t.jsonl",
          terminal: { kind: "terminal", state: "killed", reason: null },
        }),
        showLastMessage: async () => {
          showCalls++;
          return {
            ok: true,
            transcriptPath: "/t.jsonl",
            text: "STALE PRIOR TURN",
            found: true,
          };
        },
        now: () => 500,
      },
      VERB_DEPS,
      { handle: handle(), handleId: "tmux-dead", agent: "claude", startMs: 0 },
    );
    expect(Object.keys(envelope).sort()).toEqual([...ENVELOPE_KEYS]);
    expect(envelope).toMatchObject({
      outcome: "partner_died",
      handle: "tmux-dead",
      transcript_path: "/t.jsonl",
      message: null,
      message_found: false,
    });
    expect(exitCode).toBe(4);
    expect(showCalls).toBe(0);
  });

  test("resume_target is null for a Pi handle with no pinned session id", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: {
          ok: true,
          transcriptPath: "/t.jsonl",
          stop: { ...STOP, agent: "pi" },
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
        handle: { ...handle(null), agent: "pi" },
        handleId: "tmux-pi",
        agent: "pi",
        startMs: 0,
      },
    );
    expect(envelope.resume_target).toBeNull();
    expect(envelope.outcome).toBe("completed");
  });

  test("Claude keeps handle.sessionId as its resume target", async () => {
    const { envelope } = await captureFromHandle(
      seams({
        wait: { ok: true, transcriptPath: "/t.jsonl", stop: STOP },
        show: { ok: true, transcriptPath: "/t.jsonl", text: "x", found: true },
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

describe("captureLivePartnerResponse — delivery and cleanup", () => {
  const liveArgs = {
    handle: {
      ...handle("live-session"),
      lifecycleJobId: "job-live",
    },
    handleId: "job-live",
    agent: "claude" as const,
    startMs: 0,
  };
  const artifact = {
    path: "/bus-artifacts/00000000000000000000000000000001",
    ref: { id: "00000000000000000000000000000001" },
  };

  function liveDeps(overrides: Record<string, unknown> = {}) {
    let releases = 0;
    let removes = 0;
    let waits = 0;
    let sends = 0;
    const deps = {
      waitForStop: async (resolved: ResolvedHandle) => {
        waits++;
        expect(resolved.injectedMessageMarker).toBe(artifact.path);
        expect(resolved.transcriptLineFloor).toBe(4);
        return { ok: true as const, transcriptPath: "/t.jsonl", stop: STOP };
      },
      showLastMessage: async () => ({
        ok: true as const,
        transcriptPath: "/t.jsonl",
        text: "the answer",
        found: true,
      }),
      now: () => 0,
      acquire: () => ({ release: () => releases++ }),
      publish: () => artifact,
      remove: () => {
        removes++;
      },
      snapshotBoundary: () => ({ transcriptPath: "/t.jsonl", lineFloor: 4 }),
      send: async (_artifact: unknown, beforePublish: () => boolean) => {
        sends++;
        if (!beforePublish()) throw new Error("identity changed");
        return { result: "delivered", recipients: 1 };
      },
      identityStillLive: () => true,
      deliveryIsAmbiguous: (err: unknown) =>
        err instanceof BusSendAttemptError && err.deliveryAmbiguous,
      ...overrides,
    } as Parameters<typeof captureLivePartnerResponse>[0];
    return {
      deps,
      counts: () => ({ releases, removes, waits, sends }),
    };
  }

  test("an ambiguous transport is never resent and may still capture the causal answer", async () => {
    let attempts = 0;
    const h = liveDeps({
      send: async () => {
        attempts++;
        throw new BusSendAttemptError("ack lost", true);
      },
    });
    const outcome = await captureLivePartnerResponse(
      h.deps,
      VERB_DEPS,
      liveArgs,
    );
    expect(outcome.disposition).toBe("delivery_ambiguous");
    expect(outcome.result.envelope.outcome).toBe("completed");
    expect(attempts).toBe(1);
    expect(h.counts()).toEqual({ releases: 1, removes: 0, waits: 1, sends: 0 });
  });

  test("definite non-delivery removes the artifact and never starts a transcript wait", async () => {
    const h = liveDeps({
      send: async () => ({ result: "not_connected", recipients: 0 }),
    });
    const outcome = await captureLivePartnerResponse(
      h.deps,
      VERB_DEPS,
      liveArgs,
    );
    expect(outcome.disposition).toBe("delivery_failed");
    expect(outcome.result.envelope.outcome).toBe("launch_failed");
    expect(h.counts()).toEqual({ releases: 1, removes: 1, waits: 0, sends: 0 });
  });

  test("a concurrent request fails closed before artifact publication", async () => {
    const h = liveDeps({ acquire: () => null });
    const outcome = await captureLivePartnerResponse(
      h.deps,
      VERB_DEPS,
      liveArgs,
    );
    expect(outcome.disposition).toBe("capture_busy");
    expect(outcome.result.envelope.outcome).toBe("bad_args");
    expect(h.counts()).toEqual({ releases: 0, removes: 0, waits: 0, sends: 0 });
  });

  test("an exact identity race refuses publish and cleans the unpublished artifact", async () => {
    const h = liveDeps({ identityStillLive: () => false });
    const outcome = await captureLivePartnerResponse(
      h.deps,
      VERB_DEPS,
      liveArgs,
    );
    expect(outcome.disposition).toBe("identity_changed");
    expect(h.counts()).toEqual({ releases: 1, removes: 1, waits: 0, sends: 1 });
  });

  test("Partner death after delivery keeps partner_died precedence", async () => {
    const h = liveDeps({
      waitForStop: async () => ({
        ok: false,
        reason: "partner_died",
        error: "partner died",
        transcriptPath: "/t.jsonl",
        terminal: { kind: "terminal", state: "killed", reason: null },
      }),
    });
    const outcome = await captureLivePartnerResponse(
      h.deps,
      VERB_DEPS,
      liveArgs,
    );
    expect(outcome.result.envelope.outcome).toBe("partner_died");
    expect(h.counts()).toMatchObject({ releases: 1, removes: 0 });
  });

  test("a cancelled waiter releases admission without deleting a possibly-delivered artifact", async () => {
    const h = liveDeps({
      waitForStop: async () => {
        throw new Error("cancelled");
      },
    });
    const outcome = await captureLivePartnerResponse(
      h.deps,
      VERB_DEPS,
      liveArgs,
    );
    expect(outcome.disposition).toBe("capture_failed");
    expect(outcome.detail).toBe("cancelled");
    expect(h.counts()).toMatchObject({ releases: 1, removes: 0 });
  });
});

describe("launchToResolvedHandle — teardown target", () => {
  test("null killWindowCommand → ok:false via TmuxLaunchError", () => {
    const launchSpy = spyOn(
      tmuxLaunch,
      "launchKeeperAgentInTmux",
    ).mockReturnValue({
      id: "tmux-no-target",
      runDir: null,
      session: "keeper-agent",
      windowId: "@1",
      paneId: "%1",
      launchScript: null,
      attachCommand: ["/fake/tmux", "attach-session", "-t", "keeper-agent"],
      killWindowCommand: null,
      message: null,
    });
    const errs: string[] = [];

    try {
      const result = launchToResolvedHandle({
        deps: {
          env: {},
          cwd: "/work/proj",
          tmuxBin: "/fake/tmux",
          launcherStateDir: tempDir(),
          launcherArgvPrefix: ["/fake/bun", "/fake/keeper.ts", "agent"],
          randomUuid: () => "11111111-1111-1111-1111-111111111111",
          runTmuxCommand: () => {
            throw new Error("fake launch must not execute tmux");
          },
          now: () => 123,
          writeErr: (message) => errs.push(message),
        },
        agent: "claude",
        prompt: "say hi",
        posture: {},
        stopTimeoutMs: null,
      });

      expect(result).toEqual({
        ok: false,
        error: "detached tmux launch returned no exact teardown target",
      });
      expect(errs).toEqual([
        "Error: detached tmux launch returned no exact teardown target\n",
      ]);
    } finally {
      launchSpy.mockRestore();
    }
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

  test("post-launch control hook completes before capture waiting begins", async () => {
    const events: string[] = [];
    await composeRunCapture(
      {
        waitForStop: async () => {
          events.push("wait");
          return { ok: true, transcriptPath: "/t.jsonl", stop: STOP };
        },
        showLastMessage: async () => ({
          ok: true,
          transcriptPath: "/t.jsonl",
          text: "answer",
          found: true,
        }),
        now: () => 1_000,
        launch: (): RunLaunchResult => {
          events.push("launch");
          return {
            ok: true,
            handle: handle("sess-control"),
            runId: "tmux-control-1",
            killWindowCommand: [
              "/opt/tmux",
              "-S",
              "/tmp/exact.sock",
              "kill-window",
              "-t",
              "@41",
            ],
          };
        },
        onLaunched: () => {
          events.push("control");
        },
      },
      VERB_DEPS,
      "claude",
    );

    expect(events).toEqual(["launch", "control", "wait"]);
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
          killWindowCommand: ["tmux", "kill-window", "-t", "@1"],
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

describe("run control — exact, idempotent cancellation", () => {
  const EXACT_KILL = [
    "/opt/tmux",
    "-S",
    "/tmp/keeper-owned.sock",
    "kill-window",
    "-t",
    "@77",
  ];
  const OWNER: RunControlOwner = {
    request_id: "panel-1",
    member: "opus-1",
    attempt: 1,
  };

  function control(status: RunControlArtifact["status"] = "running") {
    return {
      ...buildRunControlArtifact({
        runId: "tmux-owned-77",
        agent: "claude",
        startedAtMs: 12_345,
        killWindowCommand: EXACT_KILL,
        owner: OWNER,
      }),
      status,
    };
  }

  test.each([
    ["wrong verb", ["tmux", "kill-server"]],
    ["non-@N target", ["tmux", "kill-window", "-t", "not-a-window"]],
    [
      "odd socket-arg run",
      ["tmux", "-L", "sock", "-S", "kill-window", "-t", "@77"],
    ],
    ["non-tmux argv0", ["rm", "-rf", "/", "kill-window", "-t", "@77"]],
  ] as const)(
    "rejects %s as a run-control kill_window_command tail",
    (_label, killWindowCommand) => {
      const artifact = buildRunControlArtifact({
        runId: "tmux-owned-77",
        agent: "claude",
        startedAtMs: 12_345,
        killWindowCommand: [...killWindowCommand],
        owner: OWNER,
      });
      let tmuxCalls = 0;

      expect(isRunControlArtifact(artifact)).toBe(false);
      expect(
        cancelOwnedRunFromControlArtifact({
          path: "/fake/panel.control.json",
          expectedOwner: OWNER,
          readArtifact: () => artifact,
          writeArtifact: () => {
            throw new Error("must not write");
          },
          runTmuxCommand: () => {
            tmuxCalls += 1;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
      ).toEqual({ kind: "malformed_control" });
      expect(tmuxCalls).toBe(0);
    },
  );

  test("exact teardown is single-shot and preserves the socket-qualified target", () => {
    const calls: string[][] = [];
    const teardown = createExactRunTeardown(EXACT_KILL, (command) => {
      calls.push(command);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    expect(teardown()).toEqual({ kind: "torn_down" });
    expect(teardown()).toEqual({ kind: "torn_down" });
    expect(calls).toEqual([EXACT_KILL]);
  });

  test("owned cancellation rejects malformed and mismatched controls before tmux", () => {
    let calls = 0;
    const base = {
      path: "/fake/panel.control.json",
      expectedOwner: OWNER,
      writeArtifact: () => {
        throw new Error("must not write");
      },
      runTmuxCommand: () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    expect(
      cancelOwnedRunFromControlArtifact({
        ...base,
        readArtifact: () => ({ nope: true }),
      }),
    ).toEqual({ kind: "malformed_control" });
    expect(
      cancelOwnedRunFromControlArtifact({
        ...base,
        readArtifact: () =>
          buildRunControlArtifact({
            runId: "run-1",
            agent: "claude",
            startedAtMs: 1,
            killWindowCommand: EXACT_KILL,
            owner: { ...OWNER, request_id: "foreign" },
          }),
      }),
    ).toEqual({ kind: "ownership_mismatch" });
    expect(calls).toBe(0);
  });

  test("already-gone, identity mismatch, terminal, and unresolved errors stay distinct", () => {
    let artifact = control();
    const base = {
      path: "/fake/control.json",
      claimedIdentity: {
        run_id: "tmux-owned-77",
        agent: "claude" as const,
        kill_window_command: EXACT_KILL,
      },
      readArtifact: () => artifact,
      writeArtifact: (_path: string, next: RunControlArtifact) => {
        artifact = next;
      },
    };

    const mismatch = cancelRunFromControlArtifact({
      ...base,
      claimedIdentity: { ...base.claimedIdentity, run_id: "tmux-foreign" },
      runTmuxCommand: () => {
        throw new Error("must not run");
      },
    });
    expect(mismatch).toEqual({ kind: "identity_mismatch" });

    artifact = control("terminal");
    expect(
      cancelRunFromControlArtifact({
        ...base,
        runTmuxCommand: () => {
          throw new Error("must not run");
        },
      }),
    ).toEqual({ kind: "already_terminal" });

    artifact = control();
    expect(
      cancelRunFromControlArtifact({
        ...base,
        runTmuxCommand: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "can't find window: @77",
        }),
      }),
    ).toEqual({ kind: "already_gone" });
    expect(artifact.status).toBe("terminal");

    artifact = control();
    expect(
      cancelRunFromControlArtifact({
        ...base,
        runTmuxCommand: () => ({
          exitCode: 1,
          stdout: "",
          stderr: "permission denied",
        }),
      }),
    ).toEqual({
      kind: "unresolved_teardown_error",
      error: "tmux kill-window exited 1: permission denied",
    });
    expect(artifact.status).toBe("cancelling");
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

/** A resolvable claude transcript with NO settled stop — a tool_use assistant
 *  turn carrying readable text. The stop wait times out (tool_use is excluded)
 *  while show-last-message still recovers the bounded partial. */
function writeNoStopClaudeTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  partial: string,
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
        stop_reason: "tool_use",
        content: [{ type: "text", text: partial }],
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

  test("publishes exact atomic control beside the run before capture completes", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/control-proj";
    const sessionId = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    writeClaudeTranscript(home, cwd, sessionId, "controlled answer");
    const h = makeHarness({
      argv: ["run", "claude", "control me"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      now: () => 12_345,
      tmuxCommand: fakeTmux,
    });

    expect(await expectExit(main(h.deps))).toBe(0);

    const runsDir = join(stateDir, "tmux-runs");
    const runIds = readdirSync(runsDir);
    expect(runIds).toEqual([`tmux-${sessionId}`]);
    const runFiles = readdirSync(join(runsDir, runIds[0] as string)).sort();
    expect(runFiles).toEqual(["control.json", "launch.sh", "run.json"]);
    const artifact = JSON.parse(
      readFileSync(join(runsDir, runIds[0] as string, "control.json"), "utf8"),
    );
    expect(artifact).toEqual({
      schema_version: 1,
      run_id: `tmux-${sessionId}`,
      agent: "claude",
      started_at_ms: 12_345,
      kill_window_command: ["tmux", "kill-window", "-t", "@1"],
      status: "terminal",
    });
  });

  test("a timeout leaves the Partner resident: no reap, control stays running, live guidance", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    writeNoStopClaudeTranscript(home, cwd, sessionId, "partial answer so far");
    const h = makeHarness({
      argv: [
        "run",
        "claude",
        "think hard",
        "--stop-timeout",
        "40ms",
        "--reap-window-on-terminal",
      ],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: fakeTmux,
      // The folded job is positively live — an elapsed observation deadline must
      // never kill it or discard its recoverable answer.
      probePartnerLifecycle: async () => ({ kind: "live" }),
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(4);
    expect(parseEnvelope(h.out)).toMatchObject({
      outcome: "timed_out",
      message: "partial answer so far",
      message_found: true,
    });
    // NO reap fired — the launched window is left resident for a live Partner.
    expect(h.tmuxCommands.filter((cmd) => cmd.includes("kill-window"))).toEqual(
      [],
    );
    // The run control stays `running`, never stamped terminal.
    const control = JSON.parse(
      readFileSync(
        join(stateDir, "tmux-runs", `tmux-${sessionId}`, "control.json"),
        "utf8",
      ),
    );
    expect(control.status).toBe("running");
    // Honest live guidance: still running, a non-resending recovery path, and an
    // explicit "not final" on the partial.
    const stderr = h.err.join("");
    expect(stderr).toContain("still running");
    expect(stderr).toContain("show-last-message");
    expect(stderr).toContain("not a final answer");
  });

  test("an unknown-lifecycle timeout says only that termination was not observed, still no reap", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "eeeeeeee-1111-2222-3333-444444444444";
    writeNoStopClaudeTranscript(home, cwd, sessionId, "partial so far");
    const h = makeHarness({
      argv: [
        "run",
        "claude",
        "think hard",
        "--stop-timeout",
        "40ms",
        "--reap-window-on-terminal",
      ],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: fakeTmux,
      // Default probe returns unknown → no positive liveness evidence.
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(4);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "timed_out" });
    expect(h.tmuxCommands.filter((cmd) => cmd.includes("kill-window"))).toEqual(
      [],
    );
    const stderr = h.err.join("");
    expect(stderr).toContain("termination was not observed");
    expect(stderr).not.toContain("still running");
    expect(stderr).toContain("show-last-message");
  });

  test("a completed run under --reap-window-on-terminal STILL reaps and marks terminal (unchanged)", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "cafecafe-cafe-cafe-cafe-cafecafecafe";
    writeClaudeTranscript(home, cwd, sessionId, "the final answer");
    const h = makeHarness({
      argv: ["run", "claude", "answer", "--reap-window-on-terminal"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: fakeTmux,
    });

    expect(await expectExit(main(h.deps))).toBe(0);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "completed" });
    // A confirmed-terminal outcome reaps exactly its own window and marks control
    // terminal — the honest-timeout change never weakened this path.
    expect(h.tmuxCommands.filter((cmd) => cmd.includes("kill-window"))).toEqual(
      [["tmux", "kill-window", "-t", "@1"]],
    );
    const control = JSON.parse(
      readFileSync(
        join(stateDir, "tmux-runs", `tmux-${sessionId}`, "control.json"),
        "utf8",
      ),
    );
    expect(control.status).toBe("terminal");
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

  test("caller-owned control publishes the canonical artifact at the registered path", async () => {
    const controlPath = join(tempDir(), "panel-attempt.control.json");
    const owner = { request_id: "panel-request", member: "opus-1", attempt: 1 };
    const { h } = completedRunHarness([
      "--control",
      controlPath,
      "--control-owner",
      JSON.stringify(owner),
      "--reap-window-on-terminal",
    ]);

    expect(await expectExit(main(h.deps))).toBe(0);
    expect(JSON.parse(readFileSync(controlPath, "utf8"))).toMatchObject({
      schema_version: 1,
      kill_window_command: ["tmux", "kill-window", "-t", "@1"],
      status: "terminal",
      owner,
    });
    expect(h.tmuxCommands.filter((cmd) => cmd.includes("kill-window"))).toEqual(
      [["tmux", "kill-window", "-t", "@1"]],
    );
  });

  test("caller-owned control publication failure tears down the exact launch", async () => {
    const occupied = join(tempDir(), "occupied");
    writeFileSync(occupied, "not a directory\n");
    const owner = { request_id: "panel-request", member: "opus-1", attempt: 1 };
    const { h } = completedRunHarness([
      "--control",
      join(occupied, "control.json"),
      "--control-owner",
      JSON.stringify(owner),
    ]);

    expect(await expectExit(main(h.deps))).toBe(1);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "launch_failed" });
    expect(h.tmuxCommands.filter((cmd) => cmd.includes("kill-window"))).toEqual(
      [["tmux", "kill-window", "-t", "@1"]],
    );
  });

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
    const { h } = completedRunHarness([
      "--preset",
      "pi::openai-codex/gpt-5::high",
    ]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    expect(h.err.join("")).toContain("pins harness pi");
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
      "pi::openai-codex/gpt-5::high",
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

  test("--output self-creates a missing parent dir (mkdir -p) and lands the envelope", async () => {
    // The wrapped-envelope spool (`.keeper/state/wrapped-envelopes/`) does not
    // exist on a fresh checkout; the write must create the parent, not ENOENT.
    const outPath = join(tempDir(), "no-such-subdir", "nested", "leg.json");
    const { h } = completedRunHarness(["--output", outPath]);

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const fileEnvelope = JSON.parse(readFileSync(outPath, "utf8"));
    expect(fileEnvelope).toMatchObject({ outcome: "completed" });
    // The stdout sink carries the SAME envelope the created file holds.
    expect(fileEnvelope).toEqual(parseEnvelope(h.out));
  });

  test("reap observes the durable result first and uses the exact launched target once", async () => {
    const outPath = join(tempDir(), "leg.json");
    const observations: string[] = [];
    const { h } = completedRunHarness([
      "--output",
      outPath,
      "--reap-window-on-terminal",
    ]);
    h.deps.runTmuxCommandFn = (command) => {
      h.tmuxCommands.push(command);
      if (command.includes("kill-window")) {
        const saved = JSON.parse(readFileSync(outPath, "utf8")) as {
          outcome: string;
        };
        observations.push(saved.outcome);
      }
      return fakeTmux(command);
    };

    expect(await expectExit(main(h.deps))).toBe(0);
    expect(observations).toEqual(["completed"]);
    expect(h.tmuxCommands.filter((cmd) => cmd.includes("kill-window"))).toEqual(
      [["tmux", "kill-window", "-t", "@1"]],
    );
  });

  test("an --output persistence failure still reaps the exact window once", async () => {
    const dir = tempDir();
    const occupied = join(dir, "occupied");
    writeFileSync(occupied, "not a directory\n");
    const outPath = join(occupied, "leg.json");
    const { h } = completedRunHarness([
      "--output",
      outPath,
      "--reap-window-on-terminal",
    ]);

    expect(await expectExit(main(h.deps))).toBe(2);
    expect(h.tmuxCommands.filter((cmd) => cmd.includes("kill-window"))).toEqual(
      [["tmux", "kill-window", "-t", "@1"]],
    );
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
  });

  test("--output onto a genuinely unwritable path (a file in the parent chain) is the path's own bad_args (exit 2)", async () => {
    const dir = tempDir();
    const occupied = join(dir, "occupied");
    writeFileSync(occupied, "i am a file, not a dir\n");
    // The parent component is a FILE, so `mkdir -p` cannot create it → the write
    // fails past the self-heal, and the --output path owns that as bad_args.
    const outPath = join(occupied, "leg.json");
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
      argv: [
        "run",
        "claude",
        "follow up",
        "--resume",
        "reviewer",
        "--session",
        "wrapped",
        "--name",
        "task-123",
      ],
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
    // A launch actually fired in the RECORDED cwd (not the caller cwd), while
    // the explicit presentation posture still groups/titles the resumed leg.
    expect(h.tmuxCommands.length).toBeGreaterThan(0);
    expect(h.tmuxCommands.flatMap((cmd) => flagValues(cmd, "-s"))).toContain(
      "wrapped",
    );
    expect(h.tmuxCommands.flatMap((cmd) => flagValues(cmd, "-n"))).toContain(
      "task-123",
    );
    const launchScript = readFileSync(
      join(stateDir, "tmux-runs", `tmux-${childUuid}`, "launch.sh"),
      "utf8",
    );
    expect(launchScript).toContain(`cd -- '${resumeCwd}'`);
    expect(launchScript).toContain(`'--resume' '${parentUuid}'`);
    expect(launchScript).toContain("'--name' 'task-123'");
    expect(launchScript).not.toContain("'--model'");
    expect(launchScript).not.toContain("'--effort'");
    expect(launchScript).not.toContain("'--preset'");
  });

  test("harness mismatch → bad_args naming both harnesses, no launch", async () => {
    const h = makeHarness({
      argv: ["run", "pi", "hi", "--resume", "reviewer"],
      rawArgv: true,
      resolveResumeDecision: () => ({
        kind: "harness-mismatch",
        job_id: "job-1",
        harness: "claude",
        require_harness: "pi",
        title: "reviewer",
      }),
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(2);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "bad_args" });
    const err = h.err.join("");
    expect(err).toContain("did not resolve to a pi");
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

  test("live target sends once over the Bus and captures only after its injected boundary", async () => {
    const home = tempDir();
    const cwd = "/work/live-partner";
    const sessionId = "99999999-9999-9999-9999-999999999999";
    const transcriptPath = writeClaudeTranscript(
      home,
      cwd,
      sessionId,
      "unrelated pre-existing stop",
    );
    let sends = 0;
    const resolvedTargets: string[] = [];
    const h = makeHarness({
      argv: ["run", "claude", "hi", "--resume", "reviewer"],
      rawArgv: true,
      transcriptHomeDir: home,
      resolveResumeDecision: (target) => {
        resolvedTargets.push(target);
        return {
          kind: "live",
          job_id: "job-9",
          harness: "claude",
          title: target === "job-9" ? "renamed-reviewer" : "reviewer",
          resume_target: sessionId,
          cwd,
          pid: 9009,
          start_time: "start-9",
        };
      },
      sendBusArtifact: async (
        _sock,
        artifact,
        target,
        _media,
        beforePublish,
      ) => {
        sends++;
        expect(target).toBe("job-9");
        expect(beforePublish?.()).toBe(true);
        appendFileSync(
          transcriptPath,
          `${JSON.stringify({
            type: "queue-operation",
            content: `Agent Bus message — read ${artifact.path}`,
          })}\n${JSON.stringify({
            timestamp: new Date().toISOString(),
            type: "assistant",
            message: {
              role: "assistant",
              stop_reason: "end_turn",
              content: [{ type: "text", text: "causal live answer" }],
            },
          })}\n`,
        );
        return { result: "delivered", recipients: 1 };
      },
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(sends).toBe(1);
    expect(resolvedTargets).toEqual(["reviewer", "job-9"]);
    expect(parseEnvelope(h.out)).toMatchObject({
      outcome: "completed",
      handle: "job-9",
      resume_target: sessionId,
      transcript_path: transcriptPath,
      message: "causal live answer",
    });
    expect(h.tmuxCommands.length).toBe(0);
  });

  test("a delivered live timeout leaves the Partner live and names non-resending recovery", async () => {
    const home = tempDir();
    const cwd = "/work/live-timeout";
    const sessionId = "88888888-8888-8888-8888-888888888888";
    const transcriptPath = writeClaudeTranscript(home, cwd, sessionId, "old");
    let sends = 0;
    const h = makeHarness({
      argv: [
        "run",
        "claude",
        "follow up",
        "--resume",
        "reviewer",
        "--stop-timeout",
        "20ms",
      ],
      rawArgv: true,
      transcriptHomeDir: home,
      probePartnerLifecycle: async () => ({ kind: "live" }),
      resolveResumeDecision: () => ({
        kind: "live",
        job_id: "job-live-timeout",
        harness: "claude",
        title: "reviewer",
        resume_target: sessionId,
        cwd,
        pid: 8080,
        start_time: "start-8",
      }),
      sendBusArtifact: async (
        _sock,
        artifact,
        _target,
        _media,
        beforePublish,
      ) => {
        sends++;
        expect(beforePublish?.()).toBe(true);
        appendFileSync(
          transcriptPath,
          `${JSON.stringify({
            customType: "keeper-agent-bus",
            content: `Agent Bus message — read ${artifact.path}`,
          })}\n`,
        );
        return { result: "delivered", recipients: 1 };
      },
    });

    expect(await expectExit(main(h.deps))).toBe(4);
    expect(sends).toBe(1);
    expect(parseEnvelope(h.out)).toMatchObject({ outcome: "timed_out" });
    const err = h.err.join("");
    expect(err).toContain("still running");
    expect(err).toContain(
      `keeper agent show-last-message ${transcriptPath} --agent claude`,
    );
    expect(err).not.toContain("keeper agent wait");

    appendFileSync(
      transcriptPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "assistant",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "late live answer" }],
        },
      })}\n`,
    );
    expect(findLastMessage("claude", transcriptPath).text).toBe(
      "late live answer",
    );
  });

  test("model/effort/preset alongside --resume → bad_args BEFORE the resolver is consulted, envelope written to --output", async () => {
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
        "--effort",
        "high",
        "--preset",
        "claude::opus::high",
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
