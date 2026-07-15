import { describe, expect, test } from "bun:test";
import {
  buildCodexResetCaptureArgv,
  buildCodexResetKillSessionArgv,
  buildCodexResetLiteralSendArgv,
  buildCodexResetNamedKeyArgv,
  buildCodexResetNewSessionArgv,
  CODEX_RESET_CAPTURE_MAX_BYTES,
  CODEX_RESET_TMUX_COLUMNS,
  CODEX_RESET_TMUX_ROWS,
  type CodexResetClock,
  type CodexResetCommandResult,
  type CodexResetCommandRunner,
  createCodexResetTmuxTerminal,
  resolveCodexResetBinaries,
} from "../src/codex-reset-tmux";

const TMUX = "/opt/tools/tmux exact";
const CODEX = "/opt/tools/codex exact";
const SESSION = "keeper-codex-reset-7";
const HOME = "/Users/example home";

interface Call {
  argv: string[];
  deadlineMs: number;
  maxOutputBytes: number;
}

class FakeRunner implements CodexResetCommandRunner {
  readonly calls: Call[] = [];
  readonly results: CodexResetCommandResult[] = [];

  async run(
    argv: readonly string[],
    options: { deadlineMs: number; maxOutputBytes: number },
  ): Promise<CodexResetCommandResult> {
    this.calls.push({ argv: [...argv], ...options });
    return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

class FakeClock implements CodexResetClock {
  nowMs = 1_000;
  readonly sleeps: number[] = [];

  now(): number {
    return this.nowMs;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.nowMs += ms;
  }
}

describe("Codex reset tmux argv builders", () => {
  test("resolves exact binary overrides", () => {
    expect(
      resolveCodexResetBinaries({
        KEEPER_TMUX_BIN: TMUX,
        KEEPER_CODEX_BIN: CODEX,
      }),
    ).toEqual({ tmuxBin: TMUX, codexBin: CODEX });
    expect(resolveCodexResetBinaries({})).toEqual({
      tmuxBin: "tmux",
      codexBin: "codex",
    });
  });

  test("launch is detached at fixed geometry from HOME with Codex argv after --", () => {
    expect(
      buildCodexResetNewSessionArgv({
        tmuxBin: TMUX,
        codexBin: CODEX,
        session: SESSION,
        home: HOME,
      }),
    ).toEqual([
      TMUX,
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      String(CODEX_RESET_TMUX_COLUMNS),
      "-y",
      String(CODEX_RESET_TMUX_ROWS),
      "-c",
      HOME,
      "--",
      CODEX,
      "-c",
      "check_for_update_on_startup=false",
    ]);
  });

  test("capture, literal, named-key, and dedicated cleanup argv are exact", () => {
    expect(buildCodexResetCaptureArgv(TMUX, SESSION)).toEqual([
      TMUX,
      "capture-pane",
      "-p",
      "-J",
      "-t",
      `=${SESSION}`,
    ]);
    expect(buildCodexResetLiteralSendArgv(TMUX, SESSION, "/usage")).toEqual([
      TMUX,
      "send-keys",
      "-l",
      "-t",
      `=${SESSION}`,
      "--",
      "/usage",
    ]);
    expect(buildCodexResetNamedKeyArgv(TMUX, SESSION, "Down")).toEqual([
      TMUX,
      "send-keys",
      "-t",
      `=${SESSION}`,
      "--",
      "Down",
    ]);
    expect(buildCodexResetKillSessionArgv(TMUX, SESSION)).toEqual([
      TMUX,
      "kill-session",
      "-t",
      `=${SESSION}`,
    ]);
  });

  test("builders contain no shell wrapper; Codex's config -c is structural", () => {
    const argv = buildCodexResetNewSessionArgv({
      tmuxBin: TMUX,
      codexBin: CODEX,
      session: SESSION,
      home: HOME,
    });
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("bash");
    const separator = argv.indexOf("--");
    expect(argv.slice(separator + 1)).toEqual([
      CODEX,
      "-c",
      "check_for_update_on_startup=false",
    ]);
    expect(argv.slice(0, separator)).toContain("-c");
    expect(argv.slice(separator + 1).filter((arg) => arg === "-c")).toEqual([
      "-c",
    ]);
  });
});

describe("Codex reset tmux terminal", () => {
  test("executes only exact argv with command deadlines and bounded capture", async () => {
    const runner = new FakeRunner();
    const clock = new FakeClock();
    runner.results.push(
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "screen", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    );
    const terminal = createCodexResetTmuxTerminal({
      session: SESSION,
      env: {
        HOME,
        KEEPER_TMUX_BIN: TMUX,
        KEEPER_CODEX_BIN: CODEX,
      },
      runner,
      clock,
      commandTimeoutMs: 500,
      captureMaxBytes: 6,
      captureSettleMs: 25,
    });

    await terminal.start();
    await terminal.sendLiteral("/usage");
    expect(await terminal.capture(200)).toBe("screen");
    await terminal.sendKey("Enter");
    await terminal.close();
    await terminal.close();

    expect(clock.sleeps).toEqual([25]);
    expect(runner.calls.map((call) => call.argv)).toEqual([
      buildCodexResetNewSessionArgv({
        tmuxBin: TMUX,
        codexBin: CODEX,
        session: SESSION,
        home: HOME,
      }),
      buildCodexResetLiteralSendArgv(TMUX, SESSION, "/usage"),
      buildCodexResetCaptureArgv(TMUX, SESSION),
      buildCodexResetNamedKeyArgv(TMUX, SESSION, "Enter"),
      buildCodexResetKillSessionArgv(TMUX, SESSION),
    ]);
    expect(runner.calls.map((call) => call.deadlineMs)).toEqual([
      1_500, 1_500, 1_200, 1_525, 1_525,
    ]);
    expect(runner.calls.every((call) => call.maxOutputBytes === 6)).toBe(true);
  });

  test("caps captured output even when a runner violates its requested cap", async () => {
    const runner = new FakeRunner();
    const clock = new FakeClock();
    runner.results.push({
      exitCode: 0,
      stdout: "0123456789",
      stderr: "",
    });
    const terminal = createCodexResetTmuxTerminal({
      session: SESSION,
      env: { HOME },
      runner,
      clock,
      captureMaxBytes: 4,
      captureSettleMs: 0,
    });
    expect(await terminal.capture(100)).toBe("0123");
  });

  test("nonzero and timeout results throw and are not retried", async () => {
    const runner = new FakeRunner();
    const clock = new FakeClock();
    runner.results.push(
      { exitCode: 7, stdout: "", stderr: "bad tmux" },
      { exitCode: -1, stdout: "", stderr: "", timedOut: true },
    );
    const terminal = createCodexResetTmuxTerminal({
      session: SESSION,
      env: { HOME },
      runner,
      clock,
      captureSettleMs: 0,
    });

    expect(terminal.sendKey("Down")).rejects.toThrow("exited 7: bad tmux");
    expect(terminal.sendKey("Enter")).rejects.toThrow("timed out");
    expect(runner.calls).toHaveLength(2);
  });

  test("requires HOME and never broadens cleanup beyond the supplied session", async () => {
    expect(() =>
      createCodexResetTmuxTerminal({
        session: SESSION,
        env: {},
        runner: new FakeRunner(),
        clock: new FakeClock(),
      }),
    ).toThrow("HOME must be nonempty");

    const runner = new FakeRunner();
    const terminal = createCodexResetTmuxTerminal({
      session: "only-this-session",
      env: { HOME },
      runner,
      clock: new FakeClock(),
    });
    await terminal.close();
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.argv).toEqual([
      "tmux",
      "kill-session",
      "-t",
      "=only-this-session",
    ]);
    expect(runner.calls[0]?.maxOutputBytes).toBe(CODEX_RESET_CAPTURE_MAX_BYTES);
  });
});
