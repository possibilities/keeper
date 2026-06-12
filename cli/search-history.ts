#!/usr/bin/env bun
/**
 * `keeper search-history <term>` — search the session log's UserPromptSubmit
 * rows for prompts whose payload matches a LIKE term, emitting `ts`,
 * `session_id`, and a prompt snippet as a pretty JSON envelope (epic
 * fn-794). Read-only over keeper.db so external consumers stop hand-writing
 * sqlite against a schema keeper owns.
 *
 * The prompt text lives ONLY in the event `data` payload, which the
 * daemon-side compaction relocator can NULL inline after copying the blob to
 * `event_blobs`. So BOTH the LIKE filter and the snippet read resolve through
 * `COALESCE(events.data, event_blobs.data)` with a `LEFT JOIN event_blobs` —
 * a compacted (older) event is otherwise silently missed.
 *
 * Read-only open via `openDb(path, { readonly: true })`, closed in `finally`.
 * NO schema-version guard (in-binary readers deliberately skip it). A read
 * failure surfaces as an error envelope (`{ success: false, error }`), NOT an
 * empty result.
 */

import { openDb, resolveDbPath } from "../src/db";

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

/** Emit a pretty (`indent=2`, trailing `\n`) JSON envelope. */
function printPretty(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

interface HistoryRow {
  ts: number;
  session_id: string;
  prompt: string | null;
}

/**
 * Scan UserPromptSubmit rows whose COALESCEd payload's `$.prompt` LIKE-matches
 * `term`, most-recent-first. The blob VALUE and the LIKE filter both resolve
 * via `COALESCE(events.data, event_blobs.data)` so a relocated payload still
 * matches and re-reads byte-identically.
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
                json_extract(COALESCE(events.data, event_blobs.data), '$.prompt') AS prompt
           FROM events
           LEFT JOIN event_blobs ON event_blobs.event_id = events.id
          WHERE events.hook_event = 'UserPromptSubmit'
            AND json_extract(COALESCE(events.data, event_blobs.data), '$.prompt') LIKE ? ESCAPE '\\'
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

export function main(argv: string[]): void {
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
  // A read failure surfaces as an error envelope, never an empty result.
  let rows: HistoryRow[];
  try {
    rows = searchHistory(resolveDbPath(), args.term, args.limit);
  } catch (e) {
    printPretty({ success: false, error: String(e) });
    process.exit(1);
  }
  printPretty({ success: true, matches: rows });
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
