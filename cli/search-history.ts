#!/usr/bin/env bun
/**
 * `keeper search-history <term>` — search the session log's UserPromptSubmit
 * rows for prompts whose payload matches a LIKE term, emitting `ts`,
 * `session_id`, and a prompt snippet as a pretty JSON envelope (epic
 * fn-794). Read-only over keeper.db so external consumers stop hand-writing
 * sqlite against a schema keeper owns.
 *
 * The prompt text lives in the event `data` payload. UserPromptSubmit is
 * keep-set, so post-shed (fn-836.4 dropped `event_blobs`) its body is ALWAYS
 * inline in `events.data` — both the LIKE filter and the snippet read resolve
 * straight from `events.data`.
 *
 * Read-only open via `openDb(path, { readonly: true })`, closed in `finally`.
 * NO schema-version guard (in-binary readers deliberately skip it). Output rides
 * the shared one-shot envelope (`cli/envelope.ts`): a hit is `data:{matches}`
 * (exit 0); a keeper.db read failure is `ok:false` with
 * `error.{code,message,recovery}` (exit 1), NOT an empty result. Argument-usage
 * errors stay on stderr (exit 2), never the envelope.
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

/** Envelope schema version for `keeper search-history`. */
export const SEARCH_HISTORY_SCHEMA_VERSION = 1;

const HELP = `keeper search-history <term> [options]

Search UserPromptSubmit history for prompts matching a LIKE term, emitting
matching rows (ts, session_id, prompt snippet) as a pretty JSON envelope.
Read-only over keeper.db — no commit, no lock. Includes compacted events.

Arguments:
  <term>               Substring to match (case-insensitive LIKE)

Options:
  --limit <n>          Max rows (most-recent-first; default 50)
  --help, -h           Show this help
`;

interface ParsedArgs {
  term: string | null;
  limit: number;
  help: boolean;
}

const DEFAULT_LIMIT = 50;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { term: null, limit: DEFAULT_LIMIT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      parsed.help = true;
    } else if (a === "--limit") {
      parsed.limit = parseLimit(argv[++i]);
    } else if (a.startsWith("--limit=")) {
      parsed.limit = parseLimit(a.slice("--limit=".length));
    } else if (a.startsWith("-")) {
      process.stderr.write(
        `keeper search-history: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    } else if (parsed.term === null) {
      parsed.term = a;
    } else {
      process.stderr.write(
        `keeper search-history: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write("keeper search-history: --limit requires a value\n");
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(
      `keeper search-history: --limit must be a positive integer (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

interface HistoryRow {
  ts: number;
  session_id: string;
  prompt: string | null;
}

/**
 * Scan UserPromptSubmit rows whose payload's `$.prompt` LIKE-matches `term`,
 * most-recent-first. UserPromptSubmit is keep-set, so its body is always inline
 * in `events.data` — fn-836.4 dropped the `event_blobs` side table and its
 * COALESCE dual-read.
 */
function searchHistory(
  dbPath: string,
  term: string,
  limit: number,
): HistoryRow[] {
  const { db } = openDb(dbPath, { readonly: true });
  try {
    return db
      .query(
        `SELECT events.ts AS ts,
                events.session_id AS session_id,
                json_extract(events.data, '$.prompt') AS prompt
           FROM events
          WHERE events.hook_event = 'UserPromptSubmit'
            AND json_extract(events.data, '$.prompt') LIKE ? ESCAPE '\\'
          ORDER BY events.id DESC
          LIMIT ?`,
      )
      .all(`%${escapeLike(term)}%`, limit) as HistoryRow[];
  } finally {
    db.close();
  }
}

/** Escape LIKE wildcards so a term with `%`/`_`/`\` matches literally. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
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
  if (args.term === null) {
    process.stderr.write("keeper search-history: <term> is required\n\n");
    process.stderr.write(HELP);
    process.exit(2);
  }
  // A read failure surfaces as an ok:false envelope, never an empty result.
  let rows: HistoryRow[];
  try {
    rows = searchHistory(resolveDbPath(), args.term, args.limit);
  } catch {
    emitEnvelope(
      errorEnvelope(SEARCH_HISTORY_SCHEMA_VERSION, {
        code: "read_failed",
        message: "could not read prompt history from the keeper database",
        recovery: RECOVERY_DB_READ,
      }),
      sink,
    );
    return;
  }
  emitEnvelope(
    successEnvelope(SEARCH_HISTORY_SCHEMA_VERSION, { matches: rows }),
    sink,
  );
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
