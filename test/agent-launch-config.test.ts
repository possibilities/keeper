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
  nativeCodexArgs,
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
// native flag sets — codex
// ---------------------------------------------------------------------------

test("nativeCodexArgs: interactive YOLO flags, never strips tools", () => {
  const args = nativeCodexArgs({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "p",
  });
  // Interactive TUI shape — never the headless `exec` one-shot or its exec-only
  // `--skip-git-repo-check`, and web search is on by default so the deprecated
  // `--enable web_search_request` is gone.
  expect(args).not.toContain("exec");
  expect(args).not.toContain("--skip-git-repo-check");
  expect(args).not.toContain("--enable");
  expect(args).not.toContain("web_search_request");
  // YOLO mode so the single-turn partner never stalls on an approval prompt.
  expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
  // codex must NEVER strip tools the way claude used to.
  expect(args).not.toContain("--disallowed-tools");
});

test("nativeCodexArgs: --name is NEVER emitted (codex has no native name flag)", () => {
  const args = nativeCodexArgs({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "p",
    name: "panel::smoke::gpt5",
  });
  expect(args).not.toContain("--name");
  expect(args).not.toContain("panel::smoke::gpt5");
});

test("nativeCodexArgs: --effort maps to quoted TOML model_reasoning_effort", () => {
  const args = nativeCodexArgs({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "p",
    effort: "high",
  });
  const idx = args.indexOf("-c");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).toBe('model_reasoning_effort="high"');
});

test("nativeCodexArgs: keeper effort max caps at codex band xhigh", () => {
  const args = nativeCodexArgs({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "p",
    effort: "max",
  });
  const idx = args.indexOf("-c");
  expect(args[idx + 1]).toBe('model_reasoning_effort="xhigh"');
});

test("nativeCodexArgs: an already-native band (minimal) passes through unmapped", () => {
  const args = nativeCodexArgs({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "p",
    effort: "minimal",
  });
  const idx = args.indexOf("-c");
  expect(args[idx + 1]).toBe('model_reasoning_effort="minimal"');
});

test("nativeCodexArgs: resume mode LEADS with the verb-position resume + target, ends with -- guarded prompt", () => {
  const args = nativeCodexArgs({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "follow-up ask",
    resumeTarget: "rollout-uuid",
  });
  expect(args).toEqual([
    "resume",
    "rollout-uuid",
    "--dangerously-bypass-approvals-and-sandbox",
    "--",
    "follow-up ask",
  ]);
});

test("nativeCodexArgs: resume mode still composes model/effort flags between target and prompt", () => {
  const args = nativeCodexArgs({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "-dash-ask",
    model: "gpt-5.5",
    effort: "high",
    resumeTarget: "rollout-uuid",
  });
  expect(args).toEqual([
    "resume",
    "rollout-uuid",
    "--dangerously-bypass-approvals-and-sandbox",
    "-m",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="high"',
    "--",
    "-dash-ask",
  ]);
});

// ---------------------------------------------------------------------------
// native flag sets — pi (posture-independent: read-only is prompting-only)
// ---------------------------------------------------------------------------

test("nativePiArgs: only -na, no tool strip, no codex/claude/effort flags", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
  });
  expect(args).toEqual(["-na"]);
  // Read-only is prompting-only now — no --exclude-tools strip.
  expect(args).not.toContain("--exclude-tools");
  // NEVER codex's YOLO flag (would crash a pi launch) or claude's permission flags.
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args).not.toContain("--permission-mode");
  expect(args).not.toContain("--disallowed-tools");
  // No effort supplied → no `--thinking`; pi never gets codex's `-c` either.
  expect(args).not.toContain("-c");
  expect(args).not.toContain("--thinking");
});

test("nativePiArgs: --model appended when supplied", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
    model: "gpt-5.5",
  });
  expect(args).toEqual(["-na", "--model", "gpt-5.5"]);
});

test("nativePiArgs: --name appended (pi has a native name flag)", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
    name: "panel::smoke::pi-fast",
  });
  expect(args.slice(-2)).toEqual(["--name", "panel::smoke::pi-fast"]);
});

test("nativePiArgs: a keeper effort maps onto pi's --thinking band (never codex -c)", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
    effort: "high",
  });
  const idx = args.indexOf("--thinking");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).toBe("high");
  // pi's second axis is `--thinking`, never codex's `-c model_reasoning_effort`.
  expect(args).not.toContain("-c");
});

