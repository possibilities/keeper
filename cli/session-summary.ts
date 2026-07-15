#!/usr/bin/env bun
/**
 * `keeper session summary <session-reference>` — a BOUNDED one-shot summary of
 * one tracked Session so an agent orients without Reading a multi-MB transcript into its
 * token cap. Emits ONE `{schema_version, ok, error, data}` envelope: the job's
 * title / lifecycle state / plan linkage / transcript_path, the first + last
 * human prompt (each TRUNCATED), and event counts — all off keeper.db, the
 * schema keeper owns, so consumers stop hand-rolling sqlite or slurping the
 * transcript.
 *
 * Sources: the `jobs` projection row (title, state, plan_verb/ref,
 * transcript_path, epic_links, timestamps) + the `events` log (first/last
 * `UserPromptSubmit` payload, counts). The prompt snippets are truncated to
 * {@link MAX_SNIPPET_CHARS} so the summary can never recreate the token-cap
 * problem it exists to solve — the full transcript stays one `Read
 * transcript_path` away for the rare case it is actually needed.
 *
 * Read-only open via `openDb(path, { readonly: true })`, closed in `finally`.
 * A DB read failure surfaces as an `ok:false` envelope (code `read_failed`); a
 * session with NEITHER a job row NOR any event surfaces as `ok:false` (code
 * `session_not_found`, exit 1) — both on stdout, never empty stdout + prose.
 */

import type { Database } from "bun:sqlite";
import { openDb, resolveDbPath } from "../src/db";
import {
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
  successEnvelope,
} from "./envelope";
import {
  resolveTrackedCliSession,
  type SessionReferenceCliDeps,
  trackedSessionProblem,
} from "./session-reference";

/** Envelope schema version for `keeper session summary`. */
export const SESSION_SUMMARY_SCHEMA_VERSION = 1;

/** Max characters of a prompt snippet before truncation — the whole point of
 *  the verb is to STAY bounded, so a long first/last prompt is clipped. */
export const MAX_SNIPPET_CHARS = 500;

const HELP = `keeper session summary <session-reference> [options]

Print a BOUNDED one-shot summary of one tracked Session. Qualified native ids,
exact job/native ids, and exact current/historical titles resolve through the
shared Session catalog before the Keeper job row and events are read.

Options:
  --session <ref>         Shared Session reference (alternative to positional)
  --session-id <ref>      Compatibility alias of --session
  --max-snippet <n>       Max chars per prompt snippet (default ${MAX_SNIPPET_CHARS})
  --help, -h              Show this help
`;

export interface SessionSummaryDeps extends SessionReferenceCliDeps {
  dbPath?: string;
}

interface ParsedArgs {
  sessionReference: string | null;
  maxSnippet: number;
  help: boolean;
}

function parseMax(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write(
      "keeper session summary: --max-snippet requires a value\n",
    );
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(
      `keeper session summary: --max-snippet must be a positive integer (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

function parseArgs(argv: string[]): ParsedArgs {
  const p: ParsedArgs = {
    sessionReference: null,
    maxSnippet: MAX_SNIPPET_CHARS,
    help: false,
  };
  const setReference = (value: string | undefined, spelling: string): void => {
    if (value === undefined || value.length === 0) {
      process.stderr.write(
        `keeper session summary: ${spelling} requires a value\n`,
      );
      process.exit(2);
    }
    if (p.sessionReference !== null) {
      process.stderr.write(
        "keeper session summary: specify the Session reference only once\n",
      );
      process.exit(2);
    }
    p.sessionReference = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") {
      p.help = true;
    } else if (a === "--session" || a === "--session-id") {
      setReference(argv[++i], a);
    } else if (a.startsWith("--session=") || a.startsWith("--session-id=")) {
      const spelling = a.startsWith("--session-id=")
        ? "--session-id"
        : "--session";
      setReference(a.slice(a.indexOf("=") + 1), spelling);
    } else if (a === "--max-snippet" || a.startsWith("--max-snippet=")) {
      p.maxSnippet = a.startsWith("--max-snippet=")
        ? parseMax(a.slice("--max-snippet=".length))
        : parseMax(argv[++i]);
    } else if (a.startsWith("-")) {
      process.stderr.write(
        `keeper session summary: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    } else {
      setReference(a, "<session-reference>");
    }
  }
  return p;
}

/** One truncated prompt snippet — `truncated` flags a clip at `maxSnippet`. */
export interface PromptSnippet {
  ts: number;
  text: string;
  truncated: boolean;
}

/** The bounded session summary payload. */
export interface SessionSummaryData {
  session_id: string;
  title: string | null;
  title_source: string | null;
  state: string | null;
  plan_verb: string | null;
  plan_ref: string | null;
  transcript_path: string | null;
  epic_links: unknown[];
  created_at: number | null;
  updated_at: number | null;
  first_event_ts: number | null;
  last_event_ts: number | null;
  counts: { events: number; prompts: number; tool_calls: number };
  first_prompt: PromptSnippet | null;
  last_prompt: PromptSnippet | null;
}

export type SessionSummaryResult =
  | { kind: "ok"; data: SessionSummaryData }
  | { kind: "not_found" };

/** Clip `text` to `max` chars, flagging whether it was truncated. */
function snippetOf(
  row: { ts: number; prompt: unknown } | null,
  max: number,
): PromptSnippet | null {
  if (row === null || row.prompt === null || row.prompt === undefined) {
    return null;
  }
  const full = String(row.prompt);
  const truncated = full.length > max;
  return {
    ts: row.ts,
    text: truncated ? full.slice(0, max) : full,
    truncated,
  };
}

