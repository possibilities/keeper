/**
 * Unit tests for the dep-free `src/agent/launch-config.ts` leaf module: the
 * per-CLI launch argv builder (byte-pinned, posture-independent flag sets), the
 * native flag sets, the CLAUDE* env strip, and the role-prompt resolver.
 */

import { expect, test } from "bun:test";
import {
  mapKeeperEffortToAxis,
  ResumeLaunchUnsupportedError,
} from "../src/agent/harness";
import {
  AGENT_ROLES,
  buildAgentLaunchArgv,
  composeManagedClaudeArgv,
  isAgentRole,
  loadRolePrompt,
  nativeClaudeArgs,
  nativeHermesArgs,
  nativePiArgs,
  stripClaudeEnv,
} from "../src/agent/launch-config";

// The folded-launcher argv prefix the launch path spawns: `[bun, cli/keeper.ts,
// "agent"]`. Supersedes the standalone `keeper agent` binary path.
const LAP = ["/abs/bun", "/abs/cli/keeper.ts", "agent"] as const;

// ---------------------------------------------------------------------------
// composeManagedClaudeArgv — the claude-swap managed wrapper
// ---------------------------------------------------------------------------

test("composeManagedClaudeArgv: wraps native args after `run <slot> --share-history --`", () => {
  const native = [
    "/home/.local/bin/claude",
    "--model",
    "opus",
    "--session-id",
    "abc",
    "hello",
  ];
  expect(
    composeManagedClaudeArgv({
      cswapBin: "cswap",
      slot: 4,
      nativeClaudeArgv: native,
    }),
  ).toEqual([
    "cswap",
    "run",
    "4",
    "--share-history",
    "--",
    "--model",
    "opus",
    "--session-id",
    "abc",
    "hello",
  ]);
});

test("composeManagedClaudeArgv: drops the native executable (cswap resolves claude from PATH)", () => {
  const native = ["/abs/claude", "--continue"];
  const wrapped = composeManagedClaudeArgv({
    cswapBin: "/abs/cswap",
    slot: 0,
    nativeClaudeArgv: native,
  });
  // slot 0 is valid; the executable is dropped, only args forwarded.
  expect(wrapped).toEqual([
    "/abs/cswap",
    "run",
    "0",
    "--share-history",
    "--",
    "--continue",
  ]);
  expect(wrapped.slice(5)).toEqual(native.slice(1));
});

test("composeManagedClaudeArgv: forwards a leading-dash prompt verbatim after --", () => {
  const native = ["/abs/claude", "--", "-leading-dash-prompt"];
  const wrapped = composeManagedClaudeArgv({
    cswapBin: "cswap",
    slot: 9,
    nativeClaudeArgv: native,
  });
  expect(wrapped).toEqual([
    "cswap",
    "run",
    "9",
    "--share-history",
    "--",
    "--",
    "-leading-dash-prompt",
  ]);
});

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

test("isAgentRole: accepts the four ported roles, rejects others", () => {
  for (const r of AGENT_ROLES) {
    expect(isAgentRole(r)).toBe(true);
  }
  expect(isAgentRole("bogus")).toBe(false);
  expect(isAgentRole("")).toBe(false);
});

test("loadRolePrompt: loads each ported role asset; unknown role fails loud", () => {
  for (const r of AGENT_ROLES) {
    const res = loadRolePrompt(r);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text.length).toBeGreaterThan(0);
    }
  }
  const bad = loadRolePrompt("nope");
  expect(bad.ok).toBe(false);
  if (!bad.ok) {
    expect(bad.error).toContain("unknown role");
  }
});

// ---------------------------------------------------------------------------
// native flag sets — claude (posture-independent: read-only is prompting-only)
// ---------------------------------------------------------------------------