test("nativePiArgs: keeper effort max caps at pi band xhigh, before --name", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
    effort: "max",
    name: "panel::smoke::pi",
  });
  const idx = args.indexOf("--thinking");
  expect(args[idx + 1]).toBe("xhigh");
  // --name stays the final pair so the launcher's native name lands last.
  expect(args.slice(-2)).toEqual(["--name", "panel::smoke::pi"]);
});

test("nativePiArgs: resume mode appends --session <target> then the prompt as-is", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "follow-up ask",
    resumeTarget: "pi-session-id",
  });
  expect(args).toEqual(["-na", "--session", "pi-session-id", "follow-up ask"]);
});

test("nativePiArgs: resume mode with a leading-dash prompt fails loud instead of silently misrouting it", () => {
  expect(() =>
    nativePiArgs({
      launcherArgvPrefix: LAP,
      cli: "pi",
      prompt: "-dash-prompt",
      resumeTarget: "pi-session-id",
    }),
  ).toThrow(ResumeLaunchUnsupportedError);
});

// ---------------------------------------------------------------------------
// native flag sets — hermes
// ---------------------------------------------------------------------------

test("nativeHermesArgs: fresh launch stays -z-then-separate-prompt-token (byte-unchanged)", () => {
  const args = nativeHermesArgs({
    launcherArgvPrefix: LAP,
    cli: "hermes",
    prompt: "p",
    model: "some-model",
  });
  expect(args).toEqual(["--yolo", "-m", "some-model", "-z"]);
});

test("nativeHermesArgs: resume mode uses --resume <target> then -z=<prompt> equals-joined (never a bare -z token)", () => {
  const args = nativeHermesArgs({
    launcherArgvPrefix: LAP,
    cli: "hermes",
    prompt: "follow-up ask",
    resumeTarget: "hermes-session-id",
  });
  expect(args).toEqual([
    "--yolo",
    "--resume",
    "hermes-session-id",
    "-z=follow-up ask",
  ]);
  expect(args).not.toContain("-z");
});

test("nativeHermesArgs: resume mode with a leading-dash prompt still rides safely joined", () => {
  const args = nativeHermesArgs({
    launcherArgvPrefix: LAP,
    cli: "hermes",
    prompt: "-dash-ask",
    model: "some-model",
    resumeTarget: "hermes-session-id",
  });
  expect(args).toEqual([
    "--yolo",
    "-m",
    "some-model",
    "--resume",
    "hermes-session-id",
    "-z=-dash-ask",
  ]);
});

// ---------------------------------------------------------------------------
// effort → second-axis band mapping (descriptor-driven, no harness-name switch)
// ---------------------------------------------------------------------------

test("mapKeeperEffortToAxis: claude/hermes null map passes every token through", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    expect(mapKeeperEffortToAxis("claude", effort)).toBe(effort);
    expect(mapKeeperEffortToAxis("hermes", effort)).toBe(effort);
  }
});

test("mapKeeperEffortToAxis: codex/pi are identity for the four shared rungs", () => {
  for (const effort of ["low", "medium", "high", "xhigh"]) {
    expect(mapKeeperEffortToAxis("codex", effort)).toBe(effort);
    expect(mapKeeperEffortToAxis("pi", effort)).toBe(effort);
  }
});

test("mapKeeperEffortToAxis: keeper max caps at codex/pi band xhigh", () => {
  expect(mapKeeperEffortToAxis("codex", "max")).toBe("xhigh");
  expect(mapKeeperEffortToAxis("pi", "max")).toBe("xhigh");
});

test("mapKeeperEffortToAxis: already-native bands pass through unmapped (precedence)", () => {
  // Tokens outside keeper's five efforts are left as-is — the map rewrites only
  // genuine keeper efforts, never an already-native band the caller supplied.
  expect(mapKeeperEffortToAxis("codex", "minimal")).toBe("minimal");
  expect(mapKeeperEffortToAxis("pi", "off")).toBe("off");
  expect(mapKeeperEffortToAxis("pi", "minimal")).toBe("minimal");
});

// ---------------------------------------------------------------------------
// launch argv — full composition
// ---------------------------------------------------------------------------

