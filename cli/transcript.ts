#!/usr/bin/env bun

import { homedir } from "node:os";
import { parseArgs as parseNodeArgs } from "node:util";
import type {
  SubagentSummary,
  TranscriptFilter,
  TranscriptListItem,
  TranscriptRole,
  TranscriptSession,
  TranscriptToolDetail,
} from "../src/transcript/model";
import { TRANSCRIPT_ROLES } from "../src/transcript/model";
import { resolvePiTurn } from "../src/transcript/pi";
import type {
  TranscriptReader,
  TranscriptRootInputs,
} from "../src/transcript/reader";
import {
  transcriptHarnessNames,
  transcriptReader,
} from "../src/transcript/registry";
import {
  buildTranscriptPage,
  renderTranscriptEntriesText,
} from "../src/transcript/render";
import { ellipsizeInline } from "../src/transcript/text";
import { parseOptions } from "./descriptor";
import { errorEnvelope, successEnvelope } from "./envelope";

export const TRANSCRIPT_SCHEMA_VERSION = 1;
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SHOW_LIMIT = 60;
const DEFAULT_MAX_CHARS = 32_000;
const DEFAULT_MAX_ENTRY_CHARS = 6_000;

const HELP = `keeper transcript <harness> <session-id> [options]
keeper transcript <harness> show <session-id> [options]
keeper transcript <harness> list [options]

Discover agent sessions and extract compact, bounded text for another agent.
The shorthand form is identical to "show". Show defaults to the newest page;
pass --offset 0 to read from the beginning. Main-session headers list
available subagents, selected by id/prefix or interleaved with --subagent all.

Harnesses: ${transcriptHarnessNames().join(", ")}

Commands:
  list                   List sessions (current project by default)
  show <session-id>      Extract one session ("show" may be omitted)
  turn <session-id>      Extract the selected branch's Latest turn (pi only)

Global options:
  --config-dir <dir>     Claude config directory (repeatable; claude only)
  --format human|json    Output format (default human)
  --json                 Alias of --format json
  --agent-help           Show the terse agent workflow
  --help, -h             Show this help

Run "keeper transcript <harness> list --help" or
"keeper transcript <harness> show --help" for filter and pagination options.
`;

const LIST_HELP = `keeper transcript <harness> list [options]

List transcript sessions, newest first. The current working directory is
the default project scope; --global searches every project. Date filters apply
to the session update time.

Options:
  --project <path>       Project path (default cwd)
  --global               Search every project
  --config-dir <dir>     Claude config directory (repeatable; claude only)
  --since <time>         ISO-8601 time/date, relative duration (30m, 8h, 7d),
                          or YYYY-MM-DD (that local calendar day, from midnight)
  --until <time>         ISO-8601 time/date, relative duration, or YYYY-MM-DD
                          (that local calendar day, through the last ms)
  --offset <n>           Result offset (default 0)
  --limit <n>            Max sessions (default ${DEFAULT_LIST_LIMIT})
  --format human|json    Output format (default human)
  --json                 Alias of --format json
  --help, -h             Show this help
`;

const SHOW_HELP = `keeper transcript <harness> show <session-id> [options]

Extract a bounded transcript page. Without --offset/--before, the newest
matching page is returned. Use --before with older_before to page backward,
or --offset with newer_offset to page forward.

Human output labels each entry #N, where N is its filtered page position
(matches --offset/--before under the SAME filters) — a round-trippable
paging handle, not a durable cross-filter id. JSON's entries carry a
separate "index"/"sourceIndex" (the unfiltered ordinal), unaffected by
paging or filters.

--max-chars is a TOTAL budget: the rendered header (session info plus a
capped subagent list) counts against it, and entries get the remainder,
down to a floor of one force-fitted entry when the budget is tiny.

Options:
  --project <path>       Disambiguate a duplicated session id by project
  --config-dir <dir>     Claude config directory (repeatable; claude only)
  --subagent <id|all>    Select one subagent (prefix accepted), or all
  --offset <n>           Filtered entry offset (default newest page)
  --before <n>           Page backward before this filtered entry offset
  --limit <n>            Max entries (default ${DEFAULT_SHOW_LIMIT})
  --max-chars <n>        Total character budget, header + entries (default ${DEFAULT_MAX_CHARS})
  --max-entry-chars <n>  Per-entry cap (default ${DEFAULT_MAX_ENTRY_CHARS})
  --tools <level>        none, compact, or full (default compact)
  --role <role>          Repeatable: user|assistant|tool|summary|system
  --since <time>         ISO-8601 time/date, relative duration, or YYYY-MM-DD
                          (that local calendar day, from midnight)
  --until <time>         ISO-8601 time/date, relative duration, or YYYY-MM-DD
                          (that local calendar day, through the last ms)
  --grep <text>          Case-insensitive content filter
  --meta                 Include injected meta and system entries
  --thinking             Include thinking blocks
  --format human|json    Output format (default human)
  --json                 Alias of --format json
  --help, -h             Show this help
`;

