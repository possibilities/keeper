import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionCatalog,
  keeperJobAliasFromRow,
} from "../src/history/catalog";
import type {
  KeeperJobAlias,
  NativeSessionArtifact,
} from "../src/history/model";
import { resolveSessionReference } from "../src/history/resolver";
import {
  parseClaudeTranscriptText,
  readClaudeTitleHistory,
} from "../src/transcript/claude";
import {
  encodePiCwd,
  listPiSessions,
  parsePiTranscriptText,
  readPiTitleHistory,
} from "../src/transcript/pi";

function artifact(
  harness: "claude" | "pi",
  nativeId: string,
  path: string,
  project: string,
  titles: string[],
  updatedAt: string,
): NativeSessionArtifact {
  return {
    harness,
    nativeId,
    path,
    project,
    currentTitle: titles.at(-1) ?? null,
    titleHistory: titles,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    bytes: 100,
  };
}

function job(overrides: Partial<KeeperJobAlias> = {}): KeeperJobAlias {
  return {
    jobId: "job-a",
    harness: "claude",
    nativeId: "duplicate",
    transcriptPath: "/native/project-a/duplicate.jsonl",
    project: "/project/a",
    currentTitle: "Job current",
    titleHistory: ["Job old", "Job current"],
    state: "stopped",
    createdAtMs: 1,
    updatedAtMs: 2,
    pid: null,
    startTime: null,
    ...overrides,
  };
}

