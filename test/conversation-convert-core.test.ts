import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ConversationConversionError,
  convertClaudeToPi,
  prepareClaudeToPiConversion,
  publishClaudeToPiConversion,
  validateClaudeToPiFamilyBounds,
  validatePiV3SessionText,
} from "../src/conversation/claude-to-pi";

type JsonRecord = Record<string, unknown>;

const CWD = "/repo/project";
const SOURCE_SESSION_ID = "11111111-1111-4111-8111-111111111111";

let root: string;
let mainPath: string;
let piAgentDir: string;
let mainLines: string[];

function json(value: unknown): string {
  return JSON.stringify(value);
}

function writeJsonl(path: string, lines: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function parseJsonl(text: string): JsonRecord[] {
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as JsonRecord);
}

function stringifyJsonl(records: readonly JsonRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function activeAncestry(records: readonly JsonRecord[]): JsonRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const ancestry: JsonRecord[] = [];
  let cursor = records.at(-1);
  const seen = new Set<unknown>();
  while (cursor !== undefined && !seen.has(cursor.id)) {
    ancestry.push(cursor);
    seen.add(cursor.id);
    const parentId = cursor.parentId;
    cursor = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  return ancestry;
}

function setupFixture(): void {
  mainLines = [
    json({
      type: "custom-title",
      uuid: "title-1",
      parentUuid: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customTitle: "Imported Title",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
    }),
    json({
      type: "user",
      uuid: "u1",
      parentUuid: "title-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      message: {
        role: "user",
        content: [
          { type: "text", text: "Look at this" },
          {
            type: "image",
            source: { media_type: "image/png", data: "AAA=" },
          },
        ],
      },
    }),
    json({
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      requestId: "req-main",
      message: {
        id: "msg-main",
        role: "assistant",
        model: "claude-sonnet-4",
        usage: { input_tokens: 3, output_tokens: 2 },
        content: [
          { type: "thinking", thinking: "private thought", signature: "sig-1" },
          { type: "text", text: "I will inspect" },
        ],
      },
    }),
    json({
      type: "assistant",
      uuid: "a2",
      parentUuid: "a1",
      timestamp: "2026-01-01T00:00:03.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      requestId: "req-main",
      message: {
        id: "msg-main",
        role: "assistant",
        model: "claude-sonnet-4",
        stop_reason: "tool_use",
        usage: { input_tokens: 3, output_tokens: 5 },
        content: [
          {
            type: "tool_use",
            id: "toolu-main",
            name: "bash",
            input: { command: "ls" },
          },
          { type: "redacted_thinking", data: "red-sig" },
        ],
      },
    }),
    json({
      type: "user",
      uuid: "u2",
      parentUuid: "a2",
      timestamp: "2026-01-01T00:00:04.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      toolUseResult: { status: "async_launched", agentId: "agent-child" },
      message: {
        role: "user",
        content: [
          { type: "text", text: "Tool finished" },
          {
            type: "tool_result",
            tool_use_id: "toolu-main",
            is_error: false,
            content: [
              { type: "text", text: "stdout" },
              {
                type: "image",
                source: { media_type: "image/jpeg", data: "BBB=" },
              },
            ],
          },
        ],
      },
    }),
    json({
      type: "system",
      uuid: "sys1",
      parentUuid: "u2",
      timestamp: "2026-01-01T00:00:05.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      subtype: "note",
      message: "ignored",
    }),
    '{"oops":',
    json({
      type: "user",
      uuid: "u3",
      parentUuid: "u1",
      timestamp: "2026-01-01T00:00:07.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      message: {
        role: "user",
        content: [{ type: "text", text: "Branch question" }],
      },
    }),
    json({
      type: "assistant",
      uuid: "a3",
      parentUuid: "u3",
      timestamp: "2026-01-01T00:00:08.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      requestId: "req-branch",
      message: {
        id: "msg-branch",
        role: "assistant",
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "text", text: "Branch answer" }],
      },
    }),
  ];
  writeJsonl(mainPath, mainLines);

  writeJsonl(
    join(root, "main-session", "subagents", "agent-agent-child.jsonl"),
    [
      json({
        type: "user",
        uuid: "cu1",
        parentUuid: null,
        timestamp: "2026-01-01T01:00:00.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: {
          role: "user",
          content: [{ type: "text", text: "Child task" }],
        },
      }),
      json({
        type: "assistant",
        uuid: "ca1",
        parentUuid: "cu1",
        timestamp: "2026-01-01T01:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "req-child",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          stop_reason: "tool_use",
          usage: { input_tokens: 2, output_tokens: 2 },
          content: [
            { type: "text", text: "Spawning grandchild" },
            {
              type: "tool_use",
              id: "toolu-grand",
              name: "Task",
              input: { prompt: "go" },
            },
          ],
        },
      }),
      json({
        type: "user",
        uuid: "cu2",
        parentUuid: "ca1",
        timestamp: "2026-01-01T01:00:02.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        toolUseResult: { status: "async_launched", agentId: "agent-grand" },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-grand",
              is_error: false,
              content: [{ type: "text", text: "launched" }],
            },
          ],
        },
      }),
    ],
  );

  writeJsonl(
    join(
      root,
      "main-session",
      "subagents",
      "nested",
      "agent-agent-grand.jsonl",
    ),
    [
      json({
        type: "user",
        uuid: "gu1",
        parentUuid: null,
        timestamp: "2026-01-01T02:00:00.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: {
          role: "user",
          content: [{ type: "text", text: "Grandchild" }],
        },
      }),
      json({
        type: "assistant",
        uuid: "ga1",
        parentUuid: "gu1",
        timestamp: "2026-01-01T02:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "req-grand",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: "Grandchild done" }],
        },
      }),
    ],
  );

  writeJsonl(
    join(
      root,
      "main-session",
      "subagents",
      "orphans",
      "agent-agent-orphan.jsonl",
    ),
    [
      json({
        type: "user",
        uuid: "ou1",
        parentUuid: null,
        timestamp: "2026-01-01T03:00:00.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: { role: "user", content: [{ type: "text", text: "Orphan" }] },
      }),
    ],
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-conversation-core-"));
  mainPath = join(root, "main-session.jsonl");
  piAgentDir = join(root, "pi-agent");
  setupFixture();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("claude-to-pi conversion core", () => {
  test("prepares semantic mappings, raw shadows, manifest links, and active sentinel", () => {
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    expect(prepared.rootPiSessionId).toBe(prepared.sessions[0]?.piSessionId);
    expect(prepared.sessions.map((session) => session.sourceKey)).toEqual([
      "main",
      "agent-agent-child.jsonl",
      "nested/agent-agent-grand.jsonl",
      "orphans/agent-agent-orphan.jsonl",
    ]);

    const child = prepared.manifest.streams.find(
      (stream) => stream.sourceKey === "agent-agent-child.jsonl",
    );
    const grand = prepared.manifest.streams.find(
      (stream) => stream.sourceKey === "nested/agent-agent-grand.jsonl",
    );
    const orphan = prepared.manifest.streams.find(
      (stream) => stream.sourceKey === "orphans/agent-agent-orphan.jsonl",
    );
    expect(child?.parentRelation?.parentSourceKey).toBe("main");
    expect(child?.parentRelation?.toolCallId).toBe("toolu-main");
    expect(grand?.parentRelation?.parentSourceKey).toBe(
      "agent-agent-child.jsonl",
    );
    expect(grand?.parentRelation?.toolCallId).toBe("toolu-grand");
    expect(orphan?.parentRelation).toBeNull();
    expect(orphan?.warningCodes).toContain("unmatched_subagent");
    expect(prepared.manifest.warningCodes).toEqual(
      expect.arrayContaining([
        "malformed_line",
        "unknown_record_type",
        "unmatched_subagent",
      ]),
    );

    const main = prepared.sessions.find(
      (session) => session.sourceKey === "main",
    );
    expect(main).toBeDefined();
    const mainRecords = parseJsonl(main?.text ?? "");
    const header = mainRecords[0] as JsonRecord;
    expect(header.type).toBe("session");
    expect(header.version).toBe(3);
    expect(header.cwd).toBe(CWD);

    const nativeAssistant = mainRecords.find(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "assistant" &&
        (record.message as JsonRecord)?.responseId === "msg-main",
    ) as JsonRecord | undefined;
    expect(nativeAssistant).toBeDefined();
    const assistantMessage = nativeAssistant?.message as JsonRecord;
    expect(assistantMessage.provider).toBe("anthropic");
    expect(assistantMessage.api).toBe("anthropic-messages");
    expect(assistantMessage.model).toBe("claude-sonnet-4");
    expect(assistantMessage.stopReason).toBe("toolUse");
    expect(assistantMessage.timestamp).toBe(
      Date.parse("2026-01-01T00:00:03.000Z"),
    );
    expect(assistantMessage.usage).toEqual({
      input: 3,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 8,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    });
    expect(
      ((assistantMessage.content as unknown[]) ?? []).map(
        (block) => (block as JsonRecord).type,
      ),
    ).toEqual(["thinking", "text", "toolCall", "thinking"]);
    expect(
      ((assistantMessage.content as JsonRecord[])[3] as JsonRecord).redacted,
    ).toBe(true);
    expect(
      ((assistantMessage.content as JsonRecord[])[3] as JsonRecord)
        .thinkingSignature,
    ).toBe("red-sig");

    const userMessage = mainRecords.find(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "user" &&
        JSON.stringify((record.message as JsonRecord)?.content).includes(
          "AAA=",
        ),
    ) as JsonRecord | undefined;
    expect(userMessage).toBeDefined();
    expect(typeof (userMessage?.message as JsonRecord).timestamp).toBe(
      "number",
    );

    const toolResultMessage = mainRecords.find(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "toolResult",
    ) as JsonRecord | undefined;
    expect(toolResultMessage).toBeDefined();
    expect((toolResultMessage?.message as JsonRecord).toolCallId).toBe(
      "toolu-main",
    );
    expect((toolResultMessage?.message as JsonRecord).toolName).toBe("bash");
    expect(typeof (toolResultMessage?.message as JsonRecord).timestamp).toBe(
      "number",
    );
    expect(
      JSON.stringify((toolResultMessage?.message as JsonRecord).content),
    ).toContain("BBB=");

    const toolFinishedUserIndex = mainRecords.findIndex(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "user" &&
        JSON.stringify((record.message as JsonRecord)?.content).includes(
          "Tool finished",
        ),
    );
    const toolResultIndex = mainRecords.findIndex(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "toolResult",
    );
    expect(toolResultIndex).toBeGreaterThan(0);
    expect(toolFinishedUserIndex).toBeGreaterThan(toolResultIndex);

    const rawShadows = mainRecords.filter(
      (record) =>
        record.type === "custom" &&
        record.customType === "keeper.conversation.claude-record",
    );
    expect(rawShadows).toHaveLength(mainLines.length);
    const malformedShadow = rawShadows.find(
      (record) => (record.data as JsonRecord).rawUtf8 === '{"oops":',
    );
    expect(malformedShadow).toBeDefined();
    const systemShadow = rawShadows.find(
      (record) => (record.data as JsonRecord).sourceType === "system",
    );
    expect((systemShadow?.data as JsonRecord).rawUtf8).toBe(mainLines[5]);
    const aliasA1 = rawShadows.find(
      (record) => (record.data as JsonRecord).uuid === "a1",
    ) as JsonRecord;
    const aliasA2 = rawShadows.find(
      (record) => (record.data as JsonRecord).uuid === "a2",
    ) as JsonRecord;
    expect((aliasA1.data as JsonRecord).nativeAliasEntryId).toBe(
      nativeAssistant?.id,
    );
    expect((aliasA2.data as JsonRecord).nativeAliasEntryId).toBe(
      nativeAssistant?.id,
    );

    const branchAssistant = mainRecords.find(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "assistant" &&
        (record.message as JsonRecord)?.responseId === "msg-branch",
    ) as JsonRecord | undefined;
    expect(branchAssistant?.parentId).toBeDefined();

    for (let i = 1; i < mainRecords.length; i += 1) {
      const parentId = (mainRecords[i] as JsonRecord).parentId;
      if (typeof parentId !== "string") continue;
      const parentIndex = mainRecords.findIndex(
        (record) => record.id === parentId,
      );
      expect(parentIndex).toBeGreaterThanOrEqual(1);
      expect(parentIndex).toBeLessThan(i);
    }

    expect(() => validatePiV3SessionText(main?.text ?? "")).not.toThrow();

    const last = mainRecords.at(-1) as JsonRecord;
    expect(last.type).toBe("custom");
    expect(last.customType).toBe("keeper.conversation.active-leaf");
    expect(last.parentId).toBe((mainRecords.at(-2) as JsonRecord).id);
  });

  test("a shared-resolver native id is authoritative over transcript content", () => {
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
      expectedSourceMainId: SOURCE_SESSION_ID,
    });
    expect(prepared.sourceMainId).toBe(SOURCE_SESSION_ID);

    const forged = JSON.parse(mainLines[0] as string) as JsonRecord;
    forged.sessionId = "forged-session-id";
    writeJsonl(mainPath, [json(forged), ...mainLines.slice(1)]);

    let error: unknown;
    try {
      prepareClaudeToPiConversion({
        claudeMainPath: mainPath,
        piAgentDir,
        expectedSourceMainId: SOURCE_SESSION_ID,
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConversationConversionError);
    expect((error as ConversationConversionError).code).toBe(
      "validation_failed",
    );
  });

  test("publish is deterministic, reruns are unchanged, and modes are private", () => {
    const first = convertClaudeToPi({ claudeMainPath: mainPath, piAgentDir });
    expect(
      first.published.sessions.every((item) => item.status === "created"),
    ).toBe(true);
    expect(first.published.manifest.status).toBe("created");
    const preparedMain = first.prepared.sessions.find(
      (session) => session.sourceKey === "main",
    );
    expect(first.published.sessions.at(-1)?.relativePath).toBe(
      preparedMain?.destinationPath,
    );

    const second = convertClaudeToPi({ claudeMainPath: mainPath, piAgentDir });
    expect(
      second.published.sessions.every((item) => item.status === "unchanged"),
    ).toBe(true);
    expect(second.published.manifest.status).toBe("unchanged");

    const mainPublished = first.published.sessions.find((item) =>
      item.relativePath.includes(first.prepared.rootPiSessionId),
    );
    expect(mainPublished).toBeDefined();
    const again = readFileSync(mainPublished?.absolutePath ?? "", "utf8");
    const preparedMainText =
      first.prepared.sessions.find((session) => session.sourceKey === "main")
        ?.text ?? "";
    expect(again).toBe(preparedMainText);
    const manifestText = readFileSync(
      first.published.manifest.absolutePath,
      "utf8",
    );
    expect(manifestText).toBe(first.prepared.manifestText);

    if (process.platform !== "win32") {
      expect(statSync(first.published.manifest.absolutePath).mode & 0o777).toBe(
        0o600,
      );
      expect(
        statSync(dirname(first.published.manifest.absolutePath)).mode & 0o777,
      ).toBe(0o700);
      expect(
        statSync(dirname(dirname(first.published.manifest.absolutePath))).mode &
          0o777,
      ).toBe(0o700);
      expect(
        statSync(dirname(mainPublished?.absolutePath ?? "")).mode & 0o777,
      ).toBe(0o700);
      expect(statSync(mainPublished?.absolutePath ?? "").mode & 0o777).toBe(
        0o600,
      );
    }
  });

  test("conflicting destinations fail without clobbering existing bytes", () => {
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    publishClaudeToPiConversion(prepared);
    const firstSession = prepared.sessions[0];
    expect(firstSession).toBeDefined();
    if (firstSession === undefined) throw new Error("missing prepared session");
    const target = join(piAgentDir, firstSession.destinationPath);
    writeFileSync(target, "different\n");
    let error: unknown = null;
    try {
      publishClaudeToPiConversion(prepared);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConversationConversionError);
    expect((error as ConversationConversionError).code).toBe(
      "publish_collision",
    );
    expect(readFileSync(target, "utf8")).toBe("different\n");
  });

  test("validator rejects malformed nested timestamps and usage", () => {
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const main = prepared.sessions.find(
      (session) => session.sourceKey === "main",
    );
    expect(main).toBeDefined();
    expect(() => validatePiV3SessionText(main?.text ?? "")).not.toThrow();

    const badTimestamp = parseJsonl(main?.text ?? "");
    const assistant = badTimestamp.find(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "assistant" &&
        (record.message as JsonRecord)?.responseId === "msg-main",
    ) as JsonRecord;
    const assistantMessage = assistant.message as JsonRecord;
    assistantMessage.timestamp = "oops";
    expect(() => validatePiV3SessionText(stringifyJsonl(badTimestamp))).toThrow(
      ConversationConversionError,
    );

    const badUsage = parseJsonl(main?.text ?? "");
    const assistantUsage = badUsage.find(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "assistant" &&
        (record.message as JsonRecord)?.responseId === "msg-main",
    ) as JsonRecord;
    const usage = (assistantUsage.message as JsonRecord).usage as JsonRecord;
    usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(() => validatePiV3SessionText(stringifyJsonl(badUsage))).toThrow(
      ConversationConversionError,
    );
  });

  test("missing assistant model stays raw-only and warns", () => {
    writeJsonl(mainPath, [
      ...mainLines,
      json({
        type: "user",
        uuid: "u4",
        parentUuid: "a3",
        timestamp: "2026-01-01T00:00:09.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: {
          role: "user",
          content: [{ type: "text", text: "Who are you?" }],
        },
      }),
      json({
        type: "assistant",
        uuid: "a4",
        parentUuid: "u4",
        timestamp: "2026-01-01T00:00:10.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "req-missing-model",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
          content: [{ type: "text", text: "Mysterious." }],
        },
      }),
    ]);

    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const main = prepared.sessions.find(
      (session) => session.sourceKey === "main",
    );
    expect(main?.warningCodes).toContain("assistant_missing_model");
    const mainRecords = parseJsonl(main?.text ?? "");
    expect(
      mainRecords.some(
        (record) =>
          record.type === "message" &&
          (record.message as JsonRecord)?.role === "assistant" &&
          (record.message as JsonRecord)?.responseId === "req-missing-model",
      ),
    ).toBe(false);
    expect(
      mainRecords.some(
        (record) =>
          record.type === "custom" &&
          record.customType === "keeper.conversation.claude-record" &&
          (record.data as JsonRecord)?.uuid === "a4",
      ),
    ).toBe(true);
  });

  test("latest valid cwd wins for the session header and destination", () => {
    const latestCwd = "/repo/project-latest";
    writeJsonl(mainPath, [
      ...mainLines,
      json({
        type: "user",
        uuid: "u4",
        parentUuid: "a3",
        timestamp: "2026-01-01T00:00:09.000Z",
        cwd: latestCwd,
        sessionId: SOURCE_SESSION_ID,
        message: { role: "user", content: [{ type: "text", text: "Moved." }] },
      }),
    ]);

    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const main = prepared.sessions.find(
      (session) => session.sourceKey === "main",
    );
    expect(main?.cwd).toBe(latestCwd);
    const header = parseJsonl(main?.text ?? "")[0] as JsonRecord;
    expect(header.cwd).toBe(latestCwd);
    expect(main?.destinationPath).toContain("--repo-project-latest--");
  });

  test("trusted Claude compaction pair maps to native Pi compaction", () => {
    rmSync(join(root, "main-session"), { recursive: true, force: true });
    writeJsonl(mainPath, [
      json({
        type: "custom-title",
        uuid: "title-1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customTitle: "Compact",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
      }),
      json({
        type: "user",
        uuid: "u1",
        parentUuid: "title-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: {
          role: "user",
          content: [{ type: "text", text: "Start here" }],
        },
      }),
      json({
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-01-01T00:00:02.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "req-compact",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: "Working" }],
        },
      }),
      json({
        type: "system",
        uuid: "b1",
        parentUuid: "a1",
        logicalParentUuid: "a1",
        timestamp: "2026-01-01T00:00:03.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        subtype: "compact_boundary",
        compactMetadata: {
          preTokens: 17,
          preservedSegment: { headUuid: "u1" },
        },
      }),
      json({
        type: "user",
        uuid: "s1",
        parentUuid: "b1",
        timestamp: "2026-01-01T00:00:04.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        isCompactSummary: true,
        message: {
          role: "user",
          content: [{ type: "text", text: "Compact summary" }],
        },
      }),
    ]);

    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const main = prepared.sessions.find(
      (session) => session.sourceKey === "main",
    );
    expect(main?.warningCodes).not.toContain("compaction_untrusted");
    const records = parseJsonl(main?.text ?? "");
    const keptUser = records.find(
      (record) =>
        record.type === "message" &&
        (record.message as JsonRecord)?.role === "user" &&
        JSON.stringify((record.message as JsonRecord)?.content).includes(
          "Start here",
        ),
    ) as JsonRecord;
    const compaction = records.find((record) => record.type === "compaction") as
      | JsonRecord
      | undefined;
    expect(compaction).toBeDefined();
    expect(compaction?.summary).toBe("Compact summary");
    expect(compaction?.tokensBefore).toBe(17);
    expect(compaction?.firstKeptEntryId).toBe(keptUser.id);
    expect(compaction?.fromHook).toBe(true);
    const active = activeAncestry(records);
    expect(active.some((record) => record.id === keptUser.id)).toBe(true);
    expect(
      active.some(
        (record) =>
          record.type === "compaction" && record.summary === "Compact summary",
      ),
    ).toBe(true);
  });

  test("untrusted Claude compaction pair stays raw-only and warns", () => {
    rmSync(join(root, "main-session"), { recursive: true, force: true });
    writeJsonl(mainPath, [
      json({
        type: "custom-title",
        uuid: "title-1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customTitle: "Compact",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
      }),
      json({
        type: "assistant",
        uuid: "a1",
        parentUuid: "title-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "req-compact",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: "text", text: "Working" }],
        },
      }),
      json({
        type: "system",
        uuid: "b1",
        parentUuid: "a1",
        logicalParentUuid: "a1",
        timestamp: "2026-01-01T00:00:03.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        subtype: "compact_boundary",
        compactMetadata: {
          preTokens: 17,
          preservedSegment: { headUuid: "missing" },
        },
      }),
      json({
        type: "user",
        uuid: "s1",
        parentUuid: "b1",
        timestamp: "2026-01-01T00:00:04.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        isCompactSummary: true,
        message: {
          role: "user",
          content: [{ type: "text", text: "Compact summary" }],
        },
      }),
    ]);

    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const main = prepared.sessions.find(
      (session) => session.sourceKey === "main",
    );
    expect(main?.warningCodes).toContain("compaction_untrusted");
    const records = parseJsonl(main?.text ?? "");
    expect(records.some((record) => record.type === "compaction")).toBe(false);
    expect(
      records.some(
        (record) =>
          record.type === "custom" &&
          record.customType === "keeper.conversation.claude-record" &&
          (record.data as JsonRecord)?.uuid === "s1",
      ),
    ).toBe(true);
  });

  test("subagent relation cycles are broken and warned", () => {
    rmSync(join(root, "main-session"), { recursive: true, force: true });
    writeJsonl(mainPath, [
      json({
        type: "custom-title",
        uuid: "title-1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customTitle: "Cycle",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
      }),
      json({
        type: "user",
        uuid: "m1",
        parentUuid: "title-1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        toolUseResult: { status: "async_launched", agentId: "agent-x" },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-main-a",
              is_error: false,
              content: [{ type: "text", text: "launch" }],
            },
          ],
        },
      }),
    ]);
    writeJsonl(join(root, "main-session", "subagents", "agent-agent-a.jsonl"), [
      json({
        type: "user",
        uuid: "a1",
        parentUuid: null,
        timestamp: "2026-01-01T01:00:00.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: { role: "user", content: [{ type: "text", text: "A" }] },
      }),
      json({
        type: "user",
        uuid: "a2",
        parentUuid: "a1",
        timestamp: "2026-01-01T01:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        toolUseResult: { status: "async_launched", agentId: "agent-b" },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-a-b",
              is_error: false,
              content: [{ type: "text", text: "launch" }],
            },
          ],
        },
      }),
    ]);
    writeJsonl(join(root, "main-session", "subagents", "agent-agent-b.jsonl"), [
      json({
        type: "user",
        uuid: "b1",
        parentUuid: null,
        timestamp: "2026-01-01T02:00:00.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: { role: "user", content: [{ type: "text", text: "B" }] },
      }),
      json({
        type: "user",
        uuid: "b2",
        parentUuid: "b1",
        timestamp: "2026-01-01T02:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        toolUseResult: { status: "async_launched", agentId: "agent-a" },
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call-b-a",
              is_error: false,
              content: [{ type: "text", text: "launch" }],
            },
          ],
        },
      }),
    ]);

    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const aStream = prepared.manifest.streams.find(
      (stream) => stream.sourceKey === "agent-agent-a.jsonl",
    );
    const bStream = prepared.manifest.streams.find(
      (stream) => stream.sourceKey === "agent-agent-b.jsonl",
    );
    expect(aStream?.parentRelation).toBeNull();
    expect(bStream?.parentRelation).toBeNull();
    expect(aStream?.warningCodes).toContain("subagent_relation_cycle");
    expect(bStream?.warningCodes).toContain("subagent_relation_cycle");
  });

  test("subagent ordering uses locale-independent code-unit order", () => {
    for (const agentId of ["z", "é"]) {
      writeJsonl(
        join(root, "main-session", "subagents", `agent-${agentId}.jsonl`),
        [
          json({
            type: "user",
            uuid: `user-${agentId}`,
            parentUuid: null,
            timestamp: "2026-01-01T04:00:00.000Z",
            cwd: CWD,
            sessionId: SOURCE_SESSION_ID,
            message: {
              role: "user",
              content: [{ type: "text", text: agentId }],
            },
          }),
        ],
      );
    }

    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const sourceKeys = prepared.sessions.map((session) => session.sourceKey);
    expect(sourceKeys.indexOf("agent-z.jsonl")).toBeLessThan(
      sourceKeys.indexOf("agent-é.jsonl"),
    );
  });

  test("destination symlink collisions are rejected", () => {
    if (process.platform === "win32") return;
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const firstSession = prepared.sessions[0];
    expect(firstSession).toBeDefined();
    if (firstSession === undefined) throw new Error("missing prepared session");
    const target = join(piAgentDir, firstSession.destinationPath);
    mkdirSync(dirname(target), { recursive: true });
    const sink = join(root, "symlink-sink.txt");
    writeFileSync(sink, firstSession.text);
    symlinkSync(sink, target);

    let error: unknown = null;
    try {
      publishClaudeToPiConversion(prepared);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConversationConversionError);
    expect((error as ConversationConversionError).code).toBe(
      "publish_collision",
    );
  });

  test("descendant directory symlinks cannot redirect publication", () => {
    if (process.platform === "win32") return;
    for (const scenario of ["sessions", "bucket"] as const) {
      const selectedRoot = join(root, `pi-agent-${scenario}`);
      const outside = join(root, `outside-${scenario}`);
      mkdirSync(selectedRoot, { mode: 0o700 });
      mkdirSync(outside, { mode: 0o700 });
      const sentinel = join(outside, "sentinel.txt");
      writeFileSync(sentinel, "outside stays untouched\n");
      const prepared = prepareClaudeToPiConversion({
        claudeMainPath: mainPath,
        piAgentDir: selectedRoot,
      });
      const firstSession = prepared.sessions[0];
      if (firstSession === undefined) throw new Error("missing session");
      if (scenario === "sessions") {
        symlinkSync(outside, join(selectedRoot, "sessions"));
      } else {
        const bucketRelative = dirname(firstSession.destinationPath);
        mkdirSync(join(selectedRoot, "sessions"), { mode: 0o700 });
        symlinkSync(outside, join(selectedRoot, bucketRelative));
      }

      let error: unknown;
      try {
        publishClaudeToPiConversion(prepared);
      } catch (thrown) {
        error = thrown;
      }
      expect((error as ConversationConversionError).code).toBe(
        "publish_failed",
      );
      expect(readFileSync(sentinel, "utf8")).toBe("outside stays untouched\n");
      expect(readdirSync(outside)).toEqual(["sentinel.txt"]);
    }
  });

  test("shared or foreign-writable publication roots are rejected", () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      return;
    }
    mkdirSync(piAgentDir, { mode: 0o700 });
    chmodSync(piAgentDir, 0o777);
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });

    let error: unknown;
    try {
      publishClaudeToPiConversion(prepared);
    } catch (thrown) {
      error = thrown;
    }
    expect((error as ConversationConversionError).code).toBe("publish_failed");
    expect(existsSync(join(piAgentDir, "sessions"))).toBe(false);
  });

  test("identical public destination files are collisions", () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      return;
    }
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const session = prepared.sessions[0];
    if (session === undefined) throw new Error("missing session");
    const target = join(piAgentDir, session.destinationPath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, session.bytes, { mode: 0o644 });
    chmodSync(target, 0o644);

    let error: unknown;
    try {
      publishClaudeToPiConversion(prepared);
    } catch (thrown) {
      error = thrown;
    }
    expect((error as ConversationConversionError).code).toBe(
      "publish_collision",
    );
    expect(readFileSync(target).equals(Buffer.from(session.bytes))).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  test("rollback leaves a replacement of an invocation-created artifact", () => {
    if (process.platform === "win32") return;
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const replacementPath = join(root, "prepared-replacement");
    const replacement = "replacement owned by another publisher\n";
    writeFileSync(replacementPath, replacement, { mode: 0o600 });
    chmodSync(replacementPath, 0o600);
    let firstCreatedPath: string | null = null;
    let error: unknown;
    try {
      publishClaudeToPiConversion(prepared, {
        publishDeps: {
          onAfterArtifactCreated(event) {
            if (event.sequence === 0) {
              firstCreatedPath = event.absolutePath;
              unlinkSync(event.absolutePath);
              renameSync(replacementPath, event.absolutePath);
            } else if (event.sequence === 1) {
              throw new Error("force rollback after replacement");
            }
          },
        },
      });
    } catch (thrown) {
      error = thrown;
    }
    expect((error as ConversationConversionError).code).toBe("publish_failed");
    expect(firstCreatedPath).not.toBeNull();
    expect(readFileSync(firstCreatedPath ?? "", "utf8")).toBe(replacement);
  });

  test("chmod and required directory fsync failures fail publication", () => {
    mkdirSync(piAgentDir, { mode: 0o700 });
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    let chmodError: unknown;
    try {
      publishClaudeToPiConversion(prepared, {
        publishDeps: {
          fchmodSync() {
            throw new Error("injected chmod failure");
          },
        },
      });
    } catch (thrown) {
      chmodError = thrown;
    }
    expect((chmodError as ConversationConversionError).code).toBe(
      "publish_failed",
    );
    expect(
      prepared.sessions.every(
        (session) => !existsSync(join(piAgentDir, session.destinationPath)),
      ),
    ).toBe(true);

    if (process.platform === "win32") return;
    let sawDirectoryFsync = false;
    let fsyncError: unknown;
    try {
      publishClaudeToPiConversion(prepared, {
        publishDeps: {
          fsyncSync(fd, event) {
            if (event.kind === "directory") {
              sawDirectoryFsync = true;
              throw new Error("injected directory fsync failure");
            }
            fsyncSync(fd);
          },
        },
      });
    } catch (thrown) {
      fsyncError = thrown;
    }
    expect(sawDirectoryFsync).toBe(true);
    expect((fsyncError as ConversationConversionError).code).toBe(
      "publish_failed",
    );
  });

  test("owned existing publication directories are tightened", () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      return;
    }
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const session = prepared.sessions[0];
    if (session === undefined) throw new Error("missing session");
    const bucket = dirname(join(piAgentDir, session.destinationPath));
    const sessionsDir = join(piAgentDir, "sessions");
    mkdirSync(bucket, { recursive: true, mode: 0o755 });
    chmodSync(sessionsDir, 0o755);
    chmodSync(bucket, 0o755);

    const published = publishClaudeToPiConversion(prepared);
    expect(published.sessions.every((item) => item.status === "created")).toBe(
      true,
    );
    expect(statSync(sessionsDir).mode & 0o777).toBe(0o700);
    expect(statSync(bucket).mode & 0o777).toBe(0o700);
  });

  test("dry run performs zero writes", () => {
    const result = convertClaudeToPi({
      claudeMainPath: mainPath,
      piAgentDir,
      dryRun: true,
    });
    expect(result.published.dryRun).toBe(true);
    expect(existsSync(piAgentDir)).toBe(false);
  });

  test("source mutation after read is rejected and publishes nothing", () => {
    let error: unknown = null;
    try {
      convertClaudeToPi({
        claudeMainPath: mainPath,
        piAgentDir,
        onAfterSourceRead(event) {
          if (event.streamKey === "main") {
            appendFileSync(
              mainPath,
              `${json({
                type: "user",
                uuid: "late",
                parentUuid: "a3",
                timestamp: "2026-01-01T00:00:09.000Z",
                cwd: CWD,
                sessionId: SOURCE_SESSION_ID,
                message: {
                  role: "user",
                  content: [{ type: "text", text: "late" }],
                },
              })}\n`,
            );
          }
        },
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConversationConversionError);
    expect((error as ConversationConversionError).code).toBe(
      "source_changed_during_read",
    );
    expect(existsSync(piAgentDir)).toBe(false);
  });

  test("uuid-less metadata tails do not replace the active source leaf", () => {
    const tails: JsonRecord[] = [
      { type: "last-prompt", leafUuid: "a3" },
      { type: "custom-title", customTitle: "Tail title" },
      { type: "agent-name", agentName: "tail" },
      { type: "mode", mode: "plan" },
      { type: "permission-mode", mode: "default" },
      { type: "queue-operation", operation: "enqueue" },
    ];
    for (const [index, tail] of tails.entries()) {
      writeJsonl(mainPath, [
        ...mainLines,
        json({
          ...tail,
          timestamp: `2026-01-01T00:01:0${index}.000Z`,
          cwd: CWD,
          sessionId: SOURCE_SESSION_ID,
        }),
      ]);
      const prepared = prepareClaudeToPiConversion({
        claudeMainPath: mainPath,
        piAgentDir,
      });
      const records = parseJsonl(
        prepared.sessions.find((session) => session.sourceKey === "main")
          ?.text ?? "",
      );
      const ancestry = activeAncestry(records);
      expect(records.at(-1)?.customType).toBe(
        "keeper.conversation.active-leaf",
      );
      expect(
        ancestry.some(
          (record) =>
            record.type === "message" &&
            (record.message as JsonRecord)?.responseId === "msg-branch",
        ),
      ).toBe(true);
    }
  });

  test("last-prompt selects an older leaf unless newer uuid activity exists", () => {
    const stalePrompt = json({
      type: "last-prompt",
      leafUuid: "a2",
      timestamp: "2026-01-01T00:00:09.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
    });
    writeJsonl(mainPath, [...mainLines, stalePrompt]);
    let prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    let records = parseJsonl(
      prepared.sessions.find((session) => session.sourceKey === "main")?.text ??
        "",
    );
    let ancestry = activeAncestry(records);
    expect(
      ancestry.some(
        (record) => (record.message as JsonRecord)?.responseId === "msg-main",
      ),
    ).toBe(true);
    expect(
      ancestry.some(
        (record) => (record.message as JsonRecord)?.responseId === "msg-branch",
      ),
    ).toBe(false);

    writeJsonl(mainPath, [
      ...mainLines,
      stalePrompt,
      json({
        type: "user",
        uuid: "newer-u",
        parentUuid: "a3",
        timestamp: "2026-01-01T00:00:10.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: { role: "user", content: [{ type: "text", text: "newer" }] },
      }),
    ]);
    prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    records = parseJsonl(
      prepared.sessions.find((session) => session.sourceKey === "main")?.text ??
        "",
    );
    ancestry = activeAncestry(records);
    expect(JSON.stringify(ancestry)).toContain("newer");
    expect(JSON.stringify(ancestry)).toContain("Branch answer");
  });

  test("whole-family snapshot catches main mutation after a child read", () => {
    expect(() =>
      prepareClaudeToPiConversion({
        claudeMainPath: mainPath,
        piAgentDir,
        onAfterSourceRead(event) {
          if (event.streamKey === "agent-agent-child.jsonl") {
            appendFileSync(mainPath, "{}\n");
          }
        },
      }),
    ).toThrow(ConversationConversionError);
    try {
      prepareClaudeToPiConversion({
        claudeMainPath: mainPath,
        piAgentDir,
        onAfterSourceRead(event) {
          if (event.streamKey === "agent-agent-child.jsonl") {
            appendFileSync(mainPath, "{}\n");
          }
        },
      });
    } catch (error) {
      expect((error as ConversationConversionError).code).toBe(
        "source_changed_during_read",
      );
    }
  });

  test("whole-family snapshot catches a subagent added after discovery", () => {
    let error: unknown;
    try {
      prepareClaudeToPiConversion({
        claudeMainPath: mainPath,
        piAgentDir,
        onAfterSourceRead(event) {
          if (event.streamKey === "main") {
            writeJsonl(
              join(
                root,
                "main-session",
                "subagents",
                "agent-agent-added.jsonl",
              ),
              [json({ type: "user", uuid: "added", parentUuid: null })],
            );
          }
        },
      });
    } catch (thrown) {
      error = thrown;
    }
    expect((error as ConversationConversionError).code).toBe(
      "source_changed_during_read",
    );
  });

  test("publish and dry-run revalidate the prepared source family", () => {
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    appendFileSync(mainPath, "{}\n");
    for (const dryRun of [true, false]) {
      let error: unknown;
      try {
        publishClaudeToPiConversion(prepared, { dryRun });
      } catch (thrown) {
        error = thrown;
      }
      expect((error as ConversationConversionError).code).toBe(
        "source_changed_during_read",
      );
    }
    expect(existsSync(piAgentDir)).toBe(false);
  });

  test("family bound validation covers count, depth, and aggregate bytes", () => {
    const cases = [
      { streamCount: 3, maxSubagentDepth: 0, totalBytes: 0 },
      { streamCount: 0, maxSubagentDepth: 3, totalBytes: 0 },
      { streamCount: 0, maxSubagentDepth: 0, totalBytes: 3 },
    ];
    for (const bounds of cases) {
      let error: unknown;
      try {
        validateClaudeToPiFamilyBounds(bounds, {
          maxStreams: 2,
          maxSubagentDepth: 2,
          maxFamilyBytes: 2,
        });
      } catch (thrown) {
        error = thrown;
      }
      expect((error as ConversationConversionError).code).toBe(
        "source_too_large",
      );
    }
  });

  test("tool results use only the nearest call on resolved source ancestry", () => {
    rmSync(join(root, "main-session"), { recursive: true, force: true });
    writeJsonl(mainPath, [
      json({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      }),
      json({
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "ancestral",
        message: {
          model: "claude-real",
          content: [
            {
              type: "tool_use",
              id: "collision",
              name: "ancestral-name",
              input: {},
            },
          ],
        },
      }),
      json({
        type: "assistant",
        uuid: "other",
        parentUuid: "u1",
        timestamp: "2026-01-01T00:00:02.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "other",
        message: {
          model: "claude-real",
          content: [
            {
              type: "tool_use",
              id: "collision",
              name: "other-name",
              input: {},
            },
          ],
        },
      }),
      json({
        type: "user",
        uuid: "result",
        parentUuid: "a1",
        timestamp: "2026-01-01T00:00:03.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "collision", content: "ok" },
          ],
        },
      }),
    ]);
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const records = parseJsonl(prepared.sessions[0]?.text ?? "");
    const result = records.find(
      (record) => (record.message as JsonRecord)?.role === "toolResult",
    );
    expect((result?.message as JsonRecord).toolName).toBe("ancestral-name");
  });

  test("branch-only and later tool calls cannot authorize a native result", () => {
    rmSync(join(root, "main-session"), { recursive: true, force: true });
    writeJsonl(mainPath, [
      json({
        type: "user",
        uuid: "root",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: { content: [{ type: "text", text: "root" }] },
      }),
      json({
        type: "assistant",
        uuid: "branch-call",
        parentUuid: "root",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "branch",
        message: {
          model: "claude-real",
          content: [
            { type: "tool_use", id: "branch-id", name: "bash", input: {} },
          ],
        },
      }),
      json({
        type: "user",
        uuid: "branch-result",
        parentUuid: "root",
        timestamp: "2026-01-01T00:00:02.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "branch-id", content: "no" },
          ],
        },
      }),
      json({
        type: "user",
        uuid: "later-result",
        parentUuid: "root",
        timestamp: "2026-01-01T00:00:03.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "later-id", content: "no" },
          ],
        },
      }),
      json({
        type: "assistant",
        uuid: "later-call",
        parentUuid: "later-result",
        timestamp: "2026-01-01T00:00:04.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "later",
        message: {
          model: "claude-real",
          content: [
            { type: "tool_use", id: "later-id", name: "bash", input: {} },
          ],
        },
      }),
    ]);
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    expect(prepared.sessions[0]?.warningCodes).toContain(
      "tool_result_without_ancestral_call",
    );
    const records = parseJsonl(prepared.sessions[0]?.text ?? "");
    expect(
      records.some(
        (record) => (record.message as JsonRecord)?.role === "toolResult",
      ),
    ).toBe(false);
  });

  test("synthetic Claude API errors remain raw-only without restoring their model", () => {
    rmSync(join(root, "main-session"), { recursive: true, force: true });
    writeJsonl(mainPath, [
      json({
        type: "assistant",
        uuid: "real",
        parentUuid: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "real-request",
        message: {
          model: "claude-real",
          content: [{ type: "text", text: "real answer" }],
        },
      }),
      json({
        type: "assistant",
        uuid: "synthetic",
        parentUuid: "real",
        timestamp: "2026-01-01T00:00:01.000Z",
        cwd: CWD,
        sessionId: SOURCE_SESSION_ID,
        requestId: "error-request",
        isApiErrorMessage: true,
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "fake error" }],
        },
      }),
    ]);
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    expect(prepared.sessions[0]?.warningCodes).toContain(
      "assistant_api_error_raw_only",
    );
    const records = parseJsonl(prepared.sessions[0]?.text ?? "");
    const assistants = records.filter(
      (record) => (record.message as JsonRecord)?.role === "assistant",
    );
    expect(assistants).toHaveLength(1);
    expect((assistants[0]?.message as JsonRecord).model).toBe("claude-real");
    expect(JSON.stringify(activeAncestry(records))).toContain("real answer");
  });

  test("subagent relation evidence is deduplicated but conflicts are ambiguous", () => {
    const duplicateEvidence = {
      type: "user",
      uuid: "repeat-launch",
      parentUuid: "a3",
      timestamp: "2026-01-01T00:00:09.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      toolUseResult: { status: "completed", agentId: "agent-child" },
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu-main", content: "done" },
        ],
      },
    };
    writeJsonl(mainPath, [...mainLines, json(duplicateEvidence)]);
    let prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    let child = prepared.manifest.streams.find(
      (stream) => stream.agentId === "agent-child",
    );
    expect(child?.parentRelation?.toolCallId).toBe("toolu-main");
    expect(child?.warningCodes).not.toContain("ambiguous_subagent_relation");

    writeJsonl(mainPath, [
      ...mainLines,
      json(duplicateEvidence),
      json({
        ...duplicateEvidence,
        uuid: "conflicting-launch",
        toolUseResult: { status: "completed", agentId: "agent-child" },
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "different-call",
              content: "done",
            },
          ],
        },
      }),
    ]);
    prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    child = prepared.manifest.streams.find(
      (stream) => stream.agentId === "agent-child",
    );
    expect(child?.parentRelation).toBeNull();
    expect(child?.warningCodes).toContain("ambiguous_subagent_relation");
  });

  test("raw shadows retain a leading UTF-8 BOM while parsing the first line", () => {
    rmSync(join(root, "main-session"), { recursive: true, force: true });
    const first = json({
      type: "user",
      uuid: "bom-user",
      parentUuid: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: CWD,
      sessionId: SOURCE_SESSION_ID,
      message: { content: [{ type: "text", text: "with bom" }] },
    });
    writeFileSync(mainPath, `\uFEFF${first}\n`);
    const prepared = prepareClaudeToPiConversion({
      claudeMainPath: mainPath,
      piAgentDir,
    });
    const records = parseJsonl(prepared.sessions[0]?.text ?? "");
    const raw = records.find(
      (record) => record.customType === "keeper.conversation.claude-record",
    );
    expect((raw?.data as JsonRecord).rawUtf8).toBe(`\uFEFF${first}`);
    expect(JSON.stringify(records)).toContain("with bom");
  });
});
