#!/usr/bin/env bun

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type ClaudeToPiConvertOptions,
  type ConversationConversionError,
  type ConvertedClaudeToPiConversation,
  convertClaudeToPi,
} from "../src/conversation/claude-to-pi";
import {
  type ConvertedPiToClaudeConversation,
  convertPiToClaude,
  type PiToClaudeConvertOptions,
} from "../src/conversation/pi-to-claude";
import {
  DEFAULT_HISTORY_CATALOG_ADAPTERS,
  discoverSessionCatalog,
} from "../src/history/catalog";
import type { SessionCatalog } from "../src/history/model";
import {
  resolveSessionReference,
  sessionAmbiguityDetails,
} from "../src/history/resolver";
import type { TranscriptRootInputs } from "../src/transcript/reader";
import { parseOptions } from "./descriptor";
import { errorEnvelope, type ProblemError, successEnvelope } from "./envelope";

export const CONVERSATION_SCHEMA_VERSION = 1;

export interface ConversationCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ConversationCliDeps {
  cwd: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  loadCatalog?: (
    root: TranscriptRootInputs,
    harness?: "claude" | "pi",
  ) => SessionCatalog;
  convert: (
    options: ClaudeToPiConvertOptions,
  ) => ConvertedClaudeToPiConversation;
  convertPiToClaude?: (
    options: PiToClaudeConvertOptions,
  ) => ConvertedPiToClaudeConversation;
}

const TOP_HELP = `keeper conversation — offline native Session conversion

Usage:
  keeper conversation convert --from claude --to pi <session-reference> [options]
  keeper conversation convert --from pi --to claude <session-reference> [options]
  keeper conversation convert --from <harness> --to <harness> --source-path <session.jsonl> [options]

Convert native Claude and Pi Session files without a live harness. The command is
filesystem-only: no Keeper DB, socket, daemon, subprocess, network, or wall
clock.

Run \`keeper conversation convert --help\` for the conversion flags.
Run \`keeper conversation --agent-help\` for the terse operator runbook.
`;

const AGENT_HELP = `keeper conversation operator runbook

1. Choose \`--from claude --to pi\` or \`--from pi --to claude\`.
2. Pass one exact Session reference, or use --source-path for an artifact.
3. Use --project only when a Session reference is ambiguous across projects.
4. Start with --dry-run to validate and inspect the planned target paths.
5. Re-run without --dry-run once the paths and destination look right.
6. Use --format json when another agent should parse the result.

Session references resolve by exact bare or harness-qualified native id, exact
current title, or exact historical title; title matching is case-insensitive.
The conversion is retry-safe when the source file and output directory stay
stable; a collision or read failure never prints transcript content.
`;

const CONVERT_HELP = `keeper conversation convert --from claude --to pi <session-reference> [options]
keeper conversation convert --from pi --to claude <session-reference> [options]
keeper conversation convert --from <harness> --to <harness> --source-path <session.jsonl> [options]

Convert one native Session into the other harness's native format. The command
is filesystem-only: no Keeper DB, socket, daemon, subprocess, network, or wall
clock.

Required options:
  --from <harness>       Source harness: claude|pi
  --to <harness>         Target harness: pi|claude (must differ from --from)

Source resolution:
  <session-reference>    Exact native id, harness-qualified id, exact current
                         title, or exact historical title (case-insensitive)
  --source-path <file>   Explicit source JSONL path instead of a Session reference
  --project <path>       Filters the source catalog before reference resolution
  --config-dir <dir>     Claude source config directory (repeatable; Claude→Pi only)

Output and rendering:
  --output-dir <dir>     Target root: Pi AGENT dir or Claude config dir
  --dry-run              Prepare and validate without writing destination files
  --format human|json    Output format (default human)
  --json                 Alias of --format json

Defaults: Claude→Pi writes to $PI_CODING_AGENT_DIR or ~/.pi/agent. Pi→Claude
writes to ~/.claude. Human and JSON output contain bounded metadata only.

Flags:
  --help, -h             Show this help
  --agent-help           Show the terse operator runbook
`;

