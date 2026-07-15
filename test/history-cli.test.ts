import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HistoryCliDeps, runHistoryCli } from "../cli/history";
import type { KeeperJobAlias } from "../src/history/model";
import { encodeClaudeProject } from "../src/transcript/claude";
import { encodePiCwd } from "../src/transcript/pi";
import { freshDbFile } from "./helpers/template-db";

let root: string;
let home: string;
let stateDir: string;
let deps: HistoryCliDeps;

const PROJECT = "/repo/history";
const NOW = Date.parse("2026-02-01T00:00:00.000Z");

function json(value: unknown): string {
  return JSON.stringify(value);
}

interface ParsedEnvelope {
  schema_version: number;
  ok: boolean;
  data: Record<string, unknown>;
  error: { code: string; details?: Record<string, unknown> } | null;
}

function envelope(stdout: string): ParsedEnvelope {
  return JSON.parse(stdout) as ParsedEnvelope;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
}

function writePiSession(
  sessionId: string,
  lines: readonly unknown[],
  project = PROJECT,
): string {
  const dir = join(home, ".pi", "agent", "sessions", encodePiCwd(project));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`);
  writeFileSync(
    path,
    `${[json({ type: "session", cwd: project }), ...lines.map(json)].join(
      "\n",
    )}\n`,
  );
  return path;
}

function writeClaudeSession(
  sessionId: string,
  project: string,
  title: string,
): string {
  const dir = join(home, ".claude", "projects", encodeClaudeProject(project));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(
    path,
    `${[
      json({ type: "custom-title", customTitle: title }),
      json({
        type: "user",
        timestamp: "2026-01-02T00:00:00.000Z",
        cwd: project,
        message: { role: "user", content: "hello from claude" },
      }),
    ].join("\n")}\n`,
  );
  return path;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "keeper-history-cli-"));
  home = join(root, "home");
  stateDir = join(root, "state");
  mkdirSync(home, { recursive: true });
  deps = {
    cwd: PROJECT,
    homeDir: home,
    env: {},
    nowMs: NOW,
    dbPath: join(root, "missing-keeper.db"),
    stateDir,
  };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("keeper history CLI", () => {
  test("list is global/native by default and reports metadata-only job diagnostics", () => {
    writePiSession("pi-one", [
      { type: "session_info", name: "Pi title" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      },
    ]);
    writeClaudeSession("claude-one", PROJECT, "Claude title");

    const result = runHistoryCli(["list", "--format", "json"], deps);
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body.ok).toBe(true);
    expect(
      rows(body.data.sessions)
        .map((s) => s.qualified_id)
        .sort(),
    ).toEqual(["claude:claude-one", "pi:pi-one"]);
    expect(rows(body.data.diagnostics).map((d) => d.code)).toContain(
      "keeper_jobs_unavailable",
    );
  });

  test("show uses the shared exact resolver and returns candidates on ambiguity", () => {
    writePiSession(
      "pi-a",
      [{ type: "session_info", name: "Reusable" }],
      "/repo/a",
    );
    writeClaudeSession("claude-b", "/repo/b", "reusable");

    const ambiguous = runHistoryCli(
      ["show", "REUSABLE", "--format", "json"],
      deps,
    );
    expect(ambiguous.code).toBe(1);
    const problem = envelope(ambiguous.stdout);
    expect(problem.ok).toBe(false);
    const problemError = problem.error;
    expect(problemError?.code).toBe("session_ambiguous");
    expect(rows(problemError?.details?.candidates)).toHaveLength(2);

    const shown = runHistoryCli(
      ["show", "pi:pi-a", "--project", "/repo/a", "--offset", "0"],
      deps,
    );
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("@keeper-history transcript v1");
    expect(shown.stdout).toContain("session: pi:pi-a");
  });

  test("search refreshes the History index and emits ready-to-run context locators", () => {
    writePiSession("pi-search", [
      { type: "session_info", name: "Search title" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T01:00:00.000Z",
        message: { role: "user", content: "find the needle phrase" },
      },
    ]);

    const result = runHistoryCli(
      [
        "search",
        "--syntax",
        "literal",
        "--format",
        "json",
        "--limit",
        "5",
        "--",
        "needle",
      ],
      deps,
    );
    expect(result.code).toBe(0);
    const body = envelope(result.stdout);
    expect(body.ok).toBe(true);
    const hits = rows(body.data.hits);
    expect(hits).toHaveLength(1);
    expect(String(hits[0]?.show_command)).toContain(
      "keeper history show pi:pi-search --project /repo/history",
    );
    const locator = hits[0]?.locator as Record<string, unknown> | undefined;
    expect(locator?.nativeEntryId).toBe("u1");
  });

  test("files separates observed mutation from mention and hides mentions by default", () => {
    writePiSession("pi-files", [
      {
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-01-01T01:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-1",
              name: "Write",
              arguments: { file_path: "src/observed.ts" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "r1",
        parentId: "a1",
        timestamp: "2026-01-01T01:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tool-1",
          toolName: "Write",
          isError: false,
          content: "ok",
        },
      },
      {
        type: "message",
        id: "u2",
        parentId: "r1",
        timestamp: "2026-01-01T01:00:02.000Z",
        message: { role: "user", content: "please review src/mentioned.ts" },
      },
    ]);

    const observed = runHistoryCli(
      ["files", "observed.ts", "--format", "json"],
      deps,
    );
    expect(observed.code).toBe(0);
    const observedEnvelope = envelope(observed.stdout);
    expect(observedEnvelope.schema_version).toBe(2);
    expect(rows(observedEnvelope.data.matches)[0]?.grade).toBe(
      "observed_mutation",
    );
    expect(observedEnvelope.data.coverage).toMatchObject({
      indexed_total: expect.any(Number),
      indexed_considered: expect.any(Number),
      indexed_truncated: expect.any(Boolean),
    });

    const hidden = runHistoryCli(
      ["files", "mentioned.ts", "--format", "json"],
      deps,
    );
    expect(hidden.code).toBe(0);
    expect(rows(envelope(hidden.stdout).data.matches)).toEqual([]);

    const mentioned = runHistoryCli(
      ["files", "mentioned.ts", "--mentions", "--format", "json"],
      deps,
    );
    expect(rows(envelope(mentioned.stdout).data.matches)[0]?.grade).toBe(
      "mention",
    );
  });

  test("production-shaped jobs join native artifacts and aggregate stale harness diagnostics", () => {
    const claudePath = writeClaudeSession(
      "claude-production",
      PROJECT,
      "Native Claude title",
    );
    writePiSession("pi-production", [
      { type: "session_info", name: "Native Pi title" },
    ]);
    const dbPath = join(root, "keeper.db");
    const { db } = freshDbFile(dbPath);
    const insert = db.prepare(`INSERT INTO jobs(
        job_id, created_at, updated_at, cwd, title, name_history,
        transcript_path, harness, resume_target
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      "claude-production",
      1,
      2,
      PROJECT,
      "Keeper Claude title",
      JSON.stringify(["Keeper Claude title"]),
      claudePath,
      null,
      null,
    );
    // Pi's Keeper job id is an alias; resume_target is the native Session id.
    insert.run(
      "keeper-pi-alias",
      1,
      3,
      PROJECT,
      "Keeper Pi title",
      JSON.stringify(["Keeper Pi title"]),
      null,
      "pi",
      "pi-production",
    );
    for (let index = 0; index < 40; index++) {
      insert.run(
        `retired-codex-${index}`,
        1,
        1,
        PROJECT,
        null,
        "[]",
        null,
        index % 2 === 0 ? "codex" : "hermes",
        `retired-native-${index}`,
      );
    }
    for (let index = 0; index < 3; index++) {
      insert.run(
        `targetless-pi-${index}`,
        1,
        1,
        PROJECT,
        null,
        "[]",
        null,
        "pi",
        null,
      );
    }
    db.close();
    deps.dbPath = dbPath;

    const result = runHistoryCli(["list", "--format", "json"], deps);
    expect(result.code).toBe(0);
    const data = envelope(result.stdout).data;
    expect((data.page as Record<string, unknown>).total).toBe(2);
    const sessions = rows(data.sessions);
    expect(sessions.every((session) => session.job_count === 1)).toBe(true);
    expect(
      (data.catalog as Record<string, unknown>).metadata_only_sessions,
    ).toBe(0);
    const diagnostics = rows(data.diagnostics);
    expect(
      diagnostics.find((item) => item.code === "unsupported_job_harness")
        ?.count,
    ).toBe(40);
    expect(
      diagnostics.find((item) => item.code === "job_missing_native_id")?.count,
    ).toBe(3);
    expect(diagnostics.length).toBeLessThanOrEqual(4);
  });

  test("missing keeper.db is a fallback but an existing malformed database fails", () => {
    writePiSession("pi-db-state", [{ type: "session_info", name: "DB state" }]);
    const missing = runHistoryCli(["list", "--format", "json"], deps);
    expect(missing.code).toBe(0);
    expect(rows(envelope(missing.stdout).data.sessions)).toHaveLength(1);

    deps.dbPath = join(root, "malformed.db");
    writeFileSync(deps.dbPath, "not a sqlite database");
    const malformed = runHistoryCli(["list", "--format", "json"], deps);
    expect(malformed.code).toBe(1);
    expect(envelope(malformed.stdout).error?.code).toBe(
      "keeper_jobs_read_failed",
    );

    const human = runHistoryCli(["list"], deps);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("could not read Keeper job aliases");
  });

  test("plain list samples titles, while show keeps complete historical-title resolution", () => {
    const sessionId = "claude-buried-title";
    const dir = join(home, ".claude", "projects", encodeClaudeProject(PROJECT));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      `${[
        json({
          type: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: PROJECT,
          message: { role: "user", content: "start" },
        }),
        json({ type: "future", payload: "x".repeat(70_000) }),
        json({ type: "custom-title", customTitle: "Buried historical title" }),
        json({ type: "future", payload: "y".repeat(70_000) }),
        json({
          type: "assistant",
          timestamp: "2026-01-02T00:00:00.000Z",
          cwd: PROJECT,
          message: { role: "assistant", content: "finish" },
        }),
      ].join("\n")}\n`,
    );

    const listed = runHistoryCli(["list", "--format", "json"], deps);
    const listedSession = rows(envelope(listed.stdout).data.sessions)[0];
    expect(listedSession?.title_history_complete).toBe(false);

    const shown = runHistoryCli(
      ["show", "Buried historical title", "--format", "json"],
      deps,
    );
    expect(shown.code).toBe(0);
    expect(
      (envelope(shown.stdout).data.locator as Record<string, unknown>)
        .native_id,
    ).toBe(sessionId);
  });

  test("History-index metadata makes later plain lists title-complete without body indexing", () => {
    writePiSession("pi-cached-titles", [
      { type: "session_info", name: "First title" },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T01:00:00.000Z",
        message: { role: "user", content: "cache needle" },
      },
      { type: "session_info", name: "Second title" },
    ]);
    expect(
      runHistoryCli(["search", "needle", "--format", "json"], deps).code,
    ).toBe(0);

    const listed = runHistoryCli(["list", "--format", "json"], deps);
    const session = rows(envelope(listed.stdout).data.sessions)[0];
    expect(session?.title_history_complete).toBe(true);
    expect(session?.titles).toEqual(["First title", "Second title"]);
  });

  test("context commands pin duplicate native ids by artifact and exact source ordinal", () => {
    const sessionId = "duplicate-pi";
    const paths: string[] = [];
    for (const [bucket, text] of [
      ["--bucket-a--", "ordinary branch"],
      ["--bucket-b--", "duplicate needle branch"],
    ] as const) {
      const dir = join(home, ".pi", "agent", "sessions", bucket);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `2026-01-01T00-00-00.000Z_${sessionId}.jsonl`);
      paths.push(path);
      writeFileSync(
        path,
        `${[
          json({ type: "session", cwd: PROJECT }),
          json({
            type: "message",
            id: `u-${bucket}`,
            parentId: null,
            timestamp: "2026-01-01T01:00:00.000Z",
            message: { role: "user", content: text },
          }),
        ].join("\n")}\n`,
      );
    }

    const searched = runHistoryCli(
      ["search", "needle", "--format", "json"],
      deps,
    );
    expect(searched.code).toBe(0);
    const command = String(
      rows(envelope(searched.stdout).data.hits)[0]?.show_command,
    );
    expect(command).toContain(`--artifact ${realpathSync(paths[1] as string)}`);
    expect(command).toContain("--meta --thinking --tools full --offset 0");

    const shown = runHistoryCli(
      [
        "show",
        `pi:${sessionId}`,
        "--project",
        PROJECT,
        "--artifact",
        paths[1] as string,
        "--format",
        "json",
      ],
      deps,
    );
    expect(shown.code).toBe(0);
    expect(
      (envelope(shown.stdout).data.locator as Record<string, unknown>)
        .artifact_path,
    ).toBe(realpathSync(paths[1] as string));
  });

  test("Keeper mutation facts remain scoped to job aliases, not colliding native ids", () => {
    writeClaudeSession("claude-fact-owner", PROJECT, "Fact owner");
    writePiSession("collision-job-id", [
      { type: "session_info", name: "Standalone collision" },
    ]);
    const alias: KeeperJobAlias = {
      jobId: "collision-job-id",
      harness: "claude",
      nativeId: "claude-fact-owner",
      transcriptPath: null,
      project: PROJECT,
      currentTitle: "Fact owner",
      titleHistory: ["Fact owner"],
      state: "ended",
      createdAtMs: 1,
      updatedAtMs: 2,
      pid: null,
      startTime: null,
    };
    deps.readKeeperJobs = () => ({ jobs: [alias], diagnostics: [] });
    deps.dbPath = join(root, "facts.db");
    const { db } = freshDbFile(deps.dbPath);
    db.run(
      `INSERT INTO events(
         ts, session_id, hook_event, event_type, tool_name, cwd, data,
         mutation_path
       ) VALUES (?, ?, 'PostToolUse', 'post_tool_use', 'Write', ?, '{}', ?)`,
      [1, "collision-job-id", PROJECT, "src/owned.ts"],
    );
    db.close();

    const standalone = runHistoryCli(
      [
        "files",
        "owned.ts",
        "--session",
        "pi:collision-job-id",
        "--format",
        "json",
      ],
      deps,
    );
    expect(standalone.code).toBe(0);
    expect(rows(envelope(standalone.stdout).data.matches)).toEqual([]);

    const owner = runHistoryCli(
      ["files", "owned.ts", "--session", "Fact owner", "--format", "json"],
      deps,
    );
    expect(rows(envelope(owner.stdout).data.matches)).toHaveLength(1);
  });

  test("file results bound repeated provenance and report the omitted count", () => {
    writePiSession(
      "pi-provenance-cap",
      Array.from({ length: 40 }, (_, index) => ({
        type: "message",
        id: `u${index}`,
        parentId: index === 0 ? null : `u${index - 1}`,
        timestamp: `2026-01-01T01:${String(index).padStart(2, "0")}:00.000Z`,
        message: { role: "user", content: "review src/repeated.ts" },
      })),
    );
    const result = runHistoryCli(
      ["files", "repeated.ts", "--mentions", "--format", "json"],
      deps,
    );
    expect(result.code).toBe(0);
    const match = rows(envelope(result.stdout).data.matches)[0];
    expect(rows(match?.provenance)).toHaveLength(24);
    expect(match?.provenanceTotal).toBe(40);
    expect(match?.provenanceTruncated).toBe(true);
  });

  test("human failures use stderr while JSON failures retain one envelope", () => {
    writePiSession("pi-envelope", [{ type: "session_info", name: "Envelope" }]);
    const human = runHistoryCli(["show", "missing"], deps);
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("no session matched");

    const machine = runHistoryCli(
      ["show", "missing", "--format", "json"],
      deps,
    );
    expect(machine.code).toBe(1);
    expect(machine.stderr).toBe("");
    expect(envelope(machine.stdout).error?.code).toBe("session_not_found");

    const usageFault = runHistoryCli(["list", "--limit", "201"], deps);
    expect(usageFault.code).toBe(2);
    expect(usageFault.stdout).toBe("");
    expect(usageFault.stderr).toContain("must not exceed 200");
  });

  test("index status and purge are safe JSON-envelope operations", () => {
    writePiSession("pi-index", [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-01-01T01:00:00.000Z",
        message: { role: "user", content: "index me" },
      },
    ]);
    expect(
      runHistoryCli(["search", "index", "--format", "json"], deps).code,
    ).toBe(0);

    const status = runHistoryCli(["index", "status", "--format", "json"], deps);
    expect(status.code).toBe(0);
    const statusData = envelope(status.stdout).data;
    expect((statusData.status as Record<string, unknown>).kind).toBe("ready");

    const purge = runHistoryCli(["index", "purge", "--format", "json"], deps);
    expect(purge.code).toBe(0);
    const purgeData = envelope(purge.stdout).data;
    expect((purgeData.status as Record<string, unknown>).kind).toBe("missing");
  });
});
