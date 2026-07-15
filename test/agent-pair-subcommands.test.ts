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
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/agent/main";
import { resolveHandle, runWaitForStop } from "../src/agent/pair-subcommands";
import {
  findLastMessage,
  waitForTranscriptPath,
  waitForTranscriptStop,
} from "../src/agent/transcript-watch";
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
