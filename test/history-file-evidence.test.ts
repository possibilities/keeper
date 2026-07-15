import { describe, expect, test } from "bun:test";
import {
  deriveFileEvidence,
  normalizeEvidencePath,
} from "../src/history/file-evidence";
import type { HistoryContextHandle } from "../src/history/model";
import type { TranscriptEntry, TranscriptTool } from "../src/transcript/model";

function entry(
  sourceOrdinal: number,
  overrides: Partial<TranscriptEntry>,
): TranscriptEntry {
  return {
    sourceOrdinal,
    ordinal: sourceOrdinal,
    source: "main",
    timestamp: "2026-01-01T00:00:00.000Z",
    timestampMs: 1,
    role: "assistant",
    kind: "text",
    text: null,
    meta: false,
    tool: null,
    nativeEntryId: `entry-${sourceOrdinal}`,
    parentNativeEntryId:
      sourceOrdinal === 0 ? null : `entry-${sourceOrdinal - 1}`,
    ...overrides,
  };
}

function toolCall(
  sourceOrdinal: number,
  name: string,
  useId: string,
  input: unknown,
): TranscriptEntry {
  const tool: TranscriptTool = {
    name,
    useId,
    input,
    result: null,
    isError: false,
  };
  return entry(sourceOrdinal, {
    role: "tool",
    kind: "tool_call",
    tool,
  });
}

function toolResult(
  sourceOrdinal: number,
  useId: string,
  isError: boolean,
): TranscriptEntry {
  return entry(sourceOrdinal, {
    role: "tool",
    kind: "tool_result",
    tool: {
      name: null,
      useId,
      input: null,
      result: isError ? "failed" : "ok",
      isError,
    },
  });
}

function contextForEntry(entry: TranscriptEntry): HistoryContextHandle {
  return {
    sessionKey: "session",
    sourceKey: "source",
    source: entry.source,
    sourceOrdinal: entry.sourceOrdinal,
    nativeEntryId: entry.nativeEntryId,
    parentNativeEntryId: entry.parentNativeEntryId,
  };
}

describe("File evidence", () => {
  test("keeps observed mutation, shell possibility, and mention distinct", () => {
    const entries = [
      toolCall(0, "Write", "write-ok", { file_path: "src/observed.ts" }),
      toolResult(1, "write-ok", false),
      toolCall(2, "Write", "write-failed", { file_path: "src/failed.ts" }),
      toolResult(3, "write-failed", true),
      toolCall(4, "Bash", "bash-1", { command: "rm src/shell.ts" }),
      entry(5, {
        text: "Review src/mentioned.ts and src/shell.ts before continuing.",
      }),
      // Lowercase is not one of the canonical successful mutation tools from
      // derivers.ts, even when a successful result exists.
      toolCall(6, "write", "lowercase", { file_path: "src/lower.ts" }),
      toolResult(7, "lowercase", false),
      entry(8, { text: "Someone said Write src/text-only.ts" }),
    ];

    const evidence = deriveFileEvidence({
      entries,
      project: "/repo",
      canonicalMutations: [{ path: "/repo/canonical.ts" }],
      contextForEntry,
    });
    const grades = new Map(evidence.map((item) => [item.path, item.grade]));
    expect(grades).toEqual(
      new Map([
        ["/repo/canonical.ts", "observed_mutation"],
        ["/repo/src/failed.ts", "mention"],
        ["/repo/src/lower.ts", "mention"],
        ["/repo/src/mentioned.ts", "mention"],
        ["/repo/src/observed.ts", "observed_mutation"],
        ["/repo/src/shell.ts", "possible_mutation"],
        ["/repo/src/text-only.ts", "mention"],
      ]),
    );

    const observed = evidence.find(
      (item) => item.path === "/repo/src/observed.ts",
    );
    expect(observed?.provenance[0]?.source).toBe("successful_tool");
    expect(observed?.provenance[0]?.context?.sourceOrdinal).toBe(0);
    expect(
      evidence.find((item) => item.path === "/repo/src/shell.ts")?.provenance[0]
        ?.source,
    ).toBe("shell_inference");
  });

  test("a result can precede its call without losing settled success", () => {
    const evidence = deriveFileEvidence({
      entries: [
        toolResult(0, "out-of-order", false),
        toolCall(1, "Edit", "out-of-order", { file_path: "src/order.ts" }),
      ],
      project: "/repo",
    });
    expect(evidence).toEqual([
      {
        path: "/repo/src/order.ts",
        grade: "observed_mutation",
        provenance: [{ source: "successful_tool", context: null }],
      },
    ]);
  });

  test("path normalization never changes confidence", () => {
    expect(normalizeEvidencePath("./src/../src/a.ts", "/repo")).toBe(
      "/repo/src/a.ts",
    );
    const mention = deriveFileEvidence({
      entries: [entry(0, { text: "The file is ./src/../src/a.ts" })],
      project: "/repo",
    });
    expect(mention[0]?.path).toBe("/repo/src/a.ts");
    expect(mention[0]?.grade).toBe("mention");
  });
});
