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
import type {
  ConvertedPiToClaudeConversation,
  PiToClaudeConvertOptions,
} from "../src/conversation/pi-to-claude";
import { encodeClaudeProject } from "../src/transcript/claude";
import { encodePiCwd } from "../src/transcript/pi";

const SOURCE_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_DIGEST = "sha256:fixture";
const ROOT_PI_SESSION_ID = "pi-root-session";
const ROOT_CLAUDE_SESSION_ID = "claude-root-session";
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
    convertPiToClaude?: (
      opts: PiToClaudeConvertOptions,
    ) => ConvertedPiToClaudeConversation;
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
  const piToClaudeCalls: PiToClaudeConvertOptions[] = [];
  const convert =
    options.convert ??
    ((opts: ClaudeToPiConvertOptions) => makeConverted(opts, {}));
  const reverseConvert =
    options.convertPiToClaude ??
    ((opts: PiToClaudeConvertOptions) => makePiConverted(opts));
  const deps: ConversationCliDeps = {
    cwd,
    homeDir,
    env: { ...(options.env ?? {}) },
    loadCatalog: options.loadCatalog,
    convert: (opts) => {
      calls.push(opts);
      return convert(opts);
    },
    convertPiToClaude: (opts) => {
      piToClaudeCalls.push(opts);
      return reverseConvert(opts);
    },
  };

  return { root, cwd, homeDir, calls, piToClaudeCalls, deps };
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

function writePiSession(
  homeDir: string,
  projectPath: string,
  sessionId: string,
  titles: readonly string[],
): string {
  const path = join(
    homeDir,
    ".pi",
    "agent",
    "sessions",
    encodePiCwd(projectPath),
    `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`,
  );
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      cwd: projectPath,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
    ...titles.map((title, index) =>
      JSON.stringify({
        type: "session_info",
        id: `title${index}`,
        parentId: index === 0 ? null : `title${index - 1}`,
        timestamp: new Date(
          Date.parse("2026-01-01T00:00:00.000Z") + index * 60_000,
        ).toISOString(),
        name: title,
      }),
    ),
  ];
  writeText(path, `${lines.join("\n")}\n`);
  return path;
}

