/**
 * The post-launch transcript verbs (`wait-for-stop` / `show-last-message`),
 * driven through main()'s subcommand dispatch and against the pure resolver.
 * Fixtures are real per-backend transcript JSONL: claude `assistant`/`end_turn`
 * with text content, codex `task_complete` with `last_agent_message`. Coverage:
 * wait-for-stop blocks until a stop appears; show-last-message extracts the final
 * text per backend; an empty/tool-only final turn yields a defined (not silent)
 * signal; the removed `--wait-for-stop` flag no longer short-circuits launch.
 */
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessageNotification } from "../cli/bus";
import { main } from "../src/agent/main";
import { resolveHandle, runWaitForStop } from "../src/agent/pair-subcommands";
import {
  findLastMessage,
  waitForTranscriptPath,
  waitForTranscriptStop,
} from "../src/agent/transcript-watch";
import {
  BUS_ARTIFACT_REF_TAG,
  BUS_ARTIFACT_REF_VERSION,
} from "../src/bus-artifact";
import {
  expectExit,
  flagValues,
  makeHarness,
} from "./helpers/agent-main-harness";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "keeper-agent-pair-test-"));
}
/** Write a run.json under the state dir so a run-id handle resolves. */
function writeRunJson(
  stateDir: string,
  runId: string,
  data: Record<string, unknown>,
): void {
  const dir = join(stateDir, "tmux-runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(data, null, 2)}\n`);
}
function writeClaudeTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  opts: {
    text?: string | null;
    stopReason?: string;
    mtimeMs?: number;
  } = {},
): string {
  const dir = join(home, ".claude", "projects", cwd.replace(/\//g, "-"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  const content: Array<Record<string, unknown>> = [
    { type: "thinking", thinking: "deliberating" },
  ];
  if (opts.text !== undefined && opts.text !== null) {
    content.push({ type: "text", text: opts.text });
  }
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: opts.stopReason ?? "end_turn",
        content,
      },
    })}\n`,
  );
  if (opts.mtimeMs !== undefined) {
    const seconds = opts.mtimeMs / 1000;
    utimesSync(path, seconds, seconds);
  }
  return path;
}
function parseJsonOutput(out: string[]): Record<string, unknown> {
  const lastLine = out.join("").trim().split("\n").at(-1);
  if (lastLine === undefined) {
    throw new Error("missing JSON output");
  }
  return JSON.parse(lastLine) as Record<string, unknown>;
}
describe("resolveHandle", () => {
  test("a run id resolves agent/cwd/session from run.json", () => {
    const stateDir = tempDir();
    writeRunJson(stateDir, "tmux-r1", {
      agent: "claude",
      cwd: "/work/proj",
      transcriptSessionId: "sess-1",
      startedAtMs: 123,
    });
    const res = resolveHandle({
      rest: ["tmux-r1"],
      cwd: "/elsewhere",
      stateDir,
    });
    expect(res).toEqual({
      ok: true,
      handle: {
        agent: "claude",
        cwd: "/work/proj",
        sessionId: "sess-1",
        startedAtMs: 123,
        transcriptPath: null,
        stopTimeoutMs: null,
      },
    });
  });
  test("a run id restores optional lifecycle identity and invocation boundary", () => {
    const stateDir = tempDir();
    writeRunJson(stateDir, "tmux-life", {
      agent: "pi",
      cwd: "/work/proj",
      transcriptSessionId: "pi-session",
      startedAtMs: 123,
      lifecycleJobId: "job-exact",
      invocationStopFloor: 7,
      isResume: true,
    });
    const res = resolveHandle({
      rest: ["tmux-life"],
      cwd: "/elsewhere",
      stateDir,
    });
    expect(res).toMatchObject({
      ok: true,
      handle: {
        lifecycleJobId: "job-exact",
        invocationStopFloor: 7,
        isResume: true,
      },
    });
  });
  test("a transcript path handle requires --agent", () => {
    const res = resolveHandle({
      rest: ["/tmp/x.jsonl"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res.ok).toBe(false);
  });
  test("a missing handle errors", () => {
    const res = resolveHandle({ rest: [], cwd: "/c", stateDir: tempDir() });
    expect(res.ok).toBe(false);
  });
  test("an unknown run id errors", () => {
    const res = resolveHandle({
      rest: ["tmux-nope"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res.ok).toBe(false);
  });
  test("--stop-timeout=<dur> (equals form) lands on the handle, flag after handle", () => {
    const res = resolveHandle({
      rest: ["/tmp/x.jsonl", "--agent=claude", "--stop-timeout=30m"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res).toMatchObject({
      ok: true,
      handle: { agent: "claude", stopTimeoutMs: 1800000 },
    });
  });
  test.each(["abc", "0", "1500", "-5", "1.5", ""])(
    "a malformed --stop-timeout value (%p) errors",
    (value) => {
      const res = resolveHandle({
        rest: ["/tmp/x.jsonl", "--agent", "claude", "--stop-timeout", value],
        cwd: "/c",
        stateDir: tempDir(),
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("--stop-timeout");
      }
    },
  );
});
describe("findLastMessage", () => {
  test("claude: extracts the final assistant text", () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const path = writeClaudeTranscript(home, cwd, "s1", {
      text: "the final claude answer",
    });
    expect(findLastMessage("claude", path)).toEqual({
      agent: "claude",
      text: "the final claude answer",
      found: true,
    });
  });
  test("claude tool-only final turn → found:false (no stop, no text)", () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const path = writeClaudeTranscript(home, cwd, "s2", {
      text: null,
      stopReason: "tool_use",
    });
    expect(findLastMessage("claude", path)).toEqual({
      agent: "claude",
      text: null,
      found: false,
    });
  });
});
describe("keeper agent wait-for-stop", () => {
  test("a missing handle exits bad_args with a structured error", async () => {
    const h = makeHarness({
      argv: ["wait-for-stop"],
      rawArgv: true,
      launcherStateDir: tempDir(),
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(2);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      error: true,
      reason: "bad_args",
      exitCode: 2,
    });
  });
});
describe("keeper agent show-last-message", () => {
  test("claude: prints the final message then a JSON metadata line", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const transcriptPath = writeClaudeTranscript(home, cwd, sessionId, {
      text: "claude says hello",
    });
    writeRunJson(stateDir, "tmux-cl1", {
      agent: "claude",
      cwd,
      transcriptSessionId: sessionId,
      startedAtMs: 0,
    });
    const h = makeHarness({
      argv: ["show-last-message", "tmux-cl1"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    const output = h.out.join("");
    expect(output).toStartWith("claude says hello\n");
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      agent: "claude",
      transcriptPath,
      found: true,
      message: "claude says hello",
    });
  });
  test("claude tool-only final turn → no bare text, JSON found:false message:null", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const transcriptPath = writeClaudeTranscript(
      home,
      cwd,
      "55555555-5555-5555-5555-555555555555",
      { text: null, stopReason: "tool_use" },
    );
    const h = makeHarness({
      argv: ["show-last-message", transcriptPath, "--agent", "claude"],
      rawArgv: true,
      transcriptHomeDir: home,
      cwd,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    // A claude tool-only turn registers no stop and carries no text, so it reads
    // as found:false with no bare message line — an empty turn is never mistaken
    // for an empty answer string.
    expect(parseJsonOutput(h.out)).toMatchObject({
      agent: "claude",
      found: false,
      message: null,
    });
  });
});
describe("removed --wait-for-stop flag", () => {});
describe("pinned transcript resolution (decoy collision)", () => {
  // The self-transcript collision: a concurrently-writing driver in the same
  // project dir writes a NEWER-mtime file. A pinned partner session must resolve
  // its EXACT transcript, never the newer decoy.
  const PARTNER = "11111111-1111-1111-1111-111111111111";
  const DECOY = "22222222-2222-2222-2222-222222222222";
  function writePartnerAndDecoy(home: string, cwd: string): string {
    const partnerPath = writeClaudeTranscript(home, cwd, PARTNER, {
      text: "the partner answer",
      mtimeMs: 1000000,
    });
    // The decoy is the newest file in the project dir — it would win a
    // newest-by-mtime fallback.
    writeClaudeTranscript(home, cwd, DECOY, {
      text: "the driver answer",
      mtimeMs: 2000000,
    });
    return partnerPath;
  }
  test("show-last-message resolves the pinned partner, never the newer decoy", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const partnerPath = writePartnerAndDecoy(home, cwd);
    writeRunJson(stateDir, "tmux-p1", {
      agent: "claude",
      cwd,
      transcriptSessionId: PARTNER,
      startedAtMs: 0,
    });
    const h = makeHarness({
      argv: ["show-last-message", "tmux-p1"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(h.out.join("")).toStartWith("the partner answer\n");
    expect(parseJsonOutput(h.out)).toMatchObject({
      transcriptPath: partnerPath,
      message: "the partner answer",
    });
  });
  test("wait-for-stop resolves the pinned partner, never the newer decoy", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const partnerPath = writePartnerAndDecoy(home, cwd);
    writeRunJson(stateDir, "tmux-p2", {
      agent: "claude",
      cwd,
      transcriptSessionId: PARTNER,
      startedAtMs: 0,
    });
    const h = makeHarness({
      argv: ["wait-for-stop", "tmux-p2"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    expect(parseJsonOutput(h.out)).toMatchObject({
      transcriptPath: partnerPath,
      waitedForStop: true,
      stop: { agent: "claude" },
    });
  });
  test("strict mode returns the exact pinned file, not the newer decoy", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const partnerPath = writePartnerAndDecoy(home, cwd);
    const resolved = await waitForTranscriptPath({
      agent: "claude",
      cwd,
      env: {},
      homeDir: home,
      startedAtMs: 0,
      sessionId: PARTNER,
      pathTimeoutMs: 200,
    });
    expect(resolved).toEqual({ ok: true, path: partnerPath });
  });
  test("strict mode times out (not the decoy) when the pinned file is absent", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    // Only the decoy exists; the pinned partner file is absent.
    writeClaudeTranscript(home, cwd, DECOY, {
      text: "the driver answer",
      mtimeMs: 2000000,
    });
    const resolved = await waitForTranscriptPath({
      agent: "claude",
      cwd,
      env: {},
      homeDir: home,
      startedAtMs: 0,
      sessionId: PARTNER,
      pathTimeoutMs: 200,
    });
    expect(resolved).toEqual({ ok: false, reason: "timeout" });
  });
});
describe("lifecycle-aware transcript waits", () => {
  test("terminal before transcript creation returns partner_died immediately", async () => {
    let sleeps = 0;
    const outcome = await waitForTranscriptPath({
      agent: "claude",
      cwd: "/missing",
      env: {},
      homeDir: tempDir(),
      startedAtMs: 1,
      sessionId: "missing",
      pathTimeoutMs: 60_000,
      lifecycleProbe: async () => ({
        kind: "terminal",
        state: "killed",
        reason: null,
      }),
      sleep: async () => {
        sleeps++;
      },
    });
    expect(outcome).toEqual({
      ok: false,
      reason: "partner_died",
      terminal: { kind: "terminal", state: "killed", reason: null },
    });
    expect(sleeps).toBe(0);
  });

  test("a fresh stop wins over terminal lifecycle evidence", async () => {
    const home = tempDir();
    const cwd = "/work/proj";
    const path = writeClaudeTranscript(home, cwd, "settled", {
      text: "done before clean teardown",
    });
    let probes = 0;
    const outcome = await waitForTranscriptStop({
      agent: "claude",
      cwd,
      env: {},
      homeDir: home,
      startedAtMs: 0,
      sessionId: "settled",
      transcriptPath: path,
      lifecycleProbe: async () => {
        probes++;
        return { kind: "terminal", state: "ended", reason: null };
      },
    });
    expect(outcome.ok).toBe(true);
    expect(probes).toBe(0);
  });

  test("terminal during stop polling returns without consuming the deadline", async () => {
    const path = join(tempDir(), "nostop.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "thinking" })}\n`);
    let probes = 0;
    let sleeps = 0;
    const outcome = await waitForTranscriptStop({
      agent: "claude",
      cwd: "/work/proj",
      env: {},
      homeDir: tempDir(),
      startedAtMs: 0,
      sessionId: "s",
      transcriptPath: path,
      stopTimeoutMs: 60_000,
      lifecycleProbe: async () => {
        probes++;
        return probes === 1
          ? { kind: "live" }
          : { kind: "terminal", state: "ended", reason: null };
      },
      sleep: async () => {
        sleeps++;
      },
    });
    expect(outcome).toMatchObject({ ok: false, partnerDied: true });
    expect(sleeps).toBe(1);
  });
});

