#!/usr/bin/env bun

import type { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { openDb, resolveDbPath } from "../src/db";
import type { HistoryCatalogAdapter } from "../src/history/catalog";
import { normalizeEvidencePath } from "../src/history/file-evidence";
import {
  HISTORY_FILE_PROVENANCE_MAX,
  HISTORY_FILES_DEFAULT_LIMIT,
  HISTORY_FILES_LIMIT_MAX,
  HISTORY_FILES_OFFSET_MAX,
  type HistoryFileEvidenceMatch,
  queryHistoryFileEvidenceDatabase,
} from "../src/history/files";
import {
  HISTORY_INDEX_SCHEMA_VERSION,
  inspectHistoryIndex,
  openHistoryIndexReadOnly,
  purgeHistoryIndex,
  resolveHistoryIndexPaths,
} from "../src/history/index-db";
import {
  type HistoryIndexAdapter,
  rebuildHistoryIndex,
  refreshHistoryIndex,
} from "../src/history/indexer";
import { loadSessionCatalog } from "../src/history/load-catalog";
import type {
  CatalogSession,
  HistoryDiagnostic,
  HistoryHarness,
  KeeperJobAlias,
  SessionCatalog,
  SessionResolution,
} from "../src/history/model";
import {
  aggregateHistoryDiagnostics,
  HISTORY_HARNESSES,
  isHistoryHarness,
} from "../src/history/model";
import { resolveSessionReference } from "../src/history/resolver";
import {
  HISTORY_SEARCH_LIMIT_MAX,
  HISTORY_SEARCH_OFFSET_MAX,
  HISTORY_SEARCH_QUERY_MAX_CHARS,
  searchHistoryIndex,
} from "../src/history/search";
import { keeperStateDir } from "../src/keeper-state-dir";
import type {
  TranscriptFilter,
  TranscriptRole,
  TranscriptToolDetail,
} from "../src/transcript/model";
import { TRANSCRIPT_ROLES } from "../src/transcript/model";
import { transcriptReader } from "../src/transcript/registry";
import {
  buildTranscriptPage,
  renderTranscriptEntriesText,
} from "../src/transcript/render";
import { ellipsizeInline } from "../src/transcript/text";
import { parseOptions } from "./descriptor";
import { errorEnvelope, successEnvelope } from "./envelope";
import { parseTranscriptTime } from "./transcript";

export const HISTORY_SCHEMA_VERSION = 1;

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_SHOW_LIMIT = 60;
const DEFAULT_MAX_CHARS = 32_000;
const DEFAULT_MAX_ENTRY_CHARS = 6_000;
const LIST_OFFSET_MAX = 1_000_000;
const SHOW_MAX_CHARS = 1_000_000;
const SHOW_MAX_ENTRY_CHARS = 128_000;
const OUTPUT_TITLE_CHARS = 2_000;
const OUTPUT_TITLE_ALIASES_MAX = 100;
const OUTPUT_JOBS_MAX = 100;
const RESOLUTION_CANDIDATES_MAX = 50;
const CANONICAL_MUTATION_ROWS_MAX = 500;
const FILE_CANDIDATES_MAX = 10_500;
const FILE_FRAGMENT_MAX_CHARS = 4_096;

const HELP = `keeper history <list|show|search|files|index> [options]

Unified Claude/Pi Harness session history. Reads native transcript artifacts
across projects by default, joins Keeper job aliases when keeper.db is readable,
and keeps the private full-text sidecar rebuildable and disposable.

Commands:
  list                   List cataloged sessions globally by default
  show <session-ref>     Resolve a session, then render a bounded transcript page
  search <query>         Refresh the private index, then search transcript entries
  files <fragment>       Search provenance-graded file evidence
  index [action]         Inspect or maintain the private history index

Run "keeper history <command> --help" for command-specific options.
`;

const LIST_HELP = `keeper history list [options]

List cataloged Claude/Pi sessions globally by default. Native artifacts remain
visible when keeper.db is unavailable; that condition is reported as a diagnostic.

Options:
  --project <path>       Restrict to one project path
  --harness claude|pi    Restrict to one supported harness
  --offset <n>           Result offset (default 0)
  --limit <n>            Max sessions (default ${DEFAULT_LIST_LIMIT})
  --format human|json    Output format (default human)
  --json                 Alias of --format json
  --help, -h             Show this help
`;

const SHOW_HELP = `keeper history show <session-reference> [options]

Resolve through the shared exact Session reference tiers, then render a bounded
transcript page. Ambiguous references return candidates; this read never prompts
or chooses the newest title match.

Options:
  --project <path>       Restrict resolution to one project path
  --artifact <path>      Pin one artifact when id/project are duplicated
  --subagent <id|all>    Claude only: select one subagent, or all
  --offset <n>           Filtered entry offset (default newest page)
  --before <n>           Page backward before this filtered entry offset
  --limit <n>            Max entries (default ${DEFAULT_SHOW_LIMIT})
  --max-chars <n>        Total character budget (default ${DEFAULT_MAX_CHARS})
  --max-entry-chars <n>  Per-entry cap (default ${DEFAULT_MAX_ENTRY_CHARS})
  --tools <level>        none, compact, or full (default compact)
  --role <role>          Repeatable: user|assistant|tool|summary|system
  --since <time>         ISO-8601, YYYY-MM-DD, or relative duration (30m, 8h, 7d)
  --until <time>         ISO-8601, YYYY-MM-DD, or relative duration
  --grep <text>          Case-insensitive content filter
  --meta                 Include injected meta/system entries
  --thinking             Include thinking blocks
  --format human|json    Output format (default human)
  --json                 Alias of --format json
  --help, -h             Show this help
`;

const SEARCH_HELP = `keeper history search <query> [options]

Refresh the private history index through its lock-serialized seam, then search
normalized transcript entries. Literal token search is the default; raw SQLite
FTS syntax is accepted only with --syntax fts.

Options:
  --session <ref>        Restrict to one resolved Session reference
  --project <path>       Restrict to one project path
  --harness claude|pi    Restrict to one supported harness
  --role <role>          Repeatable: user|assistant|tool|summary|system
  --since <time>         Entry at/after time
  --until <time>         Entry at/before time
  --offset <n>           Result offset (default 0)
  --limit <n>            Max hits (default ${DEFAULT_SEARCH_LIMIT})
  --syntax literal|fts   Query syntax (default literal)
  --format human|json    Output format (default human)
  --json                 Alias of --format json
  --help, -h             Show this help
`;

const FILES_HELP = `keeper history files <path-fragment> [options]

Refresh the private history index, then search globally useful file evidence.
Observed mutation, possible mutation, and textual mention remain separate;
mentions are hidden unless --mentions is set. Keeper mutation facts are read
from keeper.db when available, without writing it.

Options:
  --session <ref>        Restrict to one resolved Session reference
  --mentions             Include textual mentions (default hides them)
  --offset <n>           Result offset (default 0)
  --limit <n>            Max matches (default ${HISTORY_FILES_DEFAULT_LIMIT})
  --format human|json    Output format (default human)
  --json                 Alias of --format json
  --help, -h             Show this help
`;

const INDEX_HELP = `keeper history index [status|refresh|rebuild|purge] [options]

Inspect or maintain the private disposable history index. Refresh and rebuild
scan native Claude/Pi transcript artifacts; purge removes only the closed private
sidecar image family.

Options:
  --format human|json    Output format (default human)
  --json                 Alias of --format json
  --help, -h             Show this help
`;

export interface HistoryCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface HistoryCliDeps {
  cwd: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  nowMs: number;
  dbPath: string;
  stateDir: string;
  catalogAdapters?: readonly HistoryCatalogAdapter[];
  indexAdapters?: readonly HistoryIndexAdapter[];
  readKeeperJobs?: () => {
    jobs: KeeperJobAlias[];
    diagnostics: HistoryDiagnostic[];
  };
}

function defaultDeps(): HistoryCliDeps {
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    env: process.env,
    nowMs: Date.now(),
    dbPath: resolveDbPath(),
    stateDir: keeperStateDir(),
  };
}