const TURN_HELP = `keeper transcript pi turn <session-id> --leaf <entry-id|root> [options]

Extract the requested branch's Latest turn: the most recent non-empty user
text, plus subsequent assistant text ONLY once that response reaches a
successful terminal stop. Branch walking follows strictly the leaf's own
parent chain to the root — an entry physically later in the file but
outside that chain (an abandoned branch) never influences the result.
"root" explicitly selects the empty branch, before any entry.

JSON only, one of three shapes: "turn": null (a valid branch with no
non-empty user text yet), {prompt, response: null} (no complete response
yet — pending, mid tool-use, or aborted/errored/length-cut), or
{prompt, response} (both complete). A read/leaf failure is a JSON error
envelope, never a null turn.

Options:
  --leaf <entry-id|root> Required. The tree leaf to resolve the turn from.
  --project <path>       Disambiguate a duplicated session id by project
  --strip-skills         Remove expanded skills before bounding prompt text
  --format json          Output format (default and only mode: json)
  --json                 Alias of --format json
  --help, -h             Show this help
`;

const AGENT_HELP = `keeper transcript agent workflow

1. Discover: keeper transcript claude list --global --since 7d
2. Orient:   keeper transcript claude <session-id>
3. Go older: re-run with the emitted older_before as --before
4. Inspect a worker: --subagent <id> (ids are listed in the header)
5. Inspect tool output: --tools full; narrow first with --grep/--role/--since

Defaults are bounded: newest 60 entries, compact tool output, and a
32000-character TOTAL budget (header plus entries). Human entry labels are
filtered page positions, round-trippable via --offset/--before under the
same filters; use --format json for a structured envelope with a stable
unfiltered index.
`;

export interface TranscriptCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TranscriptCliDeps {
  cwd: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  nowMs: number;
}

function defaultDeps(): TranscriptCliDeps {
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    env: process.env,
    nowMs: Date.now(),
  };
}

function ok(stdout: string): TranscriptCliResult {
  return { code: 0, stdout, stderr: "" };
}

