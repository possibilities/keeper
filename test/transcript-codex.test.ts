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
import { runTranscriptCli, type TranscriptCliDeps } from "../cli/transcript";
import { listCodexSessions } from "../src/transcript/codex";
import { TRANSCRIPT_LINE_BYTE_CAP } from "../src/transcript/parse-common";

const SESSION = "019eeca0-fcbb-715d-9bd0-4a756390883a";
const OTHER_SESSION = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const PROJECT = "/work/alpha";
const OTHER_PROJECT = "/work/beta";
const NOW = Date.parse("2026-07-09T12:00:00.000Z");

let root: string;
let codexHome: string;
let deps: TranscriptCliDeps;

function line(value: unknown): string {
  return JSON.stringify(value);
}

/** Real codex rollout day-dir: `sessions/YYYY/MM/DD`, LOCAL calendar date
 *  components (matches the reader's own day-dir placement). */
function dayDir(ms: number): string[] {
  const d = new Date(ms);
  return [
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ];
}

/** Real codex rollout filename: `rollout-<ts-with-dashes-and-literal-T>-<uuid>.jsonl`. */
function rolloutFileName(uuid: string, ms: number): string {
  const iso = new Date(ms).toISOString();
  const tsPart = iso.slice(0, 19).replace(/:/g, "-");
  return `rollout-${tsPart}-${uuid}.jsonl`;
}

function writeRollout(
  uuid: string,
  createdAtMs: number,
  lines: readonly string[],
  modifiedIso?: string,
): string {
  const [y, m, d] = dayDir(createdAtMs);
  const dir = join(
    codexHome,
    "sessions",
    y as string,
    m as string,
    d as string,
  );
  mkdirSync(dir, { recursive: true });
  const path = join(dir, rolloutFileName(uuid, createdAtMs));
  writeFileSync(path, `${lines.join("\n")}\n`);
  const modified = new Date(modifiedIso ?? new Date(createdAtMs).toISOString());
  utimesSync(path, modified, modified);
  return path;
}

function sessionMeta(
  id: string | undefined,
  cwd: string,
  ts: string,
  extra: Record<string, unknown> = {},
): string {
  return line({
    timestamp: ts,
    type: "session_meta",
    payload: {
      ...(id === undefined ? {} : { id }),
      timestamp: ts,
      cwd,
      originator: "codex_cli_rs",
      cli_version: "0.77.0",
      ...extra,
    },
  });
}

function bareSessionMeta(id: string, cwd: string, ts: string): string {
  // Pre-envelope legacy shape: no "type"/"payload" wrapper at all.
  return line({ id, cwd, timestamp: ts });
}

function turnContext(ts: string, cwd: string, model: string): string {
  return line({
    timestamp: ts,
    type: "turn_context",
    payload: {
      cwd,
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
      model,
      summary: "auto",
    },
  });
}

function responseMessage(
  ts: string,
  role: string,
  blocks: readonly unknown[],
): string {
  return line({
    timestamp: ts,
    type: "response_item",
    payload: { type: "message", role, content: blocks },
  });
}

function userTurn(ts: string, text: string): string {
  return responseMessage(ts, "user", [{ type: "input_text", text }]);
}

function assistantTurn(ts: string, text: string): string {
  return responseMessage(ts, "assistant", [{ type: "output_text", text }]);
}

function developerTurn(ts: string, text: string): string {
  return responseMessage(ts, "developer", [{ type: "input_text", text }]);
}

function functionCall(
  ts: string,
  callId: string,
  name: string,
  args: unknown,
): string {
  return line({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "function_call",
      name,
      call_id: callId,
      arguments: JSON.stringify(args),
    },
  });
}

function functionCallOutput(
  ts: string,
  callId: string,
  output: unknown,
  success?: boolean,
): string {
  return line({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output,
      ...(success === undefined ? {} : { success }),
    },
  });
}

