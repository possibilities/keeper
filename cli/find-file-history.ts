#!/usr/bin/env bun
/**
 * `keeper find-file-history <path-fragment>` — list `file_attributions` rows
 * whose `file_path` LIKE-matches a fragment, most-recent-first, emitting
 * `session_id`, mutation time, `op`, `source`, and `project_dir` as a pretty
 * JSON envelope (epic fn-794). Read-only over keeper.db so external consumers
 * stop hand-writing sqlite against a schema keeper owns.
 *
 * `file_attributions` is a reducer PROJECTION (direct columns, no payload
 * blob), so no `events`/`event_blobs` COALESCE is needed here — the read is a
 * plain LIKE scan over the table.
 *
 * SCOPE — `file_attributions` is a LIVE-ONLY projection (fn-868): boot-seeded +
 * kept current ABOVE a skip-floor, NOT replayed from history. So this surface is
 * the current attribution state (currently-dirty + recently-discharged paths),
 * NOT a deep historical ledger — ancient attributions a full replay would have
 * carried are not re-derived. For exhaustive per-file mutation history, query the
 * event log (`events` mutation rows) rather than this projection.
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

/** Envelope schema version for `keeper find-file-history`. */
export const FIND_FILE_HISTORY_SCHEMA_VERSION = 1;

const HELP = `keeper find-file-history <path-fragment> [options]

List file attributions whose path LIKE-matches a fragment, most-recent-first
(session_id, mutation time, op, source, project_dir), as a pretty JSON
envelope. Read-only over keeper.db — no commit, no lock.

Arguments:
  <path-fragment>      Substring to match against file_path (case-insensitive)

Options:
  --limit <n>          Max rows (most-recent-first; default 50)
  --help, -h           Show this help
`;

interface ParsedArgs {
  fragment: string | null;
  limit: number;
  help: boolean;
}

const DEFAULT_LIMIT = 50;

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    fragment: null,
    limit: DEFAULT_LIMIT,
    help: false,
  };
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
        `keeper find-file-history: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    } else if (parsed.fragment === null) {
      parsed.fragment = a;
    } else {
      process.stderr.write(
        `keeper find-file-history: unexpected argument '${a}'\n`,
      );
      process.exit(2);
    }
  }
  return parsed;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    process.stderr.write(
      "keeper find-file-history: --limit requires a value\n",
    );
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    process.stderr.write(
      `keeper find-file-history: --limit must be a positive integer (got '${raw}')\n`,
    );
    process.exit(2);
  }
  return n;
}

interface FileHistoryRow {
  project_dir: string;
  session_id: string;
  file_path: string;
  last_mutation_at: number;
  op: string;
  source: string;
}

/**
 * Scan `file_attributions` for rows whose `file_path` LIKE-matches `fragment`,
 * ordered by `last_mutation_at` DESC (most-recent-first).
 */
function findFileHistory(
  dbPath: string,
  fragment: string,
  limit: number,
): FileHistoryRow[] {
  const { db } = openDb(dbPath, { readonly: true });
  try {
    return db
      .query(
        `SELECT project_dir, session_id, file_path,
                last_mutation_at, op, source
           FROM file_attributions
          WHERE file_path LIKE ? ESCAPE '\\'
          ORDER BY last_mutation_at DESC
          LIMIT ?`,
      )
      .all(`%${escapeLike(fragment)}%`, limit) as FileHistoryRow[];
  } finally {
    db.close();
  }
}

/** Escape LIKE wildcards so a fragment with `%`/`_`/`\` matches literally. */
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
  if (args.fragment === null) {
    process.stderr.write(
      "keeper find-file-history: <path-fragment> is required\n\n",
    );
    process.stderr.write(HELP);
    process.exit(2);
  }
  // A read failure surfaces as an ok:false envelope, never an empty result.
  let rows: FileHistoryRow[];
  try {
    rows = findFileHistory(resolveDbPath(), args.fragment, args.limit);
  } catch {
    emitEnvelope(
      errorEnvelope(FIND_FILE_HISTORY_SCHEMA_VERSION, {
        code: "read_failed",
        message: "could not read file attributions from the keeper database",
        recovery: RECOVERY_DB_READ,
      }),
      sink,
    );
    return;
  }
  emitEnvelope(
    successEnvelope(FIND_FILE_HISTORY_SCHEMA_VERSION, { matches: rows }),
    sink,
  );
}

if (import.meta.main) {
  main(Bun.argv.slice(3));
}