/** Decode the `jobs.epic_links` JSON-TEXT column; a NULL / malformed blob folds
 *  to `[]` (never throws), matching the read-boundary convention. */
function decodeEpicLinks(raw: unknown): unknown[] {
  if (typeof raw !== "string" || raw.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Assemble the bounded summary for `sessionId` from the `jobs` row + the
 * `events` log. A session with NEITHER a job row NOR any event → `not_found`.
 * PURE over the db handle (no env / fs / clock) so a `freshMemDb()` fixture
 * drives every path. Exported for tests.
 */
export function loadSessionSummary(
  db: Database,
  sessionId: string,
  maxSnippet: number = MAX_SNIPPET_CHARS,
): SessionSummaryResult {
  const job = db
    .query(
      `SELECT title, title_source, state, plan_verb, plan_ref, transcript_path,
              created_at, updated_at, epic_links
         FROM jobs WHERE job_id = ?`,
    )
    .get(sessionId) as {
    title: string | null;
    title_source: string | null;
    state: string | null;
    plan_verb: string | null;
    plan_ref: string | null;
    transcript_path: string | null;
    created_at: number | null;
    updated_at: number | null;
    epic_links: unknown;
  } | null;

  const counts = db
    .query(
      `SELECT COUNT(*) AS events,
              SUM(CASE WHEN hook_event = 'UserPromptSubmit' THEN 1 ELSE 0 END) AS prompts,
              SUM(CASE WHEN hook_event = 'PreToolUse' THEN 1 ELSE 0 END) AS tool_calls,
              MIN(ts) AS first_ts,
              MAX(ts) AS last_ts
         FROM events WHERE session_id = ?`,
    )
    .get(sessionId) as {
    events: number;
    prompts: number | null;
    tool_calls: number | null;
    first_ts: number | null;
    last_ts: number | null;
  };

  const eventCount = Number(counts.events ?? 0);
  if (job === null && eventCount === 0) {
    return { kind: "not_found" };
  }

  const firstPromptRow = db
    .query(
      `SELECT ts, json_extract(data, '$.prompt') AS prompt
         FROM events
        WHERE session_id = ? AND hook_event = 'UserPromptSubmit'
        ORDER BY id ASC LIMIT 1`,
    )
    .get(sessionId) as { ts: number; prompt: unknown } | null;

  const lastPromptRow = db
    .query(
      `SELECT ts, json_extract(data, '$.prompt') AS prompt
         FROM events
        WHERE session_id = ? AND hook_event = 'UserPromptSubmit'
        ORDER BY id DESC LIMIT 1`,
    )
    .get(sessionId) as { ts: number; prompt: unknown } | null;

  return {
    kind: "ok",
    data: {
      session_id: sessionId,
      title: job?.title ?? null,
      title_source: job?.title_source ?? null,
      state: job?.state ?? null,
      plan_verb: job?.plan_verb ?? null,
      plan_ref: job?.plan_ref ?? null,
      transcript_path: job?.transcript_path ?? null,
      epic_links: decodeEpicLinks(job?.epic_links),
      created_at: job?.created_at ?? null,
      updated_at: job?.updated_at ?? null,
      first_event_ts: counts.first_ts ?? null,
      last_event_ts: counts.last_ts ?? null,
      counts: {
        events: eventCount,
        prompts: Number(counts.prompts ?? 0),
        tool_calls: Number(counts.tool_calls ?? 0),
      },
      first_prompt: snippetOf(firstPromptRow, maxSnippet),
      last_prompt: snippetOf(lastPromptRow, maxSnippet),
    },
  };
}

export function main(
  argv: string[],
  sink: EnvelopeSink = processEnvelopeSink,
  deps: SessionSummaryDeps = {},
): void {
  const args = parseArgs(argv);
  if (args.help) {
    sink.writeStdout(HELP);
    return;
  }
  if (args.sessionReference === null) {
    process.stderr.write(
      "keeper session summary: <session-reference> or --session is required\n\n",
    );
    process.stderr.write(HELP);
    process.exit(2);
  }

  const resolution = resolveTrackedCliSession(args.sessionReference, deps);
  if (resolution.kind !== "resolved") {
    emitEnvelope(
      errorEnvelope(
        SESSION_SUMMARY_SCHEMA_VERSION,
        trackedSessionProblem(resolution),
      ),
      sink,
    );
    return;
  }
  const jobId = resolution.job.jobId;

  let db: Database;
  try {
    db = openDb(deps.dbPath ?? resolveDbPath(), { readonly: true }).db;
  } catch {
    emitEnvelope(
      errorEnvelope(SESSION_SUMMARY_SCHEMA_VERSION, {
        code: "read_failed",
        message: "could not open the keeper database for the Session summary",
        recovery:
          "Confirm keeper.db is readable, then retry; this read never mutates state.",
      }),
      sink,
    );
    return;
  }

  try {
    const result = loadSessionSummary(db, jobId, args.maxSnippet);
    if (result.kind === "not_found") {
      emitEnvelope(
        errorEnvelope(SESSION_SUMMARY_SCHEMA_VERSION, {
          code: "session_not_found",
          message: "the resolved Keeper job no longer has a row or events",
          recovery:
            "Refresh `keeper history list` and retry; the job may have disappeared during the read.",
        }),
        sink,
      );
      return;
    }
    emitEnvelope(
      successEnvelope(SESSION_SUMMARY_SCHEMA_VERSION, result.data),
      sink,
    );
  } catch {
    emitEnvelope(
      errorEnvelope(SESSION_SUMMARY_SCHEMA_VERSION, {
        code: "read_failed",
        message: "could not read the resolved Keeper job summary",
        recovery:
          "Retry the read; it opens keeper.db read-only and never mutates state.",
      }),
      sink,
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