function fail(message: string, code = 2): TranscriptCliResult {
  return { code, stdout: "", stderr: `keeper transcript: ${message}\n` };
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseNonNegative(raw: unknown, name: string): number | string {
  if (typeof raw !== "string" || raw.length === 0) {
    return `${name} requires a value`;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0
    ? value
    : `${name} must be a non-negative integer (got '${raw}')`;
}

function parsePositive(
  raw: unknown,
  name: string,
  fallback: number,
): number | string {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0
    ? value
    : `${name} must be a positive integer (got '${String(raw)}')`;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse ISO-8601, a duration relative to now, or a date-only YYYY-MM-DD.
 * Date-only bounds are LOCAL calendar days: since is that day's local
 * midnight, until is the next local midnight minus one ms (inclusive of
 * the whole day). Computed from Date calendar components rather than a
 * flat 86_400_000 ms offset so a DST-shortened or -lengthened day is still
 * bounded correctly.
 */
export function parseTranscriptTime(
  raw: string | undefined,
  nowMs: number,
  edge: "since" | "until",
): number | null | string {
  if (raw === undefined) return null;
  const relative = /^(\d+)(s|m|h|d|w)$/.exec(raw);
  if (relative !== null) {
    const units: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return nowMs - Number(relative[1]) * (units[relative[2] as string] ?? 0);
  }
  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const localMidnight = new Date(year, month, day, 0, 0, 0, 0);
    // Date normalizes out-of-range components (e.g. Feb 30 -> Mar 2) instead
    // of yielding an Invalid Date, so a round-trip is the only way to catch
    // an out-of-range date-only bound; this guards both the since return
    // below and the next-local-midnight construction until relies on.
    if (
      localMidnight.getFullYear() !== year ||
      localMidnight.getMonth() !== month ||
      localMidnight.getDate() !== day
    ) {
      return `invalid --${edge} time '${raw}'; use ISO-8601 or 30m/8h/7d`;
    }
    if (edge === "since") return localMidnight.getTime();
    const nextLocalMidnight = new Date(
      year,
      month,
      day + 1,
      0,
      0,
      0,
      0,
    ).getTime();
    return nextLocalMidnight - 1;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return `invalid --${edge} time '${raw}'; use ISO-8601 or 30m/8h/7d`;
  }
  return parsed;
}

function resolveOutputFormat(values: {
  format?: unknown;
  json?: unknown;
}): { ok: true; value: "human" | "json" } | { ok: false; error: string } {
  const explicit = typeof values.format === "string" ? values.format : null;
  if (values.json === true && explicit !== null && explicit !== "json") {
    return { ok: false, error: `--json conflicts with --format ${explicit}` };
  }
  const format = values.json === true ? "json" : (explicit ?? "human");
  return format === "human" || format === "json"
    ? { ok: true, value: format }
    : {
        ok: false,
        error: `--format must be human or json (got '${format}')`,
      };
}

function buildRootInputs(
  values: Record<string, unknown>,
  deps: TranscriptCliDeps,
): TranscriptRootInputs {
  const configured = values["config-dir"];
  const configDirs = Array.isArray(configured)
    ? configured.filter((value): value is string => typeof value === "string")
    : undefined;
  return { homeDir: deps.homeDir, env: deps.env, configDirs };
}

function compactLine(raw: string | null, max = 180): string {
  return raw === null ? "" : ellipsizeInline(raw, max);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)}KiB`;
  return `${(bytes / 1_048_576).toFixed(1)}MiB`;
}

function renderListText(
  harness: string,
  items: readonly TranscriptListItem[],
  metadata: {
    project: string | null;
    offset: number;
    total: number;
    nextOffset: number | null;
  },
): string {
  const lines = [
    "@keeper-transcripts v1",
    `harness: ${harness}`,
    `scope: ${metadata.project ?? "global"}`,
    `range: [${metadata.offset}, ${metadata.offset + items.length}) of ${metadata.total}`,
    `next_offset: ${metadata.nextOffset ?? "none"}`,
    "---",
  ];
  for (const item of items) {
    lines.push(
      `[${item.sessionId}] ${item.updatedAt} ${
        item.title === null ? "" : JSON.stringify(compactLine(item.title))
      }`.trimEnd(),
      `project=${item.project ?? "unknown"} size=${formatBytes(item.bytes)} subagents=${item.subagentCount}`,
    );
    if (item.firstPrompt !== null) {
      lines.push(`first: ${compactLine(item.firstPrompt)}`);
    }
    lines.push("");
  }
  if (items.length === 0) lines.push("(no sessions matched)", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Human-render subagent list bound: past this many, collapse the rest into
 *  a "+M more" tail. JSON's `subagents` field always carries the complete
 *  array — this cap is a text-rendering concern only. */
const SUBAGENT_HEADER_CAP = 12;

function renderSubagentHeaderLines(
  subagents: readonly SubagentSummary[],
): string[] {
  if (subagents.length === 0) {
    return ["subagents: none"];
  }
  const shown = subagents.slice(0, SUBAGENT_HEADER_CAP);
  const lines = ["subagents:"];
  for (const subagent of shown) {
    const task = compactLine(subagent.task, 72);
    lines.push(
      `  ${subagent.id} updated=${subagent.updatedAt ?? "unknown"} size=${formatBytes(subagent.bytes)}${task.length > 0 ? ` task=${JSON.stringify(task)}` : ""}`,
    );
  }
  const remaining = subagents.length - shown.length;
  if (remaining > 0) {
    lines.push(`  +${remaining} more`);
  }
  return lines;
}

interface ShowHeaderPage {
  offset: number;
  endOffset: number;
  total: number;
  olderBefore: number | null;
  newerOffset: number | null;
  clippedByChars: boolean;
}

function renderShowHeaderLines(
  harness: string,
  session: TranscriptSession,
  tools: TranscriptToolDetail,
  page: ShowHeaderPage,
): string[] {
  const metadata = session.main.metadata;
  const lines = [
    "@keeper-transcript v1",
    `harness: ${harness}`,
    `session: ${metadata.sessionId}`,
    `project: ${metadata.project ?? "unknown"}`,
    `title: ${metadata.title === null ? "none" : JSON.stringify(compactLine(metadata.title, 300))}`,
    `source: ${session.selectedSource}`,
    `time: ${metadata.startedAt ?? "unknown"} .. ${metadata.updatedAt ?? "unknown"}`,
    `range: [${page.offset}, ${page.endOffset}) of ${page.total}`,
    `older_before: ${page.olderBefore ?? "none"}`,
    `newer_offset: ${page.newerOffset ?? "none"}`,
    `tool_detail: ${tools}`,
    `char_clipped: ${page.clippedByChars}`,
    `malformed_lines: ${metadata.malformedLines}`,
  ];
  lines.push(...renderSubagentHeaderLines(session.subagents));
  lines.push("---");
  return lines;
}

/**
 * Worst-case length of the rendered header, used to size the --max-chars
 * entries budget honestly (replaces a prior silent flat reserve). Every
 * page-summary number (offset/endOffset/total/older_before/newer_offset) is
 * bounded above by `rawEntryCount`, so an equal-width all-nines placeholder
 * of every field is always >= the real header text; "false" (5 chars) is
 * the longer of the two char_clipped spellings. The result is therefore an
 * upper bound, never an underestimate, of the header this session will
 * actually print.
 */
function worstCaseHeaderBudget(
  harness: string,
  session: TranscriptSession,
  tools: TranscriptToolDetail,
  rawEntryCount: number,
): number {
  const digits = Math.max(1, String(rawEntryCount).length);
  const placeholder = Number("9".repeat(digits));
  const stubPage: ShowHeaderPage = {
    offset: placeholder,
    endOffset: placeholder,
    total: placeholder,
    olderBefore: placeholder,
    newerOffset: placeholder,
    clippedByChars: false,
  };
  return `${renderShowHeaderLines(harness, session, tools, stubPage).join("\n")}\n`
    .length;
}

function renderShowText(
  harness: string,
  session: TranscriptSession,
  page: ReturnType<typeof buildTranscriptPage>,
  tools: TranscriptToolDetail,
): string {
  const header = renderShowHeaderLines(harness, session, tools, page).join(
    "\n",
  );
  return `${header}\n${renderTranscriptEntriesText(
    page.entries,
    session.selectedSource === "all",
    page.offset,
  )}`;
}

function parseList(
  reader: TranscriptReader,
  argv: string[],
  deps: TranscriptCliDeps,
): TranscriptCliResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("transcript", "list"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) return ok(LIST_HELP);
  if (parsed.positionals.length > 0) {
    return fail(`list: unexpected argument '${parsed.positionals[0]}'`);
  }
  const format = resolveOutputFormat(parsed.values);
  if (!format.ok) return fail(format.error);
  if (parsed.values.global === true && parsed.values.project !== undefined) {
    return fail("list: --global and --project are mutually exclusive");
  }
  const offset = parseNonNegative(parsed.values.offset ?? "0", "--offset");
  if (typeof offset === "string") return fail(offset);
  const limit = parsePositive(
    parsed.values.limit,
    "--limit",
    DEFAULT_LIST_LIMIT,
  );
  if (typeof limit === "string") return fail(limit);
  const sinceMs = parseTranscriptTime(
    parsed.values.since as string | undefined,
    deps.nowMs,
    "since",
  );
  if (typeof sinceMs === "string") return fail(sinceMs);
  const untilMs = parseTranscriptTime(
    parsed.values.until as string | undefined,
    deps.nowMs,
    "until",
  );
  if (typeof untilMs === "string") return fail(untilMs);
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    return fail("--since must not be later than --until");
  }
  const project =
    parsed.values.global === true
      ? null
      : String(parsed.values.project ?? deps.cwd);
  const outcome = reader.list({
    root: buildRootInputs(parsed.values, deps),
    project,
    sinceMs,
    untilMs,
    offset,
    limit,
  });
  if (outcome.kind === "no_roots") {
    return fail(outcome.message, 1);
  }
  if (outcome.kind === "error") {
    return format.value === "json"
      ? {
          code: 1,
          stdout: jsonText(
            errorEnvelope(TRANSCRIPT_SCHEMA_VERSION, {
              code: "read_failed",
              message: outcome.message,
              recovery: outcome.recovery,
            }),
          ),
          stderr: "",
        }
      : fail(`list: ${outcome.message}`, 1);
  }
  const data = {
    harness: reader.harness,
    scope: project,
    page: {
      offset: outcome.offset,
      end_offset: outcome.offset + outcome.items.length,
      total: outcome.total,
      next_offset: outcome.nextOffset,
    },
    // Title history is an internal catalog input in this slice; keep the
    // public transcript-list envelope byte-compatible until history is exposed.
    sessions: outcome.items.map(
      ({ titleHistory: _titleHistory, ...item }) => item,
    ),
  };
  return format.value === "json"
    ? ok(jsonText(successEnvelope(TRANSCRIPT_SCHEMA_VERSION, data)))
    : ok(
        renderListText(reader.harness, outcome.items, {
          project,
          offset: outcome.offset,
          total: outcome.total,
          nextOffset: outcome.nextOffset,
        }),
      );
}

function parseRoles(raw: unknown): ReadonlySet<TranscriptRole> | null | string {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const roles = new Set<TranscriptRole>();
  for (const value of raw) {
    if (!(TRANSCRIPT_ROLES as readonly unknown[]).includes(value)) {
      return `unknown --role '${String(value)}'; use ${TRANSCRIPT_ROLES.join("|")}`;
    }
    roles.add(value as TranscriptRole);
  }
  return roles;
}

function parseToolDetail(
  raw: unknown,
): { ok: true; value: TranscriptToolDetail } | { ok: false; error: string } {
  const detail = typeof raw === "string" ? raw : "compact";
  return detail === "none" || detail === "compact" || detail === "full"
    ? { ok: true, value: detail }
    : {
        ok: false,
        error: `--tools must be none, compact, or full (got '${detail}')`,
      };
}

function jsonFailure(
  code: string,
  message: string,
  recovery: string,
): TranscriptCliResult {
  return {
    code: 1,
    stdout: jsonText(
      errorEnvelope(TRANSCRIPT_SCHEMA_VERSION, { code, message, recovery }),
    ),
    stderr: "",
  };
}

function parseShow(
  reader: TranscriptReader,
  argv: string[],
  deps: TranscriptCliDeps,
): TranscriptCliResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("transcript", "show"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help === true) return ok(SHOW_HELP);
  if (parsed.positionals.length !== 1) {
    return fail(
      parsed.positionals.length === 0
        ? "show: <session-id> is required"
        : `show: unexpected argument '${parsed.positionals[1]}'`,
    );
  }
  const sessionId = parsed.positionals[0] as string;
  const format = resolveOutputFormat(parsed.values);
  if (!format.ok) return fail(format.error);
  const offset =
    parsed.values.offset === undefined
      ? null
      : parseNonNegative(parsed.values.offset, "--offset");
  if (typeof offset === "string") return fail(offset);
  const before =
    parsed.values.before === undefined
      ? null
      : parseNonNegative(parsed.values.before, "--before");
  if (typeof before === "string") return fail(before);
  if (offset !== null && before !== null) {
    return fail("--offset and --before are mutually exclusive");
  }
  const limit = parsePositive(
    parsed.values.limit,
    "--limit",
    DEFAULT_SHOW_LIMIT,
  );
  if (typeof limit === "string") return fail(limit);
  const maxChars = parsePositive(
    parsed.values["max-chars"],
    "--max-chars",
    DEFAULT_MAX_CHARS,
  );
  if (typeof maxChars === "string") return fail(maxChars);
  const maxEntryChars = parsePositive(
    parsed.values["max-entry-chars"],
    "--max-entry-chars",
    DEFAULT_MAX_ENTRY_CHARS,
  );
  if (typeof maxEntryChars === "string") return fail(maxEntryChars);
  const tools = parseToolDetail(parsed.values.tools);
  if (!tools.ok) return fail(tools.error);
  const roles = parseRoles(parsed.values.role);
  if (typeof roles === "string") return fail(roles);
  const sinceMs = parseTranscriptTime(
    parsed.values.since as string | undefined,
    deps.nowMs,
    "since",
  );
  if (typeof sinceMs === "string") return fail(sinceMs);
  const untilMs = parseTranscriptTime(
    parsed.values.until as string | undefined,
    deps.nowMs,
    "until",
  );
  if (typeof untilMs === "string") return fail(untilMs);
  if (sinceMs !== null && untilMs !== null && sinceMs > untilMs) {
    return fail("--since must not be later than --until");
  }
  const project =
    typeof parsed.values.project === "string" ? parsed.values.project : null;
  const outcome = reader.find({
    root: buildRootInputs(parsed.values, deps),
    sessionId,
    project,
  });
  if (outcome.kind === "no_roots") {
    return fail(outcome.message, 1);
  }
  if (outcome.kind === "not_found") {
    const message = `session '${sessionId}' not found${project === null ? "" : ` in project ${project}`}`;
    return format.value === "json"
      ? jsonFailure(
          "session_not_found",
          message,
          `run \`keeper transcript ${reader.harness} list --global\` to discover session ids`,
        )
      : fail(message, 1);
  }
  if (outcome.kind === "ambiguous") {
    const message = `session '${sessionId}' exists in multiple projects: ${outcome.owners.join(", ")}; pass ${outcome.hint}`;
    return format.value === "json"
      ? jsonFailure(
          "session_ambiguous",
          message,
          `pass ${outcome.hint} <${outcome.hint === "--config-dir" ? "dir" : "path"}>`,
        )
      : fail(message, 1);
  }
  let session: TranscriptSession | { error: string };
  try {
    session = reader.load(
      outcome.handle,
      String(parsed.values.subagent ?? "main"),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return format.value === "json"
      ? jsonFailure(
          "read_failed",
          message,
          "check the transcript file and retry",
        )
      : fail(message, 1);
  }
  if ("error" in session) {
    return format.value === "json"
      ? jsonFailure(
          "subagent_not_found",
          session.error,
          "use an id listed in the session header",
        )
      : fail(session.error, 1);
  }
  const filter: TranscriptFilter = {
    includeMeta: parsed.values.meta === true,
    includeThinking: parsed.values.thinking === true,
    roles,
    sinceMs,
    untilMs,
    grep: typeof parsed.values.grep === "string" ? parsed.values.grep : null,
    tools: tools.value,
  };
  const headerBudget = worstCaseHeaderBudget(
    reader.harness,
    session,
    tools.value,
    session.entries.length,
  );
  const page = buildTranscriptPage(session.entries, filter, {
    offset,
    before,
    limit,
    maxChars: Math.max(0, maxChars - headerBudget),
    maxEntryChars,
  });
  const data = {
    harness: reader.harness,
    // Keep the public transcript JSON shape while the internal normalizer
    // retains native title history for the unified Session catalog.
    session: (({ titleHistory: _titleHistory, ...metadata }) => metadata)(
      session.main.metadata,
    ),
    selected_source: session.selectedSource,
    subagents: session.subagents,
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
  return format.value === "json"
    ? ok(jsonText(successEnvelope(TRANSCRIPT_SCHEMA_VERSION, data)))
    : ok(renderShowText(reader.harness, session, page, tools.value));
}

/**
 * `turn` is pi-only (the only reader implementing branch-aware walking) and
 * JSON-only (a machine contract, no human render). Every failure — session
 * resolution, leaf resolution, and read failures alike — surfaces as a JSON
 * error envelope so a caller never has to special-case a plain-text path.
 */
function parseTurn(
  reader: TranscriptReader,
  argv: string[],
  deps: TranscriptCliDeps,
): TranscriptCliResult {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: parseOptions("transcript", "turn"),
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  // --help short-circuits before the harness check: every two-level verb's
  // help is a pure, harness-independent path (help-purity.test.ts probes
  // every verb through the claude token).
  if (parsed.values.help === true) return ok(TURN_HELP);
  if (reader.harness !== "pi") {
    return fail(
      `turn is only supported for pi sessions (got '${reader.harness}')`,
    );
  }
  if (parsed.positionals.length !== 1) {
    return fail(
      parsed.positionals.length === 0
        ? "turn: <session-id> is required"
        : `turn: unexpected argument '${parsed.positionals[1]}'`,
    );
  }
  const sessionId = parsed.positionals[0] as string;
  const format = resolveOutputFormat(parsed.values);
  if (!format.ok) return fail(format.error);
  // json is the only mode turn ever renders, so it is also the silent
  // default — unlike list/show, an absent --format never falls back to
  // human here.
  const formatIsJson =
    format.value === "json" ||
    (parsed.values.format === undefined && parsed.values.json !== true);
  if (!formatIsJson) {
    return fail("turn: --format must be json (the only supported mode)");
  }
  const leaf = parsed.values.leaf;
  if (typeof leaf !== "string" || leaf.length === 0) {
    return fail("turn: --leaf <entry-id|root> is required");
  }
  const project =
    typeof parsed.values.project === "string" ? parsed.values.project : null;
  const outcome = resolvePiTurn({
    root: buildRootInputs(parsed.values, deps),
    sessionId,
    project,
    leaf,
    stripSkills: parsed.values["strip-skills"] === true,
  });
  if (outcome.kind === "no_roots") {
    return jsonFailure(
      "no_roots",
      outcome.message,
      "check the pi sessions directory and retry",
    );
  }
  if (outcome.kind === "not_found") {
    const message = `session '${sessionId}' not found${project === null ? "" : ` in project ${project}`}`;
    return jsonFailure(
      "session_not_found",
      message,
      "run `keeper transcript pi list --global` to discover session ids",
    );
  }
  if (outcome.kind === "ambiguous") {
    const message = `session '${sessionId}' exists in multiple projects: ${outcome.owners.join(", ")}; pass ${outcome.hint}`;
    return jsonFailure(
      "session_ambiguous",
      message,
      `pass ${outcome.hint} <path>`,
    );
  }
  if (outcome.kind === "leaf_not_found") {
    return jsonFailure(
      "leaf_not_found",
      `leaf '${leaf}' not found in session '${sessionId}'`,
      "pass an entry id present in this session, or 'root'",
    );
  }
  if (outcome.kind === "leaf_malformed") {
    return jsonFailure(
      "leaf_malformed",
      outcome.message,
      "the session's parent chain is broken; re-inspect the transcript file",
    );
  }
  if (outcome.kind === "read_failed") {
    return jsonFailure(
      "read_failed",
      outcome.message,
      "check the transcript file and retry",
    );
  }
  const data = {
    harness: reader.harness,
    session_id: sessionId,
    selected_leaf: outcome.selectedLeaf,
    turn: outcome.turn,
  };
  return ok(jsonText(successEnvelope(TRANSCRIPT_SCHEMA_VERSION, data)));
}

/**
 * Peel the leading harness token exactly as `keeper agent`'s splitSubcommand
 * peels its own leading agent token (`src/agent/dispatch.ts`), then route the
 * remainder through the existing list/show/bare-id router. Bare `keeper
 * transcript`, `-h`/`--help`, `--agent-help`, and a harness token with an
 * empty remainder all print help; an unrecognized harness token (hermes
 * included) fails naming the registry's supported set.
 */
export function runTranscriptCli(
  argv: string[],
  deps: TranscriptCliDeps = defaultDeps(),
): TranscriptCliResult {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return ok(HELP);
  }
  if (argv[0] === "--agent-help") return ok(AGENT_HELP);
  const harness = argv[0] as string;
  const reader = transcriptReader(harness);
  if (reader === undefined) {
    return fail(
      `unsupported harness '${harness}'; supported: ${transcriptHarnessNames().join(", ")}`,
    );
  }
  const rest = argv.slice(1);
  if (rest.length === 0) return ok(HELP);
  if (rest[0] === "list") return parseList(reader, rest.slice(1), deps);
  if (rest[0] === "show") return parseShow(reader, rest.slice(1), deps);
  if (rest[0] === "turn") return parseTurn(reader, rest.slice(1), deps);
  return parseShow(reader, rest, deps);
}

export function main(argv: string[]): void {
  const result = runTranscriptCli(argv);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  if (result.code !== 0) process.exit(result.code);
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