test("nativeClaudeArgs: interactive TUI shape — no --print, accepts edits, no tool strip", () => {
  const args = nativeClaudeArgs({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "p",
  });
  expect(args).toEqual([
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
  ]);
  // The interactive tracked-job shape drops the headless flags.
  expect(args).not.toContain("--print");
  expect(args).not.toContain("-p");
  // Read-only is prompting-only now — no per-harness tool strip.
  expect(args).not.toContain("--disallowed-tools");
});

test("nativeClaudeArgs: --model appended when supplied", () => {
  const args = nativeClaudeArgs({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "p",
    model: "opus",
  });
  expect(args.slice(-2)).toEqual(["--model", "opus"]);
});

test("nativeClaudeArgs: --name appended (claude has a native name flag)", () => {
  const args = nativeClaudeArgs({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "p",
    name: "panel::smoke::opus",
  });
  expect(args.slice(-2)).toEqual(["--name", "panel::smoke::opus"]);
});

test("nativeClaudeArgs: resume mode emits resume + pinned child session + fork flags + -- guarded prompt", () => {
  const args = nativeClaudeArgs({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "follow-up ask",
    resumeTarget: "parent-uuid",
    resumeSessionId: "child-uuid",
  });
  expect(args).toEqual([
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "--resume",
    "parent-uuid",
    "--session-id",
    "child-uuid",
    "--fork-session",
    "--",
    "follow-up ask",
  ]);
});

test("nativeClaudeArgs: resume mode composes after --model/--name (order stays deterministic)", () => {
  const args = nativeClaudeArgs({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "-dash-ask",
    model: "opus",
    name: "pair::sonnet",
    resumeTarget: "parent-uuid",
    resumeSessionId: "child-uuid",
  });
  expect(args).toEqual([
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    "--name",
    "pair::sonnet",
    "--resume",
    "parent-uuid",
    "--session-id",
    "child-uuid",
    "--fork-session",
    "--",
    "-dash-ask",
  ]);
});

test("nativeClaudeArgs: resume mode without resumeSessionId throws ResumeLaunchUnsupportedError", () => {
  expect(() =>
    nativeClaudeArgs({
      launcherArgvPrefix: LAP,
      cli: "claude",
      prompt: "p",
      resumeTarget: "parent-uuid",
    }),
  ).toThrow(ResumeLaunchUnsupportedError);
});

// ---------------------------------------------------------------------------
// Pi and Hermes native flags
// ---------------------------------------------------------------------------

test("nativePiArgs preserves an OpenAI-qualified launch id", () => {
  expect(
    nativePiArgs({
      launcherArgvPrefix: LAP,
      cli: "pi",
      prompt: "ask",
      model: "openai-codex/gpt-5.4",
      effort: "max",
    }),
  ).toEqual(["-na", "--model", "openai-codex/gpt-5.4", "--thinking", "xhigh"]);
});

test("buildAgentLaunchArgv routes a Pi Codex-named id through Pi", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "ask",
    model: "openai-codex/gpt-5.4",
  });
  expect(argv.slice(0, LAP.length + 1)).toEqual([...LAP, "pi"]);
  expect(argv).toContain("openai-codex/gpt-5.4");
  expect(argv.at(-1)).toBe("ask");
});

test("nativeHermesArgs remains model-only", () => {
  expect(
    nativeHermesArgs({
      launcherArgvPrefix: LAP,
      cli: "hermes",
      prompt: "ask",
      model: "hermes-model",
    }),
  ).toEqual(["--yolo", "-m", "hermes-model", "-z"]);
});

test("Pi effort mapping caps max and leaves native bands opaque", () => {
  expect(mapKeeperEffortToAxis("pi", "max")).toBe("xhigh");
  expect(mapKeeperEffortToAxis("pi", "minimal")).toBe("minimal");
});

test("stripClaudeEnv removes only CLAUDE-prefixed variables", () => {
  expect(
    stripClaudeEnv({ CLAUDE_CODE_X: "drop", PATH: "/bin", API_KEY: "keep" }),
  ).toEqual({ PATH: "/bin", API_KEY: "keep" });
});
