/**
 * Unit tests for the dep-free `src/pair-command.ts` leaf module: the per-CLI
 * agentwrap argv builders (byte-pinned, read-only flag sets), prompt assembly
 * (directive + role + message ordering), the launch/show-last-message JSON
 * parsers (schema-drift + handle extraction), the git changed-files diff, the
 * CLAUDE* env strip, and the output-YAML assembly (read_only_violation flag).
 */

import { expect, test } from "bun:test";
import {
  assemblePrompt,
  buildPairLaunchArgv,
  buildPairOutput,
  buildShowLastMessageArgv,
  buildWaitForStopArgv,
  DEFAULT_PAIR_SESSION,
  diffGitSnapshots,
  isPairRole,
  isSelfTranscriptCollision,
  loadRolePrompt,
  nativeClaudeArgs,
  nativeCodexArgs,
  nativePiArgs,
  PAIR_AGENTWRAP_SCHEMA_VERSION,
  PAIR_ROLES,
  parseGitPorcelain,
  parsePairLaunchJson,
  parseShowLastMessageJson,
  READ_ONLY_DIRECTIVE,
  resolveDisableAutoclose,
  resolvePairKeeperAgentPath,
  stopTimeoutMsFromSeconds,
  stripClaudeEnv,
} from "../src/pair-command";

// The folded-launcher argv prefix the pair path spawns: `[bun, cli/keeper.ts,
// "agent"]`. Supersedes the standalone `agentwrap` binary path.
const LAP = ["/abs/bun", "/abs/cli/keeper.ts", "agent"] as const;

// Subprocess-kill margin over the stop budget, mirrored from cli/pair.ts
// (PATH_CEILING_MS 30s + SLOP_MS 5s). Asserted here so the kill-margin invariant
// is pinned alongside the flag-emission seam.
const KILL_MARGIN_MS = 35_000;

// ---------------------------------------------------------------------------
// roles
// ---------------------------------------------------------------------------

test("isPairRole: accepts the four ported roles, rejects others", () => {
  for (const r of PAIR_ROLES) {
    expect(isPairRole(r)).toBe(true);
  }
  expect(isPairRole("bogus")).toBe(false);
  expect(isPairRole("")).toBe(false);
});