function defaultLoadCatalog(
  root: TranscriptRootInputs,
  harness: "claude" | "pi" = "claude",
): SessionCatalog {
  const adapters = DEFAULT_HISTORY_CATALOG_ADAPTERS.filter(
    (adapter) => adapter.harness === harness,
  );
  return discoverSessionCatalog({
    root,
    jobs: [],
    adapters,
    completeTitleHistory: true,
  });
}

function defaultDeps(): ConversationCliDeps {
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    env: process.env,
    loadCatalog: defaultLoadCatalog,
    convert: convertClaudeToPi,
    convertPiToClaude,
  };
}

function ok(stdout: string): ConversationCliResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(code: number, stderr: string): ConversationCliResult {
  return { code, stdout: "", stderr };
}

function usage(help: string, message: string): ConversationCliResult {
  return fail(2, `keeper conversation: ${message}\n\n${help}`);
}

function escapeLeadingTilde(raw: string, homeDir: string): string {
  if (!raw.startsWith("~")) return raw;
  if (raw === "~") return homeDir;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return join(homeDir, raw.slice(2));
  }
  return join(homeDir, raw.slice(1));
}

function resolvePath(raw: string, deps: ConversationCliDeps): string {
  return resolve(deps.cwd, escapeLeadingTilde(raw, deps.homeDir));
}

function resolveMaybePath(
  raw: string | undefined,
  deps: ConversationCliDeps,
): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return resolvePath(trimmed, deps);
}

function normalizeConfigDirs(
  raw: unknown,
  deps: ConversationCliDeps,
): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((dir) => resolvePath(String(dir), deps));
}

type ConversationFormat = "human" | "json";

function resolveConversationFormat(values: {
  format?: string;
  json?: boolean;
}): { ok: true; format: ConversationFormat } | { ok: false; message: string } {
  const rawFormat = typeof values.format === "string" ? values.format : null;
  const jsonAlias = values.json === true;

  if (rawFormat !== null && jsonAlias && rawFormat !== "json") {
    return {
      ok: false,
      message:
        `--json is an alias of --format json and conflicts with ` +
        `--format ${rawFormat}; pass only one`,
    };
  }

  const requested = rawFormat ?? (jsonAlias ? "json" : "human");
  if (requested !== "human" && requested !== "json") {
    return {
      ok: false,
      message: `Invalid value for '--format': '${requested}' is not one of 'human', 'json'`,
    };
  }
  return { ok: true, format: requested };
}

function problemRecovery(code: string, sourceHarness: "claude" | "pi"): string {
  switch (code) {
    case "source_roots_unavailable":
      return sourceHarness === "pi"
        ? "Make the Pi sessions directory readable, set PI_CODING_AGENT_DIR, or use --source-path <session.jsonl>, then retry."
        : "Make the Claude config directories readable, pass --config-dir, or use --source-path <main.jsonl>, then retry.";
    case "catalog_read_failed":
      return sourceHarness === "pi"
        ? "Make the Pi session artifacts readable, or use --source-path <session.jsonl>, then retry."
        : "Make the Claude project roots readable, pass --config-dir, or use --source-path <main.jsonl>, then retry.";
    case "source_not_found":
      return "Verify the Session reference or use --source-path <session.jsonl>, then retry.";
    case "source_ambiguous":
      return "Pass --project to disambiguate the Session reference, or use --source-path <session.jsonl>, then retry.";
    case "invalid_argument":
      return "Fix the conversion arguments and retry.";
    case "source_not_regular":
      return `Point at a regular ${sourceHarness === "pi" ? "Pi" : "Claude"} .jsonl file, then retry.`;
    case "source_read_failed":
      return "Check the source path and retry; this conversion is read-only until publish time.";
    case "source_decode_failed":
      return `Repair or re-export the ${sourceHarness === "pi" ? "Pi" : "Claude"} Session as UTF-8 JSONL, then retry.`;
    case "source_missing_final_lf":
      return "Rewrite the source file with a trailing newline, then retry.";
    case "source_changed_during_read":
      return "Stop writes to the source file, then retry.";
    case "source_too_large":
      return "Split or trim the source transcript, then retry.";
    case "validation_failed":
      return "Fix the malformed transcript data and retry.";
    case "publish_collision":
      return "Choose a different output dir or remove the conflicting artifact, then retry.";
    case "publish_failed":
      return "Check write permissions and free space in the output dir, then retry.";
    default:
      return "Retry; if it keeps failing, file a bug.";
  }
}

