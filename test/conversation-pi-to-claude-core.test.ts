import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  ConversationConversionError,
  prepareClaudeToPiConversion,
} from "../src/conversation/claude-to-pi";
import {
  convertPiToClaude,
  preparePiToClaudeConversion,
  publishPiToClaudeConversion,
  validateClaudeConversationText,
} from "../src/conversation/pi-to-claude";
import {
  discoverClaudeProjectsRoots,
  findClaudeSession,
  readClaudeTranscript,
} from "../src/transcript/claude";

type JsonRecord = Record<string, unknown>;

const SOURCE_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CWD = "/repo/pi-project";

let root: string;
let sourcePath: string;
let claudeConfigDir: string;
let fixtureLines: string[];

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

function descendantPaths(path: string): string[] {
  if (!existsSync(path)) return [];
  const paths: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      paths.push(child);
      if (entry.isDirectory()) walk(child);
    }
  };
  walk(path);
  return paths;
}

function setupFixture(): void {
  fixtureLines = [
    json({
      type: "session",
      version: 3,
      id: SOURCE_SESSION_ID,
      timestamp: "2026-02-01T00:00:00.000Z",
      cwd: CWD,
    }),
    json({
      type: "session_info",
      id: "info0001",
      parentId: null,
      timestamp: "2026-02-01T00:00:00.100Z",
      name: "Pi source title",
    }),
    json({
      type: "model_change",
      id: "model001",
      parentId: "info0001",
      timestamp: "2026-02-01T00:00:00.200Z",
      provider: "anthropic",
      modelId: "claude-sonnet-4",
    }),
    json({
      type: "message",
      id: "user0001",
      parentId: "model001",
      timestamp: "2026-02-01T00:00:01.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "Inspect the tree" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        timestamp: 0,
      },
    }),
    json({
      type: "message",
      id: "assist01",
      parentId: "user0001",
      timestamp: "2026-02-01T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4",
        content: [
          { type: "thinking", thinking: "unsigned reasoning" },
          { type: "text", text: "I will inspect." },
          {
            type: "toolCall",
            id: "call-1",
            name: "bash",
            arguments: { command: "ls" },
          },
        ],
        usage: {
          input: 3,
          output: 4,
          cacheRead: 1,
          cacheWrite: 2,
          totalTokens: 10,
        },
        stopReason: "toolUse",
        timestamp: 0,
      },
    }),
    json({
      type: "message",
      id: "result01",
      parentId: "assist01",
      timestamp: "2026-02-01T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "file-a\nfile-b" }],
        isError: false,
        timestamp: 0,
      },
    }),
    json({
      type: "message",
      id: "done0001",
      parentId: "result01",
      timestamp: "2026-02-01T00:00:04.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "Inspection done." }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: 0,
      },
    }),
    // Abandoned sibling, physically before the active compacted branch.
    json({
      type: "message",
      id: "branch01",
      parentId: "user0001",
      timestamp: "2026-02-01T00:00:04.100Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "Abandoned answer." }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: 0,
      },
    }),
    json({
      type: "compaction",
      id: "compact1",
      parentId: "done0001",
      timestamp: "2026-02-01T00:00:05.000Z",
      summary: "Summary before the retained turn",
      firstKeptEntryId: "user0001",
      tokensBefore: 123,
    }),
    json({
      type: "custom_message",
      id: "custom01",
      parentId: "compact1",
      timestamp: "2026-02-01T00:00:06.000Z",
      customType: "fixture-context",
      content: [{ type: "text", text: "Injected context" }],
      display: false,
    }),
    json({
      type: "message",
      id: "finish01",
      parentId: "custom01",
      timestamp: "2026-02-01T00:00:07.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4",
        content: [{ type: "text", text: "Ready to continue." }],
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        timestamp: 0,
      },
    }),
    json({
      type: "label",
      id: "label001",
      parentId: "finish01",
      timestamp: "2026-02-01T00:00:08.000Z",
      targetId: "user0001",
      label: "checkpoint",
    }),
    "{malformed",
  ];
  writeJsonl(sourcePath, fixtureLines);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-pi-to-claude-"));
  sourcePath = join(
    root,
    "pi-agent",
    "sessions",
    "--repo-pi-project--",
    `2026-02-01T00-00-00-000Z_${SOURCE_SESSION_ID}.jsonl`,
  );
  claudeConfigDir = join(root, "claude-config");
  setupFixture();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pi-to-claude conversion core", () => {
  test("maps the Pi tree, compaction, tools, title, active leaf, and raw shadows", () => {
    const prepared = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
      expectedSourceSessionId: SOURCE_SESSION_ID,
    });
    const session = prepared.sessions[0];
    expect(session).toBeDefined();
    if (session === undefined) throw new Error("missing prepared session");

    expect(session.destinationPath).toContain("projects/-repo-pi-project/");
    expect(session.destinationPath).toEndWith(
      `${prepared.rootClaudeSessionId}.jsonl`,
    );
    expect(session.rawRecordCount).toBe(fixtureLines.length);
    expect(session.warningCodes).toEqual(
      expect.arrayContaining([
        "assistant_thinking_raw_only",
        "malformed_line",
        "pi_entry_raw_only",
      ]),
    );

    const records = parseJsonl(session.text);
    const title = records.find((record) => record.type === "custom-title");
    expect(title?.customTitle).toBe("Pi source title");

    const user = records.find(
      (record) =>
        record.type === "user" &&
        JSON.stringify((record.message as JsonRecord)?.content).includes(
          "Inspect the tree",
        ),
    );
    expect(user).toBeDefined();
    expect(
      ((user?.message as JsonRecord)?.content as JsonRecord[]).some(
        (block) =>
          block.type === "image" &&
          (block.source as JsonRecord)?.media_type === "image/png",
      ),
    ).toBe(true);

    const toolAssistant = records.find(
      (record) =>
        record.type === "assistant" &&
        ((record.message as JsonRecord)?.content as JsonRecord[]).some(
          (block) => block.type === "tool_use" && block.id === "call-1",
        ),
    );
    const toolResult = records.find(
      (record) =>
        record.type === "user" &&
        ((record.message as JsonRecord)?.content as JsonRecord[]).some(
          (block) => block.type === "tool_result",
        ),
    );
    expect(toolAssistant).toBeDefined();
    expect(toolResult?.sourceToolAssistantUUID).toBe(toolAssistant?.uuid);

    const boundary = records.find(
      (record) =>
        record.type === "system" && record.subtype === "compact_boundary",
    );
    const summary = records.find(
      (record) => record.type === "user" && record.isCompactSummary === true,
    );
    expect(boundary).toBeDefined();
    expect(boundary?.parentUuid).toBeNull();
    expect(typeof boundary?.logicalParentUuid).toBe("string");
    expect((boundary?.compactMetadata as JsonRecord)?.preTokens).toBe(123);
    expect(summary).toBeDefined();
    expect(summary?.parentUuid).toBe(boundary?.uuid);

    const abandoned = records.find(
      (record) =>
        record.type === "assistant" &&
        JSON.stringify((record.message as JsonRecord)?.content).includes(
          "Abandoned answer",
        ),
    );
    expect(abandoned).toBeDefined();
    expect(abandoned?.parentUuid).toBe(user?.uuid);

    const lastPrompt = records.at(-1);
    expect(lastPrompt?.type).toBe("last-prompt");
    expect(lastPrompt?.explicit).toBe(true);
    const active = records.find(
      (record) =>
        record.type === "assistant" &&
        JSON.stringify((record.message as JsonRecord)?.content).includes(
          "Ready to continue",
        ),
    );
    expect(lastPrompt?.leafUuid).toBe(active?.uuid);

    const raw = records.filter(
      (record) => record.type === "keeper.conversation.pi-record",
    );
    expect(raw).toHaveLength(fixtureLines.length);
    expect(raw.map((record) => record.lineOrdinal)).toEqual(
      fixtureLines.map((_, index) => index + 1),
    );
    expect(raw.at(-1)?.rawUtf8).toBe("{malformed");

    validateClaudeConversationText(session.text, {
      sessionId: prepared.rootClaudeSessionId,
      cwd: CWD,
      activeLeafUuid: lastPrompt?.leafUuid as string,
    });
  });

  test("generated Claude compaction round-trips back to a native Pi compaction", () => {
    const reverse = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    const claudePath = join(root, "roundtrip.jsonl");
    writeFileSync(claudePath, reverse.sessions[0]?.text ?? "");
    const forward = prepareClaudeToPiConversion({
      claudeMainPath: claudePath,
      piAgentDir: join(root, "roundtrip-pi"),
      expectedSourceMainId: reverse.rootClaudeSessionId,
    });
    const records = parseJsonl(forward.sessions[0]?.text ?? "");
    const compaction = records.find((record) => record.type === "compaction");
    expect(compaction).toBeDefined();
    expect(compaction?.summary).toBe("Summary before the retained turn");
    expect(compaction?.tokensBefore).toBe(123);
    expect(typeof compaction?.firstKeptEntryId).toBe("string");
  });

  test("an explicit Pi leaf marker selects an older branch", () => {
    writeJsonl(sourcePath, [
      fixtureLines[0] as string,
      json({
        type: "message",
        id: "user0001",
        parentId: null,
        timestamp: "2026-02-01T00:00:01.000Z",
        message: { role: "user", content: "choose" },
      }),
      json({
        type: "message",
        id: "chosen01",
        parentId: "user0001",
        timestamp: "2026-02-01T00:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "Chosen branch" }],
          stopReason: "stop",
        },
      }),
      json({
        type: "message",
        id: "later001",
        parentId: "user0001",
        timestamp: "2026-02-01T00:00:03.000Z",
        message: {
          role: "assistant",
          model: "claude-sonnet-4",
          content: [{ type: "text", text: "Later abandoned branch" }],
          stopReason: "stop",
        },
      }),
      json({
        type: "leaf",
        id: "leaf0001",
        parentId: "later001",
        targetId: "chosen01",
        timestamp: "2026-02-01T00:00:04.000Z",
      }),
    ]);
    const prepared = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    const records = parseJsonl(prepared.sessions[0]?.text ?? "");
    const chosen = records.find((record) =>
      JSON.stringify(record.message).includes("Chosen branch"),
    );
    const later = records.find((record) =>
      JSON.stringify(record.message).includes("Later abandoned branch"),
    );
    expect(chosen).toBeDefined();
    expect(later).toBeDefined();
    expect(records.at(-1)?.leafUuid).toBe(chosen?.uuid);
  });

  test("preparation and publication are deterministic and exact reruns are unchanged", () => {
    const first = convertPiToClaude({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    expect(first.published.sessions[0]?.status).toBe("created");
    expect(first.published.manifest.status).toBe("created");

    const second = convertPiToClaude({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    expect(second.prepared.sessions[0]?.text).toBe(
      first.prepared.sessions[0]?.text,
    );
    expect(second.prepared.manifestText).toBe(first.prepared.manifestText);
    expect(second.published.sessions[0]?.status).toBe("unchanged");
    expect(second.published.manifest.status).toBe("unchanged");

    if (process.platform !== "win32") {
      const target = first.published.sessions[0]?.absolutePath as string;
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(target)).mode & 0o777).toBe(0o700);
    }
  });

  test("a concurrently committed manifest prevents rollback from deleting its session", () => {
    const prepared = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    let peerPublished = false;
    let outerError: unknown;
    try {
      publishPiToClaudeConversion(prepared, {
        publishDeps: {
          onAfterArtifactCreated(event) {
            if (event.kind !== "session") return;
            const peer = publishPiToClaudeConversion(prepared);
            peerPublished = peer.manifest.status === "created";
            throw new Error("fail original publisher after peer commit");
          },
        },
      });
    } catch (thrown) {
      outerError = thrown;
    }
    expect(peerPublished).toBe(true);
    expect((outerError as ConversationConversionError).code).toBe(
      "publish_failed",
    );
    expect(
      prepared.sessions.every((session) =>
        existsSync(join(claudeConfigDir, session.destinationPath)),
      ),
    ).toBe(true);
    expect(
      existsSync(join(claudeConfigDir, prepared.manifest.manifestPath)),
    ).toBe(true);
    const retry = publishPiToClaudeConversion(prepared);
    expect(retry.sessions.every((item) => item.status === "unchanged")).toBe(
      true,
    );
    expect(retry.manifest.status).toBe("unchanged");
  });

  test("published output is discoverable and readable as a native Claude Session", () => {
    const converted = convertPiToClaude({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    const roots = discoverClaudeProjectsRoots({
      homeDir: root,
      configDirs: [claudeConfigDir],
    });
    const found = findClaudeSession(
      roots,
      converted.prepared.rootClaudeSessionId,
      CWD,
    );
    expect(found.kind).toBe("found");
    if (found.kind !== "found") throw new Error("converted Session not found");
    const transcript = readClaudeTranscript(
      found.file.path,
      converted.prepared.rootClaudeSessionId,
    );
    expect(transcript.metadata.sessionId).toBe(
      converted.prepared.rootClaudeSessionId,
    );
    expect(transcript.metadata.project).toBe(CWD);
    expect(transcript.metadata.title).toBe("Pi source title");
    expect(
      transcript.entries.some(
        (entry) =>
          entry.role === "assistant" && entry.text === "Ready to continue.",
      ),
    ).toBe(true);
  });

  test("dry-run performs no writes", () => {
    const converted = convertPiToClaude({
      piSessionPath: sourcePath,
      claudeConfigDir,
      dryRun: true,
    });
    expect(converted.published.dryRun).toBe(true);
    expect(converted.published.sessions[0]?.status).toBe("dry_run");
    expect(existsSync(claudeConfigDir)).toBe(false);
  });

  test("catalog-resolved source identity is authoritative", () => {
    let error: unknown;
    try {
      preparePiToClaudeConversion({
        piSessionPath: sourcePath,
        claudeConfigDir,
        expectedSourceSessionId: "different-session",
      });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ConversationConversionError);
    expect((error as ConversationConversionError).code).toBe(
      "validation_failed",
    );
  });

  test("metadata-only or entirely raw-only Pi sessions are not called resumable", () => {
    for (const entry of [
      {
        type: "session_info",
        id: "info0001",
        parentId: null,
        timestamp: "2026-02-01T00:00:01.000Z",
        name: "Only metadata",
      },
      {
        type: "future-entry",
        id: "future01",
        parentId: null,
        timestamp: "2026-02-01T00:00:01.000Z",
        data: {},
      },
    ]) {
      writeJsonl(sourcePath, [fixtureLines[0] as string, json(entry)]);
      let error: unknown;
      try {
        preparePiToClaudeConversion({
          piSessionPath: sourcePath,
          claudeConfigDir,
        });
      } catch (thrown) {
        error = thrown;
      }
      expect((error as ConversationConversionError).code).toBe(
        "validation_failed",
      );
    }

    writeJsonl(sourcePath, [
      fixtureLines[0] as string,
      json({
        type: "message",
        id: "user0001",
        parentId: null,
        timestamp: "2026-02-01T00:00:01.000Z",
        message: { role: "user", content: "old context" },
      }),
      json({
        type: "leaf",
        id: "leaf0001",
        parentId: "user0001",
        targetId: null,
        timestamp: "2026-02-01T00:00:02.000Z",
      }),
    ]);
    let emptyLeafError: unknown;
    try {
      preparePiToClaudeConversion({
        piSessionPath: sourcePath,
        claudeConfigDir,
      });
    } catch (thrown) {
      emptyLeafError = thrown;
    }
    expect((emptyLeafError as ConversationConversionError).code).toBe(
      "validation_failed",
    );
  });

  test("dangling parents, cycles, and invalid compaction kept paths fail validation", () => {
    const scenarios: JsonRecord[][] = [
      [
        {
          type: "message",
          id: "dangling",
          parentId: "missing",
          timestamp: "2026-02-01T00:00:01.000Z",
          message: { role: "user", content: "x" },
        },
      ],
      [
        {
          type: "message",
          id: "cycle001",
          parentId: "cycle002",
          timestamp: "2026-02-01T00:00:01.000Z",
          message: { role: "user", content: "x" },
        },
        {
          type: "message",
          id: "cycle002",
          parentId: "cycle001",
          timestamp: "2026-02-01T00:00:02.000Z",
          message: { role: "user", content: "y" },
        },
      ],
      [
        {
          type: "message",
          id: "root0001",
          parentId: null,
          timestamp: "2026-02-01T00:00:01.000Z",
          message: { role: "user", content: "x" },
        },
        {
          type: "message",
          id: "other001",
          parentId: null,
          timestamp: "2026-02-01T00:00:02.000Z",
          message: { role: "user", content: "y" },
        },
        {
          type: "compaction",
          id: "compact1",
          parentId: "root0001",
          timestamp: "2026-02-01T00:00:03.000Z",
          summary: "bad",
          firstKeptEntryId: "other001",
          tokensBefore: 4,
        },
      ],
    ];

    for (const entries of scenarios) {
      writeJsonl(sourcePath, [fixtureLines[0] as string, ...entries.map(json)]);
      let error: unknown;
      try {
        preparePiToClaudeConversion({
          piSessionPath: sourcePath,
          claudeConfigDir,
        });
      } catch (thrown) {
        error = thrown;
      }
      expect((error as ConversationConversionError).code).toBe(
        "validation_failed",
      );
    }
  });

  test("a malformed complete tail is preserved without replacing the active leaf", () => {
    appendFileSync(sourcePath, "{malformed complete line}\n");
    const prepared = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    const records = parseJsonl(prepared.sessions[0]?.text ?? "");
    const lastPrompt = records.at(-1);
    const active = records.find(
      (record) =>
        record.uuid === lastPrompt?.leafUuid && record.type === "assistant",
    );
    expect(active).toBeDefined();
    expect(
      records
        .filter((record) => record.type === "keeper.conversation.pi-record")
        .map((record) => record.rawUtf8),
    ).toContain("{malformed complete line}");
  });

  test("tool results without an ancestral call remain raw-only", () => {
    writeJsonl(sourcePath, [
      fixtureLines[0] as string,
      json({
        type: "message",
        id: "user0001",
        parentId: null,
        timestamp: "2026-02-01T00:00:01.000Z",
        message: { role: "user", content: "start" },
      }),
      json({
        type: "message",
        id: "result01",
        parentId: "user0001",
        timestamp: "2026-02-01T00:00:02.000Z",
        message: {
          role: "toolResult",
          toolCallId: "missing-call",
          toolName: "bash",
          content: [{ type: "text", text: "result" }],
          isError: false,
        },
      }),
    ]);
    const prepared = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    expect(prepared.sessions[0]?.warningCodes).toContain(
      "tool_result_missing_call",
    );
    const records = parseJsonl(prepared.sessions[0]?.text ?? "");
    expect(
      records.some((record) =>
        JSON.stringify(record).includes('"tool_result"'),
      ),
    ).toBe(false);
    expect(records.at(-1)?.leafUuid).toBe(
      records.find(
        (record) =>
          record.type === "user" &&
          JSON.stringify(record.message).includes("start"),
      )?.uuid,
    );
  });

  test("destination collisions and descendant symlinks never clobber", () => {
    const prepared = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    const session = prepared.sessions[0];
    if (session === undefined) throw new Error("missing session");
    const target = join(claudeConfigDir, session.destinationPath);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, "foreign bytes\n", { mode: 0o600 });

    let collision: unknown;
    try {
      publishPiToClaudeConversion(prepared);
    } catch (thrown) {
      collision = thrown;
    }
    expect((collision as ConversationConversionError).code).toBe(
      "publish_collision",
    );
    expect(readFileSync(target, "utf8")).toBe("foreign bytes\n");

    if (process.platform !== "win32") {
      const symlinkSink = join(root, "symlink-sink.jsonl");
      writeFileSync(symlinkSink, session.text, { mode: 0o600 });
      rmSync(target);
      symlinkSync(symlinkSink, target);
      let targetSymlinkError: unknown;
      try {
        publishPiToClaudeConversion(prepared);
      } catch (thrown) {
        targetSymlinkError = thrown;
      }
      expect((targetSymlinkError as ConversationConversionError).code).toBe(
        "publish_collision",
      );
      expect(readFileSync(symlinkSink, "utf8")).toBe(session.text);
    }

    rmSync(claudeConfigDir, { recursive: true, force: true });
    mkdirSync(claudeConfigDir, { mode: 0o700 });
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    if (process.platform !== "win32") {
      symlinkSync(outside, join(claudeConfigDir, "projects"));
      let symlinkError: unknown;
      try {
        publishPiToClaudeConversion(prepared);
      } catch (thrown) {
        symlinkError = thrown;
      }
      expect((symlinkError as ConversationConversionError).code).toBe(
        "publish_failed",
      );
      expect(existsSync(join(outside, basename(target)))).toBe(false);
    }
  });

  test("world-writable output roots are rejected", () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      return;
    }
    mkdirSync(claudeConfigDir, { mode: 0o700 });
    chmodSync(claudeConfigDir, 0o777);
    const prepared = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    let error: unknown;
    try {
      publishPiToClaudeConversion(prepared);
    } catch (thrown) {
      error = thrown;
    }
    expect((error as ConversationConversionError).code).toBe("publish_failed");
    expect(existsSync(join(claudeConfigDir, "projects"))).toBe(false);
  });

  test("temporary artifacts are removed when chmod or file fsync fails", () => {
    for (const failure of ["chmod", "fsync"] as const) {
      const targetRoot = join(root, `claude-${failure}`);
      const prepared = preparePiToClaudeConversion({
        piSessionPath: sourcePath,
        claudeConfigDir: targetRoot,
      });
      let error: unknown;
      try {
        publishPiToClaudeConversion(prepared, {
          publishDeps:
            failure === "chmod"
              ? {
                  fchmodSync() {
                    throw new Error("injected chmod failure");
                  },
                }
              : {
                  fsyncSync(_fd, event) {
                    if (event.kind === "file") {
                      throw new Error("injected fsync failure");
                    }
                  },
                },
        });
      } catch (thrown) {
        error = thrown;
      }
      expect((error as ConversationConversionError).code).toBe(
        "publish_failed",
      );
      expect(
        descendantPaths(targetRoot).some((path) => path.endsWith(".tmp")),
      ).toBe(false);
      expect(
        prepared.sessions.some((session) =>
          existsSync(join(targetRoot, session.destinationPath)),
        ),
      ).toBe(false);
    }
  });

  test("source changes during or after preparation are rejected", () => {
    let readError: unknown;
    try {
      preparePiToClaudeConversion({
        piSessionPath: sourcePath,
        claudeConfigDir,
        onAfterSourceRead() {
          appendFileSync(sourcePath, "{}\n");
        },
      });
    } catch (thrown) {
      readError = thrown;
    }
    expect((readError as ConversationConversionError).code).toBe(
      "source_changed_during_read",
    );

    setupFixture();
    const prepared = preparePiToClaudeConversion({
      piSessionPath: sourcePath,
      claudeConfigDir,
    });
    appendFileSync(sourcePath, "{}\n");
    let publishError: unknown;
    try {
      publishPiToClaudeConversion(prepared);
    } catch (thrown) {
      publishError = thrown;
    }
    expect((publishError as ConversationConversionError).code).toBe(
      "source_changed_during_read",
    );
    expect(existsSync(claudeConfigDir)).toBe(false);
  });
});