test("loadRolePrompt: loads each ported role asset; unknown role fails loud", () => {
  for (const r of PAIR_ROLES) {
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
// prompt assembly
// ---------------------------------------------------------------------------

test("assemblePrompt: orders directive (read-only) → system → user", () => {
  const out = assemblePrompt({
    message: "do the thing",
    systemPrompt: "be helpful",
    readOnly: true,
  });
  const idxDirective = out.indexOf(READ_ONLY_DIRECTIVE);
  const idxSystem = out.indexOf("System: be helpful");
  const idxUser = out.indexOf("User: do the thing");
  expect(idxDirective).toBe(0);
  expect(idxSystem).toBeGreaterThan(idxDirective);
  expect(idxUser).toBeGreaterThan(idxSystem);
});

test("assemblePrompt: omits the directive when not read-only", () => {
  const out = assemblePrompt({
    message: "m",
    systemPrompt: "s",
    readOnly: false,
  });
  expect(out).not.toContain(READ_ONLY_DIRECTIVE);
  expect(out).toBe("System: s\n\nUser: m");
});

test("assemblePrompt: omits the System block when systemPrompt is empty", () => {
  const out = assemblePrompt({
    message: "m",
    systemPrompt: "",
    readOnly: false,
  });
  expect(out).toBe("User: m");
});

// ---------------------------------------------------------------------------
// native flag sets — claude
// ---------------------------------------------------------------------------

test("nativeClaudeArgs: interactive TUI shape — no --print, write posture accepts edits", () => {
  const args = nativeClaudeArgs({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "p",
    readOnly: false,
  });
  expect(args).toEqual([
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
  ]);
  // The interactive tracked-job shape drops the headless flags.
  expect(args).not.toContain("--print");
  expect(args).not.toContain("-p");
});

test("nativeClaudeArgs: read-only strips edit tools via --disallowed-tools", () => {
  const args = nativeClaudeArgs({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "p",
    readOnly: true,
  });
  expect(args).toEqual([
    "--disallowed-tools",
    "Edit,Write,NotebookEdit",
    "--dangerously-skip-permissions",
  ]);
  // No acceptEdits in read-only; no headless --print.
  expect(args).not.toContain("acceptEdits");
  expect(args).not.toContain("--print");
  // Regression guard: the variadic `--disallowed-tools` must never be the last
  // flag (it would swallow the prompt `buildPairLaunchArgv` appends). The
  // trailing flag must be the boolean `--dangerously-skip-permissions`.
  expect(args.at(-1)).toBe("--dangerously-skip-permissions");
});

test("nativeClaudeArgs: --model appended when supplied", () => {
  const args = nativeClaudeArgs({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "p",
    readOnly: false,
    model: "opus",
  });
  expect(args.slice(-2)).toEqual(["--model", "opus"]);
});

// ---------------------------------------------------------------------------
// native flag sets — codex
// ---------------------------------------------------------------------------

test("nativeCodexArgs: interactive YOLO flags in BOTH write and read-only", () => {
  for (const readOnly of [false, true]) {
    const args = nativeCodexArgs({
      launcherArgvPrefix: LAP,
      cli: "codex",
      prompt: "p",
      readOnly,
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
    // codex read-only is carried by the directive — same flags as write.
    // codex must NEVER strip tools the way claude does.
    expect(args).not.toContain("--disallowed-tools");
  }
});

test("nativeCodexArgs: --effort maps to quoted TOML model_reasoning_effort", () => {
  const args = nativeCodexArgs({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "p",
    readOnly: false,
    effort: "high",
  });
  const idx = args.indexOf("-c");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(args[idx + 1]).toBe('model_reasoning_effort="high"');
});

// ---------------------------------------------------------------------------
// native flag sets — pi
// ---------------------------------------------------------------------------

test("nativePiArgs: write posture — only -na, no tool strip, no codex/claude/effort flags", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
    readOnly: false,
  });
  expect(args).toEqual(["-na"]);
  // Write posture never strips tools.
  expect(args).not.toContain("--exclude-tools");
  // NEVER codex's YOLO flag (would crash a pi launch) or claude's permission flags.
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(args).not.toContain("--dangerously-skip-permissions");
  expect(args).not.toContain("--permission-mode");
  expect(args).not.toContain("--disallowed-tools");
  // pi uses thinking, never effort — pairing routes neither through here.
  expect(args).not.toContain("-c");
});

test("nativePiArgs: read-only adds --exclude-tools edit,write reinforcement (exact lowercase tokens)", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
    readOnly: true,
  });
  expect(args).toEqual(["-na", "--exclude-tools", "edit,write"]);
  // The `--exclude-tools` value is a single comma-joined token (not variadic), so
  // it sits safely before the trailing prompt positional.
  const idx = args.indexOf("--exclude-tools");
  expect(args[idx + 1]).toBe("edit,write");
});

test("nativePiArgs: --model appended when supplied", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
    readOnly: false,
    model: "gpt-5.5",
  });
  expect(args).toEqual(["-na", "--model", "gpt-5.5"]);
});

test("nativePiArgs: --effort is never emitted even when supplied (pi uses thinking)", () => {
  const args = nativePiArgs({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "p",
    readOnly: false,
    effort: "high",
  });
  expect(args).toEqual(["-na"]);
  expect(args).not.toContain("-c");
  expect(args).not.toContain("high");
});

// ---------------------------------------------------------------------------
// launch argv — full composition
// ---------------------------------------------------------------------------

test("buildPairLaunchArgv: claude — detached tmux wrapper + native + prompt last", () => {
  const argv = buildPairLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "THE PROMPT",
    readOnly: false,
  });
  // The launch spawns the folded `keeper agent` launcher prefix, then the cli
  // token, then the wrapper flags.
  expect(argv.slice(0, LAP.length)).toEqual([...LAP]);
  expect(argv[LAP.length]).toBe("claude");
  expect(argv.slice(LAP.length + 1, LAP.length + 4)).toEqual([
    "--agentwrap-tmux",
    "--agentwrap-tmux-detached",
    "--agentwrap-no-confirm",
  ]);
  // Interactive tracked-job shape — never the headless --print -p.
  expect(argv).not.toContain("--print");
  // No session supplied → no binding carrier (nothing to name).
  expect(argv).not.toContain("--agentwrap-tmux-env");
  // The prompt is ALWAYS the final positional element.
  expect(argv.at(-1)).toBe("THE PROMPT");
});

