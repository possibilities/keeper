/**
 * The shared launch→{@link ResolvedHandle} helper (`src/agent/launch-handle.ts`)
 * that backs `agent run` and its panel legs (a bare run is posture-free, a leg
 * fills the full posture).
 *
 * Coverage:
 *  - `tmuxTranscriptSessionId`: codex → null, an explicit `--session-id` passes
 *    through, a continue/resume launch → null, else a freshly minted uuid;
 *  - `launchToResolvedHandle` over an INJECTED `runTmuxCommand` — a forced launch
 *    success (the pinned handle is built locally) and a forced `TmuxLaunchError`
 *    (mapped to `{ok:false}`, the diagnostic routed to the injected stderr). No
 *    real tmux subprocess.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type LaunchHandleDeps,
  launchEnvForAgent,
  launchToResolvedHandle,
  tmuxTranscriptSessionId,
} from "../src/agent/launch-handle";
import type { TmuxCommandResult } from "../src/agent/tmux-launch";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "agent-launch-handle-test-"));
}
/** A launch-handle deps bound to an injected tmux runner + a recording stderr.
 *  The codex-trust seam is STUBBED (recording into `opts.trustCalls`) so no real
 *  `~/.codex` write ever fires. */
function deps(opts: {
  tmuxCommand: (cmd: string[]) => TmuxCommandResult;
  errs: string[];
  now?: number;
  env?: NodeJS.ProcessEnv;
}): LaunchHandleDeps {
  return {
    env: opts.env ?? {},
    cwd: "/work/proj",
    tmuxBin: "/usr/bin/tmux",
    launcherStateDir: tempDir(),
    launcherArgvPrefix: ["/bun", "/cli/keeper.ts", "agent"],
    randomUuid: () => SESSION_ID,
    runTmuxCommand: (cmd) => opts.tmuxCommand(cmd),
    now: () => opts.now ?? 0,
    writeErr: (s) => opts.errs.push(s),
  };
}
/** has-session misses (exit 1); the create command's outcome is injected. */
function tmuxRunner(createExit: number, createStderr = "") {
  return (cmd: string[]): TmuxCommandResult => {
    if (cmd.includes("has-session")) {
      return { exitCode: 1, stdout: "", stderr: "no session" };
    }
    return createExit === 0
      ? { exitCode: 0, stdout: "keeper agent\x01@1\x01%1\n", stderr: "" }
      : { exitCode: createExit, stdout: "", stderr: createStderr };
  };
}
describe("tmuxTranscriptSessionId", () => {
  test("a fresh claude session mints a uuid", () => {
    expect(tmuxTranscriptSessionId("claude", [], () => SESSION_ID)).toBe(
      SESSION_ID,
    );
  });
  test("an explicit --session-id passes through (no mint)", () => {
    expect(
      tmuxTranscriptSessionId(
        "claude",
        ["--session-id", "explicit-1"],
        () => SESSION_ID,
      ),
    ).toBe("explicit-1");
  });
  test("a continue/resume launch keeps the persisted session (null)", () => {
    expect(
      tmuxTranscriptSessionId("claude", ["--continue"], () => SESSION_ID),
    ).toBeNull();
  });
});
describe("launchToResolvedHandle", () => {
  test("launch success → ok, handle pinned locally + runId echoed", () => {
    const errs: string[] = [];
    const result = launchToResolvedHandle({
      deps: deps({ tmuxCommand: tmuxRunner(0), errs, now: 12345 }),
      agent: "claude",
      prompt: "say hi",
      posture: {},
      stopTimeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.runId).toBe(`tmux-${SESSION_ID}`);
    expect(result.handle).toEqual({
      agent: "claude",
      cwd: "/work/proj",
      sessionId: SESSION_ID,
      startedAtMs: 12345,
      transcriptPath: null,
      stopTimeoutMs: 5000,
      // Fresh launch: not a resume, so discovery keeps its strict-pin/floor path.
      isResume: false,
      lifecycleJobId: SESSION_ID,
    });
    expect(errs).toEqual([]);
  });
  test("claude resume launch → handle carries isResume + the pinned CHILD id (not the parent)", () => {
    const errs: string[] = [];
    const result = launchToResolvedHandle({
      deps: deps({ tmuxCommand: tmuxRunner(0), errs, now: 999 }),
      agent: "claude",
      prompt: "keep going",
      posture: {},
      stopTimeoutMs: null,
      resume: {
        target: "parent-uuid",
        childSessionId: "child-uuid",
        sessionId: "child-uuid",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.handle).toEqual({
      agent: "claude",
      cwd: "/work/proj",
      // The forked CHILD id — strict discovery resolves the child file, and the
      // envelope reports it as the POST-resume id (never the parent).
      sessionId: "child-uuid",
      startedAtMs: 999,
      transcriptPath: null,
      stopTimeoutMs: null,
      isResume: true,
      lifecycleJobId: "child-uuid",
    });
    expect(errs).toEqual([]);
  });
  test("a claude resume launch missing the child id → ok:false (ResumeLaunchUnsupportedError)", () => {
    const errs: string[] = [];
    const result = launchToResolvedHandle({
      deps: deps({ tmuxCommand: tmuxRunner(0), errs }),
      agent: "claude",
      prompt: "keep going",
      posture: {},
      stopTimeoutMs: null,
      // childSessionId omitted — claude's --resume MUST pin a fresh child uuid.
      resume: { target: "parent-uuid", sessionId: "" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("resumeSessionId");
    expect(errs.join("")).toContain("resumeSessionId");
  });
  test("TmuxLaunchError → ok:false, diagnostic routed to stderr", () => {
    const errs: string[] = [];
    const result = launchToResolvedHandle({
      deps: deps({ tmuxCommand: tmuxRunner(1, "boom"), errs }),
      agent: "claude",
      prompt: "say hi",
      posture: {},
      stopTimeoutMs: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("failed to create tmux window");
    expect(errs.join("")).toContain("Error: ");
    expect(errs.join("")).toContain("failed to create tmux window");
  });
});
describe("launchEnvForAgent — agent-conditional CLAUDE* scrub", () => {
  const env = {
    PATH: "/usr/bin",
    CODEX_HOME: "/x/.codex",
    CLAUDE_CODE_X: "secret",
    CLAUDECONFIG: "leak",
  };
  test("claude keeps the full inherited env (no scrub)", () => {
    expect(launchEnvForAgent("claude", env)).toBe(env);
  });
  test("pi strips inherited CLAUDE variables", () => {
    const out = launchEnvForAgent("pi", env);
    expect(out.CLAUDE_CODE_X).toBeUndefined();
    expect(out.CLAUDECONFIG).toBeUndefined();
    expect(out.CODEX_HOME).toBe("/x/.codex");
  });
});