describe("Session catalog and resolver", () => {
  test("keeps standalone artifacts and duplicate native ids distinct", () => {
    const catalog = buildSessionCatalog([
      artifact(
        "claude",
        "duplicate",
        "/native/project-a/duplicate.jsonl",
        "/project/a",
        ["Old alias", "Shared title"],
        "2026-01-03T00:00:00.000Z",
      ),
      artifact(
        "claude",
        "duplicate",
        "/native/project-b/duplicate.jsonl",
        "/project/b",
        ["Shared title"],
        "2026-01-04T00:00:00.000Z",
      ),
      artifact(
        "pi",
        "duplicate",
        "/native/pi/duplicate.jsonl",
        "/project/pi",
        ["Pi standalone"],
        "2026-01-02T00:00:00.000Z",
      ),
      artifact(
        "pi",
        "standalone",
        "/native/pi/standalone.jsonl",
        "/project/pi",
        [],
        "2026-01-01T00:00:00.000Z",
      ),
    ]);

    expect(catalog.sessions).toHaveLength(4);
    expect(
      new Set(catalog.sessions.map((session) => session.sessionKey)).size,
    ).toBe(4);
    expect(
      catalog.sessions.find((session) => session.nativeId === "standalone")
        ?.jobs,
    ).toEqual([]);

    const qualified = resolveSessionReference(catalog, "claude:duplicate");
    expect(qualified.kind).toBe("ambiguous");
    if (qualified.kind === "ambiguous") {
      expect(qualified.match).toBe("qualified_native_id");
      expect(
        qualified.candidates.map((candidate) => candidate.project),
      ).toEqual(["/project/a", "/project/b"]);
    }

    const unqualified = resolveSessionReference(catalog, "duplicate");
    expect(unqualified.kind).toBe("ambiguous");
    if (unqualified.kind === "ambiguous") {
      expect(unqualified.match).toBe("native_id");
      expect(unqualified.candidates).toHaveLength(3);
    }
  });

  test("deduplicates Pi artifacts reached through symlinked buckets", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-history-pi-symlink-"));
    try {
      const sessionsDir = join(root, "sessions");
      const bucket = join(sessionsDir, encodePiCwd("/repo"));
      mkdirSync(bucket, { recursive: true });
      const transcript = join(
        bucket,
        "2026-01-01T00-00-00.000Z_pi-session.jsonl",
      );
      writeFileSync(
        transcript,
        `${JSON.stringify({ type: "session", cwd: "/repo" })}\n`,
      );
      symlinkSync(bucket, join(sessionsDir, "--repo-alias--"), "dir");

      const listed = listPiSessions({
        sessionsDir,
        project: null,
        sinceMs: null,
        untilMs: null,
        offset: 0,
        limit: 10,
      });

      expect(listed.items.map((item) => item.path)).toEqual([transcript]);
      expect(listed.items.map((item) => item.sessionId)).toEqual([
        "pi-session",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("joins exact job artifacts and applies deterministic selector tiers", () => {
    const artifacts = [
      artifact(
        "claude",
        "duplicate",
        "/native/project-a/duplicate.jsonl",
        "/project/a",
        ["Native old", "Native current"],
        "2026-01-03T00:00:00.000Z",
      ),
      artifact(
        "claude",
        "duplicate",
        "/native/project-b/duplicate.jsonl",
        "/project/b",
        ["Other current"],
        "2026-01-04T00:00:00.000Z",
      ),
      artifact(
        "pi",
        "job-a",
        "/native/pi/job-a.jsonl",
        "/project/pi",
        ["Native id collision"],
        "2026-01-05T00:00:00.000Z",
      ),
    ];
    const catalog = buildSessionCatalog(artifacts, [job()]);

    const byJob = resolveSessionReference(catalog, "job-a");
    expect(byJob.kind).toBe("resolved");
    if (byJob.kind === "resolved") {
      expect(byJob.match).toBe("job_id");
      expect(byJob.session.project).toBe("/project/a");
      expect(byJob.session.titles).toEqual([
        "Native old",
        "Native current",
        "Job old",
        "Job current",
      ]);
    }

    const historical = resolveSessionReference(catalog, "native OLD");
    expect(historical.kind).toBe("resolved");
    if (historical.kind === "resolved") expect(historical.match).toBe("title");
  });

  test("title ambiguity never collapses to the newest session", () => {
    const catalog = buildSessionCatalog([
      artifact(
        "claude",
        "older",
        "/a.jsonl",
        "/a",
        ["Reusable"],
        "2026-01-01T00:00:00.000Z",
      ),
      artifact(
        "pi",
        "newer",
        "/b.jsonl",
        "/b",
        ["reusable"],
        "2026-02-01T00:00:00.000Z",
      ),
    ]);
    const result = resolveSessionReference(catalog, "REUSABLE");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.match).toBe("title");
      expect(result.candidates.map((candidate) => candidate.nativeId)).toEqual([
        "older",
        "newer",
      ]);
    }
  });

  test("artifact-less supported jobs remain cataloged with reduced metadata", () => {
    const catalog = buildSessionCatalog(
      [],
      [
        job({
          jobId: "job-only",
          harness: "pi",
          nativeId: "pi-native",
          transcriptPath: null,
          project: "/missing",
          currentTitle: "Tracked only",
        }),
      ],
    );
    expect(catalog.sessions).toHaveLength(1);
    expect(catalog.sessions[0]?.artifact).toBeNull();
    expect(resolveSessionReference(catalog, "job-only").kind).toBe("resolved");
    expect(resolveSessionReference(catalog, "pi:pi-native").kind).toBe(
      "resolved",
    );
  });

  test("adapts legacy Claude rows and refuses unsupported or targetless jobs", () => {
    const legacy = keeperJobAliasFromRow({
      job_id: "claude-job",
      title: "Current",
      name_history: JSON.stringify(["Old", "Current"]),
      created_at: 10,
      updated_at: 20,
    });
    expect(legacy.kind).toBe("ok");
    if (legacy.kind === "ok") {
      expect(legacy.job.harness).toBe("claude");
      expect(legacy.job.nativeId).toBe("claude-job");
      expect(legacy.job.updatedAtMs).toBe(20_000);
    }
    expect(keeperJobAliasFromRow({ job_id: "x", harness: "codex" }).kind).toBe(
      "ignored",
    );
    expect(keeperJobAliasFromRow({ job_id: "x", harness: "pi" }).kind).toBe(
      "ignored",
    );
  });
});

describe("transcript normalization retained metadata", () => {
  test("retains Claude and Pi title timelines without changing current-title semantics", () => {
    const claude = parseClaudeTranscriptText(
      [
        JSON.stringify({ type: "custom-title", customTitle: "First" }),
        JSON.stringify({ type: "custom-title", customTitle: "Second" }),
      ].join("\n"),
      { path: "/claude.jsonl", sessionId: "c" },
    );
    expect(claude.metadata.title).toBe("Second");
    expect(claude.metadata.titleHistory).toEqual(["First", "Second"]);

    const pi = parsePiTranscriptText(
      [
        JSON.stringify({
          type: "session_info",
          id: "title-1",
          parentId: null,
          name: "First",
        }),
        JSON.stringify({
          type: "session_info",
          id: "title-2",
          parentId: "title-1",
          name: "Second",
        }),
      ].join("\n"),
      { path: "/pi.jsonl", sessionId: "p" },
    );
    expect(pi.metadata.title).toBe("Second");
    expect(pi.metadata.titleHistory).toEqual(["First", "Second"]);
  });

  test("scans complete title timelines without loading transcript bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "keeper-history-titles-"));
    try {
      const claudePath = join(root, "claude.jsonl");
      writeFileSync(
        claudePath,
        `${[
          JSON.stringify({ type: "custom-title", customTitle: "Head" }),
          JSON.stringify({ type: "future", payload: "x".repeat(140_000) }),
          JSON.stringify({ type: "custom-title", customTitle: "Middle" }),
          JSON.stringify({ type: "future", payload: "y".repeat(140_000) }),
        ].join("\n")}\n`,
      );
      expect(readClaudeTitleHistory(claudePath)).toEqual(["Head", "Middle"]);

      const piPath = join(root, "pi.jsonl");
      writeFileSync(
        piPath,
        `${[
          JSON.stringify({ type: "session_info", name: "Head" }),
          JSON.stringify({ type: "future", payload: "x".repeat(140_000) }),
          JSON.stringify({ type: "session_info", name: "Middle" }),
          JSON.stringify({ type: "future", payload: "y".repeat(140_000) }),
        ].join("\n")}\n`,
      );
      expect(readPiTitleHistory(piPath)).toEqual(["Head", "Middle"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains Pi branch links and unknown records", () => {
    const document = parsePiTranscriptText(
      [
        JSON.stringify({
          type: "message",
          id: "user-1",
          parentId: "root-1",
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "hello" },
        }),
        JSON.stringify({
          type: "future_record",
          id: "future-1",
          parentId: "user-1",
          payload: { retained: true },
        }),
      ].join("\n"),
      { path: "/pi.jsonl", sessionId: "p" },
    );
    expect(document.entries[0]?.nativeEntryId).toBe("user-1");
    expect(document.entries[0]?.parentNativeEntryId).toBe("root-1");
    expect(document.unknownRecords).toHaveLength(1);
    expect(document.unknownRecords[0]?.nativeEntryId).toBe("future-1");
  });
});
