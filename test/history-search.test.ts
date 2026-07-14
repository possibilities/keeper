import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionCatalog } from "../src/history/catalog";
import { resolveHistoryIndexPaths } from "../src/history/index-db";
import { refreshHistoryIndex } from "../src/history/indexer";
import type { NativeSessionArtifact } from "../src/history/model";
import { searchHistoryIndex } from "../src/history/search";

let root: string;
let paths: ReturnType<typeof resolveHistoryIndexPaths>;
let catalog: ReturnType<typeof buildSessionCatalog>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function writeJsonl(path: string, lines: readonly string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

function piMessage(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  timestamp: string,
): string {
  return json({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role, content: [{ type: "text", text }] },
  });
}

function nativeArtifact(
  harness: "claude" | "pi",
  nativeId: string,
  path: string,
  project: string,
  title: string,
): NativeSessionArtifact {
  return {
    harness,
    nativeId,
    path,
    project,
    currentTitle: title,
    titleHistory: [title],
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    bytes: statSync(path).size,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-history-search-"));
  const native = join(root, "native");
  const piOne = join(native, "pi-one.jsonl");
  const piTwo = join(native, "pi-two.jsonl");
  const claude = join(native, "claude.jsonl");

  writeJsonl(piOne, [
    piMessage(
      "pi-u1",
      null,
      "user",
      "alpha only common",
      "2026-01-01T01:00:00.000Z",
    ),
    piMessage(
      "pi-a1",
      "pi-u1",
      "assistant",
      "needle pi-provenance common",
      "2026-01-01T02:00:00.000Z",
    ),
  ]);
  writeJsonl(piTwo, [
    piMessage(
      "pi2-u1",
      null,
      "user",
      "alpha OR beta common",
      "2026-01-02T01:00:00.000Z",
    ),
  ]);
  writeJsonl(claude, [
    json({
      type: "custom-title",
      customTitle: "Claude search",
    }),
    json({
      type: "user",
      timestamp: "2026-01-03T01:00:00.000Z",
      cwd: "/project/claude",
      message: { role: "user", content: "alpha OR beta common" },
    }),
  ]);
  const subagent = join(
    claude.slice(0, -".jsonl".length),
    "subagents",
    "agent-sub1.jsonl",
  );
  writeJsonl(subagent, [
    json({
      type: "assistant",
      timestamp: "2026-01-03T02:00:00.000Z",
      cwd: "/project/claude",
      message: { role: "assistant", content: "needle subagent common" },
    }),
  ]);

  catalog = buildSessionCatalog([
    nativeArtifact("pi", "pi-one", piOne, "/project/pi-one", "Pi one"),
    nativeArtifact("pi", "pi-two", piTwo, "/project/pi-two", "Pi two"),
    nativeArtifact(
      "claude",
      "claude-one",
      claude,
      "/project/claude",
      "Claude search",
    ),
  ]);
  paths = resolveHistoryIndexPaths(join(root, "state"));
  refreshHistoryIndex({ paths, catalog, nowMs: 1 });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("History full-text search", () => {
  test("treats FTS operators literally unless advanced mode is explicit", () => {
    const literal = searchHistoryIndex(paths, { text: "alpha OR beta" });
    expect(literal.kind).toBe("ok");
    if (literal.kind === "ok") {
      expect(literal.total).toBe(2);
      expect(
        literal.hits.every((hit) => hit.body.includes("alpha OR beta")),
      ).toBe(true);
    }

    const advanced = searchHistoryIndex(paths, {
      text: "alpha OR beta",
      mode: "advanced",
    });
    expect(advanced.kind).toBe("ok");
    if (advanced.kind === "ok") expect(advanced.total).toBe(3);
  });

  test("applies structured session, project, role, source, and time filters", () => {
    const piOne = catalog.sessions.find(
      (session) => session.nativeId === "pi-one",
    );
    expect(piOne).toBeDefined();
    const bySession = searchHistoryIndex(paths, {
      text: "common",
      filters: { sessionKeys: [piOne?.sessionKey ?? "missing"] },
    });
    expect(bySession.kind).toBe("ok");
    if (bySession.kind === "ok") {
      expect(new Set(bySession.hits.map((hit) => hit.nativeId))).toEqual(
        new Set(["pi-one"]),
      );
    }

    const byProjectRole = searchHistoryIndex(paths, {
      text: "needle",
      filters: {
        projects: ["/project/pi-one"],
        roles: ["assistant"],
        sinceMs: Date.parse("2026-01-01T01:30:00.000Z"),
        untilMs: Date.parse("2026-01-01T02:30:00.000Z"),
      },
    });
    expect(byProjectRole.kind).toBe("ok");
    if (byProjectRole.kind === "ok") {
      expect(byProjectRole.total).toBe(1);
      expect(byProjectRole.hits[0]?.nativeId).toBe("pi-one");
    }

    const bySource = searchHistoryIndex(paths, {
      text: "needle",
      filters: { sources: ["subagent:sub1"] },
    });
    expect(bySource.kind).toBe("ok");
    if (bySource.kind === "ok") {
      expect(bySource.total).toBe(1);
      expect(bySource.hits[0]?.source).toBe("subagent:sub1");
    }
  });

  test("returns stable ranked pages with entry-level Pi branch provenance", () => {
    const first = searchHistoryIndex(paths, {
      text: "common",
      limit: 2,
    });
    const repeated = searchHistoryIndex(paths, {
      text: "common",
      limit: 2,
    });
    expect(first).toEqual(repeated);
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;
    expect(first.total).toBe(5);
    expect(first.nextOffset).toBe(2);

    const second = searchHistoryIndex(paths, {
      text: "common",
      offset: first.nextOffset ?? 0,
      limit: 2,
    });
    expect(second.kind).toBe("ok");
    if (second.kind === "ok") {
      expect(
        new Set(first.hits.map((hit) => hit.entryId)).intersection(
          new Set(second.hits.map((hit) => hit.entryId)),
        ).size,
      ).toBe(0);
    }

    const provenance = searchHistoryIndex(paths, { text: "pi-provenance" });
    expect(provenance.kind).toBe("ok");
    if (provenance.kind === "ok") {
      expect(provenance.hits[0]?.context.nativeEntryId).toBe("pi-a1");
      expect(provenance.hits[0]?.context.parentNativeEntryId).toBe("pi-u1");
      expect(provenance.hits[0]?.context.sourceOrdinal).toBe(1);
    }
  });

  test("fails malformed advanced syntax without echoing the raw query", () => {
    const raw = '" private-token-never-echo';
    const result = searchHistoryIndex(paths, {
      text: raw,
      mode: "advanced",
    });
    expect(result.kind).toBe("invalid_query");
    if (result.kind === "invalid_query") {
      expect(result.code).toBe("invalid_fts_query");
      expect(result.message).not.toContain(raw);
      expect(result.message).not.toContain("private-token-never-echo");
    }
  });
});