function sanitizeProblem(
  code: string,
  details: Record<string, unknown> | undefined,
): ProblemError {
  const sourceHarness = details?.source_harness === "pi" ? "pi" : "claude";
  return {
    code,
    message:
      code === "source_roots_unavailable"
        ? `no readable ${sourceHarness === "pi" ? "Pi session" : "Claude project"} roots were found`
        : code === "catalog_read_failed"
          ? `failed to read the ${sourceHarness === "pi" ? "Pi" : "Claude"} session catalog`
          : code === "source_not_found"
            ? "Session reference not found"
            : code === "source_ambiguous"
              ? "multiple Session references matched the requested reference"
              : code === "conversion_failed"
                ? "conversation conversion failed"
                : code === "publish_collision"
                  ? "destination path already exists with different bytes"
                  : code === "publish_failed"
                    ? `failed to publish the converted ${sourceHarness === "pi" ? "Claude" : "Pi"} artifacts`
                    : code === "invalid_argument"
                      ? "invalid conversion arguments"
                      : code === "source_not_regular"
                        ? "source path must be a regular file"
                        : code === "source_read_failed"
                          ? "failed to read the source transcript"
                          : code === "source_decode_failed"
                            ? "source transcript contains invalid UTF-8"
                            : code === "source_missing_final_lf"
                              ? "source transcript must end with a trailing newline"
                              : code === "source_changed_during_read"
                                ? "source transcript changed during read"
                                : code === "source_too_large"
                                  ? "source transcript exceeds the supported size"
                                  : code === "validation_failed"
                                    ? "source transcript failed validation"
                                    : "conversation conversion failed",
    recovery: problemRecovery(code, sourceHarness),
    ...(details !== undefined ? { details } : {}),
  };
}

function successData(conversion: ConvertedClaudeToPiConversation) {
  const prepared = conversion.prepared;
  const published = conversion.published;
  const sessionWarningCodes = prepared.sessions.flatMap((session) =>
    session.warningCodes.map((code) => code),
  );
  const warningCodes = Array.from(
    new Set([...prepared.manifest.warningCodes, ...sessionWarningCodes]),
  ).sort();
  const artifactsByPath = new Map(
    published.sessions.map((artifact) => [artifact.relativePath, artifact]),
  );

  return {
    source: {
      harness: "claude" as const,
      session_id: prepared.sourceMainId,
      path: prepared.sourceMainPath,
      sha256: prepared.sourceMainDigest,
    },
    target: {
      harness: "pi" as const,
      agent_dir: prepared.piAgentDir,
      root_session_id: prepared.rootPiSessionId,
      manifest_path: published.manifest.absolutePath,
    },
    dry_run: published.dryRun,
    sessions: prepared.sessions.map((session) => {
      const artifact = artifactsByPath.get(session.destinationPath);
      if (artifact === undefined) {
        throw new Error("published session artifact is missing");
      }
      return {
        source_key: session.sourceKey,
        agent_id: session.agentId,
        pi_session_id: session.piSessionId,
        cwd: session.cwd,
        path: artifact.absolutePath,
        status: artifact.status,
        parent_relation:
          session.parentRelation === null
            ? null
            : {
                parent_source_key: session.parentRelation.parentSourceKey,
                parent_pi_session_id: session.parentRelation.parentPiSessionId,
                tool_call_id: session.parentRelation.toolCallId,
              },
        line_count: session.sourceLineCount,
        entry_count: session.entryCount,
        warning_codes: [...session.warningCodes],
      };
    }),
    warning_codes: warningCodes,
  };
}

