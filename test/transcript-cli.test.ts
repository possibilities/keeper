import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTranscriptTime,
  runTranscriptCli,
  type TranscriptCliDeps,
} from "../cli/transcript";
import { encodeClaudeProject } from "../src/transcript/claude";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";
const SUBAGENT = "abc123def456";
const PROJECT = "/work/alpha";
const OTHER_PROJECT = "/work/beta";
const NOW = Date.parse("2026-07-09T12:00:00.000Z");

let root: string;
let configDir: string;
let deps: TranscriptCliDeps;

function line(value: unknown): string {
  return JSON.stringify(value);
}

function message(
  type: "user" | "assistant",
  timestamp: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): string {
  return line({
    type,
    timestamp,
    cwd: PROJECT,
    sessionId: SESSION,
    message: { role: type, content, model: "claude-test" },
    ...extra,
  });
}

function writeSession(
  project: string,
  sessionId: string,
  body: string,
  modified: string,
): string {
  const projectDir = join(configDir, "projects", encodeClaudeProject(project));
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(path, `${body}\n`);
  const time = new Date(modified);
  utimesSync(path, time, time);
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-transcript-"));
  configDir = join(root, "claude");
  deps = { cwd: PROJECT, homeDir: root, env: {}, nowMs: NOW };

  const main = [
    line({
      type: "custom-title",
      customTitle: "Alpha handoff",
      sessionId: SESSION,
    }),
    message("user", "2026-07-09T08:00:00.000Z", "Build the alpha feature"),
    message("user", "2026-07-09T08:00:01.000Z", "injected skill body", {
      isMeta: true,
    }),
    message("assistant", "2026-07-09T08:00:02.000Z", [
      { type: "thinking", thinking: "private chain" },
      { type: "text", text: "I will inspect the repository." },
    ]),
    message("assistant", "2026-07-09T08:00:03.000Z", [
      {
        type: "tool_use",
        id: "tool-1",
        name: "Bash",
        input: { command: "git status --short", description: "Inspect state" },
      },
    ]),
    message("user", "2026-07-09T08:00:04.000Z", [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: " M cli/transcript.ts\n",
        is_error: false,
      },
    ]),
    message(
      "user",
      "2026-07-09T08:00:05.000Z",
      "Compact summary of the earlier work",
      { isCompactSummary: true },
    ),
    line({
      type: "system",
      subtype: "turn_duration",
      timestamp: "2026-07-09T08:00:06.000Z",
      durationMs: 1200,
    }),
    message("user", "2026-07-09T08:00:07.000Z", "Please finish it"),
    message("assistant", "2026-07-09T08:00:08.000Z", "Finished and verified."),
    "{malformed",
  ].join("\n");
  const mainPath = writeSession(
    PROJECT,
    SESSION,
    main,
    "2026-07-09T08:01:00.000Z",
  );

  const subagentDir = join(mainPath.slice(0, -".jsonl".length), "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, `agent-${SUBAGENT}.jsonl`),
    `${[
      line({
        type: "user",
        timestamp: "2026-07-09T08:00:03.500Z",
        cwd: PROJECT,
        sessionId: SESSION,
        agentId: SUBAGENT,
        message: { role: "user", content: "Inspect the parser edge cases" },
      }),
      line({
        type: "assistant",
        timestamp: "2026-07-09T08:00:05.500Z",
        cwd: PROJECT,
        sessionId: SESSION,
        agentId: SUBAGENT,
        message: {
          role: "assistant",
          content: "Parser edge cases are covered.",
        },
      }),
    ].join("\n")}\n`,
  );

  writeSession(
    OTHER_PROJECT,
    OTHER_SESSION,
    [
      line({
        type: "custom-title",
        customTitle: "Beta session",
        sessionId: OTHER_SESSION,
      }),
      line({
        type: "user",
        timestamp: "2026-07-09T09:00:00.000Z",
        cwd: OTHER_PROJECT,
        sessionId: OTHER_SESSION,
        message: { role: "user", content: "Work in beta" },
      }),
    ].join("\n"),
    "2026-07-09T09:01:00.000Z",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[]) {
  return runTranscriptCli([...args, "--config-dir", configDir], deps);
}