test("buildAgentLaunchArgv: claude — detached tmux wrapper + native + prompt last", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "THE PROMPT",
  });
  // The launch spawns the folded `keeper agent` launcher prefix, then the cli
  // token, then the wrapper flags.
  expect(argv.slice(0, LAP.length)).toEqual([...LAP]);
  expect(argv[LAP.length]).toBe("claude");
  expect(argv.slice(LAP.length + 1, LAP.length + 4)).toEqual([
    "--x-tmux",
    "--x-tmux-detached",
    "--x-no-confirm",
  ]);
  // Interactive tracked-job shape — never the headless --print -p.
  expect(argv).not.toContain("--print");
  // No session supplied → no binding carrier (nothing to name).
  expect(argv).not.toContain("--x-tmux-env");
  // The prompt is ALWAYS the final positional element.
  expect(argv.at(-1)).toBe("THE PROMPT");
});

test("buildAgentLaunchArgv: claude with session injects the KEEPER_TMUX_SESSION binding carrier", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
    session: "panels",
  });
  // The carrier is what binds the partner into `jobs` as a tracked job, mirroring
  // buildKeeperAgentLaunchArgv. Its value names the same session as the window.
  const envIdx = argv.indexOf("--x-tmux-env");
  expect(envIdx).toBeGreaterThanOrEqual(0);
  expect(argv[envIdx + 1]).toBe("KEEPER_TMUX_SESSION=panels");
  // And the window session flag is still present + names the same session.
  const sessIdx = argv.indexOf("--x-tmux-session");
  expect(sessIdx).toBeGreaterThanOrEqual(0);
  expect(argv[sessIdx + 1]).toBe("panels");
});

test("buildAgentLaunchArgv: codex never gets the binding carrier (stays untracked)", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "P",
    session: "pair",
  });
  // codex fires no keeper hooks → never a tracked job → no KEEPER_TMUX_SESSION
  // carrier, even with a session named for the window.
  expect(argv).not.toContain("--x-tmux-env");
  expect(argv).toContain("--x-tmux-session");
});

test("buildAgentLaunchArgv: codex — agent token is codex, interactive native flags, prompt last", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "P",
    effort: "medium",
  });
  expect(argv[LAP.length]).toBe("codex");
  // Interactive TUI — never the headless `exec` one-shot or the deprecated web
  // search flag.
  expect(argv).not.toContain("exec");
  expect(argv).not.toContain("web_search_request");
  expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(argv.at(-1)).toBe("P");
});

test("buildAgentLaunchArgv: pi routes to nativePiArgs — never codex/claude flags, no strip, no carrier, prompt last", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "THE PI PROMPT",
    model: "gpt-5.5",
    session: "panels",
  });
  // The agent token is pi (NOT codex — codex's YOLO flag would crash a pi launch).
  expect(argv[LAP.length]).toBe("pi");
  expect(argv).toContain("-na");
  // Read-only is prompting-only now — no --exclude-tools strip on the pi argv.
  expect(argv).not.toContain("--exclude-tools");
  // NONE of codex's or claude's native flags leak onto the pi argv.
  expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(argv).not.toContain("--permission-mode");
  expect(argv).not.toContain("--disallowed-tools");
  // Interactive tracked-job shape is claude-only — never the headless --print.
  expect(argv).not.toContain("--print");
  // pi fires no keeper hooks → never a tracked job → no KEEPER_TMUX_SESSION carrier,
  // even with a session named for the window.
  expect(argv).not.toContain("--x-tmux-env");
  expect(argv).toContain("--x-tmux-session");
  // The prompt is ALWAYS the final positional element.
  expect(argv.at(-1)).toBe("THE PI PROMPT");
});

test("buildAgentLaunchArgv: --x-tmux-session appended when session supplied", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
    session: "pair-sess",
  });
  const idx = argv.indexOf("--x-tmux-session");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("pair-sess");
});

test("buildAgentLaunchArgv: --preset forwards the launch triple as --x-preset", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
    preset: "claude::opus::xhigh",
  });
  const idx = argv.indexOf("--x-preset");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("claude::opus::xhigh");
  // The base wrapper-flag triad stays the first three flags after the cli token —
  // preset rides AFTER them, never reordering the load-bearing prefix.
  expect(argv.slice(LAP.length + 1, LAP.length + 4)).toEqual([
    "--x-tmux",
    "--x-tmux-detached",
    "--x-no-confirm",
  ]);
  // The prompt is still the final positional.
  expect(argv.at(-1)).toBe("P");
});

