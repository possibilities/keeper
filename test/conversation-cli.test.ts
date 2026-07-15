import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CONVERSATION_SCHEMA_VERSION,
  type ConversationCliDeps,
  runConversationCli,
} from "../cli/conversation";
import { successEnvelope } from "../cli/envelope";
import {
  type ClaudeToPiConvertOptions,
  ConversationConversionError,
  type ConvertedClaudeToPiConversation,
} from "../src/conversation/claude-to-pi";
import { encodeClaudeProject } from "../src/transcript/claude";

const SOURCE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_DIGEST = "sha256:fixture";
const ROOT_PI_SESSION_ID = "pi-root-session";
const CWD = "/repo/project";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function makeHarness(
  options: {
    env?: NodeJS.ProcessEnv;
    convert?: (
      opts: ClaudeToPiConvertOptions,
    ) => ConvertedClaudeToPiConversation;
    loadCatalog?: ConversationCliDeps["loadCatalog"];
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "keeper-conversation-cli-"));
  roots.push(root);
  const cwd = join(root, "cwd");
  const homeDir = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const calls: ClaudeToPiConvertOptions[] = [];
  const convert =
    options.convert ??
    ((opts: ClaudeToPiConvertOptions) => makeConverted(opts, {}));
  const deps: ConversationCliDeps = {
    cwd,
    homeDir,
    env: { ...(options.env ?? {}) },
    loadCatalog: options.loadCatalog,
    convert: (opts) => {
      calls.push(opts);
      return convert(opts);
    },
  };

  return { root, cwd, homeDir, calls, deps };
}

function writeText(path: string, text = "{}\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function writeClaudeSession(
  homeDir: string,
  projectPath: string,
  sessionId: string,
  titles: readonly string[],
  startedAt = "2026-01-01T00:00:00.000Z",
): string {
  const bucket = encodeClaudeProject(projectPath);
  const path = join(
    homeDir,
    ".claude",
    "projects",
    bucket,
    `${sessionId}.jsonl`,
  );
  const base = Date.parse(startedAt);
  const lines = titles.map((title, index) =>
    JSON.stringify({
      type: "custom-title",
      customTitle: title,
      cwd: projectPath,
      sessionId,
      timestamp: new Date(base + index * 60_000).toISOString(),
    }),
  );
  writeText(path, `${lines.join("\n")}\n`);
  return path;
}

function makeConverted(
  opts: ClaudeToPiConvertOptions,
  overrides: {
    dryRun?: boolean;
    status?: "created" | "unchanged" | "dry_run";
    warningCodes?: readonly string[];
    rootSessionId?: string;
    sourceSessionId?: string;
    manifestWarnings?: readonly string[];
  },
): ConvertedClaudeToPiConversation {
  const dryRun = overrides.dryRun ?? opts.dryRun === true;
  const status = overrides.status ?? (dryRun ? "dry_run" : "created");
  const rootSessionId = overrides.rootSessionId ?? ROOT_PI_SESSION_ID;
  const sourceSessionId = overrides.sourceSessionId ?? SOURCE_SESSION_ID;
  const manifestWarnings = [...(overrides.manifestWarnings ?? [])];
  const warningCodes = [...(overrides.warningCodes ?? [])];
  const sessionPath = join(opts.piAgentDir, "sessions", "main.jsonl");
  const manifestPath = join(opts.piAgentDir, "manifest.json");

  return {
    prepared: {
      mappingVersion: 1,
      piAgentDir: opts.piAgentDir,
      sourceMainPath: opts.claudeMainPath,
      sourceMainId: sourceSessionId,
      sourceMainDigest: SOURCE_DIGEST,
      rootPiSessionId: rootSessionId,
      manifest: {
        schemaVersion: 1,
        mappingVersion: 1,
        sourceMainId: sourceSessionId,
        sourceMainPath: opts.claudeMainPath,
        sourceMainDigest: SOURCE_DIGEST,
        rootPiSessionId: rootSessionId,
        manifestPath,
        streams: [],
        warningCodes: manifestWarnings,
      },
      manifestBytes: new Uint8Array(),
      manifestText: "",
      sourceSnapshot: {
        mainPath: opts.claudeMainPath,
        files: [],
      },
      sessions: [
        {
          sourceKey: "main",
          agentId: null,
          sourcePath: opts.claudeMainPath,
          sourceDigest: SOURCE_DIGEST,
          sourceLineCount: 1,
          piSessionId: rootSessionId,
          cwd: CWD,
          sessionTimestamp: "1970-01-01T00:00:00.000Z",
          destinationPath: "sessions/main.jsonl",
          entryCount: 1,
          warningCodes,
          parentRelation: null,
          bytes: new Uint8Array(),
          text: "",
        },
      ],
    },
    published: {
      dryRun,
      sessions: [
        {
          relativePath: "sessions/main.jsonl",
          absolutePath: sessionPath,
          status,
        },
      ],
      manifest: {
        relativePath: "manifest.json",
        absolutePath: manifestPath,
        status,
      },
    },
  } as ConvertedClaudeToPiConversation;
}

