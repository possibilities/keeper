import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
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
import {
  discoverClaudeProjectsRoots,
  encodeClaudeProject,
  listClaudeSessions,
} from "../src/transcript/claude";

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

/**
 * Writes a session directly into a literal, hard-coded bucket directory name,
 * bypassing encodeClaudeProject entirely. Regression fixtures for the encoder
 * must use this helper (never writeSession) so the expected bucket string
 * cannot silently co-move with a future encoder change.
 */
function writeSessionInBucket(
  bucket: string,
  sessionId: string,
  body: string,
  modified: string,
): string {
  const projectDir = join(configDir, "projects", bucket);
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
      customTitle: "Earlier Alpha",
      sessionId: SESSION,
    }),
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
  return runTranscriptCli(["claude", ...args, "--config-dir", configDir], deps);
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

  test("resolves current/historical titles and exact Keeper job aliases", () => {
    const current = run(["Alpha handoff", "--offset", "0"]);
    expect(current.code).toBe(0);
    const historical = run(["Earlier Alpha", "--offset", "0"]);
    expect(historical.code).toBe(0);
    expect(historical.stdout).toContain("Build the alpha feature");

    deps.readKeeperJobs = () => ({
      diagnostics: [],
      jobs: [
        {
          jobId: "keeper-job-alias",
          harness: "claude",
          nativeId: SESSION,
          transcriptPath: join(
            configDir,
            "projects",
            encodeClaudeProject(PROJECT),
            `${SESSION}.jsonl`,
          ),
          project: PROJECT,
          currentTitle: "Alpha handoff",
          titleHistory: ["Earlier Alpha", "Alpha handoff"],
          state: "ended",
          createdAtMs: 1,
          updatedAtMs: 2,
          pid: null,
          startTime: null,
        },
      ],
    });
    const alias = run(["keeper-job-alias", "--offset", "0"]);
    expect(alias.code).toBe(0);
    expect(alias.stdout).toContain(`session: ${SESSION}`);
  });

  test("an exact job alias keeps precedence over a colliding native id", () => {
    deps.readKeeperJobs = () => ({
      diagnostics: [],
      jobs: [
        {
          jobId: SESSION,
          harness: "claude",
          nativeId: OTHER_SESSION,
          transcriptPath: null,
          project: OTHER_PROJECT,
          currentTitle: "Beta session",
          titleHistory: ["Beta session"],
          state: "ended",
          createdAtMs: 1,
          updatedAtMs: 2,
          pid: null,
          startTime: null,
        },
      ],
    });
    const result = run([SESSION, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.session.sessionId).toBe(
      OTHER_SESSION,
    );
  });

  test("returns structured errors for misses and qualified harness mismatch", () => {
    const missing = run(["missing-session", "--json"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toBe("");
    expect(JSON.parse(missing.stdout).error.code).toBe("session_not_found");

    const mismatch = runTranscriptCli(
      ["pi", "show", `claude:${SESSION}`, "--json"],
      deps,
    );
    expect(mismatch.code).toBe(1);
    expect(JSON.parse(mismatch.stdout).error.code).toBe("harness_mismatch");
  });

  test("human entry labels equal page.offset + array position and round-trip via --offset", () => {
    const forward = JSON.parse(
      run([SESSION, "--offset", "0", "--limit", "20", "--json"]).stdout,
    );
    const page = forward.data.page;
    expect(page.offset).toBe(0);
    const human = run([SESSION, "--offset", "0", "--limit", "20"]);
    expect(human.stdout).toContain(`[#${page.offset} `);

    const midLabel = page.offset + 2;
    const viaOffset = JSON.parse(
      run([SESSION, "--offset", String(midLabel), "--json"]).stdout,
    );
    expect(viaOffset.data.page.offset).toBe(midLabel);
    expect(viaOffset.data.entries[0].sourceIndex).toBe(
      forward.data.entries[2].sourceIndex,
    );
  });

  test("backward-paged human labels equal page.offset even when char-clipping skips entries from the front", () => {
    const clipped = JSON.parse(
      run([SESSION, "--max-chars", "700", "--json"]).stdout,
    );
    expect(clipped.data.page.clipped_by_chars).toBe(true);
    const human = run([SESSION, "--max-chars", "700"]);
    expect(human.stdout).toContain(`[#${clipped.data.page.offset} `);
  });

  test("human output never exceeds the requested --max-chars", () => {
    for (const budget of [900, 1000, 1500, 5000]) {
      const result = run([SESSION, "--max-chars", String(budget)]);
      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeLessThanOrEqual(budget);
    }
  });

  test("many-subagent session caps the human header with a '+M more' tail; JSON keeps the full list", () => {
    const manyId = "55555555-5555-4555-8555-555555555555";
    const mainPath = writeSession(
      PROJECT,
      manyId,
      [
        line({
          type: "custom-title",
          customTitle: "Many subagents",
          sessionId: manyId,
        }),
        line({
          type: "user",
          timestamp: "2026-07-09T08:00:00.000Z",
          cwd: PROJECT,
          sessionId: manyId,
          message: { role: "user", content: "Build the alpha feature" },
        }),
      ].join("\n"),
      "2026-07-09T08:01:00.000Z",
    );
    const subagentDir = join(mainPath.slice(0, -".jsonl".length), "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const total = 15;
    for (let i = 0; i < total; i++) {
      const id = `sub${String(i).padStart(2, "0")}abcdef`;
      writeFileSync(
        join(subagentDir, `agent-${id}.jsonl`),
        `${line({
          type: "user",
          timestamp: "2026-07-09T08:00:03.500Z",
          cwd: PROJECT,
          sessionId: manyId,
          agentId: id,
          message: { role: "user", content: `Subagent ${i} task` },
        })}\n`,
      );
    }

    const human = run([manyId, "--offset", "0"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain(`+${total - 12} more`);
    expect(human.stdout.match(/^ {2}sub\d\dabcdef /gm)).toHaveLength(12);

    const json = JSON.parse(run([manyId, "--offset", "0", "--json"]).stdout);
    expect(json.data.subagents).toHaveLength(total);
  });

  test("--help documents the total-budget semantics and the label/JSON-index distinction", () => {
    const help = runTranscriptCli(["claude", "show", "--help"], deps);
    expect(help.stdout).toContain("Total character budget");
    expect(help.stdout).toContain("page position");
  });
});

describe("keeper transcript preview ellipsizing", () => {
  test("preview call sites each clip to their own exact max, never max+2", () => {
    const longId = "88888888-8888-4888-8888-888888888888";
    const longTitle = "T".repeat(1000);
    const longPrompt = "P".repeat(500);
    const mainPath = writeSession(
      PROJECT,
      longId,
      [
        line({
          type: "custom-title",
          customTitle: longTitle,
          sessionId: longId,
        }),
        message("user", "2026-07-09T08:00:00.000Z", longPrompt),
      ].join("\n"),
      "2026-07-09T08:01:00.000Z",
    );

    const subagentDir = join(mainPath.slice(0, -".jsonl".length), "subagents");
    mkdirSync(subagentDir, { recursive: true });
    const longTask = "S".repeat(500);
    writeFileSync(
      join(subagentDir, `agent-${SUBAGENT}.jsonl`),
      `${line({
        type: "user",
        timestamp: "2026-07-09T08:00:01.000Z",
        cwd: PROJECT,
        sessionId: longId,
        agentId: SUBAGENT,
        message: { role: "user", content: longTask },
      })}\n`,
    );

    // firstPrompt is computed once (max 240) and carried verbatim into the
    // JSON list item — never re-clipped downstream.
    const listJson = JSON.parse(
      run(["list", "--project", PROJECT, "--json"]).stdout,
    );
    const item = listJson.data.sessions.find(
      (session: { sessionId: string }) => session.sessionId === longId,
    );
    expect(item.firstPrompt).toBe(`${"P".repeat(237)}...`);
    expect(item.firstPrompt.length).toBe(240);

    // list human rendering clips the title preview to max 180.
    const listHuman = run(["list", "--project", PROJECT]);
    expect(listHuman.stdout).toContain(JSON.stringify(`${"T".repeat(177)}...`));

    // show's header clips the (raw, unclipped-at-JSON-layer) title to max 300.
    const showHuman = run([longId, "--project", PROJECT, "--offset", "0"]);
    expect(showHuman.stdout).toContain(
      `title: ${JSON.stringify(`${"T".repeat(297)}...`)}`,
    );

    // the subagent header line clips its task preview to max 72.
    expect(showHuman.stdout).toContain(
      `task=${JSON.stringify(`${"S".repeat(69)}...`)}`,
    );
  });
});

describe("keeper transcript first-prompt slash-command stripping", () => {
  test("strips slash-command XML wrappers and falls through to the next candidate when empty", () => {
    const slashId = "99999999-9999-4999-9999-999999999999";
    writeSession(
      PROJECT,
      slashId,
      [
        line({
          type: "custom-title",
          customTitle: "Slash session",
          sessionId: slashId,
        }),
        message(
          "user",
          "2026-07-09T08:00:00.000Z",
          "<command-message>Running tests</command-message>" +
            "<command-name>/test</command-name><command-args></command-args>",
        ),
        message(
          "user",
          "2026-07-09T08:00:01.000Z",
          "Actually run the widget tests",
        ),
      ].join("\n"),
      "2026-07-09T08:01:00.000Z",
    );

    const parsed = JSON.parse(
      run(["list", "--project", PROJECT, "--json"]).stdout,
    );
    const item = parsed.data.sessions.find(
      (session: { sessionId: string }) => session.sessionId === slashId,
    );
    expect(item.firstPrompt).toBe("Actually run the widget tests");
  });

  test("unwraps command-args content instead of dropping it", () => {
    const slashId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeSession(
      PROJECT,
      slashId,
      [
        line({
          type: "custom-title",
          customTitle: "Slash args session",
          sessionId: slashId,
        }),
        message(
          "user",
          "2026-07-09T08:00:00.000Z",
          "<command-message>Running</command-message>" +
            "<command-name>/grep</command-name><command-args>needle</command-args>",
        ),
      ].join("\n"),
      "2026-07-09T08:01:00.000Z",
    );

    const parsed = JSON.parse(
      run(["list", "--project", PROJECT, "--json"]).stdout,
    );
    const item = parsed.data.sessions.find(
      (session: { sessionId: string }) => session.sessionId === slashId,
    );
    expect(item.firstPrompt).toBe("needle");
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

  test("a file vanishing between scan and parse degrades one row, not the whole list", () => {
    const roots = discoverClaudeProjectsRoots({ configDirs: [configDir] });
    const result = listClaudeSessions({
      roots,
      project: null,
      sinceMs: null,
      untilMs: null,
      offset: 0,
      limit: 20,
      onBeforeInspect: (file) => {
        if (file.sessionId === SESSION) {
          unlinkSync(file.path);
        }
      },
    });
    expect(result.total).toBe(2);
    expect(result.nextOffset).toBeNull();
    expect(result.items).toHaveLength(2);

    const vanished = result.items.find((item) => item.sessionId === SESSION);
    expect(vanished).toBeDefined();
    expect(vanished?.project).toBeNull();
    expect(vanished?.title).toBeNull();
    expect(vanished?.startedAt).toBeNull();
    expect(vanished?.firstPrompt).toBeNull();
    expect(vanished?.bytes).toBeGreaterThan(0);

    const survivor = result.items.find(
      (item) => item.sessionId === OTHER_SESSION,
    );
    expect(survivor?.title).toBe("Beta session");
  });
});

describe("keeper transcript show ambiguous session hint", () => {
  test("an exact title ambiguity is narrowed by --project", () => {
    const first = "33333333-aaaa-4333-8333-aaaaaaaaaaaa";
    const second = "44444444-bbbb-4444-8444-bbbbbbbbbbbb";
    writeSession(
      PROJECT,
      first,
      [
        line({
          type: "custom-title",
          customTitle: "Shared title",
          sessionId: first,
        }),
        line({
          type: "user",
          timestamp: "2026-07-09T11:00:00.000Z",
          cwd: PROJECT,
          sessionId: first,
          message: { role: "user", content: "first project" },
        }),
      ].join("\n"),
      "2026-07-09T12:00:00.000Z",
    );
    writeSession(
      OTHER_PROJECT,
      second,
      [
        line({
          type: "custom-title",
          customTitle: "Shared title",
          sessionId: second,
        }),
        line({
          type: "user",
          timestamp: "2026-07-09T11:00:00.000Z",
          cwd: OTHER_PROJECT,
          sessionId: second,
          message: { role: "user", content: "second project" },
        }),
      ].join("\n"),
      "2026-07-09T12:00:00.000Z",
    );

    const ambiguous = run(["Shared title", "--json"]);
    expect(ambiguous.code).toBe(1);
    expect(JSON.parse(ambiguous.stdout).error.code).toBe("session_ambiguous");

    const selected = run([
      "Shared title",
      "--project",
      OTHER_PROJECT,
      "--json",
    ]);
    expect(selected.code).toBe(0);
    expect(JSON.parse(selected.stdout).data.session.sessionId).toBe(second);
  });

  test("duplicate session id within one config root names --project", () => {
    const dupSessionId = "66666666-6666-4666-8666-666666666666";
    writeSession(
      PROJECT,
      dupSessionId,
      line({ type: "custom-title", customTitle: "A", sessionId: dupSessionId }),
      "2026-07-09T12:00:00.000Z",
    );
    writeSession(
      OTHER_PROJECT,
      dupSessionId,
      line({ type: "custom-title", customTitle: "B", sessionId: dupSessionId }),
      "2026-07-09T12:00:00.000Z",
    );

    const result = run([dupSessionId]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--project");
    expect(result.stderr).not.toContain("--config-dir");
  });

  test("duplicate session id across config roots names --config-dir", () => {
    const dupSessionId = "77777777-7777-4777-8777-777777777777";
    writeSession(
      PROJECT,
      dupSessionId,
      line({ type: "custom-title", customTitle: "A", sessionId: dupSessionId }),
      "2026-07-09T12:00:00.000Z",
    );

    const configDir2 = join(root, "claude2");
    const projectDir2 = join(
      configDir2,
      "projects",
      encodeClaudeProject(PROJECT),
    );
    mkdirSync(projectDir2, { recursive: true });
    const path2 = join(projectDir2, `${dupSessionId}.jsonl`);
    writeFileSync(
      path2,
      `${line({ type: "custom-title", customTitle: "C", sessionId: dupSessionId })}\n`,
    );
    const modified = new Date("2026-07-09T12:00:00.000Z");
    utimesSync(path2, modified, modified);

    const result = runTranscriptCli(
      [
        "claude",
        dupSessionId,
        "--config-dir",
        configDir,
        "--config-dir",
        configDir2,
      ],
      deps,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--config-dir");
  });
});

describe("encodeClaudeProject", () => {
  test("replaces every non-alphanumeric character with a dash, one dash per character", () => {
    expect(encodeClaudeProject("/work/alpha")).toBe("-work-alpha");
    expect(encodeClaudeProject("/work/keeper-lane.3")).toBe(
      "-work-keeper-lane-3",
    );
  });

  test("adjacent non-alphanumeric characters yield adjacent dashes (non-collapsing)", () => {
    expect(encodeClaudeProject("/work/foo_.bar")).toBe("-work-foo--bar");
  });
});

describe("keeper transcript dotted/underscored project paths", () => {
  test("list --project finds sessions for a worktree-lane-like dotted path", () => {
    const dottedProject = "/work/keeper-qzvs8i.harden-transcript";
    const dottedBucket = "-work-keeper-qzvs8i-harden-transcript";
    const dottedSession = "33333333-3333-4333-8333-333333333333";
    writeSessionInBucket(
      dottedBucket,
      dottedSession,
      [
        line({
          type: "custom-title",
          customTitle: "Dotted lane session",
          sessionId: dottedSession,
        }),
        line({
          type: "user",
          timestamp: "2026-07-09T10:00:00.000Z",
          cwd: dottedProject,
          sessionId: dottedSession,
          message: { role: "user", content: "Work in the dotted lane" },
        }),
      ].join("\n"),
      "2026-07-09T10:01:00.000Z",
    );

    const listResult = run(["list", "--project", dottedProject, "--json"]);
    expect(listResult.code).toBe(0);
    const parsed = JSON.parse(listResult.stdout);
    expect(
      parsed.data.sessions.map((item: { sessionId: string }) => item.sessionId),
    ).toEqual([dottedSession]);

    const showResult = run([
      dottedSession,
      "--project",
      dottedProject,
      "--offset",
      "0",
    ]);
    expect(showResult.code).toBe(0);
    expect(showResult.stdout).toContain("Work in the dotted lane");
  });

  test("adjacent non-alphanumeric characters (underscore-dot) resolve to the same literal bucket", () => {
    const project = "/work/foo_.bar";
    const bucket = "-work-foo--bar";
    const sessionId = "44444444-4444-4444-8444-444444444444";
    writeSessionInBucket(
      bucket,
      sessionId,
      [
        line({
          type: "custom-title",
          customTitle: "Underscore-dot session",
          sessionId,
        }),
        line({
          type: "user",
          timestamp: "2026-07-09T11:00:00.000Z",
          cwd: project,
          sessionId,
          message: { role: "user", content: "Work in the underscore-dot dir" },
        }),
      ].join("\n"),
      "2026-07-09T11:01:00.000Z",
    );

    const listResult = run(["list", "--project", project, "--json"]);
    expect(listResult.code).toBe(0);
    const parsed = JSON.parse(listResult.stdout);
    expect(
      parsed.data.sessions.map((item: { sessionId: string }) => item.sessionId),
    ).toEqual([sessionId]);
  });
});

describe("keeper transcript harness-first grammar", () => {
  test("bare invocation, --help/-h, and --agent-help print help without a harness token", () => {
    expect(runTranscriptCli([], deps).stdout).toContain("keeper transcript");
    expect(runTranscriptCli(["--help"], deps).stdout).toContain(
      "keeper transcript",
    );
    expect(runTranscriptCli(["-h"], deps).stdout).toContain(
      "keeper transcript",
    );
    expect(runTranscriptCli(["--agent-help"], deps).stdout).toContain(
      "agent workflow",
    );
  });

  test("a harness token with an empty rest prints help", () => {
    const result = runTranscriptCli(["claude"], deps);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("keeper transcript <harness>");
  });

  test("an unregistered harness token exits non-zero naming the registry keys", () => {
    const result = runTranscriptCli(["hermes", "list"], deps);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("hermes");
    expect(result.stderr).toContain("claude");
  });

  test("an unknown position-0 token exits non-zero the same way", () => {
    const result = runTranscriptCli(["bogus", "list"], deps);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("bogus");
    expect(result.stderr).toContain("claude");
  });

  test("--harness no longer parses anywhere", () => {
    const listResult = run(["list", "--harness", "claude"]);
    expect(listResult.code).toBe(2);
    const showResult = run([SESSION, "--harness", "claude"]);
    expect(showResult.code).toBe(2);
  });

  test("the claude positional list/show/bare-id forms work end to end", () => {
    const listResult = runTranscriptCli(
      ["claude", "list", "--project", PROJECT, "--config-dir", configDir],
      deps,
    );
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("harness: claude");
    expect(listResult.stdout).toContain(SESSION);

    const showResult = runTranscriptCli(
      ["claude", "show", SESSION, "--offset", "0", "--config-dir", configDir],
      deps,
    );
    expect(showResult.code).toBe(0);
    expect(showResult.stdout).toContain("harness: claude");

    const bareIdResult = runTranscriptCli(
      ["claude", SESSION, "--offset", "0", "--config-dir", configDir],
      deps,
    );
    expect(bareIdResult.code).toBe(0);
    expect(bareIdResult.stdout).toBe(showResult.stdout);
  });

  test("turn is pi-only: any other harness fails naming pi", () => {
    const result = runTranscriptCli(
      ["claude", "turn", SESSION, "--leaf", "root", "--format", "json"],
      deps,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("pi");
  });

  test("turn --help is harness-independent (prints help even for claude)", () => {
    const result = runTranscriptCli(["claude", "turn", "--help"], deps);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("keeper transcript pi turn");
  });

  test("turn requires --leaf", () => {
    const result = runTranscriptCli(["pi", "turn", SESSION], deps);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--leaf");
  });

  test("turn rejects a non-json --format", () => {
    const result = runTranscriptCli(
      ["pi", "turn", SESSION, "--leaf", "root", "--format", "human"],
      deps,
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("json");
  });
});

test("time parser supports relative durations and inclusive local-day until", () => {
  expect(parseTranscriptTime("7d", NOW, "since")).toBe(NOW - 7 * 86_400_000);
  // Date-only bounds are local calendar days: since is that day's local
  // midnight (Date's own local-time constructor), until is the next local
  // midnight minus one ms — independent of the host's timezone.
  expect(parseTranscriptTime("2026-07-09", NOW, "since")).toBe(
    new Date(2026, 6, 9, 0, 0, 0, 0).getTime(),
  );
  expect(parseTranscriptTime("2026-07-09", NOW, "until")).toBe(
    new Date(2026, 6, 10, 0, 0, 0, 0).getTime() - 1,
  );
  expect(parseTranscriptTime("nonsense", NOW, "since")).toContain("invalid");
});

test("out-of-range date-only since/until returns the invalid time error", () => {
  expect(parseTranscriptTime("2026-02-30", NOW, "since")).toContain("invalid");
  expect(parseTranscriptTime("2026-02-30", NOW, "until")).toContain("invalid");
  expect(parseTranscriptTime("2026-13-01", NOW, "since")).toContain("invalid");
  expect(parseTranscriptTime("2026-13-01", NOW, "until")).toContain("invalid");
});

test("date-only since/until select local calendar days across DST boundaries", () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    // 2026-03-08 is the America/New_York spring-forward transition: local
    // midnight to next local midnight spans only 23 wall-clock hours.
    const springSince = parseTranscriptTime("2026-03-08", NOW, "since");
    const springUntil = parseTranscriptTime("2026-03-08", NOW, "until");
    expect(springSince).toBe(new Date(2026, 2, 8, 0, 0, 0, 0).getTime());
    expect(springUntil).toBe(new Date(2026, 2, 9, 0, 0, 0, 0).getTime() - 1);
    expect((springUntil as number) - (springSince as number)).toBe(
      23 * 3_600_000 - 1,
    );

    // 2026-11-01 is the fall-back transition: the local day spans 25 hours.
    const fallSince = parseTranscriptTime("2026-11-01", NOW, "since");
    const fallUntil = parseTranscriptTime("2026-11-01", NOW, "until");
    expect(fallSince).toBe(new Date(2026, 10, 1, 0, 0, 0, 0).getTime());
    expect(fallUntil).toBe(new Date(2026, 10, 2, 0, 0, 0, 0).getTime() - 1);
    expect((fallUntil as number) - (fallSince as number)).toBe(
      25 * 3_600_000 - 1,
    );
  } finally {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  }
});