test("buildAgentLaunchArgv: no preset → no --x-preset flag (zero behavior change)", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
  });
  expect(argv).not.toContain("--x-preset");
});

test("buildAgentLaunchArgv: --name lands on the tmux window name for EVERY harness", () => {
  for (const cli of ["claude", "codex", "pi"] as const) {
    const argv = buildAgentLaunchArgv({
      launcherArgvPrefix: LAP,
      cli,
      prompt: "P",
      name: "panel::smoke::x",
    });
    const idx = argv.indexOf("--x-tmux-window-name");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("panel::smoke::x");
  }
});

test("buildAgentLaunchArgv: native --name for claude/pi, but NEVER for codex", () => {
  const claude = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
    name: "panel::smoke::opus",
  });
  const nIdx = claude.indexOf("--name");
  expect(nIdx).toBeGreaterThanOrEqual(0);
  expect(claude[nIdx + 1]).toBe("panel::smoke::opus");

  const pi = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "P",
    name: "panel::smoke::pi",
  });
  const piIdx = pi.indexOf("--name");
  expect(piIdx).toBeGreaterThanOrEqual(0);
  expect(pi[piIdx + 1]).toBe("panel::smoke::pi");

  // codex carries the window name but NO native --name (it has no such flag).
  const codex = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "P",
    name: "panel::smoke::gpt5",
  });
  expect(codex).toContain("--x-tmux-window-name");
  expect(codex).not.toContain("--name");
});

test("buildAgentLaunchArgv: no name → no window-name flag, no native --name (zero behavior change)", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
  });
  expect(argv).not.toContain("--x-tmux-window-name");
  expect(argv).not.toContain("--name");
});

// ---------------------------------------------------------------------------
// launch argv — resume-launch composition
// ---------------------------------------------------------------------------

test("buildAgentLaunchArgv: resume launch omits the trailing prompt append — the prompt already rides inside native", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "follow-up ask",
    resumeTarget: "rollout-uuid",
  });
  // The verb-position resume token leads the forwarded (post-wrapper-flag)
  // codex argv, and the prompt appears EXACTLY once — not double-appended.
  const idx = argv.indexOf("resume");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("rollout-uuid");
  expect(argv.at(-1)).toBe("follow-up ask");
  expect(argv.filter((a) => a === "follow-up ask")).toHaveLength(1);
});

test("buildAgentLaunchArgv: claude resume launch composes the full pinned-child-session shape", () => {
  const argv = buildAgentLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "follow-up ask",
    resumeTarget: "parent-uuid",
    resumeSessionId: "child-uuid",
  });
  expect(argv.at(-1)).toBe("follow-up ask");
  expect(argv).toContain("--resume");
  expect(argv[argv.indexOf("--resume") + 1]).toBe("parent-uuid");
  expect(argv).toContain("--session-id");
  expect(argv[argv.indexOf("--session-id") + 1]).toBe("child-uuid");
  expect(argv).toContain("--fork-session");
  expect(argv.filter((a) => a === "follow-up ask")).toHaveLength(1);
});

test("buildAgentLaunchArgv: fresh launch is unaffected when resumeTarget is absent (byte-unchanged)", () => {
  for (const cli of ["claude", "codex", "pi", "hermes"] as const) {
    const argv = buildAgentLaunchArgv({
      launcherArgvPrefix: LAP,
      cli,
      prompt: "P",
    });
    expect(argv.at(-1)).toBe("P");
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("resume");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--fork-session");
  }
});

// ---------------------------------------------------------------------------
// env strip
// ---------------------------------------------------------------------------

test("stripClaudeEnv: removes every CLAUDE-prefixed key, keeps the rest", () => {
  const out = stripClaudeEnv({
    PATH: "/bin",
    CLAUDE_CONFIG_DIR: "/c",
    CLAUDECODE: "1",
    HOME: "/h",
    UNDEF: undefined,
  });
  expect(out).toEqual({ PATH: "/bin", HOME: "/h" });
  expect(out.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(out.CLAUDECODE).toBeUndefined();
});
