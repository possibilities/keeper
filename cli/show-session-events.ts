#!/usr/bin/env bun
/**
 * `keeper show-session-events --session-id <id>` — emit the prompt/tool-call
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
 * NO schema-version guard (in-binary readers deliberately skip it). A read
 * failure surfaces as an error envelope (`{ success: false, error }`), NOT an
 * empty result. `--session-id` is REQUIRED.
 */

import { openDb, resolveDbPath } from "../src/db";

const HELP = `keeper show-session-events --session-id <id> [options]

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
        `keeper show-session-events: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write(
      "keeper show-session-events: --limit requires a value\n",
    );
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(
      `keeper show-session-events: --limit must be a positive integer (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

/** Emit a pretty (`indent=2`, trailing `\n`) JSON envelope. */
function printPretty(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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

export function main(argv: string[]): void {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.sessionId === null) {
    process.stderr.write(
      "keeper show-session-events: --session-id is required\n\n",
    );
    process.stderr.write(HELP);
    process.exit(2);
  }
  // A read failure surfaces as an error envelope, never an empty result.
  let rows: SpineRow[];
  try {
    rows = showSessionEvents(resolveDbPath(), args.sessionId, args.limit);
  } catch (e) {
    printPretty({ success: false, error: String(e) });
    process.exit(1);
  }
  printPretty({ success: true, session_id: args.sessionId, events: rows });
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
