#!/usr/bin/env bun
/**
 * `keeper session events <session-reference>` — resolve one tracked Session
 * and emit its prompt/tool-call spine as a pretty JSON envelope: the ordered
 * UserPromptSubmit / PreToolUse rows with `ts`, `hook_event`, `tool_name`,
 * `slash_command`, `skill_name`, and `plan_op`. Read-only over keeper.db so
 * external consumers stop hand-writing sqlite against a schema keeper owns.
 *
 * The spine fields are all direct `events` columns (derived at ingest), so no
 * payload `data` read is needed — this is a plain column scan, ordered by `id`
 * ASC for stable chronology.
 *
 * Read-only open via `openDb(path, { readonly: true })`, closed in `finally`.
 * NO schema-version guard (in-binary readers deliberately skip it). Output rides
 * the shared one-shot envelope (`cli/envelope.ts`): a hit is
 * `data:{session_id, events}` (exit 0); a keeper.db read failure is `ok:false`
 * with `error.{code,message,recovery}` (exit 1), NOT an empty result.
 * Argument-usage errors (including a missing Session reference) stay on stderr
 * (exit 2),
 * never the envelope.
 */

import { openDb, resolveDbPath } from "../src/db";
import {
  type EnvelopeSink,
  emitEnvelope,
  errorEnvelope,
  processEnvelopeSink,
  RECOVERY_DB_READ,
  successEnvelope,
} from "./envelope";
import {
  resolveTrackedCliSession,
  type SessionReferenceCliDeps,
  trackedSessionProblem,
} from "./session-reference";

/** Envelope schema version for `keeper session events`. */
export const SHOW_SESSION_EVENTS_SCHEMA_VERSION = 1;

const HELP = `keeper session events <session-reference> [options]

Emit the prompt/tool-call spine for one tracked Session, ordered chronologically.
Qualified native ids, exact job/native ids, and exact current/historical titles
resolve through the shared Session catalog before the Keeper job is read.

Options:
  --session <ref>       Shared Session reference (alternative to positional)
  --session-id <ref>    Compatibility alias of --session
  --limit <n>           Max rows (chronological; default 500)
  --help, -h            Show this help
`;

export interface SessionEventsDeps extends SessionReferenceCliDeps {
  dbPath?: string;
}

interface ParsedArgs {
  sessionReference: string | null;
  limit: number;
  help: boolean;
}

const DEFAULT_LIMIT = 500;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    sessionReference: null,
    limit: DEFAULT_LIMIT,
    help: false,
  };
  const setReference = (value: string | undefined, spelling: string): void => {
    if (value === undefined || value.length === 0) {
      process.stderr.write(
        `keeper session events: ${spelling} requires a value\n`,
      );
      process.exit(2);
    }
    if (parsed.sessionReference !== null) {
      process.stderr.write(
        "keeper session events: specify the Session reference only once\n",
      );
      process.exit(2);
    }
    parsed.sessionReference = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--session" || a === "--session-id") {
      setReference(argv[++i], a);
    } else if (a.startsWith("--session=")) {
      setReference(a.slice("--session=".length), "--session");
    } else if (a.startsWith("--session-id=")) {
      setReference(a.slice("--session-id=".length), "--session-id");
    } else if (a === "--limit") {
      parsed.limit = parseLimit(argv[++i]);
    } else if (a.startsWith("--limit=")) {
      parsed.limit = parseLimit(a.slice("--limit=".length));
    } else if (!a.startsWith("-")) {
      setReference(a, "<session-reference>");
    } else {
      process.stderr.write(
        `keeper session events: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write("keeper session events: --limit requires a value\n");
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(
      `keeper session events: --limit must be a positive integer (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

interface SpineRow {
  ts: number;
  hook_event: string;
  tool_name: string | null;
  slash_command: string | null;
  skill_name: string | null;
  plan_op: string | null;
}

/**
 * Load the UserPromptSubmit / PreToolUse spine for `sessionId`, ordered by `id`
 * ASC (stable chronology). All fields are direct `events` columns.
 */
export function showSessionEvents(
  dbPath: string,
  sessionId: string,
  limit: number,
): SpineRow[] {
  const { db } = openDb(dbPath, { readonly: true });
  try {
    return db
      .query(
        `SELECT ts, hook_event, tool_name, slash_command, skill_name, plan_op
           FROM events
          WHERE session_id = ?
            AND hook_event IN ('UserPromptSubmit', 'PreToolUse')
          ORDER BY id ASC
          LIMIT ?`,
      )
      .all(sessionId, limit) as SpineRow[];
  } finally {
    db.close();
  }
}

export function main(
  argv: string[],
  sink: EnvelopeSink = processEnvelopeSink,
  deps: SessionEventsDeps = {},
): void {
  const args = parseArgs(argv);
  if (args.help) {
    sink.writeStdout(HELP);
    return;
  }
  if (args.sessionReference === null) {
    process.stderr.write(
      "keeper session events: <session-reference> or --session is required\n\n",
    );
    process.stderr.write(HELP);
    process.exit(2);
  }
  const resolution = resolveTrackedCliSession(args.sessionReference, deps);
  if (resolution.kind !== "resolved") {
    emitEnvelope(
      errorEnvelope(
        SHOW_SESSION_EVENTS_SCHEMA_VERSION,
        trackedSessionProblem(resolution),
      ),
      sink,
    );
    return;
  }
  const jobId = resolution.job.jobId;
  // A read failure surfaces as an ok:false envelope, never an empty result.
  let rows: SpineRow[];
  try {
    rows = showSessionEvents(deps.dbPath ?? resolveDbPath(), jobId, args.limit);
  } catch {
    emitEnvelope(
      errorEnvelope(SHOW_SESSION_EVENTS_SCHEMA_VERSION, {
        code: "read_failed",
        message:
          "could not read the session event spine from the keeper database",
        recovery: RECOVERY_DB_READ,
      }),
      sink,
    );
    return;
  }
  emitEnvelope(
    successEnvelope(SHOW_SESSION_EVENTS_SCHEMA_VERSION, {
      session_id: jobId,
      events: rows,
    }),
    sink,
  );
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
