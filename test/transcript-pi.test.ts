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
import { TRANSCRIPT_LINE_BYTE_CAP } from "../src/transcript/parse-common";
import {
  encodePiCwd,
  listPiSessions,
  TURN_TEXT_CAP,
} from "../src/transcript/pi";

const SESSION = "019eeca0-fcbb-715d-9bd0-4a756390883a";
const OTHER_SESSION = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const TURN_SESSION = "77777777-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROJECT = "/work/alpha";
const OTHER_PROJECT = "/work/beta";
const NOW = Date.parse("2026-07-09T12:00:00.000Z");

let root: string;
let piRoot: string;
let deps: TranscriptCliDeps;

function line(value: unknown): string {
  return JSON.stringify(value);
}

/** Real pi session filename: `<iso-ts-with-dashes>_<uuid>.jsonl`. */
function piFileName(uuid: string, ms: number): string {
  return `${new Date(ms).toISOString().replace(/[:.]/g, "-")}_${uuid}.jsonl`;
}

function writePiSessionInBucket(
  bucket: string,
  uuid: string,
  createdAtMs: number,
  lines: readonly string[],
  modifiedIso?: string,
): string {
  const dir = join(piRoot, "sessions", bucket);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, piFileName(uuid, createdAtMs));
  writeFileSync(path, `${lines.join("\n")}\n`);
  const modified = new Date(modifiedIso ?? new Date(createdAtMs).toISOString());
  utimesSync(path, modified, modified);
  return path;
}

function writePiSession(
  project: string,
  uuid: string,
  createdAtMs: number,
  lines: readonly string[],
  modifiedIso?: string,
): string {
  return writePiSessionInBucket(
    encodePiCwd(project),
    uuid,
    createdAtMs,
    lines,
    modifiedIso,
  );
}

function sessionHeader(id: string, cwd: string, timestamp: string): string {
  return line({ type: "session", version: 3, id, timestamp, cwd });
}

function userMessage(
  id: string,
  parentId: string | null,
  timestamp: string,
  text: string,
): string {
  return line({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
  });
}