test("buildPairLaunchArgv: claude with session injects the KEEPER_TMUX_SESSION binding carrier", () => {
  const argv = buildPairLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
    readOnly: false,
    session: "panels",
  });
  // The carrier is what binds the partner into `jobs` as a tracked job, mirroring
  // buildAgentwrapLaunchArgv. Its value names the same session as the window.
  const envIdx = argv.indexOf("--agentwrap-tmux-env");
  expect(envIdx).toBeGreaterThanOrEqual(0);
  expect(argv[envIdx + 1]).toBe("KEEPER_TMUX_SESSION=panels");
  // And the window session flag is still present + names the same session.
  const sessIdx = argv.indexOf("--agentwrap-tmux-session");
  expect(sessIdx).toBeGreaterThanOrEqual(0);
  expect(argv[sessIdx + 1]).toBe("panels");
});

test("buildPairLaunchArgv: codex never gets the binding carrier (stays untracked)", () => {
  const argv = buildPairLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "P",
    readOnly: false,
    session: "pair",
  });
  // codex fires no keeper hooks → never a tracked job → no KEEPER_TMUX_SESSION
  // carrier, even with a session named for the window.
  expect(argv).not.toContain("--agentwrap-tmux-env");
  expect(argv).toContain("--agentwrap-tmux-session");
});

test("buildPairLaunchArgv: codex — agent token is codex, interactive native flags, prompt last", () => {
  const argv = buildPairLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "codex",
    prompt: "P",
    readOnly: true,
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

test("buildPairLaunchArgv: pi routes to nativePiArgs — never codex/claude flags, no carrier, prompt last", () => {
  const argv = buildPairLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "pi",
    prompt: "THE PI PROMPT",
    readOnly: true,
    model: "gpt-5.5",
    session: "panels",
  });
  // The agent token is pi (NOT codex — codex's YOLO flag would crash a pi launch).
  expect(argv[LAP.length]).toBe("pi");
  expect(argv).toContain("-na");
  const xtIdx = argv.indexOf("--exclude-tools");
  expect(xtIdx).toBeGreaterThanOrEqual(0);
  expect(argv[xtIdx + 1]).toBe("edit,write");
  // NONE of codex's or claude's native flags leak onto the pi argv.
  expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  expect(argv).not.toContain("--permission-mode");
  expect(argv).not.toContain("--disallowed-tools");
  // Interactive tracked-job shape is claude-only — never the headless --print.
  expect(argv).not.toContain("--print");
  // pi fires no keeper hooks → never a tracked job → no KEEPER_TMUX_SESSION carrier,
  // even with a session named for the window.
  expect(argv).not.toContain("--agentwrap-tmux-env");
  expect(argv).toContain("--agentwrap-tmux-session");
  // The prompt is ALWAYS the final positional element.
  expect(argv.at(-1)).toBe("THE PI PROMPT");
});

test("buildPairLaunchArgv: --agentwrap-tmux-session appended when session supplied", () => {
  const argv = buildPairLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
    readOnly: false,
    session: "pair-sess",
  });
  const idx = argv.indexOf("--agentwrap-tmux-session");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("pair-sess");
});

test("buildPairLaunchArgv: --preset forwards --agentwrap-preset so the launcher owns model/effort", () => {
  const argv = buildPairLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
    readOnly: false,
    preset: "claude-opus-xhigh",
  });
  const idx = argv.indexOf("--agentwrap-preset");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("claude-opus-xhigh");
  // The base wrapper-flag triad stays the first three flags after the cli token —
  // preset rides AFTER them, never reordering the load-bearing prefix.
  expect(argv.slice(LAP.length + 1, LAP.length + 4)).toEqual([
    "--agentwrap-tmux",
    "--agentwrap-tmux-detached",
    "--agentwrap-no-confirm",
  ]);
  // The prompt is still the final positional.
  expect(argv.at(-1)).toBe("P");
});