function ok(stdout: string): HistoryCliResult {
  return { code: 0, stdout, stderr: "" };
}

function usage(message: string, help = HELP): HistoryCliResult {
  return {
    code: 2,
    stdout: "",
    stderr: `keeper history: ${message}\n\n${help}`,
  };
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function jsonOk(data: unknown): HistoryCliResult {
  return ok(jsonText(successEnvelope(HISTORY_SCHEMA_VERSION, data)));
}

function jsonFail(
  code: string,
  message: string,
  recovery: string,
  details?: unknown,
): HistoryCliResult {
  return {
    code: 1,
    stdout: jsonText(
      errorEnvelope(HISTORY_SCHEMA_VERSION, {
        code,
        message,
        recovery,
        ...(details === undefined ? {} : { details }),
      }),
    ),
    stderr: "",
  };
}

function historyFailure(
  format: "human" | "json",
  code: string,
  message: string,
  recovery: string,
  options: { details?: unknown; humanDetails?: readonly string[] } = {},
): HistoryCliResult {
  if (format === "json") {
    return jsonFail(code, message, recovery, options.details);
  }
  return {
    code: 1,
    stdout: "",
    stderr: [
      `keeper history: ${message}`,
      ...(options.humanDetails ?? []),
      `recovery: ${recovery}`,
      "",
    ].join("\n"),
  };
}

function parseNonNegative(
  raw: unknown,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
): number | string {
  if (typeof raw !== "string" || raw.length === 0)
    return `${name} requires a value`;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    return `${name} must be a non-negative integer (got '${raw}')`;
  }
  return n <= max ? n : `${name} must not exceed ${max}`;
}

function parsePositive(
  raw: unknown,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number | string {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return `${name} must be a positive integer (got '${String(raw)}')`;
  }
  return n <= max ? n : `${name} must not exceed ${max}`;
}

function parseFormat(
  values: Record<string, unknown>,
): "human" | "json" | string {
  const explicit = typeof values.format === "string" ? values.format : null;
  if (values.json === true && explicit !== null && explicit !== "json") {
    return `--json conflicts with --format ${explicit}`;
  }
  const format = values.json === true ? "json" : (explicit ?? "human");
  return format === "human" || format === "json"
    ? format
    : `--format must be human or json (got '${format}')`;
}

function projectFilter(raw: unknown, deps: HistoryCliDeps): string | null {
  return typeof raw === "string" && raw.length > 0
    ? resolve(deps.cwd, raw)
    : null;
}

function artifactFilter(raw: unknown, deps: HistoryCliDeps): string | null {
  const path = projectFilter(raw, deps);
  if (path === null) return null;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function harnessFilter(raw: unknown): HistoryHarness[] | string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !isHistoryHarness(raw)) {
    return `--harness must be ${HISTORY_HARNESSES.join("|")}`;
  }
  return [raw];
}

function parseRoles(raw: unknown): TranscriptRole[] | null | string {
  if (raw === undefined) return null;
  const values = Array.isArray(raw) ? raw : [raw];
  const roles: TranscriptRole[] = [];
  for (const value of values) {
    if (!(TRANSCRIPT_ROLES as readonly unknown[]).includes(value)) {
      return `unknown --role '${String(value)}'; use ${TRANSCRIPT_ROLES.join("|")}`;
    }
    roles.push(value as TranscriptRole);
  }
  return roles;
}

function parseToolDetail(
  raw: unknown,
): { ok: true; value: TranscriptToolDetail } | { ok: false; error: string } {
  const value = typeof raw === "string" ? raw : "compact";
  return value === "none" || value === "compact" || value === "full"
    ? { ok: true, value }
    : {
        ok: false,
        error: `--tools must be none, compact, or full (got '${value}')`,
      };
}

function loadCatalog(
  deps: HistoryCliDeps,
  options: { completeTitleHistory?: boolean } = {},
): SessionCatalog {
  return loadSessionCatalog({
    root: { homeDir: deps.homeDir, env: deps.env },
    dbPath: deps.dbPath,
    stateDir: deps.stateDir,
    adapters: deps.catalogAdapters,
    completeTitleHistory: options.completeTitleHistory,
    readKeeperJobs: deps.readKeeperJobs,
  });
}

function catalogReadFailure(format: "human" | "json"): HistoryCliResult {
  return historyFailure(
    format,
    "keeper_jobs_read_failed",
    "could not read Keeper job aliases from the existing keeper database",
    "Confirm keeper.db is healthy, then retry; native artifacts were not returned because silently omitting aliases could misidentify sessions.",
  );
}