function makePiConverted(
  opts: PiToClaudeConvertOptions,
): ConvertedPiToClaudeConversation {
  const dryRun = opts.dryRun === true;
  const status = dryRun ? "dry_run" : "created";
  const sessionPath = join(
    opts.claudeConfigDir,
    "projects",
    "-repo-project",
    `${ROOT_CLAUDE_SESSION_ID}.jsonl`,
  );
  const manifestPath = join(
    opts.claudeConfigDir,
    "conversation-imports",
    "pi-to-claude",
    `${ROOT_CLAUDE_SESSION_ID}.json`,
  );
  return {
    prepared: {
      mappingVersion: 1,
      claudeConfigDir: opts.claudeConfigDir,
      sourceMainPath: opts.piSessionPath,
      sourceMainId: SOURCE_SESSION_ID,
      sourceMainDigest: SOURCE_DIGEST,
      rootClaudeSessionId: ROOT_CLAUDE_SESSION_ID,
      manifest: {
        schemaVersion: 1,
        mappingVersion: 1,
        sourceSessionId: SOURCE_SESSION_ID,
        sourcePath: opts.piSessionPath,
        sourceDigest: SOURCE_DIGEST,
        sourceLineCount: 1,
        sourceCwd: CWD,
        targetSessionId: ROOT_CLAUDE_SESSION_ID,
        destinationPath: "projects/-repo-project/session.jsonl",
        manifestPath: "conversation-imports/pi-to-claude/manifest.json",
        linkedRecordCount: 1,
        rawRecordCount: 1,
        warningCodes: [],
      },
      manifestBytes: new Uint8Array(),
      manifestText: "",
      sourceSnapshot: {
        path: opts.piSessionPath,
        identity: {
          dev: 0,
          ino: 0,
          size: 0,
          mtimeMs: 0,
          ctimeMs: 0,
        },
        byteLength: 0,
      },
      sessions: [
        {
          sourceKey: "main",
          agentId: null,
          sourcePath: opts.piSessionPath,
          sourceDigest: SOURCE_DIGEST,
          sourceLineCount: 1,
          claudeSessionId: ROOT_CLAUDE_SESSION_ID,
          cwd: CWD,
          sessionTimestamp: "1970-01-01T00:00:00.000Z",
          destinationPath: "projects/-repo-project/session.jsonl",
          entryCount: 2,
          linkedRecordCount: 1,
          rawRecordCount: 1,
          warningCodes: [],
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
          relativePath: "projects/-repo-project/session.jsonl",
          absolutePath: sessionPath,
          status,
        },
      ],
      manifest: {
        relativePath: "conversation-imports/pi-to-claude/manifest.json",
        absolutePath: manifestPath,
        status,
      },
    },
  };
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
      "keeper conversation — offline native Session conversion",
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

  test("explicit Pi paths dry-run to the default Claude config root", () => {
    const harness = makeHarness();
    const sourcePath = join(harness.cwd, "pi-session.jsonl");
    writeText(sourcePath, "{}\n");

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "pi",
        "--to",
        "claude",
        "--source-path",
        sourcePath,
        "--dry-run",
        "--format",
        "json",
      ],
      harness.deps,
    );

    expect(result.code).toBe(0);
    expect(harness.calls).toEqual([]);
    expect(harness.piToClaudeCalls).toEqual([
      {
        piSessionPath: sourcePath,
        claudeConfigDir: join(harness.homeDir, ".claude"),
        dryRun: true,
      },
    ]);
    const parsed = parseJson(result.stdout) as {
      ok: true;
      data: {
        source: { harness: string };
        target: {
          harness: string;
          config_dir: string;
          root_session_id: string;
        };
        sessions: Array<{ claude_session_id: string; status: string }>;
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.source.harness).toBe("pi");
    expect(parsed.data.target).toEqual(
      expect.objectContaining({
        harness: "claude",
        config_dir: join(harness.homeDir, ".claude"),
        root_session_id: ROOT_CLAUDE_SESSION_ID,
      }),
    );
    expect(parsed.data.sessions[0]).toEqual(
      expect.objectContaining({
        claude_session_id: ROOT_CLAUDE_SESSION_ID,
        status: "dry_run",
      }),
    );
  });

  test("Pi native ids and historical titles resolve through the shared catalog", () => {
    for (const reference of [SOURCE_SESSION_ID, "Historical Pi title"]) {
      const harness = makeHarness();
      const sourcePath = writePiSession(
        harness.homeDir,
        CWD,
        SOURCE_SESSION_ID,
        ["Historical Pi title", "Current Pi title"],
      );
      const outputDir = join(harness.cwd, "claude-output");

      const result = runConversationCli(
        [
          "convert",
          "--from",
          "pi",
          "--to",
          "claude",
          "--output-dir",
          outputDir,
          reference,
        ],
        harness.deps,
      );

      expect(result.code).toBe(0);
      expect(harness.piToClaudeCalls).toEqual([
        {
          piSessionPath: realpathSync(sourcePath),
          claudeConfigDir: outputDir,
          dryRun: false,
          expectedSourceSessionId: SOURCE_SESSION_ID,
        },
      ]);
      expect(result.stdout).toContain(
        `root claude session: ${ROOT_CLAUDE_SESSION_ID}`,
      );
    }
  });

  test("Pi title ambiguity is preserved and --project filters before resolution", () => {
    const harness = makeHarness();
    writePiSession(harness.homeDir, "/repo/pi-a", "pi-a", ["Shared Pi"]);
    const selected = writePiSession(harness.homeDir, "/repo/pi-b", "pi-b", [
      "Shared Pi",
    ]);

    const ambiguous = runConversationCli(
      [
        "convert",
        "--from",
        "pi",
        "--to",
        "claude",
        "--format",
        "json",
        "Shared Pi",
      ],
      harness.deps,
    );
    expect(ambiguous.code).toBe(1);
    expect((parseJson(ambiguous.stdout) as ErrorEnvelopeLike).error.code).toBe(
      "source_ambiguous",
    );
    expect(harness.piToClaudeCalls).toEqual([]);

    const filtered = runConversationCli(
      [
        "convert",
        "--from",
        "pi",
        "--to",
        "claude",
        "--project",
        "/repo/pi-b",
        "Shared Pi",
      ],
      harness.deps,
    );
    expect(filtered.code).toBe(0);
    expect(harness.piToClaudeCalls[0]).toEqual({
      piSessionPath: realpathSync(selected),
      claudeConfigDir: join(harness.homeDir, ".claude"),
      dryRun: false,
      expectedSourceSessionId: "pi-b",
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

  test("a title match is still indeterminate when another title history is incomplete", () => {
    const catalogSession = (
      nativeId: string,
      titles: string[],
      complete: boolean,
    ) => ({
      sessionKey: `pi:${nativeId}@fixture`,
      harness: "pi" as const,
      nativeId,
      qualifiedNativeId: `pi:${nativeId}`,
      artifact: { path: `/repo/${nativeId}.jsonl`, bytes: 12 },
      project: "/repo/project-a",
      currentTitle: titles.at(-1) ?? null,
      titleRecords: titles.map((title, ordinal) => ({
        title,
        source: "native" as const,
        current: ordinal === titles.length - 1,
        jobId: null,
        ordinal,
      })),
      titles,
      titleHistoryComplete: complete,
      jobs: [],
      startedAt: null,
      updatedAt: null,
    });
    const harness = makeHarness({
      loadCatalog: () => ({
        sessions: [
          catalogSession("matching", ["Requested title"], true),
          catalogSession("incomplete", ["Visible title"], false),
        ],
        diagnostics: [
          {
            code: "artifact_read_failed",
            harness: "pi",
            scope: "artifact",
          },
        ],
        authoritativeHarnesses: ["pi"],
      }),
    });

    const result = runConversationCli(
      [
        "convert",
        "--from",
        "pi",
        "--to",
        "claude",
        "--format",
        "json",
        "Requested title",
      ],
      harness.deps,
    );

    expect(result.code).toBe(1);
    expect((parseJson(result.stdout) as ErrorEnvelopeLike).error.code).toBe(
      "catalog_read_failed",
    );
    expect(harness.piToClaudeCalls).toEqual([]);
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

  test("Pi sources reject Claude-only --config-dir", () => {
    const harness = makeHarness();
    const result = runConversationCli(
      [
        "convert",
        "--from",
        "pi",
        "--to",
        "claude",
        "--config-dir",
        "/tmp/claude-source",
        SOURCE_SESSION_ID,
      ],
      harness.deps,
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(
      "--config-dir applies only when Claude is the source harness",
    );
    expect(harness.piToClaudeCalls).toEqual([]);
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
