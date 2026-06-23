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
  diffGitSnapshots,
  isPairRole,
  isSelfTranscriptCollision,
  loadRolePrompt,
  nativeClaudeArgs,
  nativeCodexArgs,
  PAIR_AGENTWRAP_SCHEMA_VERSION,
  PAIR_ROLES,
  parseGitPorcelain,
  parsePairLaunchJson,
  parseShowLastMessageJson,
  READ_ONLY_DIRECTIVE,
  resolvePairAgentwrapPath,
  stripClaudeEnv,
} from "../src/pair-command";

const AW = "/abs/agentwrap";

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

test("nativeClaudeArgs: write posture accepts edits + skips permissions", () => {
  const args = nativeClaudeArgs({
    agentwrapPath: AW,
    cli: "claude",
    prompt: "p",
    readOnly: false,
  });
  expect(args).toEqual([
    "--print",
    "-p",
    "--permission-mode",
    "acceptEdits",
    "--dangerously-skip-permissions",
  ]);
});

test("nativeClaudeArgs: read-only strips edit tools via --disallowed-tools", () => {
  const args = nativeClaudeArgs({
    agentwrapPath: AW,
    cli: "claude",
    prompt: "p",
    readOnly: true,
  });
  expect(args).toEqual([
    "--print",
    "-p",
    "--disallowed-tools",
    "Edit,Write,NotebookEdit",
    "--dangerously-skip-permissions",
  ]);
  // No acceptEdits in read-only.
  expect(args).not.toContain("acceptEdits");
  // Regression guard: the variadic `--disallowed-tools` must never be the last
  // flag (it would swallow the prompt `buildPairLaunchArgv` appends). The
  // trailing flag must be the boolean `--dangerously-skip-permissions`.
  expect(args.at(-1)).toBe("--dangerously-skip-permissions");
});

test("nativeClaudeArgs: --model appended when supplied", () => {
  const args = nativeClaudeArgs({
    agentwrapPath: AW,
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

test("nativeCodexArgs: keeps web search in BOTH write and read-only", () => {
  for (const readOnly of [false, true]) {
    const args = nativeCodexArgs({
      agentwrapPath: AW,
      cli: "codex",
      prompt: "p",
      readOnly,
    });
    expect(args).toContain("--enable");
    expect(args).toContain("web_search_request");
    // codex read-only is carried by the directive — same exec flags as write.
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    // codex must NEVER strip tools the way claude does.
    expect(args).not.toContain("--disallowed-tools");
  }
});

test("nativeCodexArgs: --effort maps to quoted TOML model_reasoning_effort", () => {
  const args = nativeCodexArgs({
    agentwrapPath: AW,
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
// launch argv — full composition
// ---------------------------------------------------------------------------

test("buildPairLaunchArgv: claude — detached tmux wrapper + native + prompt last", () => {
  const argv = buildPairLaunchArgv({
    agentwrapPath: AW,
    cli: "claude",
    prompt: "THE PROMPT",
    readOnly: false,
  });
  expect(argv[0]).toBe(AW);
  expect(argv[1]).toBe("claude");
  expect(argv.slice(2, 5)).toEqual([
    "--agentwrap-tmux",
    "--agentwrap-tmux-detached",
    "--agentwrap-no-confirm",
  ]);
  // The prompt is ALWAYS the final positional element.
  expect(argv.at(-1)).toBe("THE PROMPT");
});

test("buildPairLaunchArgv: codex — agent token is codex, exec native flags present", () => {
  const argv = buildPairLaunchArgv({
    agentwrapPath: AW,
    cli: "codex",
    prompt: "P",
    readOnly: true,
    effort: "medium",
  });
  expect(argv[1]).toBe("codex");
  expect(argv).toContain("exec");
  expect(argv).toContain("web_search_request");
  expect(argv.at(-1)).toBe("P");
});

test("buildPairLaunchArgv: --agentwrap-tmux-session appended when session supplied", () => {
  const argv = buildPairLaunchArgv({
    agentwrapPath: AW,
    cli: "claude",
    prompt: "P",
    readOnly: false,
    session: "pair-sess",
  });
  const idx = argv.indexOf("--agentwrap-tmux-session");
  expect(idx).toBeGreaterThanOrEqual(0);
  expect(argv[idx + 1]).toBe("pair-sess");
});

test("buildWaitForStopArgv / buildShowLastMessageArgv: handle composition", () => {
  expect(buildWaitForStopArgv(AW, "tmux-abc")).toEqual([
    AW,
    "wait-for-stop",
    "tmux-abc",
  ]);
  expect(buildShowLastMessageArgv(AW, "tmux-abc")).toEqual([
    AW,
    "show-last-message",
    "tmux-abc",
  ]);
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
// agentwrap path resolution
// ---------------------------------------------------------------------------

test("resolvePairAgentwrapPath: KEEPER_AGENTWRAP_PATH wins; tilde expands", () => {
  expect(
    resolvePairAgentwrapPath(
      { KEEPER_AGENTWRAP_PATH: "/custom/aw" },
      "/home/u",
    ),
  ).toBe("/custom/aw");
  expect(
    resolvePairAgentwrapPath({ KEEPER_AGENTWRAP_PATH: "~/bin/aw" }, "/home/u"),
  ).toBe("/home/u/bin/aw");
  // Default when no override.
  expect(resolvePairAgentwrapPath({}, "/home/u")).toBe(
    "/home/u/.bun/bin/agentwrap",
  );
});

test("schema version constant is pinned at 1 (cross-repo contract)", () => {
  expect(PAIR_AGENTWRAP_SCHEMA_VERSION).toBe(1);
});