function constrainCatalog(
  catalog: SessionCatalog,
  filters: {
    project?: string | null;
    artifact?: string | null;
    harnesses?: readonly HistoryHarness[];
  },
): SessionCatalog {
  const harnessSet =
    filters.harnesses === undefined ? null : new Set(filters.harnesses);
  const sessions = catalog.sessions.filter(
    (session) =>
      (filters.project === undefined ||
        filters.project === null ||
        session.project === filters.project) &&
      (filters.artifact === undefined ||
        filters.artifact === null ||
        session.artifact?.path === filters.artifact) &&
      (harnessSet === null || harnessSet.has(session.harness)),
  );
  return { ...catalog, sessions };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandText(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

function baseShowArgv(session: CatalogSession): string[] {
  const reference =
    session.artifact === null && session.jobs.length > 0
      ? (session.jobs[0]?.jobId ?? session.qualifiedNativeId)
      : session.qualifiedNativeId;
  const args = ["keeper", "history", "show", reference];
  if (session.project !== null) args.push("--project", session.project);
  if (session.artifact !== null) {
    args.push("--artifact", session.artifact.path);
  }
  return args;
}

function contextShowCommand(
  session: CatalogSession,
  context: { source?: string; sourceOrdinal?: number | null } | null,
): string {
  const args = baseShowArgv(session);
  if (context?.source?.startsWith("subagent:")) {
    args.push("--subagent", context.source.slice("subagent:".length));
  }
  const ordinal = context?.sourceOrdinal;
  if (typeof ordinal === "number" && Number.isFinite(ordinal)) {
    // sourceOrdinal counts every normalized source entry. Include the normally
    // hidden classes so --offset remains the exact coordinate emitted by the
    // search/file locator rather than drifting under default display filters.
    args.push(
      "--meta",
      "--thinking",
      "--tools",
      "full",
      "--offset",
      String(Math.max(0, Math.trunc(ordinal) - 5)),
      "--limit",
      "20",
    );
  }
  return commandText(args);
}

function sessionByKey(catalog: SessionCatalog): Map<string, CatalogSession> {
  return new Map(
    catalog.sessions.map((session) => [session.sessionKey, session]),
  );
}

function resolutionFailure(
  resolution: SessionResolution,
  format: "human" | "json",
): HistoryCliResult {
  if (resolution.kind === "not_found") {
    return historyFailure(
      format,
      "session_not_found",
      "no session matched the supplied reference",
      "Run `keeper history list --format json` and retry with a qualified native id or exact title.",
    );
  }
  if (resolution.kind === "ambiguous") {
    const candidates = resolution.candidates.slice(
      0,
      RESOLUTION_CANDIDATES_MAX,
    );
    const truncated = candidates.length < resolution.candidates.length;
    return historyFailure(
      format,
      "session_ambiguous",
      "the supplied reference matches multiple sessions",
      "Retry with a more specific reference; use --project and, when needed, the candidate artifact path with --artifact.",
      {
        details: {
          match: resolution.match,
          candidate_count: resolution.candidates.length,
          candidates_truncated: truncated,
          candidates,
        },
        humanDetails: [
          ...candidates.map(
            (candidate) =>
              `  ${candidate.qualifiedNativeId} project=${candidate.project ?? "unknown"} artifact=${candidate.artifactPath ?? "none"}`,
          ),
          ...(truncated
            ? [`  +${resolution.candidates.length - candidates.length} more`]
            : []),
        ],
      },
    );
  }
  return historyFailure(
    format,
    "session_resolution_failed",
    "session resolution failed",
    "Retry with an unambiguous Session reference.",
  );
}

function diagnosticsData(diagnostics: readonly HistoryDiagnostic[]): unknown[] {
  return aggregateHistoryDiagnostics(diagnostics).map((diagnostic) => ({
    ...diagnostic,
    count: diagnostic.count ?? 1,
  }));
}

function renderDiagnosticsHuman(
  diagnostics: readonly HistoryDiagnostic[],
): string[] {
  const aggregated = aggregateHistoryDiagnostics(diagnostics);
  if (aggregated.length === 0) return [];
  return [
    "diagnostics:",
    ...aggregated.map(
      (d) =>
        `  ${d.code} count=${d.count ?? 1} harness=${d.harness ?? "any"} scope=${d.scope}`,
    ),
  ];
}

function compact(value: string | null, max = 120): string {
  return value === null ? "" : ellipsizeInline(value, max);
}

function boundedText(
  value: string | null,
  max = OUTPUT_TITLE_CHARS,
): string | null {
  if (value === null || value.length <= max) return value;
  return value.slice(0, max);
}

function publicJobAlias(job: KeeperJobAlias): Record<string, unknown> {
  const titleHistory = job.titleHistory.slice(0, OUTPUT_TITLE_ALIASES_MAX);
  return {
    jobId: job.jobId,
    harness: job.harness,
    nativeId: job.nativeId,
    transcriptPath: job.transcriptPath,
    project: job.project,
    currentTitle: boundedText(job.currentTitle),
    titleHistory: titleHistory.map((title) => boundedText(title)),
    titleHistoryCount: job.titleHistory.length,
    titleHistoryTruncated: titleHistory.length < job.titleHistory.length,
    state: job.state,
    createdAtMs: job.createdAtMs,
    updatedAtMs: job.updatedAtMs,
    pid: job.pid,
    startTime: job.startTime,
  };
}

function catalogCounts(catalog: SessionCatalog) {
  const counts = {
    native_sessions: 0,
    metadata_only_sessions: 0,
    standalone_native_sessions: 0,
    complete_title_history_sessions: 0,
    job_aliases: 0,
    native_job_aliases: 0,
    metadata_only_job_aliases: 0,
    by_harness: {
      claude: { native_sessions: 0, metadata_only_sessions: 0 },
      pi: { native_sessions: 0, metadata_only_sessions: 0 },
    },
  };
  const jobs = new Set<string>();
  for (const session of catalog.sessions) {
    const byHarness = counts.by_harness[session.harness];
    if (session.artifact === null) {
      counts.metadata_only_sessions++;
      counts.metadata_only_job_aliases += session.jobs.length;
      byHarness.metadata_only_sessions++;
    } else {
      counts.native_sessions++;
      counts.native_job_aliases += session.jobs.length;
      byHarness.native_sessions++;
      if (session.jobs.length === 0) counts.standalone_native_sessions++;
    }
    if (session.titleHistoryComplete) {
      counts.complete_title_history_sessions++;
    }
    for (const job of session.jobs) jobs.add(`${job.harness}\0${job.jobId}`);
  }
  counts.job_aliases = jobs.size;
  return counts;
}

function renderListHuman(data: {
  sessions: CatalogSession[];
  offset: number;
  total: number;
  nextOffset: number | null;
  diagnostics: readonly HistoryDiagnostic[];
  counts: ReturnType<typeof catalogCounts>;
}): string {
  const lines = [
    "@keeper-history sessions v1",
    `range: [${data.offset}, ${data.offset + data.sessions.length}) of ${data.total}`,
    `next_offset: ${data.nextOffset ?? "none"}`,
    `catalog: native=${data.counts.native_sessions} metadata_only=${data.counts.metadata_only_sessions} job_aliases=${data.counts.job_aliases} complete_titles=${data.counts.complete_title_history_sessions}`,
    ...renderDiagnosticsHuman(data.diagnostics),
    "---",
  ];
  for (const session of data.sessions) {
    lines.push(
      `[${session.qualifiedNativeId}] ${session.updatedAt ?? "time-unknown"} ${session.currentTitle === null ? "" : JSON.stringify(compact(session.currentTitle))}`.trimEnd(),
      `project=${session.project ?? "unknown"} artifact=${session.artifact === null ? "none" : "yes"} jobs=${
        session.jobs
          .slice(0, OUTPUT_JOBS_MAX)
          .map((job) => job.jobId)
          .join(",") || "none"
      }${session.jobs.length > OUTPUT_JOBS_MAX ? `,+${session.jobs.length - OUTPUT_JOBS_MAX} more` : ""}`,
      `show: ${commandText(baseShowArgv(session))}`,
      "",
    );
  }
  if (data.sessions.length === 0) lines.push("(no sessions matched)", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

function parseList(argv: string[], deps: HistoryCliDeps): HistoryCliResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("history", "list"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usage(
      error instanceof Error ? error.message : String(error),
      LIST_HELP,
    );
  }
  if (parsed.values.help === true) return ok(LIST_HELP);
  if (parsed.positionals.length > 0) {
    return usage("list: unexpected argument", LIST_HELP);
  }
  const format = parseFormat(parsed.values);
  if (typeof format === "string" && format !== "human" && format !== "json") {
    return usage(format, LIST_HELP);
  }
  const offset = parseNonNegative(
    parsed.values.offset ?? "0",
    "--offset",
    LIST_OFFSET_MAX,
  );
  if (typeof offset === "string") return usage(offset, LIST_HELP);
  const limit = parsePositive(
    parsed.values.limit,
    "--limit",
    DEFAULT_LIST_LIMIT,
    200,
  );
  if (typeof limit === "string") return usage(limit, LIST_HELP);
  const harnesses = harnessFilter(parsed.values.harness);
  if (typeof harnesses === "string") return usage(harnesses, LIST_HELP);
  const project = projectFilter(parsed.values.project, deps);
  let loadedCatalog: SessionCatalog;
  try {
    loadedCatalog = loadCatalog(deps, { completeTitleHistory: false });
  } catch {
    return catalogReadFailure(format);
  }
  const catalog = constrainCatalog(loadedCatalog, { project, harnesses });
  const counts = catalogCounts(catalog);
  const total = catalog.sessions.length;
  const sessions = catalog.sessions.slice(offset, offset + limit);
  const nextOffset =
    offset + sessions.length < total ? offset + sessions.length : null;
  const data = {
    page: {
      offset,
      end_offset: offset + sessions.length,
      total,
      next_offset: nextOffset,
    },
    filters: { project, harnesses: harnesses ?? null },
    catalog: counts,
    diagnostics: diagnosticsData(catalog.diagnostics),
    sessions: sessions.map((session) => ({
      session_key: session.sessionKey,
      harness: session.harness,
      native_id: session.nativeId,
      qualified_id: session.qualifiedNativeId,
      project: session.project,
      current_title: boundedText(session.currentTitle),
      titles: session.titles
        .slice(0, OUTPUT_TITLE_ALIASES_MAX)
        .map((title) => boundedText(title)),
      title_count: session.titles.length,
      title_history_complete: session.titleHistoryComplete,
      titles_truncated: session.titles.length > OUTPUT_TITLE_ALIASES_MAX,
      artifact: session.artifact,
      jobs: session.jobs.slice(0, OUTPUT_JOBS_MAX).map(publicJobAlias),
      job_count: session.jobs.length,
      jobs_truncated: session.jobs.length > OUTPUT_JOBS_MAX,
      started_at: session.startedAt,
      updated_at: session.updatedAt,
      show_command: commandText(baseShowArgv(session)),
    })),
  };
  return format === "json"
    ? jsonOk(data)
    : ok(
        renderListHuman({
          sessions,
          offset,
          total,
          nextOffset,
          diagnostics: catalog.diagnostics,
          counts,
        }),
      );
}

function showHeaderLines(
  session: CatalogSession,
  selectedSource: string,
  page: ReturnType<typeof buildTranscriptPage>,
  tools: TranscriptToolDetail,
): string[] {
  return [
    "@keeper-history transcript v1",
    `harness: ${session.harness}`,
    `session: ${session.qualifiedNativeId}`,
    `project: ${session.project ?? "unknown"}`,
    `title: ${session.currentTitle === null ? "none" : JSON.stringify(compact(session.currentTitle, 300))}`,
    `source: ${selectedSource}`,
    `range: [${page.offset}, ${page.endOffset}) of ${page.total}`,
    `older_before: ${page.olderBefore ?? "none"}`,
    `newer_offset: ${page.newerOffset ?? "none"}`,
    `tool_detail: ${tools}`,
    `char_clipped: ${page.clippedByChars}`,
    `show_command: ${commandText(baseShowArgv(session))}`,
    "---",
  ];
}

function parseShow(argv: string[], deps: HistoryCliDeps): HistoryCliResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("history", "show"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usage(
      error instanceof Error ? error.message : String(error),
      SHOW_HELP,
    );
  }
  if (parsed.values.help === true) return ok(SHOW_HELP);
  if (parsed.positionals.length !== 1) {
    return usage(
      parsed.positionals.length === 0
        ? "show: <session-reference> is required"
        : "show: too many arguments",
      SHOW_HELP,
    );
  }
  const format = parseFormat(parsed.values);
  if (typeof format === "string" && format !== "human" && format !== "json") {
    return usage(format, SHOW_HELP);
  }
  const offset =
    parsed.values.offset === undefined
      ? null
      : parseNonNegative(parsed.values.offset, "--offset", LIST_OFFSET_MAX);
  if (typeof offset === "string") return usage(offset, SHOW_HELP);
  const before =
    parsed.values.before === undefined
      ? null
      : parseNonNegative(parsed.values.before, "--before", LIST_OFFSET_MAX);
  if (typeof before === "string") return usage(before, SHOW_HELP);
  if (offset !== null && before !== null) {
    return usage("--offset and --before are mutually exclusive", SHOW_HELP);
  }
  const limit = parsePositive(
    parsed.values.limit,
    "--limit",
    DEFAULT_SHOW_LIMIT,
    500,
  );
  if (typeof limit === "string") return usage(limit, SHOW_HELP);
  const maxChars = parsePositive(
    parsed.values["max-chars"],
    "--max-chars",
    DEFAULT_MAX_CHARS,
    SHOW_MAX_CHARS,
  );
  if (typeof maxChars === "string") return usage(maxChars, SHOW_HELP);
  const maxEntryChars = parsePositive(
    parsed.values["max-entry-chars"],
    "--max-entry-chars",
    DEFAULT_MAX_ENTRY_CHARS,
    SHOW_MAX_ENTRY_CHARS,
  );
  if (typeof maxEntryChars === "string") return usage(maxEntryChars, SHOW_HELP);
  const tools = parseToolDetail(parsed.values.tools);
  if (!tools.ok) return usage(tools.error, SHOW_HELP);
  const roles = parseRoles(parsed.values.role);
  if (typeof roles === "string") return usage(roles, SHOW_HELP);
  const sinceMs = parseTranscriptTime(
    parsed.values.since as string | undefined,
    deps.nowMs,
    "since",
  );
  if (typeof sinceMs === "string") return usage(sinceMs, SHOW_HELP);
  const untilMs = parseTranscriptTime(
    parsed.values.until as string | undefined,
    deps.nowMs,
    "until",
  );
  if (typeof untilMs === "string") return usage(untilMs, SHOW_HELP);
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    return usage("--since must not be later than --until", SHOW_HELP);
  }

  const project = projectFilter(parsed.values.project, deps);
  const artifact = artifactFilter(parsed.values.artifact, deps);
  let loadedCatalog: SessionCatalog;
  try {
    loadedCatalog = loadCatalog(deps);
  } catch {
    return catalogReadFailure(format);
  }
  const catalog = constrainCatalog(loadedCatalog, { project, artifact });
  const resolution = resolveSessionReference(
    catalog,
    parsed.positionals[0] as string,
  );
  if (resolution.kind !== "resolved") {
    return resolutionFailure(resolution, format);
  }
  const session = resolution.session;
  if (session.artifact === null) {
    return historyFailure(
      format,
      "artifact_unavailable",
      "the session resolved through Keeper metadata but has no readable native transcript artifact",
      "Use `keeper history list --format json` to choose a session with artifact metadata.",
    );
  }
  const reader = transcriptReader(session.harness);
  if (reader === undefined) {
    return historyFailure(
      format,
      "unsupported_harness",
      "the resolved session's harness is not supported by history rendering",
      "Choose a Claude or Pi session.",
    );
  }
  let loaded: ReturnType<typeof reader.load>;
  try {
    loaded = reader.load(
      { sessionId: session.nativeId, path: session.artifact.path },
      String(parsed.values.subagent ?? "main"),
    );
  } catch {
    return historyFailure(
      format,
      "read_failed",
      "could not read the resolved transcript artifact",
      "Retry the read; if it persists, rebuild the history index or inspect the native transcript root.",
    );
  }
  if ("error" in loaded) {
    return loaded.error.startsWith("transcript disappeared")
      ? historyFailure(
          format,
          "read_failed",
          "could not read the resolved transcript artifact",
          "Retry the read; if it persists, rebuild the history index or inspect the native transcript root.",
        )
      : historyFailure(
          format,
          "subagent_not_found",
          "the requested subagent was not found or is ambiguous",
          "Use a subagent id listed by a main-session show.",
        );
  }
  const filter: TranscriptFilter = {
    includeMeta: parsed.values.meta === true,
    includeThinking: parsed.values.thinking === true,
    roles: roles === null ? null : new Set(roles),
    sinceMs,
    untilMs,
    grep: typeof parsed.values.grep === "string" ? parsed.values.grep : null,
    tools: tools.value,
  };
  const page = buildTranscriptPage(loaded.entries, filter, {
    offset,
    before,
    limit,
    maxChars: Math.max(0, maxChars - 1_600),
    maxEntryChars,
  });
  const data = {
    resolution: { match: resolution.match },
    locator: {
      session_key: session.sessionKey,
      harness: session.harness,
      native_id: session.nativeId,
      qualified_id: session.qualifiedNativeId,
      project: session.project,
      artifact_path: session.artifact.path,
    },
    show_command: commandText(baseShowArgv(session)),
    selected_source: loaded.selectedSource,
    page: {
      offset: page.offset,
      end_offset: page.endOffset,
      total: page.total,
      requested_limit: page.requestedLimit,
      older_before: page.olderBefore,
      newer_offset: page.newerOffset,
      clipped_by_chars: page.clippedByChars,
    },
    entries: page.entries,
  };
  if (format === "json") return jsonOk(data);
  const header = showHeaderLines(
    session,
    loaded.selectedSource,
    page,
    tools.value,
  ).join("\n");
  return ok(
    `${header}\n${renderTranscriptEntriesText(
      page.entries,
      loaded.selectedSource === "all",
      page.offset,
    )}`,
  );
}

function refreshForRead(
  deps: HistoryCliDeps,
  catalog: SessionCatalog,
): ReturnType<typeof refreshHistoryIndex> {
  return refreshHistoryIndex({
    paths: resolveHistoryIndexPaths(deps.stateDir),
    catalog,
    adapters: deps.indexAdapters,
    nowMs: deps.nowMs,
  });
}

function parseSearch(argv: string[], deps: HistoryCliDeps): HistoryCliResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("history", "search"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usage(
      error instanceof Error ? error.message : String(error),
      SEARCH_HELP,
    );
  }
  if (parsed.values.help === true) return ok(SEARCH_HELP);
  if (parsed.positionals.length !== 1) {
    return usage(
      parsed.positionals.length === 0
        ? "search: <query> is required"
        : "search: too many arguments",
      SEARCH_HELP,
    );
  }
  const format = parseFormat(parsed.values);
  if (typeof format === "string" && format !== "human" && format !== "json") {
    return usage(format, SEARCH_HELP);
  }
  const offset = parseNonNegative(
    parsed.values.offset ?? "0",
    "--offset",
    HISTORY_SEARCH_OFFSET_MAX,
  );
  if (typeof offset === "string") return usage(offset, SEARCH_HELP);
  const limit = parsePositive(
    parsed.values.limit,
    "--limit",
    DEFAULT_SEARCH_LIMIT,
    HISTORY_SEARCH_LIMIT_MAX,
  );
  if (typeof limit === "string") return usage(limit, SEARCH_HELP);
  const syntax = String(parsed.values.syntax ?? "literal");
  if (syntax !== "literal" && syntax !== "fts") {
    return usage("--syntax must be literal or fts", SEARCH_HELP);
  }
  const queryText = String(parsed.positionals[0]);
  if (queryText.trim().length === 0) {
    return usage("search: <query> must not be empty", SEARCH_HELP);
  }
  if (queryText.trim().length > HISTORY_SEARCH_QUERY_MAX_CHARS) {
    return usage(
      `search query must not exceed ${HISTORY_SEARCH_QUERY_MAX_CHARS} characters`,
      SEARCH_HELP,
    );
  }
  const harnesses = harnessFilter(parsed.values.harness);
  if (typeof harnesses === "string") return usage(harnesses, SEARCH_HELP);
  const roles = parseRoles(parsed.values.role);
  if (typeof roles === "string") return usage(roles, SEARCH_HELP);
  const sinceMs = parseTranscriptTime(
    parsed.values.since as string | undefined,
    deps.nowMs,
    "since",
  );
  if (typeof sinceMs === "string") return usage(sinceMs, SEARCH_HELP);
  const untilMs = parseTranscriptTime(
    parsed.values.until as string | undefined,
    deps.nowMs,
    "until",
  );
  if (typeof untilMs === "string") return usage(untilMs, SEARCH_HELP);
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    return usage("--since must not be later than --until", SEARCH_HELP);
  }
  const project = projectFilter(parsed.values.project, deps);
  let catalog: SessionCatalog;
  try {
    catalog = loadCatalog(deps);
  } catch {
    return catalogReadFailure(format);
  }
  const constrained = constrainCatalog(catalog, { project, harnesses });
  let sessionKeys: string[] | undefined;
  if (typeof parsed.values.session === "string") {
    const resolution = resolveSessionReference(
      constrained,
      parsed.values.session,
    );
    if (resolution.kind !== "resolved") {
      return resolutionFailure(resolution, format);
    }
    sessionKeys = [resolution.session.sessionKey];
  }
  let stats: ReturnType<typeof refreshHistoryIndex>;
  try {
    stats = refreshForRead(deps, catalog);
  } catch {
    return historyFailure(
      format,
      "index_refresh_failed",
      "could not refresh the private history index",
      "Retry the read; the history index is disposable and can be rebuilt with `keeper history index rebuild`.",
    );
  }
  let result: ReturnType<typeof searchHistoryIndex>;
  try {
    result = searchHistoryIndex(resolveHistoryIndexPaths(deps.stateDir), {
      text: queryText,
      mode: syntax === "fts" ? "advanced" : "literal",
      filters: {
        sessionKeys,
        harnesses,
        projects: project === null ? undefined : [project],
        roles: roles ?? undefined,
        sinceMs,
        untilMs,
      },
      offset,
      limit,
    });
  } catch {
    return historyFailure(
      format,
      "index_read_failed",
      "could not read the private history index",
      "Retry the read or rebuild the disposable history index.",
    );
  }
  if (result.kind === "invalid_query") {
    return historyFailure(
      format,
      result.code,
      result.message,
      "Revise the search query and retry.",
    );
  }
  const byKey = sessionByKey(catalog);
  const hits = result.hits.map((hit) => {
    const session = byKey.get(hit.sessionKey);
    const showCommand =
      session === undefined
        ? `keeper history show ${hit.harness}:${hit.nativeId}`
        : contextShowCommand(session, hit.context);
    return {
      ...hit,
      qualified_id: `${hit.harness}:${hit.nativeId}`,
      show_command: showCommand,
      locator: { ...hit.context },
      title: boundedText(hit.title),
      body: hit.body,
    };
  });
  const data = {
    page: {
      offset: result.offset,
      end_offset: result.offset + hits.length,
      total: result.total,
      next_offset: result.nextOffset,
    },
    syntax,
    refresh: stats,
    diagnostics: diagnosticsData([
      ...catalog.diagnostics,
      ...stats.diagnostics,
    ]),
    hits,
  };
  if (format === "json") return jsonOk(data);
  const lines = [
    "@keeper-history search v1",
    `range: [${result.offset}, ${result.offset + hits.length}) of ${result.total}`,
    `next_offset: ${result.nextOffset ?? "none"}`,
    ...renderDiagnosticsHuman([...catalog.diagnostics, ...stats.diagnostics]),
    "---",
  ];
  for (const hit of hits) {
    lines.push(
      `[${hit.qualified_id}] ${hit.timestamp ?? "time-unknown"} ${hit.role}/${hit.kind} ${hit.title === null ? "" : JSON.stringify(compact(hit.title))}`.trimEnd(),
      `project=${hit.project ?? "unknown"} source=${hit.source} entry=${hit.context.sourceOrdinal}`,
      compact(hit.body, 300),
      `show: ${hit.show_command}`,
      "",
    );
  }
  if (hits.length === 0) lines.push("(no hits matched)", "");
  return ok(`${lines.join("\n").trimEnd()}\n`);
}