function webSearchCall(ts: string, query: string): string {
  return line({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query },
    },
  });
}

function encryptedReasoning(ts: string): string {
  return line({
    timestamp: ts,
    type: "response_item",
    payload: {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "never rendered" }],
      content: null,
      encrypted_content: "gAAAAABnever-render-this",
    },
  });
}

function agentReasoningEvent(ts: string, text: string): string {
  return line({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "agent_reasoning", text },
  });
}

function agentMessageEvent(ts: string, text: string): string {
  return line({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "agent_message", message: text },
  });
}

function userMessageEvent(ts: string, text: string): string {
  return line({
    timestamp: ts,
    type: "event_msg",
    payload: { type: "user_message", message: text },
  });
}

function compactedLine(ts: string): string {
  return line({
    timestamp: ts,
    type: "compacted",
    payload: { message: "", replacement_history: [] },
  });
}

function worldStateLine(ts: string): string {
  return line({ timestamp: ts, type: "world_state", payload: {} });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-transcript-codex-"));
  codexHome = join(root, "codex-home");
  deps = {
    cwd: PROJECT,
    homeDir: root,
    env: { CODEX_HOME: codexHome },
    nowMs: NOW,
  };

  const mainLines = [
    sessionMeta(SESSION, PROJECT, "2026-07-09T08:00:00.000Z"),
    // The padded AGENTS.md/environment_context user turns firstPrompt must
    // NOT prefer.
    userTurn(
      "2026-07-09T08:00:00.100Z",
      "# AGENTS.md instructions for /work/alpha\n<INSTRUCTIONS>padding</INSTRUCTIONS>",
    ),
    userTurn(
      "2026-07-09T08:00:00.200Z",
      "<environment_context>\n  <cwd>/work/alpha</cwd>\n</environment_context>",
    ),
    // The CLEAN human turn — firstPrompt must prefer this.
    userMessageEvent("2026-07-09T08:00:00.300Z", "Build the alpha feature"),
    turnContext("2026-07-09T08:00:00.400Z", PROJECT, "gpt-5.5-codex"),
    developerTurn(
      "2026-07-09T08:00:00.500Z",
      "<permissions instructions>full access</permissions instructions>",
    ),
    agentReasoningEvent("2026-07-09T08:00:01.000Z", "private chain"),
    encryptedReasoning("2026-07-09T08:00:01.100Z"),
    functionCall("2026-07-09T08:00:01.200Z", "call-1", "bash", {
      command: "ls",
    }),
    functionCallOutput("2026-07-09T08:00:01.300Z", "call-1", "file1\nfile2"),
    functionCall("2026-07-09T08:00:01.400Z", "call-2", "apply_patch", {
      patch: "diff",
    }),
    functionCallOutput(
      "2026-07-09T08:00:01.500Z",
      "call-2",
      "patch failed",
      false,
    ),
    webSearchCall("2026-07-09T08:00:01.600Z", "keeper transcript codex"),
    // The event_msg agent_message duplicate must never render.
    agentMessageEvent("2026-07-09T08:00:01.700Z", "duplicate, never rendered"),
    assistantTurn("2026-07-09T08:00:01.800Z", "I will inspect the repository."),
    compactedLine("2026-07-09T08:00:01.900Z"),
    worldStateLine("2026-07-09T08:00:01.950Z"),
    "{malformed",
    responseMessage("2026-07-09T08:00:02.000Z", "user", [
      { type: "input_text", text: "x".repeat(TRANSCRIPT_LINE_BYTE_CAP) },
    ]),
    userTurn("2026-07-09T08:00:03.000Z", "Please finish it"),
    assistantTurn("2026-07-09T08:00:04.000Z", "Finished and verified."),
  ];
  writeRollout(
    SESSION,
    Date.parse("2026-07-09T08:00:00.000Z"),
    mainLines,
    "2026-07-09T08:01:00.000Z",
  );

  writeRollout(
    OTHER_SESSION,
    Date.parse("2026-07-09T09:00:00.000Z"),
    [
      sessionMeta(OTHER_SESSION, OTHER_PROJECT, "2026-07-09T09:00:00.000Z"),
      userMessageEvent("2026-07-09T09:00:00.500Z", "Work in beta"),
      userTurn("2026-07-09T09:00:00.500Z", "Work in beta"),
    ],
    "2026-07-09T09:01:00.000Z",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[]) {
  return runTranscriptCli(["codex", ...args], deps);
}

describe("keeper transcript codex show", () => {
  test("renders every mapped entry kind in file order with per-entry timestamps", () => {
    const result = run([
      SESSION,
      "--offset",
      "0",
      "--limit",
      "30",
      "--thinking",
      "--meta",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("harness: codex");
    expect(result.stdout).toContain("Please finish it");
    expect(result.stdout).toContain("private chain");
    expect(result.stdout).toContain("full access");
    expect(result.stdout).toContain("tool-call bash");
    expect(result.stdout).toContain("tool-call web_search");
    expect(result.stdout).toContain("tool-result apply_patch error");
    expect(result.stdout).toContain("I will inspect the repository.");
    expect(result.stdout).toContain("Finished and verified.");
    // event_msg message duplicates never render, regardless of --meta.
    expect(result.stdout).not.toContain("duplicate, never rendered");
    // encrypted reasoning never renders.
    expect(result.stdout).not.toContain("never rendered");
    // compacted/world_state fold to a silent skip.
    expect(result.stdout).not.toContain("replacement_history");
    // malformed JSON plus the oversized line both count, never abort the read.
    expect(result.stdout).toContain("malformed_lines: 2");
  });

  test("thinking is hidden by default like every other harness", () => {
    const result = run([SESSION, "--offset", "0"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("private chain");
  });

  test("developer turns are meta system entries, hidden without --meta", () => {
    const withoutMeta = run([SESSION, "--offset", "0"]);
    expect(withoutMeta.stdout).not.toContain("full access");

    const withMeta = run([SESSION, "--offset", "0", "--meta"]);
    expect(withMeta.stdout).toContain("full access");
  });

  test("tool_call input is the JSON-parsed arguments object", () => {
    const parsed = JSON.parse(
      run([SESSION, "--offset", "0", "--limit", "30", "--json"]).stdout,
    );
    const call = parsed.data.entries.find(
      (entry: { toolName: string | null }) => entry.toolName === "bash",
    );
    expect(call).toBeDefined();
    expect(call.body).toContain("ls");
  });

  test("JSON envelope carries harness codex and an always-empty subagents list", () => {
    const parsed = JSON.parse(run([SESSION, "--offset", "0", "--json"]).stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.harness).toBe("codex");
    expect(parsed.data.subagents).toEqual([]);
    expect(parsed.data.session.malformedLines).toBe(2);
    expect(parsed.data.session.model).toBe("gpt-5.5-codex");
  });

  test("a non-main --subagent selection fails with a no-subagents error", () => {
    const human = run([SESSION, "--subagent", "worker-1", "--offset", "0"]);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("no subagents");

    const json = JSON.parse(
      run([SESSION, "--subagent", "worker-1", "--offset", "0", "--json"])
        .stdout,
    );
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("subagent_not_found");
    expect(json.error.message).toContain("no subagents");
  });

  test("--role, --tools, and --grep filter as they do for claude", () => {
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
    expect(assistants.stdout).not.toContain("Please finish it");

    const noTools = run([SESSION, "--offset", "0", "--tools", "none"]);
    expect(noTools.stdout).not.toContain("tool-call");
    expect(noTools.stdout).not.toContain("tool-result");
  });

  test("--since/--until bound entries by the top-level timestamp", () => {
    const windowed = run([
      SESSION,
      "--offset",
      "0",
      "--since",
      "2026-07-09T08:00:01.750Z",
      "--until",
      "2026-07-09T08:00:03.500Z",
    ]);
    expect(windowed.code).toBe(0);
    expect(windowed.stdout).toContain("I will inspect the repository.");
    expect(windowed.stdout).toContain("Please finish it");
    expect(windowed.stdout).not.toContain("Finished and verified.");
  });

  test("returns a structured not-found error for an unknown session id", () => {
    const result = run(["66666666-6666-4666-8666-666666666666", "--json"]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("session_not_found");
  });
});

describe("keeper transcript codex find guards", () => {
  test("refuses a session id that is not a bare uuid, never resolving it to a path", () => {
    // The find guard (basename identity + strict uuid shape) must reject any
    // id carrying a separator or traversal segment before a single day-dir is
    // scanned — the id is never joined onto a filesystem path.
    const traversals = [
      "../../../etc/passwd",
      "foo/bar",
      "019eeca0-fcbb-715d-9bd0-4a756390883a/../../secrets",
      "not-a-uuid",
    ];
    for (const evil of traversals) {
      const result = run([evil, "--json"]);
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("session_not_found");
    }
  });

  test("reports an ambiguous session when one uuid appears in two day-dirs", () => {
    const dup = "12121212-3434-4565-8787-909090909090";
    writeRollout(
      dup,
      Date.parse("2026-07-05T12:00:00.000Z"),
      [sessionMeta(dup, PROJECT, "2026-07-05T12:00:00.000Z")],
      "2026-07-05T12:00:00.000Z",
    );
    writeRollout(
      dup,
      Date.parse("2026-07-08T12:00:00.000Z"),
      [sessionMeta(dup, PROJECT, "2026-07-08T12:00:00.000Z")],
      "2026-07-08T12:00:00.000Z",
    );
    const result = run([dup, "--json"]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("session_ambiguous");
  });
});

describe("keeper transcript codex list", () => {
  test("defaults to the cwd scope and --global expands it", () => {
    const local = run(["list"]);
    expect(local.code).toBe(0);
    expect(local.stdout).toContain(SESSION);
    expect(local.stdout).not.toContain(OTHER_SESSION);

    const global = JSON.parse(run(["list", "--global", "--json"]).stdout);
    expect(
      global.data.sessions.map((item: { sessionId: string }) => item.sessionId),
    ).toEqual([OTHER_SESSION, SESSION]);
  });

  test("--project selects another cwd explicitly", () => {
    const parsed = JSON.parse(
      run(["list", "--project", OTHER_PROJECT, "--json"]).stdout,
    );
    expect(
      parsed.data.sessions.map((item: { sessionId: string }) => item.sessionId),
    ).toEqual([OTHER_SESSION]);
  });

  test("firstPrompt prefers the clean event_msg user_message over the padded response_item turn", () => {
    const parsed = JSON.parse(run(["list", "--json"]).stdout);
    const item = parsed.data.sessions.find(
      (session: { sessionId: string }) => session.sessionId === SESSION,
    );
    expect(item.firstPrompt).toBe("Build the alpha feature");
    expect(item.project).toBe(PROJECT);
    expect(item.subagentCount).toBe(0);
    expect(item.title).toBeNull();
  });

  test("--since/--until narrow the day-dir walk and still reach old sessions unwindowed", () => {
    const old = "77777777-7777-4777-8777-777777777777";
    writeRollout(
      old,
      Date.parse("2025-01-01T00:00:00.000Z"),
      [sessionMeta(old, PROJECT, "2025-01-01T00:00:00.000Z")],
      "2025-01-01T00:00:00.000Z",
    );

    const windowed = JSON.parse(
      run(["list", "--since", "2026-07-01T00:00:00.000Z", "--json"]).stdout,
    );
    expect(
      windowed.data.sessions.map((s: { sessionId: string }) => s.sessionId),
    ).toEqual([SESSION]);

    const unwindowed = JSON.parse(run(["list", "--json"]).stdout);
    expect(
      unwindowed.data.sessions.map((s: { sessionId: string }) => s.sessionId),
    ).toContain(old);
  });

  test("archived_sessions, a sibling of sessions/, is never walked", () => {
    const archivedId = "88888888-8888-4888-8888-888888888888";
    const archivedDir = join(codexHome, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(
      join(archivedDir, rolloutFileName(archivedId, NOW)),
      `${sessionMeta(archivedId, PROJECT, "2026-07-09T08:00:00.000Z")}\n`,
    );

    const global = JSON.parse(run(["list", "--global", "--json"]).stdout);
    expect(
      global.data.sessions.map((item: { sessionId: string }) => item.sessionId),
    ).not.toContain(archivedId);

    const found = run([archivedId, "--json"]);
    expect(found.code).toBe(1);
  });

  test("a session_meta missing its id backfills from the filename uuid", () => {
    const noId = "99999999-9999-4999-8999-999999999999";
    writeRollout(
      noId,
      Date.parse("2026-07-09T10:00:00.000Z"),
      [sessionMeta(undefined, PROJECT, "2026-07-09T10:00:00.000Z")],
      "2026-07-09T10:01:00.000Z",
    );
    const parsed = JSON.parse(run(["list", "--json"]).stdout);
    const item = parsed.data.sessions.find(
      (session: { sessionId: string }) => session.sessionId === noId,
    );
    expect(item).toBeDefined();
    expect(item.project).toBe(PROJECT);
  });

  test("a bare pre-envelope meta line falls back to top-level fields", () => {
    const bare = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    writeRollout(
      bare,
      Date.parse("2026-07-09T11:00:00.000Z"),
      [bareSessionMeta(bare, PROJECT, "2026-07-09T11:00:00.000Z")],
      "2026-07-09T11:01:00.000Z",
    );
    const parsed = JSON.parse(run(["list", "--json"]).stdout);
    const item = parsed.data.sessions.find(
      (session: { sessionId: string }) => session.sessionId === bare,
    );
    expect(item).toBeDefined();
    expect(item.project).toBe(PROJECT);
  });

  test("a file vanishing between scan and inspect drops that one row, not the whole list", () => {
    const result = listCodexSessions({
      sessionsDir: join(codexHome, "sessions"),
      project: null,
      sinceMs: null,
      untilMs: null,
      offset: 0,
      limit: 20,
      onBeforeInspect: (file) => {
        if (file.filenameId === SESSION) {
          unlinkSync(file.path);
        }
      },
    });
    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.sessionId)).toEqual([OTHER_SESSION]);
  });

  test("--global and --project are mutually exclusive", () => {
    const conflict = run(["list", "--global", "--project", PROJECT]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("mutually exclusive");
  });
});

describe("keeper transcript codex no readable sessions directory", () => {
  test("list and show both fail loud when the codex sessions tree does not exist", () => {
    const emptyRoot = mkdtempSync(
      join(tmpdir(), "keeper-transcript-codex-empty-"),
    );
    const emptyDeps: TranscriptCliDeps = {
      cwd: PROJECT,
      homeDir: emptyRoot,
      env: { CODEX_HOME: join(emptyRoot, "no-such-codex-home") },
      nowMs: NOW,
    };
    try {
      const list = runTranscriptCli(["codex", "list"], emptyDeps);
      expect(list.code).not.toBe(0);
      const show = runTranscriptCli(["codex", SESSION], emptyDeps);
      expect(show.code).not.toBe(0);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("keeper transcript codex harness grammar", () => {
  test("registers under the harness-first grammar alongside claude and pi", () => {
    const listResult = runTranscriptCli(
      ["codex", "list", "--project", PROJECT],
      deps,
    );
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("harness: codex");
  });
});
