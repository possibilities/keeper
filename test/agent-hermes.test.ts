/**
 * Hermes launcher + M2 capture pins. `keeper agent hermes` maps wrapper features
 * onto Hermes-native contracts: the no-approval posture (`--yolo` +
 * `HERMES_ACCEPT_HOOKS=1`), the model default (`-m`, model-only — no effort or
 * thinking), the `-z/--oneshot` prompt delivery, and management-subcommand
 * passthrough. Capture is store-based: hermes has no transcript FILE, so the
 * wait/show verbs poll `hermes sessions export` and attribute a session by cwd +
 * created-at (refuse-to-guess on collision). These tests pin the argv, the preset
 * validation, and the capture on synthetic export fixtures — no live hermes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgsForAgent } from "../src/agent/args";
import { ConfigError, loadPresetCatalog } from "../src/agent/config";
import {
  attributeHermesSession,
  hermesLastMessage,
  hermesSessionStop,
  parseHermesExport,
} from "../src/agent/hermes-capture";
import {
  buildAgentLaunchArgv,
  nativeHermesArgs,
} from "../src/agent/launch-config";
import { main } from "../src/agent/main";
import {
  runShowLastMessage,
  runWaitForStop,
} from "../src/agent/pair-subcommands";
import { captureFromHandle } from "../src/agent/run-capture";
import {
  expectExit,
  flagValues,
  makeHarness,
  runAndCapture,
} from "./helpers/agent-main-harness";

function hermesHarness(
  argv: string[],
  opts: Omit<Parameters<typeof makeHarness>[0], "argv"> = {},
) {
  return makeHarness({ ...opts, argv: ["hermes", ...argv], rawArgv: true });
}

// The default catalog's hermes_default pins `-m gpt-5.5` on a fresh launch.
const DEFAULT_MODEL = "gpt-5.5";

describe("Hermes parse signals", () => {
  test("resume/continue are continuation; a fork flag does not exist", () => {
    const resume = parseArgsForAgent(["--resume", "abc"], "hermes");
    expect(resume.hasContinueOrResume).toBe(true);
    expect(resume.hasForkSession).toBe(false);
    expect(resume.remainingArgs).toEqual(["--resume", "abc"]);

    expect(parseArgsForAgent(["-r", "x"], "hermes").hasContinueOrResume).toBe(
      true,
    );
    expect(
      parseArgsForAgent(["--continue"], "hermes").hasContinueOrResume,
    ).toBe(true);
    expect(parseArgsForAgent(["-c"], "hermes").hasContinueOrResume).toBe(true);
  });

  test("one-shot (-z/--oneshot) reads as headless", () => {
    expect(parseArgsForAgent(["-z", "hi"], "hermes").hasPrint).toBe(true);
    expect(parseArgsForAgent(["--oneshot", "hi"], "hermes").hasPrint).toBe(
      true,
    );
    // A bare interactive launch is neither headless nor a continuation.
    const bare = parseArgsForAgent([], "hermes");
    expect(bare.hasPrint).toBe(false);
    expect(bare.hasContinueOrResume).toBe(false);
  });
});

describe("Hermes command assembly", () => {
  test("bare interactive launch adds --yolo + the default model, sets the hook env", async () => {
    const h = hermesHarness(["--x-no-confirm"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.hermesBin, "--yolo", "-m", DEFAULT_MODEL]);
    expect(h.deps.env.HERMES_ACCEPT_HOOKS).toBe("1");
    // No claude/pi state leaks in.
    expect(h.deps.env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(h.deps.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  test("one-shot launch keeps -z <prompt> and injects the default model", async () => {
    const h = hermesHarness(["--x-no-confirm", "-z", "reply DONE"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([
      h.deps.hermesBin,
      "--yolo",
      "-m",
      DEFAULT_MODEL,
      "-z",
      "reply DONE",
    ]);
  });

  test("an explicit -m suppresses the configured default; --yolo is not doubled", async () => {
    const h = hermesHarness([
      "--x-no-confirm",
      "--yolo",
      "-m",
      "custom",
      "-z",
      "hi",
    ]);
    const cmd = await runAndCapture(h, main);
    expect(flagValues(cmd, "-m")).toEqual(["custom"]);
    expect(cmd.filter((t) => t === "--yolo")).toHaveLength(1);
    expect(cmd).toEqual([
      h.deps.hermesBin,
      "--yolo",
      "-m",
      "custom",
      "-z",
      "hi",
    ]);
  });

  test("a management subcommand passes through with no model/posture injection", async () => {
    const h = hermesHarness(["sessions", "list"]);
    const cmd = await runAndCapture(h, main);
    expect(cmd).toEqual([h.deps.hermesBin, "sessions", "list"]);
    // Passthrough never seeds the hook env or a model.
    expect(h.deps.env.HERMES_ACCEPT_HOOKS).toBeUndefined();
    expect(cmd).not.toContain("--yolo");
  });

  test("a fresh launch with no default and no model is fail-loud (exit 2)", async () => {
    const h = hermesHarness(["--x-no-confirm"], {
      presetCatalog: { presets: {} },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(h.err.join("")).toContain("no model resolved");
    expect(h.err.join("")).toContain("hermes_default");
  });
});

describe("Hermes detached launch argv (native builder)", () => {
  test("nativeHermesArgs ends with -z so the appended prompt is its value", () => {
    expect(nativeHermesArgs({ model: "gpt-5.5" } as never)).toEqual([
      "--yolo",
      "-m",
      "gpt-5.5",
      "-z",
    ]);
    // No model → no -m, still one-shot.
    expect(nativeHermesArgs({} as never)).toEqual(["--yolo", "-z"]);
  });

  test("buildAgentLaunchArgv assembles the detached one-shot form", () => {
    const argv = buildAgentLaunchArgv({
      launcherArgvPrefix: ["keeper", "agent"],
      cli: "hermes",
      prompt: "reply DONE",
      model: "gpt-5.5",
    });
    expect(argv).toEqual([
      "keeper",
      "agent",
      "hermes",
      "--x-tmux",
      "--x-tmux-detached",
      "--x-no-confirm",
      "--yolo",
      "-m",
      "gpt-5.5",
      "-z",
      "reply DONE",
    ]);
  });
});

describe("Hermes default triple validation", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keeper-agent-hermes-preset-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePresets(body: string): string {
    const p = join(tmpDir, "presets.yaml");
    writeFileSync(p, body);
    return p;
  }

  test("a hermes_default triple parses (model-only, na effort)", () => {
    const cat = loadPresetCatalog(
      writePresets("hermes_default: hermes::gpt-5.5::na\n"),
    );
    expect(cat.hermes_default).toEqual({
      harness: "hermes",
      model: "gpt-5.5",
      effort: "na",
    });
  });

  test("a hermes_default triple carrying a non-na effort fails loud", () => {
    // Hermes is axisless — the grammar requires the `na` sentinel, rejecting an
    // effort band.
    const p = writePresets("hermes_default: hermes::m::high\n");
    expect(() => loadPresetCatalog(p)).toThrow(ConfigError);
    expect(() => loadPresetCatalog(p)).toThrow(/must be 'na'/);
  });

  test("a hermes_default naming a non-hermes harness is fail-loud", () => {
    const p = writePresets("hermes_default: claude::m::high\n");
    expect(() => loadPresetCatalog(p)).toThrow(
      /hermes_default 'claude::m::high' pins harness claude, expected hermes/,
    );
  });
});

// A completed hermes one-shot session, as `hermes sessions export` renders it:
// one JSON object per line, cwd-attributed, ended by a terminal assistant turn.
const CWD = "/proj/x";
const SESSION_ID = "20260703_165444_0be097";

function exportFixture(overrides: Record<string, unknown> = {}): string {
  const session = {
    id: SESSION_ID,
    source: "cli",
    cwd: CWD,
    started_at: 2000,
    messages: [
      {
        role: "user",
        content: "reply DONE",
        finish_reason: null,
        timestamp: 2000,
      },
      {
        role: "assistant",
        content: "DONE",
        finish_reason: "stop",
        timestamp: 2001,
      },
    ],
    ...overrides,
  };
  return `${JSON.stringify(session)}\n`;
}

describe("Hermes capture — pure parsers", () => {
  test("parseHermesExport reads sessions and skips non-session lines", () => {
    const text = `Exported 1 sessions\n${exportFixture()}\n{"not":"a session"}\n`;
    const sessions = parseHermesExport(text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe(SESSION_ID);
    expect(sessions[0]?.cwd).toBe(CWD);
    expect(sessions[0]?.startedAtMs).toBe(2000 * 1000);
    expect(sessions[0]?.messages).toHaveLength(2);
  });

  test("attribution is exactly-one by cwd + created-at; a collision is ambiguous", () => {
    const sessions = parseHermesExport(exportFixture());
    // startedAtMs before the session's start (within slop) → attributed.
    expect(attributeHermesSession(sessions, CWD, 2_000_000)).toMatchObject({
      kind: "found",
    });
    // Wrong cwd → pending.
    expect(attributeHermesSession(sessions, "/other", 0).kind).toBe("pending");
    // A session predating launch → not attributable.
    expect(attributeHermesSession(sessions, CWD, 9_000_000_000).kind).toBe(
      "pending",
    );
    // Two same-cwd fresh sessions → ambiguous (refuse to guess).
    const two = parseHermesExport(
      exportFixture() + exportFixture({ id: "other" }),
    );
    expect(attributeHermesSession(two, CWD, 0).kind).toBe("ambiguous");
  });

  test("stop is the latest terminal assistant turn; tool_calls hops never stop", () => {
    const found = attributeHermesSession(
      parseHermesExport(exportFixture()),
      CWD,
      0,
    );
    if (found.kind !== "found") throw new Error("expected found");
    const stop = hermesSessionStop(found.session, 0);
    expect(stop).toMatchObject({ agent: "hermes", message: "DONE" });

    // A still-working turn (only a tool_calls assistant hop) is NOT a stop.
    const working = parseHermesExport(
      exportFixture({
        messages: [
          { role: "user", content: "go", finish_reason: null, timestamp: 2000 },
          {
            role: "assistant",
            content: "",
            finish_reason: "tool_calls",
            timestamp: 2001,
          },
        ],
      }),
    );
    const wa = attributeHermesSession(working, CWD, 0);
    if (wa.kind !== "found") throw new Error("expected found");
    expect(hermesSessionStop(wa.session, 0)).toBeNull();
  });

  test("last message returns the final assistant text", () => {
    const found = attributeHermesSession(
      parseHermesExport(exportFixture()),
      CWD,
      0,
    );
    if (found.kind !== "found") throw new Error("expected found");
    expect(hermesLastMessage(found.session)).toEqual({
      agent: "hermes",
      text: "DONE",
      found: true,
    });
  });
});

describe("Hermes capture — envelope end-to-end (injected export seam)", () => {
  test("a completed one-shot yields outcome completed + resume target", async () => {
    const verbDeps = {
      env: {},
      homeDir: "/home",
      hermesExport: () => exportFixture(),
    };
    const { envelope, exitCode } = await captureFromHandle(
      {
        waitForStop: runWaitForStop,
        showLastMessage: runShowLastMessage,
        now: () => 5000,
      },
      verbDeps,
      {
        handle: {
          agent: "hermes",
          cwd: CWD,
          sessionId: null,
          startedAtMs: 1000,
          transcriptPath: null,
          stopTimeoutMs: null,
        },
        handleId: "tmux-1",
        agent: "hermes",
        startMs: 0,
      },
    );
    expect(exitCode).toBe(0);
    expect(envelope).toMatchObject({
      agent: "hermes",
      outcome: "completed",
      message: "DONE",
      message_found: true,
      // Hermes has no transcript file — the session id is both the transcript
      // handle and the resume target discovered post-stop.
      transcript_path: SESSION_ID,
      resume_target: SESSION_ID,
    });
  });

  test("a concurrent same-cwd collision → transcript_ambiguous", async () => {
    const verbDeps = {
      env: {},
      homeDir: "/home",
      hermesExport: () => exportFixture() + exportFixture({ id: "other" }),
    };
    const { envelope } = await captureFromHandle(
      {
        waitForStop: runWaitForStop,
        showLastMessage: runShowLastMessage,
        now: () => 5000,
      },
      verbDeps,
      {
        handle: {
          agent: "hermes",
          cwd: CWD,
          sessionId: null,
          startedAtMs: 1000,
          transcriptPath: null,
          stopTimeoutMs: 1,
        },
        handleId: "tmux-1",
        agent: "hermes",
        startMs: 0,
      },
    );
    expect(envelope.outcome).toBe("transcript_ambiguous");
  });
});