function gradeRank(grade: string): number {
  return grade === "observed_mutation"
    ? 0
    : grade === "possible_mutation"
      ? 1
      : 2;
}

function mergeFileMatches(
  matches: readonly HistoryFileEvidenceMatch[],
): HistoryFileEvidenceMatch[] {
  const byKey = new Map<string, HistoryFileEvidenceMatch>();
  for (const match of matches) {
    // One strongest grade per (Session,path). A canonical observed fact must
    // replace—not sit beside—a weaker mention from the transcript sidecar.
    const key = `${match.sessionKey}\0${match.path}`;
    const existing = byKey.get(key);
    if (
      existing === undefined ||
      gradeRank(match.grade) < gradeRank(existing.grade)
    ) {
      byKey.set(key, {
        ...match,
        provenance: match.provenance.slice(0, HISTORY_FILE_PROVENANCE_MAX),
        provenanceTruncated:
          match.provenanceTruncated ||
          match.provenance.length > HISTORY_FILE_PROVENANCE_MAX,
      });
      continue;
    }
    if (existing.grade !== match.grade) continue;
    const seen = new Set(
      existing.provenance.map(
        (item) =>
          `${item.source}\0${item.context?.sourceKey ?? ""}\0${item.context?.sourceOrdinal ?? -1}`,
      ),
    );
    for (const provenance of match.provenance) {
      const provenanceKey = `${provenance.source}\0${provenance.context?.sourceKey ?? ""}\0${provenance.context?.sourceOrdinal ?? -1}`;
      if (
        !seen.has(provenanceKey) &&
        existing.provenance.length < HISTORY_FILE_PROVENANCE_MAX
      ) {
        seen.add(provenanceKey);
        existing.provenance.push(provenance);
      }
    }
    existing.provenanceTotal += match.provenanceTotal;
    existing.provenanceTruncated =
      existing.provenanceTruncated ||
      match.provenanceTruncated ||
      existing.provenanceTotal > existing.provenance.length;
  }
  return [...byKey.values()].sort(
    (a, b) =>
      gradeRank(a.grade) - gradeRank(b.grade) ||
      a.path.localeCompare(b.path) ||
      a.sessionKey.localeCompare(b.sessionKey),
  );
}