function parseJson(stdout: string): unknown {
  return JSON.parse(stdout);
}

interface ErrorEnvelopeLike {
  ok: false;
  error: {
    code: string;
    message: string;
    recovery: string;
    details?: unknown;
  };
  data: null;
  schema_version: number;
}

describe("conversation CLI", () => {
  test("help, agent-help, and verb help are pure and usage faults print help on stderr", () => {
    const helpHarness = makeHarness();
    const help = runConversationCli(["--help"], helpHarness.deps);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(
      "keeper conversation — offline Claude→Pi conversion",
    );
    expect(help.stderr).toBe("");
    expect(helpHarness.calls).toEqual([]);

    const agentHelp = runConversationCli(["--agent-help"], helpHarness.deps);
    expect(agentHelp.code).toBe(0);
    expect(agentHelp.stdout).toContain("operator runbook");
    expect(agentHelp.stderr).toBe("");
    expect(helpHarness.calls).toEqual([]);

    const verbHelp = runConversationCli(
      ["convert", "--help"],
      helpHarness.deps,
    );
    expect(verbHelp.code).toBe(0);
    expect(verbHelp.stdout).toContain(
      "keeper conversation convert --from claude --to pi",
    );
    expect(verbHelp.stderr).toBe("");
    expect(helpHarness.calls).toEqual([]);

    const usage = runConversationCli(["convert"], helpHarness.deps);
    expect(usage.code).toBe(2);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toContain(
      "keeper conversation: missing source reference",
    );
    expect(usage.stderr).toContain(
      "keeper conversation convert --from claude --to pi",
    );
    expect(helpHarness.calls).toEqual([]);
  });

  test("explicit path dry-run JSON resolves paths, writes nothing, and stays bounded", () => {
    const harness = makeHarness({ env: { PI_CODING_AGENT_DIR: "" } });
    const sourceRel = "./session.jsonl";
    const outputRel = "./pi-out";
    const sourcePath = resolve(harness.cwd, sourceRel);
    const outputDir = resolve(harness.cwd, outputRel);
    writeText(sourcePath, '{"type":"user"}\n');

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--dry-run",
        "--output-dir",
        outputRel,
        "--format",
        "json",
        "--source-path",
        sourceRel,
      ],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toEqual({
      claudeMainPath: sourcePath,
      piAgentDir: outputDir,
      dryRun: true,
    });
    expect(existsSync(outputDir)).toBe(false);

    const parsed = parseJson(result.stdout);
    expect(parsed).toEqual(
      successEnvelope(CONVERSATION_SCHEMA_VERSION, {
        source: {
          harness: "claude",
          session_id: SOURCE_SESSION_ID,
          path: sourcePath,
          sha256: SOURCE_DIGEST,
        },
        target: {
          harness: "pi",
          agent_dir: outputDir,
          root_session_id: ROOT_PI_SESSION_ID,
          manifest_path: join(outputDir, "manifest.json"),
        },
        dry_run: true,
        sessions: [
          {
            source_key: "main",
            agent_id: null,
            pi_session_id: ROOT_PI_SESSION_ID,
            cwd: CWD,
            path: join(outputDir, "sessions", "main.jsonl"),
            status: "dry_run",
            parent_relation: null,
            line_count: 1,
            entry_count: 1,
            warning_codes: [],
          },
        ],
        warning_codes: [],
      }),
    );
  });

  test("explicit path human success reports converted metadata only", () => {
    const harness = makeHarness({
      env: { PI_CODING_AGENT_DIR: "" },
      loadCatalog: () => {
        throw new Error("catalog should not load for explicit paths");
      },
    });
    const sourceRel = "./session.jsonl";
    const outputRel = "./pi-out";
    const sourcePath = resolve(harness.cwd, sourceRel);
    const outputDir = resolve(harness.cwd, outputRel);
    writeText(sourcePath, '{"type":"user"}\n');

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--output-dir",
        outputRel,
        "--source-path",
        sourceRel,
      ],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(harness.calls[0]).toEqual({
      claudeMainPath: sourcePath,
      piAgentDir: outputDir,
      dryRun: false,
    });
    expect(result.stdout).toContain(
      "keeper conversation convert: converted 1 session",
    );
    expect(result.stdout).toContain(`root pi session: ${ROOT_PI_SESSION_ID}`);
    expect(result.stdout).toContain(
      `manifest: ${join(outputDir, "manifest.json")}`,
    );
    expect(result.stdout).toContain(
      `  main: created ${join(outputDir, "sessions", "main.jsonl")}`,
    );
    expect(result.stdout).toContain("warning codes: none");
  });

  test("exact Claude ids discover via ~/.claude/projects and default the Pi agent dir", () => {
    const harness = makeHarness();
    const projectPath = "/repo/project-one";
    const sourcePath = writeClaudeSession(
      harness.homeDir,
      projectPath,
      SOURCE_SESSION_ID,
      ["First project title", "Current project title"],
    );
    const expectedSourcePath = realpathSync(sourcePath);

    const result = runConversationCli(
      ["convert", "--from", "claude", "--to", "pi", SOURCE_SESSION_ID],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toEqual({
      claudeMainPath: expectedSourcePath,
      piAgentDir: join(harness.homeDir, ".pi", "agent"),
      dryRun: false,
      expectedSourceMainId: SOURCE_SESSION_ID,
    });
    expect(result.stdout).toContain(`root pi session: ${ROOT_PI_SESSION_ID}`);
    expect(result.stdout).toContain(
      `manifest: ${join(harness.homeDir, ".pi", "agent", "manifest.json")}`,
    );
  });

  test("qualified Claude ids resolve through the shared catalog", () => {
    const harness = makeHarness();
    const projectPath = "/repo/project-qualified";
    const sourcePath = writeClaudeSession(
      harness.homeDir,
      projectPath,
      SOURCE_SESSION_ID,
      ["Qualified title", "Qualified current"],
    );
    const expectedSourcePath = realpathSync(sourcePath);

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        `claude:${SOURCE_SESSION_ID}`,
      ],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls[0]).toEqual({
      claudeMainPath: expectedSourcePath,
      piAgentDir: join(harness.homeDir, ".pi", "agent"),
      dryRun: false,
      expectedSourceMainId: SOURCE_SESSION_ID,
    });
  });

  test("current Claude titles resolve through the shared catalog", () => {
    const harness = makeHarness();
    const projectPath = "/repo/project-title-current";
    const sourcePath = writeClaudeSession(
      harness.homeDir,
      projectPath,
      SOURCE_SESSION_ID,
      ["Historical project title", "Current project title"],
    );
    const expectedSourcePath = realpathSync(sourcePath);

    const result = runConversationCli(
      ["convert", "--from", "claude", "--to", "pi", "Current project title"],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls[0]).toEqual({
      claudeMainPath: expectedSourcePath,
      piAgentDir: join(harness.homeDir, ".pi", "agent"),
      dryRun: false,
      expectedSourceMainId: SOURCE_SESSION_ID,
    });
  });

  test("historical Claude titles resolve through the shared catalog", () => {
    const harness = makeHarness();
    const projectPath = "/repo/project-title-historical";
    const sourcePath = writeClaudeSession(
      harness.homeDir,
      projectPath,
      SOURCE_SESSION_ID,
      ["Historical project title", "Current project title"],
    );
    const expectedSourcePath = realpathSync(sourcePath);

    const result = runConversationCli(
      ["convert", "--from", "claude", "--to", "pi", "Historical project title"],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls[0]).toEqual({
      claudeMainPath: expectedSourcePath,
      piAgentDir: join(harness.homeDir, ".pi", "agent"),
      dryRun: false,
      expectedSourceMainId: SOURCE_SESSION_ID,
    });
  });

  test("Claude title matching is case-insensitive", () => {
    const harness = makeHarness();
    const projectPath = "/repo/project-title-case";
    const sourcePath = writeClaudeSession(
      harness.homeDir,
      projectPath,
      SOURCE_SESSION_ID,
      ["Case Sensitive Title", "Still Current"],
    );
    const expectedSourcePath = realpathSync(sourcePath);

    const result = runConversationCli(
      ["convert", "--from", "claude", "--to", "pi", "case sensitive title"],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls[0]).toEqual({
      claudeMainPath: expectedSourcePath,
      piAgentDir: join(harness.homeDir, ".pi", "agent"),
      dryRun: false,
      expectedSourceMainId: SOURCE_SESSION_ID,
    });
  });

  test("path-looking titles still resolve through the shared Session resolver", () => {
    const harness = makeHarness();
    const sourcePath = writeClaudeSession(
      harness.homeDir,
      "/repo/project-path-title",
      SOURCE_SESSION_ID,
      ["notes/report.jsonl"],
    );

    const result = runConversationCli(
      ["convert", "--from", "claude", "--to", "pi", "notes/report.jsonl"],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls[0]?.claudeMainPath).toBe(realpathSync(sourcePath));
    expect(harness.calls[0]?.expectedSourceMainId).toBe(SOURCE_SESSION_ID);
  });

  test("project filtering disambiguates title references across Claude projects", () => {
    const harness = makeHarness();
    writeClaudeSession(
      harness.homeDir,
      "/repo/project-a",
      "project-a-session",
      ["Shared title"],
    );
    const projectB = writeClaudeSession(
      harness.homeDir,
      "/repo/project-b",
      "project-b-session",
      ["Shared title"],
    );
    const expectedSourcePath = realpathSync(projectB);

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--project",
        "/repo/project-b",
        "Shared title",
      ],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls[0]).toEqual({
      claudeMainPath: expectedSourcePath,
      piAgentDir: join(harness.homeDir, ".pi", "agent"),
      dryRun: false,
      expectedSourceMainId: "project-b-session",
    });
  });

  test("duplicate Claude titles stay ambiguous and never collapse to newest", () => {
    const harness = makeHarness();
    const oldPath = writeClaudeSession(
      harness.homeDir,
      "/repo/project-older",
      "older-session",
      ["Reusable title"],
      "2026-02-01T00:00:00.000Z",
    );
    const newerPath = writeClaudeSession(
      harness.homeDir,
      "/repo/project-newer",
      "newer-session",
      ["Reusable title"],
      "2026-01-01T00:00:00.000Z",
    );

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--format",
        "json",
        "Reusable title",
      ],
      harness.deps,
    );

    expect(result.code).toBe(1);
    const parsed = parseJson(result.stdout) as ErrorEnvelopeLike;
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("source_ambiguous");
    const details = parsed.error.details as {
      match: string;
      candidate_count: number;
      candidates_truncated: boolean;
      candidates: Array<{
        project: string | null;
        current_title: string | null;
        artifact_path: string | null;
      }>;
    };
    expect(details.match).toBe("title");
    expect(details.candidate_count).toBe(2);
    expect(details.candidates_truncated).toBe(false);
    expect(details.candidates.map((candidate) => candidate.project)).toEqual([
      "/repo/project-newer",
      "/repo/project-older",
    ]);
    expect(
      details.candidates.map((candidate) => candidate.artifact_path),
    ).toEqual([realpathSync(newerPath), realpathSync(oldPath)]);
    expect(
      details.candidates.map((candidate) => candidate.current_title),
    ).toEqual(["Reusable title", "Reusable title"]);
    expect(harness.calls).toEqual([]);
  });

  test("source roots unavailable is a retry-safe operational failure", () => {
    const harness = makeHarness();
    const result = runConversationCli(
      ["convert", "--from", "claude", "--to", "pi", SOURCE_SESSION_ID],
      harness.deps,
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "keeper conversation convert: no readable Claude project roots were found",
    );
    expect(result.stderr).toContain("recovery:");
    expect(harness.calls).toEqual([]);
  });

  test("a missing title is indeterminate when native title history is incomplete", () => {
    const harness = makeHarness({
      loadCatalog: () => ({
        sessions: [
          {
            sessionKey: "claude:other-session@fixture",
            harness: "claude",
            nativeId: "other-session",
            qualifiedNativeId: "claude:other-session",
            artifact: { path: "/repo/other-session.jsonl", bytes: 12 },
            project: "/repo/project-a",
            currentTitle: "Visible sampled title",
            titleRecords: [],
            titles: ["Visible sampled title"],
            titleHistoryComplete: false,
            jobs: [],
            startedAt: null,
            updatedAt: null,
          },
        ],
        diagnostics: [
          {
            code: "artifact_read_failed",
            harness: "claude",
            scope: "artifact",
          },
        ],
        authoritativeHarnesses: ["claude"],
      }),
    });

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--format",
        "json",
        "Missing historical title",
      ],
      harness.deps,
    );

    expect(result.code).toBe(1);
    const parsed = parseJson(result.stdout) as ErrorEnvelopeLike;
    expect(parsed.error.code).toBe("catalog_read_failed");
    expect(harness.calls).toEqual([]);
  });

  test("missing Claude ids fail without collapsing to a newest result", () => {
    const harness = makeHarness();
    mkdirSync(
      join(
        harness.homeDir,
        ".claude",
        "projects",
        encodeClaudeProject("/repo/project-a"),
      ),
      {
        recursive: true,
      },
    );

    const result = runConversationCli(
      ["convert", "--from", "claude", "--to", "pi", SOURCE_SESSION_ID],
      harness.deps,
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Session reference not found");
    expect(result.stderr).toContain("recovery:");
    expect(harness.calls).toEqual([]);
  });

  test("ambiguous Claude ids expose bounded shared ambiguity details", () => {
    const harness = makeHarness();
    const projectA = writeClaudeSession(
      harness.homeDir,
      "/repo/project-a",
      SOURCE_SESSION_ID,
      ["Project A title", "Project A current"],
    );
    const projectB = writeClaudeSession(
      harness.homeDir,
      "/repo/project-b",
      SOURCE_SESSION_ID,
      ["Project B title", "Project B current"],
    );
    const realProjectA = realpathSync(projectA);
    const realProjectB = realpathSync(projectB);

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--format",
        "json",
        SOURCE_SESSION_ID,
      ],
      harness.deps,
    );

    expect(result.code).toBe(1);
    const parsed = parseJson(result.stdout) as ErrorEnvelopeLike;
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("source_ambiguous");
    const details = parsed.error.details as {
      match: string;
      candidate_count: number;
      candidates_truncated: boolean;
      candidates: Array<{
        session_key: string;
        harness: string;
        native_id: string;
        qualified_id: string;
        project: string | null;
        current_title: string | null;
        job_ids: string[];
        job_count: number;
        job_ids_truncated: boolean;
        artifact_path: string | null;
      }>;
    };
    expect(details.match).toBe("native_id");
    expect(details.candidate_count).toBe(2);
    expect(details.candidates_truncated).toBe(false);
    expect(details.candidates).toHaveLength(2);
    expect(details.candidates.map((candidate) => candidate.project)).toEqual([
      "/repo/project-a",
      "/repo/project-b",
    ]);
    expect(
      details.candidates.map((candidate) => candidate.artifact_path),
    ).toEqual([realProjectA, realProjectB]);
    expect(
      details.candidates.every(
        (candidate) =>
          candidate.session_key.length > 0 &&
          candidate.harness === "claude" &&
          candidate.native_id === SOURCE_SESSION_ID &&
          candidate.qualified_id === `claude:${SOURCE_SESSION_ID}` &&
          candidate.job_ids.length === 0 &&
          candidate.job_count === 0 &&
          candidate.job_ids_truncated === false,
      ),
    ).toBe(true);
    expect(harness.calls).toEqual([]);
  });

  test("an explicit source path and Session reference are mutually exclusive", () => {
    const harness = makeHarness();
    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--source-path",
        "session.jsonl",
        SOURCE_SESSION_ID,
      ],
      harness.deps,
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "either one Session reference or --source-path",
    );
    expect(harness.calls).toEqual([]);
  });

  test("unsupported harness pairs are usage faults", () => {
    const harness = makeHarness();
    const result = runConversationCli(
      ["convert", "--from", "claude", "--to", "claude", SOURCE_SESSION_ID],
      harness.deps,
    );

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unsupported harness pair");
    expect(result.stderr).toContain(
      "keeper conversation convert --from claude --to pi",
    );
    expect(harness.calls).toEqual([]);
  });

  test("typed converter failures map to stable human and JSON operational contracts", () => {
    const typedHarness = makeHarness({
      convert: () => {
        throw new ConversationConversionError(
          "publish_collision",
          "destination path exists",
          { path: "/tmp/keeper-collision.jsonl" },
        );
      },
    });
    const sourcePath = join(typedHarness.cwd, "source.jsonl");
    writeText(sourcePath, '{"type":"user"}\n');

    const human = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--source-path",
        sourcePath,
      ],
      typedHarness.deps,
    );
    expect(human.code).toBe(1);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain(
      "destination path already exists with different bytes",
    );
    expect(human.stderr).toContain("recovery:");

    const jsonHarness = makeHarness({
      convert: () => {
        throw new ConversationConversionError(
          "publish_collision",
          "destination path exists",
          { path: "/tmp/keeper-collision.jsonl" },
        );
      },
    });
    writeText(join(jsonHarness.cwd, "source.jsonl"), '{"type":"user"}\n');
    const json = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--format",
        "json",
        "--source-path",
        join(jsonHarness.cwd, "source.jsonl"),
      ],
      jsonHarness.deps,
    );
    expect(json.code).toBe(1);
    const parsed = parseJson(json.stdout) as ErrorEnvelopeLike;
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("publish_collision");
    expect(parsed.error.message).not.toContain("/");
    expect(parsed.error.details).toEqual({
      path: "/tmp/keeper-collision.jsonl",
    });
  });

  test("unexpected converter exceptions collapse to conversion_failed", () => {
    const harness = makeHarness({
      convert: () => {
        throw new Error("boom: do not leak me");
      },
    });
    const sourcePath = join(harness.cwd, "source.jsonl");
    writeText(sourcePath, '{"type":"user"}\n');

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "claude",
        "--to",
        "pi",
        "--format",
        "json",
        "--source-path",
        sourcePath,
      ],
      harness.deps,
    );

    expect(result.code).toBe(1);
    const parsed = parseJson(result.stdout) as ErrorEnvelopeLike;
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("conversion_failed");
    expect(parsed.error.message).toBe("conversation conversion failed");
    expect(JSON.stringify(parsed)).not.toContain("boom: do not leak me");
  });
});