test("buildPairLaunchArgv: no preset → no --agentwrap-preset flag (zero behavior change)", () => {
  const argv = buildPairLaunchArgv({
    launcherArgvPrefix: LAP,
    cli: "claude",
    prompt: "P",
    readOnly: false,
  });
  expect(argv).not.toContain("--agentwrap-preset");
});

test("buildWaitForStopArgv / buildShowLastMessageArgv: handle composition", () => {
  expect(buildWaitForStopArgv(LAP, "tmux-abc", 1_800_000)).toEqual([
    ...LAP,
    "wait-for-stop",
    "tmux-abc",
    "--stop-timeout-ms",
    "1800000",
  ]);
  expect(buildShowLastMessageArgv(LAP, "tmux-abc")).toEqual([
    ...LAP,
    "show-last-message",
    "tmux-abc",
  ]);
});

test("stopTimeoutMsFromSeconds: integer seconds → exact ms", () => {
  expect(stopTimeoutMsFromSeconds(1800)).toBe(1_800_000);
  expect(stopTimeoutMsFromSeconds(1)).toBe(1000);
});

test("stopTimeoutMsFromSeconds: fractional seconds round UP to ms", () => {
  expect(stopTimeoutMsFromSeconds(0.5)).toBe(500);
  expect(stopTimeoutMsFromSeconds(1.0009)).toBe(1001);
  expect(stopTimeoutMsFromSeconds(599.9999)).toBe(600_000);
});

test("buildWaitForStopArgv emits --stop-timeout-ms <Math.ceil(secs*1000)>", () => {
  // A fractional --timeout still emits an integer-ms flag (the same one tested
  // seam the kill margin uses) — never a fractional ms.
  const argv = buildWaitForStopArgv(LAP, "h", stopTimeoutMsFromSeconds(1.0009));
  const idx = argv.indexOf("--stop-timeout-ms");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("1001");
});

test("kill margin = stopTimeoutMs + 35_000, strictly above the stop budget", () => {
  for (const secs of [1, 600, 1800, 0.5]) {
    const stopMs = stopTimeoutMsFromSeconds(secs);
    const killMs = stopMs + KILL_MARGIN_MS;
    expect(killMs).toBe(stopMs + 35_000);
    expect(killMs).toBeGreaterThan(stopMs);
  }
});

// ---------------------------------------------------------------------------
// launch JSON parsing
// ---------------------------------------------------------------------------

test("parsePairLaunchJson: extracts id + paneId from the schema-1 line", () => {
  const line = JSON.stringify({
    schema_version: 1,
    id: "tmux-xyz",
    agent: "claude",
    paneId: "%7",
  });
  const res = parsePairLaunchJson(`some banner\n${line}\n`);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.handle).toEqual({ id: "tmux-xyz", paneId: "%7" });
  }
});

test("parsePairLaunchJson: schema drift fails loud", () => {
  const line = JSON.stringify({ schema_version: 99, id: "x" });
  const res = parsePairLaunchJson(line);
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.error).toContain("schema_version");
  }
});

test("parsePairLaunchJson: missing id fails loud; null paneId tolerated", () => {
  const noId = parsePairLaunchJson(JSON.stringify({ schema_version: 1 }));
  expect(noId.ok).toBe(false);
  const nullPane = parsePairLaunchJson(
    JSON.stringify({ schema_version: 1, id: "h", paneId: null }),
  );
  expect(nullPane.ok).toBe(true);
  if (nullPane.ok) {
    expect(nullPane.handle.paneId).toBeNull();
  }
});