function canonicalMutationMatches(
  deps: HistoryCliDeps,
  catalog: SessionCatalog,
  fragment: string,
  sessionKeys: readonly string[] | undefined,
): {
  matches: HistoryFileEvidenceMatch[];
  diagnostics: HistoryDiagnostic[];
  truncated: boolean;
} {
  const sessionsByJob = new Map<string, CatalogSession[]>();
  for (const session of catalog.sessions) {
    for (const job of session.jobs) {
      const list = sessionsByJob.get(job.jobId) ?? [];
      list.push(session);
      sessionsByJob.set(job.jobId, list);
    }
  }
  const allowed = sessionKeys === undefined ? null : new Set(sessionKeys);
  const like = `%${fragment.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const matches: HistoryFileEvidenceMatch[] = [];
  const add = (
    sessionId: string,
    rawPath: string,
    project: string | null,
  ): void => {
    const path = normalizeEvidencePath(rawPath, project);
    if (path === null || !path.toLowerCase().includes(fragment.toLowerCase())) {
      return;
    }
    for (const session of sessionsByJob.get(sessionId) ?? []) {
      if (allowed !== null && !allowed.has(session.sessionKey)) continue;
      matches.push({
        path,
        grade: "observed_mutation",
        sessionKey: session.sessionKey,
        harness: session.harness,
        nativeId: session.nativeId,
        project: session.project,
        title: boundedText(session.currentTitle),
        provenance: [{ source: "canonical_mutation", context: null }],
        provenanceTotal: 1,
        provenanceTruncated: false,
      });
    }
  };
  const unavailableDiagnostic: HistoryDiagnostic = {
    code: "keeper_mutations_unavailable",
    harness: null,
    scope: "mutation",
  };
  try {
    const { db } = openDb(deps.dbPath, { readonly: true, prepareStmts: false });
    let partialUnavailable = false;
    let truncated = false;
    try {
      try {
        const eventRows = db
          .query(`SELECT session_id, cwd, mutation_path
                    FROM events
                   WHERE mutation_path IS NOT NULL
                     AND (mutation_path LIKE ? ESCAPE '\\'
                          OR (cwd IS NOT NULL AND (cwd || '/' || mutation_path) LIKE ? ESCAPE '\\'))
                   ORDER BY id DESC
                   LIMIT ${CANONICAL_MUTATION_ROWS_MAX + 1}`)
          .all(like, like) as Array<{
          session_id: string;
          cwd: string | null;
          mutation_path: string;
        }>;
        if (eventRows.length > CANONICAL_MUTATION_ROWS_MAX) truncated = true;
        for (const row of eventRows.slice(0, CANONICAL_MUTATION_ROWS_MAX)) {
          add(row.session_id, row.mutation_path, row.cwd);
        }
      } catch {
        partialUnavailable = true;
      }
      try {
        const attrRows = db
          .query(`SELECT session_id, project_dir, file_path
                    FROM file_attributions
                   WHERE file_path LIKE ? ESCAPE '\\'
                      OR (project_dir || '/' || file_path) LIKE ? ESCAPE '\\'
                   ORDER BY last_mutation_at DESC
                   LIMIT ${CANONICAL_MUTATION_ROWS_MAX + 1}`)
          .all(like, like) as Array<{
          session_id: string;
          project_dir: string;
          file_path: string;
        }>;
        if (attrRows.length > CANONICAL_MUTATION_ROWS_MAX) truncated = true;
        for (const row of attrRows.slice(0, CANONICAL_MUTATION_ROWS_MAX)) {
          add(row.session_id, row.file_path, row.project_dir);
        }
      } catch {
        partialUnavailable = true;
      }
    } finally {
      db.close();
    }
    return {
      matches,
      diagnostics: partialUnavailable ? [unavailableDiagnostic] : [],
      truncated,
    };
  } catch {
    return {
      matches,
      diagnostics: [unavailableDiagnostic],
      truncated: false,
    };
  }
}

function readSidecarFileCandidates(
  db: Database,
  options: {
    fragment: string;
    sessionKeys: readonly string[] | undefined;
    includeMentions: boolean;
    needed: number;
  },
): {
  matches: HistoryFileEvidenceMatch[];
  total: number;
  considered: number;
  truncated: boolean;
} {
  const matches: HistoryFileEvidenceMatch[] = [];
  let cursor = 0;
  let total = 0;
  for (;;) {
    const remainingBudget = FILE_CANDIDATES_MAX - cursor;
    if (remainingBudget <= 0) break;
    const page = queryHistoryFileEvidenceDatabase(db, {
      fragment: options.fragment,
      sessionKeys: options.sessionKeys,
      includeMentions: options.includeMentions,
      offset: cursor,
      limit: Math.min(HISTORY_FILES_LIMIT_MAX, remainingBudget),
    });
    total = page.total;
    matches.push(...page.matches);
    cursor += page.matches.length;
    if (cursor >= total || page.matches.length === 0) break;
    if (mergeFileMatches(matches).length >= options.needed) {
      break;
    }
  }
  return {
    matches,
    total,
    considered: cursor,
    truncated: cursor < total,
  };
}

function parseFiles(argv: string[], deps: HistoryCliDeps): HistoryCliResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("history", "files"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usage(
      error instanceof Error ? error.message : String(error),
      FILES_HELP,
    );
  }
  if (parsed.values.help === true) return ok(FILES_HELP);
  if (parsed.positionals.length !== 1) {
    return usage(
      parsed.positionals.length === 0
        ? "files: <path-fragment> is required"
        : "files: too many arguments",
      FILES_HELP,
    );
  }
  const fragment = String(parsed.positionals[0]);
  if (fragment.length === 0) {
    return usage("files: <path-fragment> must not be empty", FILES_HELP);
  }
  if (fragment.length > FILE_FRAGMENT_MAX_CHARS) {
    return usage(
      `files: <path-fragment> must not exceed ${FILE_FRAGMENT_MAX_CHARS} characters`,
      FILES_HELP,
    );
  }
  const format = parseFormat(parsed.values);
  if (typeof format === "string" && format !== "human" && format !== "json") {
    return usage(format, FILES_HELP);
  }
  const offset = parseNonNegative(
    parsed.values.offset ?? "0",
    "--offset",
    HISTORY_FILES_OFFSET_MAX,
  );
  if (typeof offset === "string") return usage(offset, FILES_HELP);
  const limit = parsePositive(
    parsed.values.limit,
    "--limit",
    HISTORY_FILES_DEFAULT_LIMIT,
    HISTORY_FILES_LIMIT_MAX,
  );
  if (typeof limit === "string") return usage(limit, FILES_HELP);
  let catalog: SessionCatalog;
  try {
    catalog = loadCatalog(deps);
  } catch {
    return catalogReadFailure(format);
  }
  let sessionKeys: string[] | undefined;
  if (typeof parsed.values.session === "string") {
    const resolution = resolveSessionReference(catalog, parsed.values.session);
    if (resolution.kind !== "resolved") {
      return resolutionFailure(resolution, format);
    }
    sessionKeys = [resolution.session.sessionKey];
  }
  let stats: ReturnType<typeof refreshHistoryIndex>;
  try {
    stats = refreshForRead(deps, catalog);
  } catch {
    return historyFailure(
      format,
      "index_refresh_failed",
      "could not refresh the private history index",
      "Retry the read; the history index is disposable and can be rebuilt with `keeper history index rebuild`.",
    );
  }
  const canonical = canonicalMutationMatches(
    deps,
    catalog,
    fragment,
    sessionKeys,
  );
  let sidecar: ReturnType<typeof readSidecarFileCandidates>;
  try {
    const db = openHistoryIndexReadOnly(
      resolveHistoryIndexPaths(deps.stateDir),
    );
    try {
      sidecar = readSidecarFileCandidates(db, {
        fragment,
        sessionKeys,
        includeMentions: parsed.values.mentions === true,
        needed: offset + limit,
      });
    } finally {
      db.close();
    }
  } catch {
    return historyFailure(
      format,
      "index_read_failed",
      "could not read file evidence from the private history index",
      "Retry the read or rebuild the disposable history index.",
    );
  }
  const byKey = sessionByKey(catalog);
  const merged = mergeFileMatches([...sidecar.matches, ...canonical.matches]);
  const pageMatches = merged.slice(offset, offset + limit).map((match) => {
    const session = byKey.get(match.sessionKey);
    const context =
      match.provenance.find((p) => p.context !== null)?.context ?? null;
    const showCommand =
      session === undefined
        ? `keeper history show ${match.harness}:${match.nativeId}`
        : contextShowCommand(session, context);
    return {
      ...match,
      title: boundedText(match.title),
      qualified_id: `${match.harness}:${match.nativeId}`,
      show_command: showCommand,
      locator: context,
    };
  });
  const resultsComplete = !sidecar.truncated && !canonical.truncated;
  const exactTotal = resultsComplete ? merged.length : null;
  const hasMore =
    offset + pageMatches.length < merged.length ||
    sidecar.truncated ||
    canonical.truncated;
  const nextOffset =
    pageMatches.length > 0 && hasMore ? offset + pageMatches.length : null;
  const diagnostics = aggregateHistoryDiagnostics([
    ...catalog.diagnostics,
    ...stats.diagnostics,
    ...canonical.diagnostics,
  ]);
  const data = {
    page: {
      offset,
      end_offset: offset + pageMatches.length,
      total: exactTotal,
      total_is_exact: resultsComplete,
      total_lower_bound: merged.length,
      next_offset: nextOffset,
    },
    include_mentions: parsed.values.mentions === true,
    coverage: {
      observed_mutation:
        "Successful native mutation-tool results plus readable Keeper mutation facts; best-effort, not an exhaustive filesystem ledger.",
      possible_mutation:
        "Bounded shell inference only; never upgraded to observed.",
      mention: "Text/tool path mentions only, included only with --mentions.",
      results_complete: resultsComplete,
      sidecar_total: sidecar.total,
      sidecar_considered: sidecar.considered,
      sidecar_truncated: sidecar.truncated,
      keeper_fact_scan_truncated: canonical.truncated,
    },
    refresh: stats,
    diagnostics: diagnosticsData(diagnostics),
    matches: pageMatches,
  };
  if (format === "json") return jsonOk(data);
  const lines = [
    "@keeper-history files v1",
    `range: [${offset}, ${offset + pageMatches.length}) of ${exactTotal ?? `>=${merged.length}`}`,
    `next_offset: ${nextOffset ?? "none"}`,
    `mentions: ${parsed.values.mentions === true ? "included" : "hidden"}`,
    ...renderDiagnosticsHuman(diagnostics),
    `coverage: ${resultsComplete ? "complete for readable indexed sources/facts" : "bounded best-effort (see truncation fields in JSON)"}; observed, possible, and mention remain distinct.`,
    "---",
  ];
  for (const match of pageMatches) {
    lines.push(
      `[${match.grade}] ${match.path}`,
      `session=${match.qualified_id} project=${match.project ?? "unknown"} title=${match.title === null ? "none" : JSON.stringify(compact(match.title))}`,
      `provenance=${match.provenance.map((p) => p.source).join(",") || "none"}${match.provenanceTruncated ? ` (+${Math.max(0, match.provenanceTotal - match.provenance.length)} more)` : ""}`,
      `show: ${match.show_command}`,
      "",
    );
  }
  if (pageMatches.length === 0) lines.push("(no file evidence matched)", "");
  return ok(`${lines.join("\n").trimEnd()}\n`);
}

function readIndexFreshness(
  deps: HistoryCliDeps,
): Record<string, unknown> | null {
  const db = openHistoryIndexReadOnly(resolveHistoryIndexPaths(deps.stateDir));
  try {
    const sources = db.query("SELECT count(*) AS count FROM sources").get() as {
      count: number;
    };
    const entries = db.query("SELECT count(*) AS count FROM entries").get() as {
      count: number;
    };
    const evidence = db
      .query("SELECT count(*) AS count FROM file_evidence")
      .get() as { count: number };
    const freshness = db
      .query(
        "SELECT min(indexed_at_ms) AS oldest, max(indexed_at_ms) AS newest FROM sources",
      )
      .get() as { oldest: number | null; newest: number | null };
    return {
      sources: Number(sources.count),
      entries: Number(entries.count),
      file_evidence: Number(evidence.count),
      oldest_indexed_at:
        freshness.oldest === null
          ? null
          : new Date(Number(freshness.oldest)).toISOString(),
      newest_indexed_at:
        freshness.newest === null
          ? null
          : new Date(Number(freshness.newest)).toISOString(),
    };
  } finally {
    db.close();
  }
}

function parseIndex(argv: string[], deps: HistoryCliDeps): HistoryCliResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("history", "index"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usage(
      error instanceof Error ? error.message : String(error),
      INDEX_HELP,
    );
  }
  if (parsed.values.help === true) return ok(INDEX_HELP);
  if (parsed.positionals.length > 1) {
    return usage("index: too many arguments", INDEX_HELP);
  }
  const action = String(parsed.positionals[0] ?? "status");
  if (!["status", "refresh", "rebuild", "purge"].includes(action)) {
    return usage(
      "index action must be status, refresh, rebuild, or purge",
      INDEX_HELP,
    );
  }
  const format = parseFormat(parsed.values);
  if (typeof format === "string" && format !== "human" && format !== "json") {
    return usage(format, INDEX_HELP);
  }
  const paths = resolveHistoryIndexPaths(deps.stateDir);
  let maintenanceCatalog: SessionCatalog | null = null;
  if (action === "refresh" || action === "rebuild") {
    try {
      maintenanceCatalog = loadCatalog(deps);
    } catch {
      return catalogReadFailure(format);
    }
  }
  try {
    if (action === "purge") {
      purgeHistoryIndex(paths);
      const data = { action, status: inspectHistoryIndex(paths) };
      return format === "json"
        ? jsonOk(data)
        : ok("@keeper-history index v1\naction: purge\nstatus: purged\n");
    }
    if (
      (action === "refresh" || action === "rebuild") &&
      maintenanceCatalog !== null
    ) {
      const catalog = maintenanceCatalog;
      const stats =
        action === "refresh"
          ? refreshHistoryIndex({
              paths,
              catalog,
              adapters: deps.indexAdapters,
              nowMs: deps.nowMs,
            })
          : rebuildHistoryIndex({
              paths,
              catalog,
              adapters: deps.indexAdapters,
              nowMs: deps.nowMs,
            });
      const status = inspectHistoryIndex(paths);
      const freshness =
        status.kind === "ready" ? readIndexFreshness(deps) : null;
      const data = {
        action,
        status,
        schema_version: HISTORY_INDEX_SCHEMA_VERSION,
        stats,
        freshness,
        diagnostics: diagnosticsData([
          ...catalog.diagnostics,
          ...stats.diagnostics,
        ]),
      };
      if (format === "json") return jsonOk(data);
      return ok(
        [
          "@keeper-history index v1",
          `action: ${action}`,
          `status: ${status.kind}`,
          `schema_version: ${HISTORY_INDEX_SCHEMA_VERSION}`,
          `sources: ${stats.discoveredSources} discovered, ${stats.indexedSources} indexed, ${stats.unchangedSources} unchanged, ${stats.failedSources} failed, ${stats.removedSources} removed`,
          `entries_indexed: ${stats.indexedEntries}`,
          ...renderDiagnosticsHuman([
            ...catalog.diagnostics,
            ...stats.diagnostics,
          ]),
          "",
        ].join("\n"),
      );
    }
    const status = inspectHistoryIndex(paths);
    const freshness = status.kind === "ready" ? readIndexFreshness(deps) : null;
    const data = {
      action,
      status,
      schema_version: HISTORY_INDEX_SCHEMA_VERSION,
      freshness,
    };
    if (format === "json") return jsonOk(data);
    return ok(
      [
        "@keeper-history index v1",
        `status: ${status.kind}`,
        `schema_version: ${HISTORY_INDEX_SCHEMA_VERSION}`,
        freshness === null
          ? "freshness: unavailable"
          : `freshness: sources=${freshness.sources} entries=${freshness.entries} file_evidence=${freshness.file_evidence} newest=${freshness.newest_indexed_at ?? "none"}`,
        "",
      ].join("\n"),
    );
  } catch {
    return historyFailure(
      format,
      "index_operation_failed",
      "the history index operation failed",
      "Retry the operation; the history index is disposable, and purge/rebuild is safe.",
    );
  }
}

export function runHistoryCli(
  argv: string[],
  deps: HistoryCliDeps = defaultDeps(),
): HistoryCliResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h")
    return ok(HELP);
  const verb = argv[0];
  const rest = argv.slice(1);
  if (verb === "list") return parseList(rest, deps);
  if (verb === "show") return parseShow(rest, deps);
  if (verb === "search") return parseSearch(rest, deps);
  if (verb === "files") return parseFiles(rest, deps);
  if (verb === "index") return parseIndex(rest, deps);
  return usage(`unknown command '${verb}'`, HELP);
}

export function main(argv: string[]): void {
  const result = runHistoryCli(argv);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  if (result.code !== 0) process.exit(result.code);
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
