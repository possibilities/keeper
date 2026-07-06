#!/usr/bin/env bun
/**
 * `keeper session events --session-id <id>` — emit the prompt/tool-call
 * spine for one session as a pretty JSON envelope (epic fn-794): the ordered
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
 * Argument-usage errors (incl. missing `--session-id`) stay on stderr (exit 2),
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

/** Envelope schema version for `keeper session events`. */
export const SHOW_SESSION_EVENTS_SCHEMA_VERSION = 1;

const HELP = `keeper session events --session-id <id> [options]

Emit the prompt/tool-call spine for one session (ts, hook_event, tool_name,
slash_command, skill_name, plan_op) as a pretty JSON envelope, ordered
chronologically. Read-only over keeper.db — no commit, no lock.

Options:
  --session-id <id>    Claude Code session id (REQUIRED)
  --limit <n>          Max rows (chronological; default 500)
  --help, -h           Show this help
`;

interface ParsedArgs {
  sessionId: string | null;
  limit: number;
  help: boolean;
}

const DEFAULT_LIMIT = 500;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    sessionId: null,
    limit: DEFAULT_LIMIT,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--session-id") {
      parsed.sessionId = argv[++i] ?? null;
    } else if (a.startsWith("--session-id=")) {
      parsed.sessionId = a.slice("--session-id=".length);
    } else if (a === "--limit") {
      parsed.limit = parseLimit(argv[++i]);
    } else if (a.startsWith("--limit=")) {
      parsed.limit = parseLimit(a.slice("--limit=".length));
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
function showSessionEvents(
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
): void {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.sessionId === null) {
    process.stderr.write("keeper session events: --session-id is required\n\n");
    process.stderr.write(HELP);
    process.exit(2);
  }
  // A read failure surfaces as an ok:false envelope, never an empty result.
  let rows: SpineRow[];
  try {
    rows = showSessionEvents(resolveDbPath(), args.sessionId, args.limit);
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
      session_id: args.sessionId,
      events: rows,
    }),
    sink,
  );
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