function renderHumanSuccess(
  conversion: ConvertedClaudeToPiConversation,
): string {
  const prepared = conversion.prepared;
  const published = conversion.published;
  const data = successData(conversion);
  const prefix = published.dryRun ? "dry-run prepared" : "converted";
  const sessionCount = data.sessions.length;
  const lines = [
    `keeper conversation convert: ${prefix} ${sessionCount} session${sessionCount === 1 ? "" : "s"}`,
    `root pi session: ${data.target.root_session_id}`,
    `agent dir: ${data.target.agent_dir}`,
    `manifest: ${data.target.manifest_path}`,
    `source: ${data.source.path}`,
    `sessions (${sessionCount}):`,
  ];

  for (const session of data.sessions) {
    lines.push(`  ${session.source_key}: ${session.status} ${session.path}`);
    if (session.parent_relation !== null) {
      lines.push(
        `    parent: ${session.parent_relation.parent_source_key} -> ${session.parent_relation.parent_pi_session_id} via ${session.parent_relation.tool_call_id}`,
      );
    }
    lines.push(
      `    cwd: ${session.cwd}; lines: ${session.line_count}; entries: ${session.entry_count}`,
    );
  }

  lines.push(
    `warning codes: ${data.warning_codes.length === 0 ? "none" : data.warning_codes.join(", ")}`,
  );
  if (prepared.manifest.warningCodes.length > 0) {
    lines.push(
      `manifest warnings: ${prepared.manifest.warningCodes.join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderJsonSuccess(
  conversion: ConvertedClaudeToPiConversation,
): string {
  return `${JSON.stringify(successEnvelope(CONVERSATION_SCHEMA_VERSION, successData(conversion)), null, 2)}\n`;
}

function piToClaudeSuccessData(conversion: ConvertedPiToClaudeConversation) {
  const prepared = conversion.prepared;
  const published = conversion.published;
  const artifactsByPath = new Map(
    published.sessions.map((artifact) => [artifact.relativePath, artifact]),
  );
  const warningCodes = Array.from(
    new Set(prepared.sessions.flatMap((session) => [...session.warningCodes])),
  ).sort();
  return {
    source: {
      harness: "pi" as const,
      session_id: prepared.sourceMainId,
      path: prepared.sourceMainPath,
      sha256: prepared.sourceMainDigest,
    },
    target: {
      harness: "claude" as const,
      config_dir: prepared.claudeConfigDir,
      root_session_id: prepared.rootClaudeSessionId,
      manifest_path: published.manifest.absolutePath,
    },
    dry_run: published.dryRun,
    sessions: prepared.sessions.map((session) => {
      const artifact = artifactsByPath.get(session.destinationPath);
      if (artifact === undefined) {
        throw new Error("published session artifact is missing");
      }
      return {
        source_key: session.sourceKey,
        agent_id: session.agentId,
        claude_session_id: session.claudeSessionId,
        cwd: session.cwd,
        path: artifact.absolutePath,
        status: artifact.status,
        parent_relation: null,
        line_count: session.sourceLineCount,
        entry_count: session.entryCount,
        warning_codes: [...session.warningCodes],
      };
    }),
    warning_codes: warningCodes,
  };
}

function renderPiToClaudeHumanSuccess(
  conversion: ConvertedPiToClaudeConversation,
): string {
  const data = piToClaudeSuccessData(conversion);
  const prefix = data.dry_run ? "dry-run prepared" : "converted";
  const lines = [
    `keeper conversation convert: ${prefix} ${data.sessions.length} session${data.sessions.length === 1 ? "" : "s"}`,
    `root claude session: ${data.target.root_session_id}`,
    `config dir: ${data.target.config_dir}`,
    `manifest: ${data.target.manifest_path}`,
    `source: ${data.source.path}`,
    `sessions (${data.sessions.length}):`,
  ];
  for (const session of data.sessions) {
    lines.push(`  ${session.source_key}: ${session.status} ${session.path}`);
    lines.push(
      `    cwd: ${session.cwd}; lines: ${session.line_count}; entries: ${session.entry_count}`,
    );
  }
  lines.push(
    `warning codes: ${data.warning_codes.length === 0 ? "none" : data.warning_codes.join(", ")}`,
  );
  return `${lines.join("\n")}\n`;
}

function renderPiToClaudeJsonSuccess(
  conversion: ConvertedPiToClaudeConversation,
): string {
  return `${JSON.stringify(successEnvelope(CONVERSATION_SCHEMA_VERSION, piToClaudeSuccessData(conversion)), null, 2)}\n`;
}

function renderHumanFailure(problem: ProblemError): string {
  const lines = [`keeper conversation convert: ${problem.message}`];
  if (problem.details !== undefined && problem.code === "source_ambiguous") {
    const details = problem.details as {
      candidates?: readonly {
        artifact_path?: string | null;
        qualified_id?: string | null;
        native_id?: string | null;
      }[];
    };
    if (Array.isArray(details.candidates) && details.candidates.length > 0) {
      lines.push("details:");
      for (const candidate of details.candidates) {
        lines.push(
          `  ${candidate.artifact_path ?? candidate.qualified_id ?? candidate.native_id ?? "(unknown)"}`,
        );
      }
    }
  }
  lines.push(`recovery: ${problem.recovery}`);
  return `${lines.join("\n")}\n`;
}

function renderJsonFailure(problem: ProblemError): string {
  return `${JSON.stringify(errorEnvelope(CONVERSATION_SCHEMA_VERSION, problem), null, 2)}\n`;
}

function operationalFailure(
  problem: ProblemError,
  format: ConversationFormat,
): ConversationCliResult {
  return format === "json"
    ? { code: 1, stdout: renderJsonFailure(problem), stderr: "" }
    : fail(1, renderHumanFailure(problem));
}

function catalogLoadProblem(
  format: ConversationFormat,
  harness: "claude" | "pi" = "claude",
): ConversationCliResult {
  return operationalFailure(
    sanitizeProblem(
      "catalog_read_failed",
      harness === "pi" ? { source_harness: "pi" } : undefined,
    ),
    format,
  );
}

function filterCatalogByProject(
  catalog: SessionCatalog,
  project: string | null,
): SessionCatalog {
  if (project === null) return catalog;
  return {
    ...catalog,
    sessions: catalog.sessions.filter((session) => session.project === project),
  };
}

function catalogHasReadFailure(catalog: SessionCatalog): boolean {
  return catalog.diagnostics.some(
    (diagnostic) => diagnostic.code === "root_read_failed",
  );
}

function catalogRootsUnavailable(
  catalog: SessionCatalog,
  harness: "claude" | "pi",
): boolean {
  return (
    !catalog.authoritativeHarnesses.includes(harness) &&
    catalog.diagnostics.some(
      (diagnostic) => diagnostic.code === "root_unavailable",
    )
  );
}

function catalogHasIncompleteTitleHistory(catalog: SessionCatalog): boolean {
  return catalog.sessions.some((session) => !session.titleHistoryComplete);
}

function converterFailure(
  error: unknown,
  format: ConversationFormat,
  sourceHarness: "claude" | "pi" = "claude",
): ConversationCliResult {
  if (error && typeof error === "object" && "code" in error) {
    const typed = error as ConversationConversionError & {
      details?: Record<string, unknown>;
    };
    const details =
      typed.path !== null && typed.path !== undefined
        ? {
            path: typed.path,
            ...(sourceHarness === "pi" ? { source_harness: "pi" } : {}),
          }
        : sourceHarness === "pi"
          ? { source_harness: "pi" }
          : undefined;
    return operationalFailure(sanitizeProblem(typed.code, details), format);
  }
  return operationalFailure(
    sanitizeProblem("conversion_failed", undefined),
    format,
  );
}

function runPiToClaudeConvert(
  options: {
    readonly sourceToken: string | undefined;
    readonly explicitSource: string | undefined;
    readonly project: string | null;
    readonly outputDir: string;
    readonly dryRun: boolean;
    readonly format: ConversationFormat;
  },
  deps: ConversationCliDeps,
): ConversationCliResult {
  let sourcePath: string;
  let expectedSourceSessionId: string | undefined;
  if (options.explicitSource !== undefined) {
    sourcePath = resolvePath(options.explicitSource, deps);
  } else {
    const loadCatalog = deps.loadCatalog ?? defaultLoadCatalog;
    let catalog: SessionCatalog;
    try {
      catalog = loadCatalog({ homeDir: deps.homeDir, env: deps.env }, "pi");
    } catch {
      return catalogLoadProblem(options.format, "pi");
    }
    if (catalogHasReadFailure(catalog)) {
      return catalogLoadProblem(options.format, "pi");
    }
    if (catalogRootsUnavailable(catalog, "pi")) {
      return operationalFailure(
        sanitizeProblem("source_roots_unavailable", {
          home_dir: deps.homeDir,
          source_harness: "pi",
        }),
        options.format,
      );
    }
    const resolvedCatalog = filterCatalogByProject(
      {
        ...catalog,
        sessions: catalog.sessions.filter(
          (session) => session.harness === "pi",
        ),
      },
      options.project,
    );
    const resolution = resolveSessionReference(
      resolvedCatalog,
      options.sourceToken as string,
    );
    if (resolution.kind === "not_found") {
      if (catalogHasIncompleteTitleHistory(resolvedCatalog)) {
        return catalogLoadProblem(options.format, "pi");
      }
      return operationalFailure(
        sanitizeProblem("source_not_found", undefined),
        options.format,
      );
    }
    if (
      resolution.match === "title" &&
      catalogHasIncompleteTitleHistory(resolvedCatalog)
    ) {
      return catalogLoadProblem(options.format, "pi");
    }
    if (resolution.kind === "ambiguous") {
      return operationalFailure(
        sanitizeProblem("source_ambiguous", {
          ...sessionAmbiguityDetails(resolution.match, resolution.candidates),
        }),
        options.format,
      );
    }
    if (resolution.session.artifact === null) {
      return catalogLoadProblem(options.format, "pi");
    }
    sourcePath = resolution.session.artifact.path;
    expectedSourceSessionId = resolution.session.nativeId;
  }

  try {
    const conversion = (deps.convertPiToClaude ?? convertPiToClaude)({
      piSessionPath: sourcePath,
      claudeConfigDir: options.outputDir,
      dryRun: options.dryRun,
      ...(expectedSourceSessionId !== undefined
        ? { expectedSourceSessionId }
        : {}),
    });
    return ok(
      options.format === "json"
        ? renderPiToClaudeJsonSuccess(conversion)
        : renderPiToClaudeHumanSuccess(conversion),
    );
  } catch (error) {
    return converterFailure(error, options.format, "pi");
  }
}

function runConvert(
  argv: string[],
  deps: ConversationCliDeps,
): ConversationCliResult {
  if (argv.includes("--help") || argv.includes("-h")) {
    return ok(CONVERT_HELP);
  }
  if (argv.includes("--agent-help")) {
    return ok(AGENT_HELP);
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: parseOptions("conversation", "convert"),
      allowPositionals: true,
    });
  } catch (error) {
    return usage(
      CONVERT_HELP,
      error instanceof Error ? error.message : "invalid conversion options",
    );
  }

  const values = parsed.values as {
    help?: boolean;
    "agent-help"?: boolean;
    from?: string;
    to?: string;
    project?: string;
    "source-path"?: string;
    "config-dir"?: string[];
    "output-dir"?: string;
    "dry-run"?: boolean;
    format?: string;
    json?: boolean;
  };

  if (values.help === true) return ok(CONVERT_HELP);
  if (values["agent-help"] === true) return ok(AGENT_HELP);

  const format = resolveConversationFormat(values);
  if (!format.ok) {
    return usage(CONVERT_HELP, format.message);
  }

  const positionals = parsed.positionals;
  const explicitSource = values["source-path"];
  if (explicitSource === undefined && positionals.length === 0) {
    return usage(CONVERT_HELP, "missing source reference or --source-path");
  }
  if (explicitSource !== undefined && positionals.length > 0) {
    return usage(
      CONVERT_HELP,
      "pass either one Session reference or --source-path, not both",
    );
  }
  if (positionals.length > 1) {
    return usage(
      CONVERT_HELP,
      `unexpected extra arguments: ${positionals.slice(1).join(" ")}`,
    );
  }

  const sourceToken = positionals[0];
  const from = values.from;
  const to = values.to;
  if (from === undefined) {
    return usage(CONVERT_HELP, "missing required --from");
  }
  if (to === undefined) {
    return usage(CONVERT_HELP, "missing required --to");
  }
  const claudeToPi = from === "claude" && to === "pi";
  const piToClaude = from === "pi" && to === "claude";
  if (!claudeToPi && !piToClaude) {
    return usage(
      CONVERT_HELP,
      `unsupported harness pair --from ${from} --to ${to}; expected claude -> pi or pi -> claude`,
    );
  }

  const project = resolveMaybePath(values.project, deps);
  if (explicitSource !== undefined && project !== null) {
    return usage(
      CONVERT_HELP,
      "--project is only used when resolving a Session reference",
    );
  }

  const configDirs = normalizeConfigDirs(values["config-dir"], deps);
  const dryRun = values["dry-run"] === true;
  if (piToClaude) {
    if (configDirs !== undefined) {
      return usage(
        CONVERT_HELP,
        "--config-dir applies only when Claude is the source harness",
      );
    }
    const outputDir =
      resolveMaybePath(values["output-dir"], deps) ??
      join(deps.homeDir, ".claude");
    return runPiToClaudeConvert(
      {
        sourceToken,
        explicitSource,
        project,
        outputDir,
        dryRun,
        format: format.format,
      },
      deps,
    );
  }

  const outputDir =
    resolveMaybePath(values["output-dir"], deps) ??
    (typeof deps.env.PI_CODING_AGENT_DIR === "string" &&
    deps.env.PI_CODING_AGENT_DIR.length > 0
      ? resolvePath(deps.env.PI_CODING_AGENT_DIR, deps)
      : join(deps.homeDir, ".pi", "agent"));

  let sourcePath: string;
  let expectedSourceMainId: string | undefined;
  if (explicitSource !== undefined) {
    sourcePath = resolvePath(explicitSource, deps);
  } else {
    const loadCatalog = deps.loadCatalog ?? defaultLoadCatalog;
    let catalog: SessionCatalog;
    try {
      catalog = loadCatalog({
        homeDir: deps.homeDir,
        env: deps.env,
        ...(configDirs !== undefined ? { configDirs } : {}),
      });
    } catch {
      return catalogLoadProblem(format.format);
    }
    if (catalogHasReadFailure(catalog)) {
      return catalogLoadProblem(format.format);
    }
    if (catalogRootsUnavailable(catalog, "claude")) {
      const problem = sanitizeProblem("source_roots_unavailable", {
        home_dir: deps.homeDir,
        ...(configDirs !== undefined ? { config_dirs: configDirs } : {}),
      });
      return operationalFailure(problem, format.format);
    }
    const resolvedCatalog = filterCatalogByProject(
      {
        ...catalog,
        sessions: catalog.sessions.filter(
          (session) => session.harness === "claude",
        ),
      },
      project,
    );
    const resolution = resolveSessionReference(
      resolvedCatalog,
      sourceToken as string,
    );
    if (resolution.kind === "not_found") {
      if (catalogHasIncompleteTitleHistory(resolvedCatalog)) {
        return catalogLoadProblem(format.format);
      }
      return operationalFailure(
        sanitizeProblem("source_not_found", undefined),
        format.format,
      );
    }
    if (
      resolution.match === "title" &&
      catalogHasIncompleteTitleHistory(resolvedCatalog)
    ) {
      return catalogLoadProblem(format.format);
    }
    if (resolution.kind === "ambiguous") {
      return operationalFailure(
        sanitizeProblem("source_ambiguous", {
          ...sessionAmbiguityDetails(resolution.match, resolution.candidates),
        }),
        format.format,
      );
    }
    if (resolution.session.artifact === null) {
      return catalogLoadProblem(format.format);
    }
    sourcePath = resolution.session.artifact.path;
    expectedSourceMainId = resolution.session.nativeId;
  }

  try {
    const conversion = deps.convert({
      claudeMainPath: sourcePath,
      piAgentDir: outputDir,
      dryRun,
      ...(expectedSourceMainId !== undefined ? { expectedSourceMainId } : {}),
    });
    return ok(
      format.format === "json"
        ? renderJsonSuccess(conversion)
        : renderHumanSuccess(conversion),
    );
  } catch (error) {
    return converterFailure(error, format.format);
  }
}

export function runConversationCli(
  argv: string[],
  deps: ConversationCliDeps = defaultDeps(),
): ConversationCliResult {
  if (argv.length === 0) {
    return usage(TOP_HELP, "missing verb; expected 'convert'");
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    return ok(TOP_HELP);
  }
  if (argv[0] === "--agent-help") {
    return ok(AGENT_HELP);
  }
  if (argv[0] !== "convert") {
    return usage(TOP_HELP, `unknown subcommand '${argv[0]}'`);
  }
  return runConvert(argv.slice(1), deps);
}

export async function main(argv: string[]): Promise<void> {
  const result = runConversationCli(argv);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  if (result.code !== 0) process.exit(result.code);
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}