describe("keeper transcript show", () => {
  test("renders conversation, compact tools, pagination, and subagent ids", () => {
    const result = run([SESSION, "--offset", "0", "--limit", "20"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("@keeper-transcript v1");
    expect(result.stdout).toContain('title: "Alpha handoff"');
    expect(result.stdout).toContain("Build the alpha feature");
    expect(result.stdout).toContain("I will inspect the repository.");
    expect(result.stdout).toContain("tool-call Bash");
    expect(result.stdout).toContain("git status --short");
    expect(result.stdout).toContain("tool-result Bash ok");
    expect(result.stdout).toContain("Compact summary of the earlier work");
    expect(result.stdout).toContain(SUBAGENT);
    expect(result.stdout).toContain("malformed_lines: 1");
    expect(result.stdout).not.toContain("injected skill body");
    expect(result.stdout).not.toContain("private chain");
    expect(result.stdout).not.toContain("turn duration");
  });

  test("default page takes the newest matching entries", () => {
    const result = run([SESSION, "--limit", "1"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Finished and verified.");
    expect(result.stdout).not.toContain("Build the alpha feature");
    expect(result.stdout).toMatch(/older_before: \d+/);
  });

  test("older_before identifies the adjacent character-bounded page", () => {
    const newest = JSON.parse(
      run([SESSION, "--max-chars", "1000", "--json"]).stdout,
    );
    expect(newest.data.page.clipped_by_chars).toBe(true);
    expect(newest.data.page.older_before).toBeGreaterThanOrEqual(0);

    const previous = JSON.parse(
      run([
        SESSION,
        "--before",
        String(newest.data.page.older_before),
        "--max-chars",
        "1000",
        "--json",
      ]).stdout,
    );
    expect(previous.data.page.end_offset).toBe(newest.data.page.offset);
    expect(previous.data.page.newer_offset).toBe(newest.data.page.offset);

    const conflict = run([SESSION, "--offset", "0", "--before", "1"]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("mutually exclusive");
  });

  test("selects a subagent by prefix", () => {
    const result = run([SESSION, "--subagent", "abc123", "--offset", "0"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`source: subagent:${SUBAGENT}`);
    expect(result.stdout).toContain("Inspect the parser edge cases");
    expect(result.stdout).toContain("Parser edge cases are covered.");
    expect(result.stdout).not.toContain("Build the alpha feature");
  });

  test("all-source JSON interleaves main and subagent entries", () => {
    const result = run([
      SESSION,
      "--subagent",
      "all",
      "--offset",
      "0",
      "--format",
      "json",
    ]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.selected_source).toBe("all");
    expect(
      parsed.data.entries.map((entry: { source: string }) => entry.source),
    ).toContain(`subagent:${SUBAGENT}`);
    expect(parsed.data.subagents[0].id).toBe(SUBAGENT);
  });

  test("filters by role, content, and tool visibility", () => {
    const assistants = run([
      SESSION,
      "--offset",
      "0",
      "--role",
      "assistant",
      "--grep",
      "inspect",
    ]);
    expect(assistants.stdout).toContain("I will inspect the repository.");
    expect(assistants.stdout).not.toContain("Build the alpha feature");

    const noTools = run([SESSION, "--offset", "0", "--tools", "none"]);
    expect(noTools.stdout).not.toContain("tool-call");
    expect(noTools.stdout).not.toContain("tool-result");
  });

  test("returns structured errors for JSON callers", () => {
    const result = run(["missing-session", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("session_not_found");
  });
});

describe("keeper transcript list", () => {
  test("defaults to cwd and --global expands the scope", () => {
    const local = run(["list"]);
    expect(local.code).toBe(0);
    expect(local.stdout).toContain(SESSION);
    expect(local.stdout).not.toContain(OTHER_SESSION);

    const global = run(["list", "--global", "--format", "json"]);
    const parsed = JSON.parse(global.stdout);
    expect(
      parsed.data.sessions.map((item: { sessionId: string }) => item.sessionId),
    ).toEqual([OTHER_SESSION, SESSION]);
  });

  test("paginates and rejects conflicting scope flags", () => {
    const page = run(["list", "--global", "--limit", "1", "--json"]);
    const parsed = JSON.parse(page.stdout);
    expect(parsed.data.page.next_offset).toBe(1);
    expect(parsed.data.sessions).toHaveLength(1);

    const conflict = run(["list", "--global", "--project", PROJECT]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("mutually exclusive");
  });
});

test("time parser supports relative durations and inclusive date-only until", () => {
  expect(parseTranscriptTime("7d", NOW, "since")).toBe(NOW - 7 * 86_400_000);
  expect(parseTranscriptTime("2026-07-09", NOW, "until")).toBe(
    Date.parse("2026-07-10T00:00:00.000Z") - 1,
  );
  expect(parseTranscriptTime("nonsense", NOW, "since")).toContain("invalid");
});