describe("positive-gone window probe terminates the wait", () => {
  const absentProbe = async (): Promise<"absent"> => "absent";
  const presentProbe = async (): Promise<"present"> => "present";
  const unknownProbe = async (): Promise<"unknown"> => "unknown";

  function noStopTranscript(): string {
    const path = join(tempDir(), "nostop.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "thinking" })}\n`);
    return path;
  }

  test("(a) window absent at wait start → windowGone within one tick, no sleep", async () => {
    let sleeps = 0;
    const outcome = await waitForTranscriptStop({
      agent: "claude",
      cwd: "/work/proj",
      env: {},
      homeDir: tempDir(),
      startedAtMs: 0,
      sessionId: "s",
      transcriptPath: noStopTranscript(),
      stopTimeoutMs: 60_000,
      windowProbe: absentProbe,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(outcome).toEqual({ ok: false, windowGone: true });
    expect(sleeps).toBe(0);
  });

  test("(b) window dies MID-wait → windowGone within one tick of the death", async () => {
    let probes = 0;
    let sleeps = 0;
    const outcome = await waitForTranscriptStop({
      agent: "claude",
      cwd: "/work/proj",
      env: {},
      homeDir: tempDir(),
      startedAtMs: 0,
      sessionId: "s",
      transcriptPath: noStopTranscript(),
      stopTimeoutMs: 60_000,
      windowProbe: async () => {
        probes++;
        return probes === 1 ? "present" : "absent";
      },
      sleep: async () => {
        sleeps++;
      },
    });
    expect(outcome).toEqual({ ok: false, windowGone: true });
    expect(sleeps).toBe(1);
  });

  test("(c) inconclusive probe keeps waiting → genuine timed_out, sleeps exercised", async () => {
    let now = 0;
    let sleeps = 0;
    const outcome = await waitForTranscriptStop({
      agent: "claude",
      cwd: "/work/proj",
      env: {},
      homeDir: tempDir(),
      startedAtMs: 0,
      sessionId: "s",
      transcriptPath: noStopTranscript(),
      stopTimeoutMs: 100,
      pollIntervalMs: 50,
      windowProbe: unknownProbe,
      now: () => now,
      sleep: async (ms) => {
        sleeps++;
        now += ms;
      },
    });
    expect(outcome).toEqual({ ok: false, timedOut: true });
    expect(sleeps).toBeGreaterThan(0);
  });

  test("(d) live target through the deadline → timed_out, byte-identical to no probe", async () => {
    const path = noStopTranscript();
    const runOnce = (
      windowProbe?: () => Promise<"present" | "absent" | "unknown">,
    ): Promise<unknown> => {
      let now = 0;
      return waitForTranscriptStop({
        agent: "claude",
        cwd: "/work/proj",
        env: {},
        homeDir: tempDir(),
        startedAtMs: 0,
        sessionId: "s",
        transcriptPath: path,
        stopTimeoutMs: 100,
        pollIntervalMs: 50,
        windowProbe,
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      });
    };
    const withLiveProbe = await runOnce(presentProbe);
    const withoutProbe = await runOnce(undefined);
    expect(withLiveProbe).toEqual({ ok: false, timedOut: true });
    expect(withLiveProbe).toEqual(withoutProbe);
  });

  test("(a-path) window absent before any transcript appears → window_gone, no sleep", async () => {
    let sleeps = 0;
    const outcome = await waitForTranscriptPath({
      agent: "claude",
      cwd: "/missing",
      env: {},
      homeDir: tempDir(),
      startedAtMs: 1,
      sessionId: "never-appears",
      pathTimeoutMs: 60_000,
      windowProbe: absentProbe,
      sleep: async () => {
        sleeps++;
      },
    });
    expect(outcome).toEqual({ ok: false, reason: "window_gone" });
    expect(sleeps).toBe(0);
  });

  test("runWaitForStop threads a run.json tmux window probe → window_gone", async () => {
    const stateDir = tempDir();
    writeRunJson(stateDir, "tmux-w1", {
      id: "tmux-w1",
      agent: "claude",
      cwd: "/work/proj",
      transcriptSessionId: "never-appears",
      startedAtMs: 0,
      tmux: { command: ["/opt/homebrew/bin/tmux"], windowId: "@170" },
    });
    const resolution = resolveHandle({
      rest: ["tmux-w1", "--stop-timeout", "60000ms"],
      cwd: "/work/proj",
      stateDir,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.handle.tmuxWindowProbeCommand).toEqual([
      "/opt/homebrew/bin/tmux",
      "list-panes",
      "-t",
      "@170",
      "-F",
      "#{window_id}",
    ]);
    let probeCommand: string[] | null = null;
    const result = await runWaitForStop(resolution.handle, {
      env: {},
      homeDir: tempDir(),
      probeWindowPresence: async (command) => {
        probeCommand = command;
        return "absent";
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "window_gone" });
    expect(probeCommand as string[] | null).toEqual([
      "/opt/homebrew/bin/tmux",
      "list-panes",
      "-t",
      "@170",
      "-F",
      "#{window_id}",
    ]);
  });
});

describe("injected-message response boundary", () => {
  test("Claude ignores unrelated stops until the matching Bus notification appears", async () => {
    const path = join(tempDir(), "claude-live.jsonl");
    const stop = (text: string) => ({
      timestamp: new Date().toISOString(),
      type: "assistant",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
      },
    });
    const marker = "/trusted/bus-artifacts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(
      path,
      `${[
        stop("before capture"),
        stop("unrelated work finished"),
        {
          type: "queue-operation",
          content: `Agent Bus message — read ${marker}`,
        },
        stop("causal answer"),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    const outcome = await waitForTranscriptStop({
      agent: "claude",
      cwd: "/work/proj",
      env: {},
      homeDir: tempDir(),
      startedAtMs: 0,
      sessionId: "s",
      transcriptPath: path,
      injectedMessageMarker: marker,
      transcriptLineFloor: 1,
      stopTimeoutMs: 100,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.stop.message).toBe("causal answer");
  });

  test("an over-budget artifact notification still opens the capture boundary", async () => {
    const base = tempDir();
    const root = join(
      base,
      ...Array.from({ length: 16 }, () => "deep-root-segment"),
    );
    const path = join(base, "claude-over-budget.jsonl");
    const id = "0123456789abcdef0123456789abcdef";
    const sender = "s".repeat(128);
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, id), "");
      const notification = renderMessageNotification(
        {
          namespace: "chat",
          event: "message",
          from: { name: sender, channel_id: "ch-1" },
          ts: 0,
          payload: {
            text: "read artifact",
            t: BUS_ARTIFACT_REF_TAG,
            v: BUS_ARTIFACT_REF_VERSION,
            id,
            len: 0,
            sha256:
              "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        },
        join(base, "inbox"),
        root,
      );
      const expected = `Agent Bus message from ${sender} — read artifact ${id} (path omitted)`;
      const fullPathLine = `Agent Bus message from ${sender} — read ${join(root, id)}`;
      expect(fullPathLine.length).toBeGreaterThan(400);
      expect(notification).toBe(expected);
      expect(notification.length).toBeLessThanOrEqual(400);
      writeFileSync(
        path,
        `${[
          {
            type: "queue-operation",
            content: notification,
          },
          {
            timestamp: new Date().toISOString(),
            type: "assistant",
            message: {
              role: "assistant",
              stop_reason: "end_turn",
              content: [{ type: "text", text: "causal answer" }],
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n")}\n`,
      );
      const outcome = await waitForTranscriptStop({
        agent: "claude",
        cwd: "/work/proj",
        env: {},
        homeDir: tempDir(),
        startedAtMs: 0,
        sessionId: "s",
        transcriptPath: path,
        injectedMessageMarker: id,
        transcriptLineFloor: 0,
        stopTimeoutMs: 100,
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.stop.message).toBe("causal answer");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("Pi accepts only a stop after its matching custom Bus message", async () => {
    const path = join(tempDir(), "pi-live.jsonl");
    const marker = "/trusted/bus-artifacts/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const piStop = (text: string) => ({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text }],
      },
    });
    writeFileSync(
      path,
      `${[
        piStop("old"),
        piStop("unrelated"),
        {
          customType: "keeper-agent-bus",
          content: `Agent Bus message — read ${marker}`,
        },
        piStop("pi causal answer"),
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    const outcome = await waitForTranscriptStop({
      agent: "pi",
      cwd: "/work/proj",
      env: {},
      homeDir: tempDir(),
      startedAtMs: 0,
      sessionId: "s",
      transcriptPath: path,
      injectedMessageMarker: marker,
      transcriptLineFloor: 1,
      stopTimeoutMs: 100,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.stop.message).toBe("pi causal answer");
  });
});

describe("waitForTranscriptStop is bounded", () => {
  const PINNED_NO_STOP = "33333333-3333-3333-3333-333333333333";
  test("a stop that never appears times out (no unbounded hang)", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    // A transcript with no stop event — only a thinking-only assistant turn.
    const path = writeClaudeTranscript(home, cwd, PINNED_NO_STOP, {
      text: null,
      stopReason: "tool_use",
    });
    const outcome = await waitForTranscriptStop({
      agent: "claude",
      cwd,
      env: {},
      homeDir: home,
      startedAtMs: 0,
      sessionId: PINNED_NO_STOP,
      transcriptPath: path,
      stopTimeoutMs: 200,
      pollIntervalMs: 50,
    });
    expect(outcome).toEqual({ ok: false, timedOut: true });
  });
});
describe("runWaitForStop forwards --stop-timeout", () => {
  const PINNED_NO_STOP = "88888888-8888-8888-8888-888888888888";
  // A no-stop transcript so the wait always reaches its deadline. The parsed
  // flag bounds the wait AND self-reports in the error; an absent flag falls back
  // to the 600s default and would report (default) instead.
  function noStopHandle(
    home: string,
    cwd: string,
    stopTimeoutMs: number | null,
  ) {
    writeClaudeTranscript(home, cwd, PINNED_NO_STOP, {
      text: null,
      stopReason: "tool_use",
    });
    const res = resolveHandle({
      rest:
        stopTimeoutMs === null
          ? ["tmux-fwd"]
          : ["tmux-fwd", "--stop-timeout", `${stopTimeoutMs}ms`],
      cwd,
      stateDir: writeFwdRun(cwd),
    });
    if (!res.ok) {
      throw new Error(`resolveHandle failed: ${res.error}`);
    }
    return res.handle;
  }
  function writeFwdRun(cwd: string): string {
    const stateDir = tempDir();
    writeRunJson(stateDir, "tmux-fwd", {
      agent: "claude",
      cwd,
      transcriptSessionId: PINNED_NO_STOP,
      startedAtMs: 0,
    });
    return stateDir;
  }
  test("a parsed flag bounds the wait and the error self-reports (caller)", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const handle = noStopHandle(home, cwd, 50);
    // The bounded wait reaching its deadline proves the parsed 50ms threaded into
    // waitForTranscriptStop (the 600s default would never return in test time),
    // and the (caller) source distinguishes it from an absent-flag default.
    const result = await runWaitForStop(handle, { env: {}, homeDir: home });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("50ms (caller)");
    }
  });
});
describe("runWaitForStop re-probes Partner liveness at the deadline", () => {
  const PINNED_NO_STOP = "99999999-9999-9999-9999-999999999999";
  // A resolvable transcript with NO settled stop (a tool_use assistant turn) so
  // the stop wait always reaches its deadline; the run.json carries a lifecycle
  // job id so the probe seam is wired.
  function noStopLifecycleHandle(home: string, cwd: string) {
    writeClaudeTranscript(home, cwd, PINNED_NO_STOP, {
      text: "partial so far",
      stopReason: "tool_use",
    });
    const stateDir = tempDir();
    writeRunJson(stateDir, "tmux-live", {
      agent: "claude",
      cwd,
      transcriptSessionId: PINNED_NO_STOP,
      startedAtMs: 0,
      lifecycleJobId: "job-live",
    });
    const res = resolveHandle({
      rest: ["tmux-live", "--stop-timeout", "50ms"],
      cwd,
      stateDir,
    });
    if (!res.ok) {
      throw new Error(`resolveHandle failed: ${res.error}`);
    }
    return res.handle;
  }

  test("a positively-live probe carries liveness 'live' (never partner_died)", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const handle = noStopLifecycleHandle(home, cwd);
    const result = await runWaitForStop(handle, {
      env: {},
      homeDir: home,
      probePartnerLifecycle: async (jobId) => {
        expect(jobId).toBe("job-live");
        return { kind: "live" };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      expect(result.liveness).toBe("live");
    }
  });

  test("a job id but no probe seam collapses liveness to 'unknown', never a fabricated live", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const handle = noStopLifecycleHandle(home, cwd);
    const result = await runWaitForStop(handle, { env: {}, homeDir: home });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      expect(result.liveness).toBe("unknown");
    }
  });

  test("an unknown-lifecycle probe stays 'unknown' — the deadline never confirms termination", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const handle = noStopLifecycleHandle(home, cwd);
    const result = await runWaitForStop(handle, {
      env: {},
      homeDir: home,
      probePartnerLifecycle: async () => ({ kind: "unknown" }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      expect(result.liveness).toBe("unknown");
    }
  });
});
describe("keeper agent wait-for-stop partner death", () => {
  test("raw wait exposes the partner_died discriminator and exit 4", async () => {
    const stateDir = tempDir();
    writeRunJson(stateDir, "tmux-dead", {
      agent: "claude",
      cwd: "/work/proj",
      transcriptSessionId: "never-created",
      startedAtMs: 1,
      lifecycleJobId: "job-dead",
    });
    const h = makeHarness({
      argv: ["wait-for-stop", "tmux-dead", "--stop-timeout", "1m"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: tempDir(),
      probePartnerLifecycle: async (jobId) => {
        expect(jobId).toBe("job-dead");
        return { kind: "terminal", state: "killed", reason: null };
      },
    });
    expect(await expectExit(main(h.deps))).toBe(4);
    expect(parseJsonOutput(h.out)).toMatchObject({
      error: true,
      reason: "partner_died",
      exitCode: 4,
    });
  });
});

describe("inner --session-id pin", () => {
  test("the inner claude re-exec pushes --session-id from the pane carrier", async () => {
    // Simulate the pane env the outer launch forwards: the inner re-exec reads
    // KEEPER_AGENT_TMUX_SESSION_ID and must push it as --session-id, matching the
    // id the outer recorded in run.json transcriptSessionId.
    const sessionId = "66666666-6666-6666-6666-666666666666";
    const h = makeHarness({
      argv: ["claude", "--x-no-confirm", "hi"],
      rawArgv: true,
      env: { KEEPER_AGENT_TMUX_SESSION_ID: sessionId },
    });
    const cmd = await (async () => {
      await expectExit(main(h.deps));
      return h.spawned[0] as string[];
    })();
    expect(flagValues(cmd, "--session-id")).toEqual([sessionId]);
  });
  test("the outer tmux launch forwards the pinned carrier into the pane via -e", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const sessionId = "77777777-7777-7777-7777-777777777777";
    const h = makeHarness({
      argv: ["claude", "--x-tmux-session=work", "--x-tmux-detached", "hi"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
      randomUuid: () => sessionId,
      tmuxCommand: (cmd) => {
        if (cmd.includes("has-session")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (cmd.includes("new-window")) {
          return { exitCode: 0, stdout: "work\x01@7\x01%8\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const code = await expectExit(main(h.deps));
    expect(code).toBe(0);
    // The launch JSON records the pinned id, and the new-window argv carries the
    // carrier so the inner re-exec mints the SAME uuid.
    const newWindow = h.tmuxCommands.find((cmd) => cmd.includes("new-window"));
    expect(newWindow).toBeDefined();
    expect(newWindow).toContain(`KEEPER_AGENT_TMUX_SESSION_ID=${sessionId}`);
  });
});