function assistantMessage(
  id: string,
  parentId: string | null,
  timestamp: string,
  content: unknown[],
): string {
  return line({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "assistant", content, timestamp: 0 },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-transcript-pi-"));
  piRoot = join(root, "pi-agent");
  deps = {
    cwd: PROJECT,
    homeDir: root,
    env: { PI_CODING_AGENT_DIR: piRoot },
    nowMs: NOW,
  };

  const mainLines = [
    sessionHeader(SESSION, PROJECT, "2026-07-09T08:00:00.000Z"),
    line({
      type: "session_info",
      id: "info1",
      parentId: null,
      timestamp: "2026-07-09T08:00:00.100Z",
      name: "Alpha handoff",
    }),
    line({
      type: "session_info",
      id: "info2",
      parentId: "info1",
      timestamp: "2026-07-09T08:00:00.200Z",
      name: "Alpha renamed",
    }),
    line({
      type: "model_change",
      id: "mc1",
      parentId: "info2",
      timestamp: "2026-07-09T08:00:00.300Z",
      provider: "openai-codex",
      modelId: "gpt-5.5",
    }),
    line({
      type: "thinking_level_change",
      id: "tl1",
      parentId: "mc1",
      timestamp: "2026-07-09T08:00:00.400Z",
      thinkingLevel: "high",
    }),
    userMessage(
      "m1",
      "tl1",
      "2026-07-09T08:00:01.000Z",
      "Build the alpha feature",
    ),
    assistantMessage("m2", "m1", "2026-07-09T08:00:02.000Z", [
      { type: "thinking", thinking: "private chain" },
      { type: "text", text: "I will inspect the repository." },
    ]),
    assistantMessage("m3", "m2", "2026-07-09T08:00:03.000Z", [
      {
        type: "toolCall",
        id: "call-1",
        name: "bash",
        arguments: { command: "ls" },
      },
    ]),
    line({
      type: "message",
      id: "m4",
      parentId: "m3",
      timestamp: "2026-07-09T08:00:04.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "file1\nfile2" }],
        isError: false,
        timestamp: 0,
      },
    }),
    line({
      type: "compaction",
      id: "c1",
      parentId: "m4",
      timestamp: "2026-07-09T08:00:05.000Z",
      summary: "Compact summary of the earlier work",
    }),
    line({
      type: "message",
      id: "m5",
      parentId: "c1",
      timestamp: "2026-07-09T08:00:05.500Z",
      message: {
        role: "bashExecution",
        command: "echo hi",
        output: "hi",
        exitCode: 0,
        timestamp: 0,
      },
    }),
    line({
      type: "custom",
      customType: "subagents:record",
      id: "cu1",
      parentId: "m5",
      timestamp: "2026-07-09T08:00:05.700Z",
      data: {},
    }),
    userMessage("m6", "cu1", "2026-07-09T08:00:06.000Z", "Please finish it"),
    assistantMessage("m7", "m6", "2026-07-09T08:00:07.000Z", [
      { type: "text", text: "Finished and verified." },
    ]),
    "{malformed",
    line({
      type: "message",
      id: "big",
      parentId: "m7",
      timestamp: "2026-07-09T08:00:08.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "x".repeat(TRANSCRIPT_LINE_BYTE_CAP) }],
        timestamp: 0,
      },
    }),
  ];
  writePiSession(
    PROJECT,
    SESSION,
    Date.parse("2026-07-09T08:00:00.000Z"),
    mainLines,
    "2026-07-09T08:01:00.000Z",
  );

  writePiSession(
    OTHER_PROJECT,
    OTHER_SESSION,
    Date.parse("2026-07-09T09:00:00.000Z"),
    [
      sessionHeader(OTHER_SESSION, OTHER_PROJECT, "2026-07-09T09:00:00.000Z"),
      line({
        type: "session_info",
        id: "oinfo1",
        parentId: null,
        timestamp: "2026-07-09T09:00:00.100Z",
        name: "Beta session",
      }),
      userMessage("om1", "oinfo1", "2026-07-09T09:00:00.500Z", "Work in beta"),
    ],
    "2026-07-09T09:01:00.000Z",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(args: string[]) {
  return runTranscriptCli(["pi", ...args], deps);
}

describe("keeper transcript pi show", () => {
  test("renders every mapped entry kind in file order with per-entry timestamps", () => {
    const result = run([
      SESSION,
      "--offset",
      "0",
      "--limit",
      "20",
      "--thinking",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("harness: pi");
    // renames append: the LAST session_info name wins.
    expect(result.stdout).toContain('title: "Alpha renamed"');
    expect(result.stdout).toContain("Build the alpha feature");
    expect(result.stdout).toContain("private chain");
    expect(result.stdout).toContain("I will inspect the repository.");
    expect(result.stdout).toContain("tool-call bash");
    expect(result.stdout).toContain("tool-result bash ok");
    expect(result.stdout).toContain("Compact summary of the earlier work");
    expect(result.stdout).toContain("Please finish it");
    expect(result.stdout).toContain("Finished and verified.");
    // unknown roles/types fold to a silent skip.
    expect(result.stdout).not.toContain("echo hi");
    expect(result.stdout).not.toContain("subagents:record");
    // malformed JSON plus the oversized line both count, never abort the read.
    expect(result.stdout).toContain("malformed_lines: 2");
  });

  test("thinking is hidden by default like every other harness", () => {
    const result = run([SESSION, "--offset", "0"]);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("private chain");
  });

  test("JSON envelope carries harness pi and an always-empty subagents list", () => {
    const parsed = JSON.parse(run([SESSION, "--offset", "0", "--json"]).stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.harness).toBe("pi");
    expect(parsed.data.subagents).toEqual([]);
    expect(parsed.data.session.malformedLines).toBe(2);
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

  test("--subagent main still loads the main session", () => {
    const result = run([SESSION, "--subagent", "main", "--offset", "0"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Build the alpha feature");
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
    expect(assistants.stdout).not.toContain("Build the alpha feature");

    const noTools = run([SESSION, "--offset", "0", "--tools", "none"]);
    expect(noTools.stdout).not.toContain("tool-call");
    expect(noTools.stdout).not.toContain("tool-result");
  });

  test("--since/--until bound entries by their top-level timestamp", () => {
    const windowed = run([
      SESSION,
      "--offset",
      "0",
      "--since",
      "2026-07-09T08:00:03.500Z",
      "--until",
      "2026-07-09T08:00:06.500Z",
    ]);
    expect(windowed.code).toBe(0);
    expect(windowed.stdout).toContain("Compact summary of the earlier work");
    expect(windowed.stdout).toContain("Please finish it");
    expect(windowed.stdout).not.toContain("Build the alpha feature");
    expect(windowed.stdout).not.toContain("Finished and verified.");
  });

  test("returns a structured not-found error for an unknown session id", () => {
    const result = run(["missing-session", "--json"]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("session_not_found");
  });

  test("a duplicate uuid across buckets is ambiguous and names --project", () => {
    const dup = "77777777-7777-4777-8777-777777777777";
    writePiSession(PROJECT, dup, Date.parse("2026-07-09T10:00:00.000Z"), [
      sessionHeader(dup, PROJECT, "2026-07-09T10:00:00.000Z"),
    ]);
    writePiSession(OTHER_PROJECT, dup, Date.parse("2026-07-09T10:00:00.000Z"), [
      sessionHeader(dup, OTHER_PROJECT, "2026-07-09T10:00:00.000Z"),
    ]);
    const result = run([dup]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--project");
  });
});

describe("keeper transcript pi list", () => {
  test("defaults to the cwd bucket and --global expands the scope", () => {
    const local = run(["list"]);
    expect(local.code).toBe(0);
    expect(local.stdout).toContain(SESSION);
    expect(local.stdout).not.toContain(OTHER_SESSION);

    const global = JSON.parse(run(["list", "--global", "--json"]).stdout);
    expect(
      global.data.sessions.map((item: { sessionId: string }) => item.sessionId),
    ).toEqual([OTHER_SESSION, SESSION]);
  });

  test("title, firstPrompt, and updatedAt come from real header/session_info/message lines", () => {
    const parsed = JSON.parse(run(["list", "--json"]).stdout);
    const item = parsed.data.sessions.find(
      (session: { sessionId: string }) => session.sessionId === SESSION,
    );
    expect(item.title).toBe("Alpha renamed");
    expect(item.firstPrompt).toBe("Build the alpha feature");
    // The oversized "big" line at 08:00:08 folds to malformed before its
    // timestamp is ever read, so the max tracked timestamp stays at m7.
    expect(item.updatedAt).toBe("2026-07-09T08:00:07.000Z");
    expect(item.subagentCount).toBe(0);
  });

  test("--project selects another bucket explicitly", () => {
    const parsed = JSON.parse(
      run(["list", "--project", OTHER_PROJECT, "--json"]).stdout,
    );
    expect(
      parsed.data.sessions.map((item: { sessionId: string }) => item.sessionId),
    ).toEqual([OTHER_SESSION]);
  });

  test("a file vanishing between scan and parse degrades one row, not the whole list", () => {
    const result = listPiSessions({
      sessionsDir: join(piRoot, "sessions"),
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
    expect(result.items).toHaveLength(2);

    const vanished = result.items.find((item) => item.sessionId === SESSION);
    expect(vanished).toBeDefined();
    expect(vanished?.title).toBeNull();
    expect(vanished?.firstPrompt).toBeNull();
    expect(vanished?.bytes).toBeGreaterThan(0);

    const survivor = result.items.find(
      (item) => item.sessionId === OTHER_SESSION,
    );
    expect(survivor?.title).toBe("Beta session");
  });

  test("--global and --project are mutually exclusive", () => {
    const conflict = run(["list", "--global", "--project", PROJECT]);
    expect(conflict.code).toBe(2);
    expect(conflict.stderr).toContain("mutually exclusive");
  });
});

describe("keeper transcript pi no readable sessions directory", () => {
  test("list and show both fail loud when the pi sessions tree does not exist", () => {
    const emptyRoot = mkdtempSync(
      join(tmpdir(), "keeper-transcript-pi-empty-"),
    );
    const emptyDeps: TranscriptCliDeps = {
      cwd: PROJECT,
      homeDir: emptyRoot,
      env: { PI_CODING_AGENT_DIR: join(emptyRoot, "no-such-pi-dir") },
      nowMs: NOW,
    };
    try {
      const list = runTranscriptCli(["pi", "list"], emptyDeps);
      expect(list.code).not.toBe(0);
      const show = runTranscriptCli(["pi", SESSION], emptyDeps);
      expect(show.code).not.toBe(0);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("keeper transcript pi harness grammar", () => {
  test("registers under the harness-first grammar alongside claude", () => {
    const listResult = runTranscriptCli(
      ["pi", "list", "--project", PROJECT],
      deps,
    );
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain("harness: pi");
  });
});

describe("keeper transcript pi turn", () => {
  function assistantMsg(
    id: string,
    parentId: string,
    stopReason: string,
    content: unknown[],
  ): string {
    return line({
      type: "message",
      id,
      parentId,
      timestamp: "2026-07-09T10:00:00.000Z",
      message: { role: "assistant", content, stopReason, timestamp: 0 },
    });
  }

  function userMsg(id: string, parentId: string, content: unknown[]): string {
    return line({
      type: "message",
      id,
      parentId,
      timestamp: "2026-07-09T10:00:00.000Z",
      message: { role: "user", content, timestamp: 0 },
    });
  }

  function toolResultMsg(id: string, parentId: string): string {
    return line({
      type: "message",
      id,
      parentId,
      timestamp: "2026-07-09T10:00:00.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        toolName: "bash",
        content: [{ type: "text", text: "file1" }],
        isError: false,
        timestamp: 0,
      },
    });
  }

  const OVERSIZED = "y".repeat(TURN_TEXT_CAP + 100);

  beforeEach(() => {
    const turnLines = [
      sessionHeader(TURN_SESSION, PROJECT, "2026-07-09T10:00:00.000Z"),
      line({
        type: "session_info",
        id: "si1",
        parentId: null,
        timestamp: "2026-07-09T10:00:00.100Z",
        name: "Turn test",
      }),
      // u1 -> a1 (toolUse, has its own text too) -> t1 -> a2 (stop): a
      // multi-message tool-use response, terminated by a successful stop.
      userMsg("u1", "si1", [{ type: "text", text: "Build the alpha feature" }]),
      assistantMsg("a1", "u1", "toolUse", [
        { type: "thinking", thinking: "private" },
        { type: "text", text: "Let me check." },
        {
          type: "toolCall",
          id: "call1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ]),
      toolResultMsg("t1", "a1"),
      assistantMsg("a2", "t1", "stop", [{ type: "text", text: "Done." }]),
      // u2 straight off a2: a prompt with nothing following yet.
      userMsg("u2", "a2", [{ type: "text", text: "Please finish it" }]),
      // Siblings off u2: mid tool-use, and each terminal-failure stopReason —
      // every one must reduce to response: null despite carrying partial text.
      assistantMsg("a_toolonly", "u2", "toolUse", [
        { type: "toolCall", id: "call2", name: "bash", arguments: {} },
      ]),
      assistantMsg("a_err", "u2", "error", [
        { type: "text", text: "partial before error" },
      ]),
      assistantMsg("a_abort", "u2", "aborted", [
        { type: "text", text: "partial before abort" },
      ]),
      assistantMsg("a_len", "u2", "length", [
        { type: "text", text: "partial before length cut" },
      ]),
      // An image-only user entry off a2 carries no text: the reducer falls
      // through to the last NON-empty user text (u1), not a null prompt.
      userMsg("u_img", "a2", [
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
      // A branch with no non-empty user text anywhere on its path at all.
      userMsg("only_img", "si1", [
        { type: "image", data: "BBBB", mimeType: "image/png" },
      ]),
      // Oversized prompt/response text, each independently capped.
      userMsg("u_big", "si1", [{ type: "text", text: OVERSIZED }]),
      assistantMsg("a_big", "u_big", "stop", [
        { type: "text", text: OVERSIZED },
      ]),
      // A skill body longer than the ordinary prompt cap. Rename's opt-in
      // strips the complete envelope while it is still intact, preserving the
      // actual request that follows it.
      userMsg("u_skill", "si1", [
        {
          type: "text",
          text: `<skill name="hack">${OVERSIZED}</skill>\n\nFix wrapped dispatch`,
        },
      ]),
      userMsg("u_skill_only", "si1", [
        { type: "text", text: `<skill name="hack">${OVERSIZED}</skill>` },
      ]),
      // A dangling parent link: never resolvable, regardless of file order.
      userMsg("dangling", "does-not-exist", [
        { type: "text", text: "Dangling" },
      ]),
      // An abandoned branch off u1, written LAST in physical file order —
      // proves file position never leaks into a different leaf's result.
      assistantMsg("ab1", "u1", "stop", [
        { type: "text", text: "Abandoned answer" },
      ]),
    ];
    writePiSession(
      PROJECT,
      TURN_SESSION,
      Date.parse("2026-07-09T10:00:00.000Z"),
      turnLines,
      "2026-07-09T10:01:00.000Z",
    );
  });

  function runTurn(leaf: string, extra: string[] = []) {
    return runTranscriptCli(
      [
        "pi",
        "turn",
        TURN_SESSION,
        "--leaf",
        leaf,
        "--format",
        "json",
        ...extra,
      ],
      deps,
    );
  }

  test("a prompt-and-response turn aggregates multi-message tool-use text in order, only past a terminal stop", () => {
    const result = runTurn("a2");
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.harness).toBe("pi");
    expect(parsed.data.selected_leaf).toBe("a2");
    expect(parsed.data.turn).toEqual({
      prompt: "Build the alpha feature",
      promptTruncated: false,
      response: "Let me check.\nDone.",
      responseTruncated: false,
    });
  });

  test("a prompt with nothing following yet is prompt-only (response: null)", () => {
    const parsed = JSON.parse(runTurn("u2").stdout);
    expect(parsed.data.turn).toEqual({
      prompt: "Please finish it",
      promptTruncated: false,
      response: null,
      responseTruncated: false,
    });
  });

  test("mid tool-use (no terminal stop yet) is prompt-only", () => {
    const parsed = JSON.parse(runTurn("a_toolonly").stdout);
    expect(parsed.data.turn.response).toBeNull();
  });

  test("error, aborted, and length stopReasons all discard partial text (response: null)", () => {
    for (const leaf of ["a_err", "a_abort", "a_len"]) {
      const parsed = JSON.parse(runTurn(leaf).stdout);
      expect(parsed.data.turn.response).toBeNull();
      expect(parsed.data.turn.prompt).toBe("Please finish it");
    }
  });

  test("an image-only leaf falls through to the last non-empty user text", () => {
    const parsed = JSON.parse(runTurn("u_img").stdout);
    expect(parsed.data.turn).toEqual({
      prompt: "Build the alpha feature",
      promptTruncated: false,
      response: "Let me check.\nDone.",
      responseTruncated: false,
    });
  });

  test("a branch with no non-empty user text anywhere is an explicit empty turn", () => {
    const parsed = JSON.parse(runTurn("only_img").stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.turn).toBeNull();
  });

  test("root explicitly selects the empty branch", () => {
    const parsed = JSON.parse(runTurn("root").stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.selected_leaf).toBe("root");
    expect(parsed.data.turn).toBeNull();
  });

  test("prompt and response are independently capped with truncation flags", () => {
    const parsed = JSON.parse(runTurn("a_big").stdout);
    expect(parsed.data.turn.prompt.length).toBe(TURN_TEXT_CAP);
    expect(parsed.data.turn.promptTruncated).toBe(true);
    expect(parsed.data.turn.response.length).toBe(TURN_TEXT_CAP);
    expect(parsed.data.turn.responseTruncated).toBe(true);
  });

  test("--strip-skills removes an oversized skill before the prompt cap", () => {
    const raw = JSON.parse(runTurn("u_skill").stdout);
    expect(raw.data.turn.promptTruncated).toBe(true);
    expect(raw.data.turn.prompt).toContain('<skill name="hack">');
    expect(raw.data.turn.prompt).not.toContain("Fix wrapped dispatch");

    const stripped = JSON.parse(runTurn("u_skill", ["--strip-skills"]).stdout);
    expect(stripped.data.turn).toEqual({
      prompt: "Fix wrapped dispatch",
      promptTruncated: false,
      response: null,
      responseTruncated: false,
    });
  });

  test("--strip-skills reduces a skill-only prompt to an empty turn", () => {
    const parsed = JSON.parse(
      runTurn("u_skill_only", ["--strip-skills"]).stdout,
    );
    expect(parsed.data.turn).toBeNull();
  });

  test("an abandoned branch written later in the file never influences an earlier leaf's result", () => {
    const parsed = JSON.parse(runTurn("a2").stdout);
    expect(JSON.stringify(parsed.data.turn)).not.toContain("Abandoned");

    // Selecting the abandoned branch's own leaf resolves it in isolation.
    const abandoned = JSON.parse(runTurn("ab1").stdout);
    expect(abandoned.data.turn.response).toBe("Abandoned answer");
  });

  test("an unknown leaf is a structured error, never a null turn", () => {
    const result = runTurn("nonexistent-leaf-id");
    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("leaf_not_found");
  });

  test("a dangling parent link is a structured malformed error, never a null turn", () => {
    const result = runTurn("dangling");
    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("leaf_malformed");
  });

  test("an unknown session id is a structured not-found error", () => {
    const result = runTranscriptCli(
      ["pi", "turn", "missing-session", "--leaf", "root", "--format", "json"],
      deps,
    );
    expect(result.code).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("session_not_found");
  });
});