test("parsePairLaunchJson: no JSON line at all fails", () => {
  const res = parsePairLaunchJson("plain text, no json\n");
  expect(res.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// show-last-message JSON parsing
// ---------------------------------------------------------------------------

test("parseShowLastMessageJson: reads message + transcriptPath from metadata line", () => {
  const meta = JSON.stringify({
    schema_version: 1,
    agent: "claude",
    transcriptPath: "/t/x.jsonl",
    found: true,
    message: "the final answer",
  });
  // agentwrap prints the bare message first, then the JSON metadata.
  const res = parseShowLastMessageJson(`the final answer\n${meta}\n`);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.result.message).toBe("the final answer");
    expect(res.result.found).toBe(true);
    expect(res.result.transcriptPath).toBe("/t/x.jsonl");
  }
});

test("parseShowLastMessageJson: tool-only turn — found true, message null", () => {
  const meta = JSON.stringify({
    schema_version: 1,
    agent: "codex",
    transcriptPath: "/t/y.jsonl",
    found: true,
    message: null,
  });
  const res = parseShowLastMessageJson(meta);
  expect(res.ok).toBe(true);
  if (res.ok) {
    expect(res.result.message).toBeNull();
    expect(res.result.found).toBe(true);
  }
});

test("parseShowLastMessageJson: no metadata line fails", () => {
  const res = parseShowLastMessageJson("just a message body, no json\n");
  expect(res.ok).toBe(false);
});

// ---------------------------------------------------------------------------
// git changed-files diff
// ---------------------------------------------------------------------------

test("parseGitPorcelain: parses lines, preserves leading status spaces", () => {
  const set = parseGitPorcelain(" M src/a.ts\n?? new.txt\n");
  expect(set.has(" M src/a.ts")).toBe(true);
  expect(set.has("?? new.txt")).toBe(true);
  expect(parseGitPorcelain("").size).toBe(0);
});

test("diffGitSnapshots: returns sorted new paths; rename arrow → dest", () => {
  const before = new Set([" M a.ts"]);
  const after = new Set([
    " M a.ts",
    "?? z.txt",
    "?? b.txt",
    "R  old.ts -> new.ts",
  ]);
  expect(diffGitSnapshots(before, after)).toEqual(["b.txt", "new.ts", "z.txt"]);
});

test("diffGitSnapshots: a null snapshot yields no detection", () => {
  expect(diffGitSnapshots(null, new Set(["?? x"]))).toEqual([]);
  expect(diffGitSnapshots(new Set(), null)).toEqual([]);
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

// ---------------------------------------------------------------------------
// output assembly
// ---------------------------------------------------------------------------

test("buildPairOutput: carries message + cli/role + handle drill-down", () => {
  const out = buildPairOutput({
    cli: "claude",
    role: "default",
    message: "answer text",
    readOnly: false,
    changedFiles: [],
    transcriptPath: "/t/x.jsonl",
    handle: "tmux-h",
    elapsedSeconds: 12.34,
  });
  expect(out.message).toBe("answer text");
  expect(out.cli).toBe("claude");
  expect(out.role).toBe("default");
  expect(out.handle).toBe("tmux-h");
  expect(out.transcript_path).toBe("/t/x.jsonl");
  expect(out.elapsed_seconds).toBe(12.3);
  // No read_only key on a write run.
  expect(out.read_only).toBeUndefined();
});

test("buildPairOutput: read-only run that changed the tree flags read_only_violation", () => {
  const out = buildPairOutput({
    cli: "codex",
    role: "codereviewer",
    message: "m",
    readOnly: true,
    changedFiles: ["a.ts", "b.ts"],
    transcriptPath: null,
    handle: "h",
  });
  expect(out.read_only).toBe(true);
  expect(out.changed_files).toEqual(["a.ts", "b.ts"]);
  expect(out.read_only_violation).toEqual(["a.ts", "b.ts"]);
});

test("buildPairOutput: write run with changed files records them WITHOUT a violation", () => {
  const out = buildPairOutput({
    cli: "claude",
    role: "default",
    message: "m",
    readOnly: false,
    changedFiles: ["x.ts"],
    transcriptPath: null,
    handle: "h",
  });
  expect(out.changed_files).toEqual(["x.ts"]);
  expect(out.read_only_violation).toBeUndefined();
});

test("buildPairOutput: null message serializes to an empty string message", () => {
  const out = buildPairOutput({
    cli: "claude",
    role: "default",
    message: null,
    readOnly: false,
    changedFiles: [],
    transcriptPath: null,
    handle: "h",
  });
  expect(out.message).toBe("");
});

// ---------------------------------------------------------------------------
// self-transcript-collision guard
// ---------------------------------------------------------------------------

test("isSelfTranscriptCollision: basename == driver session id collides", () => {
  const sid = "abc123-uuid";
  expect(
    isSelfTranscriptCollision(
      `/home/u/.claude/projects/encoded-cwd/${sid}.jsonl`,
      sid,
    ),
  ).toBe(true);
});

test("isSelfTranscriptCollision: partner transcript (different uuid) does not collide", () => {
  expect(
    isSelfTranscriptCollision(
      "/home/u/.claude/projects/encoded-cwd/partner-uuid.jsonl",
      "driver-uuid",
    ),
  ).toBe(false);
});

test("isSelfTranscriptCollision: null/empty inputs never collide", () => {
  expect(isSelfTranscriptCollision(null, "driver")).toBe(false);
  expect(isSelfTranscriptCollision("/p/driver.jsonl", null)).toBe(false);
  expect(isSelfTranscriptCollision("/p/driver.jsonl", undefined)).toBe(false);
  expect(isSelfTranscriptCollision("", "driver")).toBe(false);
  expect(isSelfTranscriptCollision("/p/driver.jsonl", "")).toBe(false);
});

// ---------------------------------------------------------------------------
// keeper-agent launcher path resolution
// ---------------------------------------------------------------------------

test("resolvePairKeeperAgentPath: KEEPER_AGENT_PATH wins; deprecated alias next; tilde expands", () => {
  // The new env override wins.
  expect(
    resolvePairKeeperAgentPath(
      { KEEPER_AGENT_PATH: "/custom/keeper.ts" },
      "/home/u",
    ),
  ).toBe("/custom/keeper.ts");
  // The deprecated agentwrap alias still resolves (migration readability).
  expect(
    resolvePairKeeperAgentPath(
      { KEEPER_AGENTWRAP_PATH: "~/bin/keeper.ts" },
      "/home/u",
    ),
  ).toBe("/home/u/bin/keeper.ts");
  // No override → derived `cli/keeper.ts` default (absolute, ends in keeper.ts).
  const derived = resolvePairKeeperAgentPath({}, "/home/u");
  expect(derived.startsWith("/")).toBe(true);
  expect(derived.endsWith("/cli/keeper.ts")).toBe(true);
});

test("schema version constant is pinned at 1 (cross-repo contract)", () => {
  expect(PAIR_AGENTWRAP_SCHEMA_VERSION).toBe(1);
});

test("resolveDisableAutoclose: empty/absent list matches nothing (autocloses everything)", () => {
  // Default empty — `pair`/`panels` are NO LONGER exempt by default; every
  // managed session autocloses unless explicitly listed in `disable-autoclose`.
  expect(resolveDisableAutoclose()("pair")).toBe(false);
  expect(resolveDisableAutoclose([])("anything")).toBe(false);
  expect(DEFAULT_PAIR_SESSION).toBe("pair");
});

test("resolveDisableAutoclose: a bare name matches exactly (backward compatible)", () => {
  const isDisabled = resolveDisableAutoclose(["panels", "pair"]);
  expect(isDisabled("panels")).toBe(true);
  expect(isDisabled("pair")).toBe(true);
  // An unlisted session autocloses; a bare token is an exact anchored match,
  // never a substring/prefix.
  expect(isDisabled("agentwrap")).toBe(false);
  expect(isDisabled("panels-2")).toBe(false);
  expect(isDisabled("xpanels")).toBe(false);
});

test("resolveDisableAutoclose: a glob token matches by fnmatch", () => {
  const isDisabled = resolveDisableAutoclose(["panels:*"]);
  // `:` is not a separator, so `panels:*` → `panels:<anything>`.
  expect(isDisabled("panels:foo")).toBe(true);
  expect(isDisabled("panels:bar-7")).toBe(true);
  // The literal colon is required — `*` does not cover the missing `:`.
  expect(isDisabled("panelsfoo")).toBe(false);
  expect(isDisabled("panels")).toBe(false);
});

test("resolveDisableAutoclose: trims and drops empty entries", () => {
  const isDisabled = resolveDisableAutoclose([
    "  panels  ",
    "",
    "  ",
    "my-debug",
  ]);
  expect(isDisabled("panels")).toBe(true);
  expect(isDisabled("my-debug")).toBe(true);
  expect(isDisabled("")).toBe(false);
});
