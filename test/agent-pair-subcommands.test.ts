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
  defaultTranscriptPathTimeoutMs,
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

test("Pi transcript discovery tolerates cold profile package startup", () => {
  expect(defaultTranscriptPathTimeoutMs("pi")).toBe(120_000);
  expect(defaultTranscriptPathTimeoutMs("claude")).toBe(30_000);
  expect(defaultTranscriptPathTimeoutMs("codex")).toBe(30_000);
});

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

function writeCodexTranscript(
  home: string,
  cwd: string,
  opts: { stopped?: boolean; finalMessage?: string | null } = {},
): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const dir = join(home, ".codex", "sessions", year, month, day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-2026-06-22T00-00-00-test.jsonl");
  const lines = [
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: "codex-session", cwd },
    }),
  ];
  if (opts.stopped) {
    const payload: Record<string, unknown> = { type: "task_complete" };
    if (opts.finalMessage !== undefined && opts.finalMessage !== null) {
      payload.last_agent_message = opts.finalMessage;
    }
    lines.push(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload,
      }),
    );
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function writeClaudeTranscript(
  home: string,
  cwd: string,
  sessionId: string,
  opts: { text?: string | null; stopReason?: string; mtimeMs?: number } = {},
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

  test("a transcript path handle with --agent resolves to itself", () => {
    const res = resolveHandle({
      rest: ["/tmp/x.jsonl", "--agent", "codex"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res).toMatchObject({
      ok: true,
      handle: { agent: "codex", transcriptPath: "/tmp/x.jsonl" },
    });
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

  test("--stop-timeout (space form) lands on the handle, flag before handle", () => {
    const res = resolveHandle({
      rest: ["--stop-timeout", "30m", "/tmp/x.jsonl", "--agent", "codex"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res).toMatchObject({
      ok: true,
      handle: { agent: "codex", stopTimeoutMs: 1_800_000 },
    });
  });

  test("--stop-timeout=<dur> (equals form) lands on the handle, flag after handle", () => {
    const res = resolveHandle({
      rest: ["/tmp/x.jsonl", "--agent=claude", "--stop-timeout=30m"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res).toMatchObject({
      ok: true,
      handle: { agent: "claude", stopTimeoutMs: 1_800_000 },
    });
  });

  test("absent --stop-timeout leaves stopTimeoutMs null", () => {
    const res = resolveHandle({
      rest: ["/tmp/x.jsonl", "--agent", "codex"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res).toMatchObject({
      ok: true,
      handle: { stopTimeoutMs: null },
    });
  });

  test.each(["abc", "0", "1500", "-5", "1.5", ""])(
    "a malformed --stop-timeout value (%p) errors",
    (value) => {
      const res = resolveHandle({
        rest: ["/tmp/x.jsonl", "--agent", "codex", "--stop-timeout", value],
        cwd: "/c",
        stateDir: tempDir(),
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("--stop-timeout");
      }
    },
  );

  test("--stop-timeout with no value errors", () => {
    const res = resolveHandle({
      rest: ["/tmp/x.jsonl", "--agent", "codex", "--stop-timeout"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res.ok).toBe(false);
  });

  test("the retired --stop-timeout-ms spelling hard-fails", () => {
    const res = resolveHandle({
      rest: ["/tmp/x.jsonl", "--agent", "codex", "--stop-timeout-ms=1800000"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res.ok).toBe(false);
  });

  test("a genuinely-unknown flag is still rejected", () => {
    const res = resolveHandle({
      rest: ["/tmp/x.jsonl", "--agent", "codex", "--bogus-flag"],
      cwd: "/c",
      stateDir: tempDir(),
    });
    expect(res.ok).toBe(false);
  });
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

  test("codex: extracts last_agent_message from task_complete", () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const path = writeCodexTranscript(home, cwd, {
      stopped: true,
      finalMessage: "the final codex answer",
    });
    expect(findLastMessage("codex", path)).toEqual({
      agent: "codex",
      text: "the final codex answer",
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

  test("no transcript → found:false", () => {
    expect(findLastMessage("codex", "/nonexistent/x.jsonl")).toEqual({
      agent: "codex",
      text: null,
      found: false,
    });
  });
});

describe("keeper agent wait-for-stop", () => {
  test("codex: resolves the handle and returns the stop event", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const transcriptPath = writeCodexTranscript(home, cwd, {
      stopped: true,
      finalMessage: "done",
    });
    writeRunJson(stateDir, "tmux-c1", {
      agent: "codex",
      cwd,
      transcriptSessionId: null,
      startedAtMs: 0,
    });
    const h = makeHarness({
      argv: ["wait-for-stop", "tmux-c1"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(parseJsonOutput(h.out)).toMatchObject({
      schema_version: 1,
      agent: "codex",
      transcriptPath,
      waitedForStop: true,
      stop: { agent: "codex", eventType: "task_complete", message: "done" },
    });
  });

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

  test("a malformed --stop-timeout exits bad_args (2), never retryable (4)", async () => {
    const stateDir = tempDir();
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    writeRunJson(stateDir, "tmux-bad1", {
      agent: "codex",
      cwd,
      transcriptSessionId: null,
      startedAtMs: 0,
    });
    const h = makeHarness({
      argv: ["wait-for-stop", "tmux-bad1", "--stop-timeout", "abc"],
      rawArgv: true,
      launcherStateDir: stateDir,
      transcriptHomeDir: home,
      cwd,
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

  test("codex: extracts last_agent_message from a path handle + --agent", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const transcriptPath = writeCodexTranscript(home, cwd, {
      stopped: true,
      finalMessage: "codex final answer",
    });
    const h = makeHarness({
      argv: ["show-last-message", transcriptPath, "--agent", "codex"],
      rawArgv: true,
      transcriptHomeDir: home,
      cwd,
    });

    const code = await expectExit(main(h.deps));

    expect(code).toBe(0);
    expect(h.out.join("")).toStartWith("codex final answer\n");
    expect(parseJsonOutput(h.out)).toMatchObject({
      agent: "codex",
      found: true,
      message: "codex final answer",
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

describe("removed --wait-for-stop flag", () => {
  test("--wait-for-stop after an agent token is no longer wrapper-consumed", async () => {
    // It is not a tmux flag anymore, so tmux mode is NOT entered and it falls
    // through verbatim into the agent argv (the agent would reject it loudly).
    const h = makeHarness({
      argv: ["codex", "--x-no-confirm", "--wait-for-stop", "hi"],
      rawArgv: true,
    });

    await expectExit(main(h.deps));

    expect(h.spawned.length).toBe(1);
    expect(h.spawned[0]).toContain("--wait-for-stop");
    // No tmux launch occurred.
    expect(h.tmuxCommands).toEqual([]);
  });
});

describe("pinned transcript resolution (decoy collision)", () => {
  // The self-transcript collision: a concurrently-writing driver in the same
  // project dir writes a NEWER-mtime file. A pinned partner session must resolve
  // its EXACT transcript, never the newer decoy.
  const PARTNER = "11111111-1111-1111-1111-111111111111";
  const DECOY = "22222222-2222-2222-2222-222222222222";

  function writePartnerAndDecoy(home: string, cwd: string): string {
    const partnerPath = writeClaudeTranscript(home, cwd, PARTNER, {
      text: "the partner answer",
      mtimeMs: 1_000_000,
    });
    // The decoy is the newest file in the project dir — it would win a
    // newest-by-mtime fallback.
    writeClaudeTranscript(home, cwd, DECOY, {
      text: "the driver answer",
      mtimeMs: 2_000_000,
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
      mtimeMs: 2_000_000,
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

describe("codex transcript attribution (concurrent-session collision)", () => {
  const LEG_ID = "019eec40-1111-7142-9363-5c1535537ee6";
  const CONCURRENT_ID = "019eec41-2222-7163-afa1-7facaaf72122";
  const SECOND_LEG_ID = "019eec42-3333-7163-afa1-7facaaf72133";

  /**
   * Fabricate a codex rollout with independently-controlled attribution signals:
   * `createdAtMs` (its `session_meta` timestamp — the creation instant the fix
   * keys on) and `mtimeMs` (its filesystem mtime — a concurrent session's keeps
   * advancing past launch). The filename embeds `id` for the resume-target parse.
   */
  function writeCodexRollout(
    home: string,
    opts: {
      id: string;
      cwd: string;
      createdAtMs: number;
      mtimeMs: number;
    },
  ): string {
    const created = new Date(opts.createdAtMs);
    const year = String(created.getFullYear());
    const month = String(created.getMonth() + 1).padStart(2, "0");
    const day = String(created.getDate()).padStart(2, "0");
    const dir = join(home, ".codex", "sessions", year, month, day);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `rollout-2026-07-01T22-48-06-${opts.id}.jsonl`);
    writeFileSync(
      path,
      `${JSON.stringify({
        timestamp: created.toISOString(),
        type: "session_meta",
        payload: { id: opts.id, cwd: opts.cwd },
      })}\n${JSON.stringify({
        timestamp: new Date(opts.mtimeMs).toISOString(),
        type: "event_msg",
        payload: { type: "task_complete", last_agent_message: "answer" },
      })}\n`,
    );
    const seconds = opts.mtimeMs / 1000;
    utimesSync(path, seconds, seconds);
    return path;
  }

  test("finds the leg's own rollout beside a fresher pre-launch concurrent session", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const launchMs = Date.parse("2026-07-01T22:48:02Z");
    // A concurrent human session created 2.3 min BEFORE launch, still being
    // written (mtime advances past launch) — the exact wrong-file trap.
    writeCodexRollout(home, {
      id: CONCURRENT_ID,
      cwd,
      createdAtMs: launchMs - 136_000,
      mtimeMs: launchMs + 30_000,
    });
    // The leg's own rollout, created just after launch.
    const legPath = writeCodexRollout(home, {
      id: LEG_ID,
      cwd,
      createdAtMs: launchMs + 4_000,
      mtimeMs: launchMs + 20_000,
    });

    const resolved = await waitForTranscriptPath({
      agent: "codex",
      cwd,
      env: { CODEX_HOME: join(home, ".codex") },
      homeDir: home,
      startedAtMs: launchMs,
      sessionId: null,
      pathTimeoutMs: 200,
    });
    expect(resolved).toEqual({ ok: true, path: legPath });
  });

  test("two post-launch same-cwd rollouts collide → ambiguous, never a guess", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const launchMs = Date.parse("2026-07-01T22:48:02Z");
    writeCodexRollout(home, {
      id: LEG_ID,
      cwd,
      createdAtMs: launchMs + 2_000,
      mtimeMs: launchMs + 10_000,
    });
    writeCodexRollout(home, {
      id: SECOND_LEG_ID,
      cwd,
      createdAtMs: launchMs + 5_000,
      mtimeMs: launchMs + 20_000,
    });

    const resolved = await waitForTranscriptPath({
      agent: "codex",
      cwd,
      env: { CODEX_HOME: join(home, ".codex") },
      homeDir: home,
      startedAtMs: launchMs,
      sessionId: null,
      pathTimeoutMs: 200,
    });
    expect(resolved).toEqual({ ok: false, reason: "ambiguous" });
  });

  test("only a pre-launch concurrent rollout exists → times out, never attaches", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const launchMs = Date.parse("2026-07-01T22:48:02Z");
    // A same-cwd session created before launch, mtime still advancing — must NOT
    // be attributed to the leg; the leg's own file simply never appeared.
    writeCodexRollout(home, {
      id: CONCURRENT_ID,
      cwd,
      createdAtMs: launchMs - 136_000,
      mtimeMs: launchMs + 30_000,
    });

    const resolved = await waitForTranscriptPath({
      agent: "codex",
      cwd,
      env: { CODEX_HOME: join(home, ".codex") },
      homeDir: home,
      startedAtMs: launchMs,
      sessionId: null,
      pathTimeoutMs: 60,
      pollIntervalMs: 20,
    });
    expect(resolved).toEqual({ ok: false, reason: "timeout" });
  });

  test("a same-instant rollout in a DIFFERENT cwd is not the leg's → times out", async () => {
    const home = tempDir();
    const cwd = "/fake-home/code/proj";
    const launchMs = Date.parse("2026-07-01T22:48:02Z");
    writeCodexRollout(home, {
      id: CONCURRENT_ID,
      cwd: "/fake-home/code/other",
      createdAtMs: launchMs + 3_000,
      mtimeMs: launchMs + 10_000,
    });

    const resolved = await waitForTranscriptPath({
      agent: "codex",
      cwd,
      env: { CODEX_HOME: join(home, ".codex") },
      homeDir: home,
      startedAtMs: launchMs,
      sessionId: null,
      pathTimeoutMs: 60,
      pollIntervalMs: 20,
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
