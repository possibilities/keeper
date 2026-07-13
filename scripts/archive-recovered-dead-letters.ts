#!/usr/bin/env bun
/** Archive dead-letter files only after every parseable record is durable. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { openDb, resolveDbPath, resolveDeadLetterDir } from "../src/db";
import { parseDeadLetterLine } from "../src/dead-letter";

export interface ArchiveEligibility {
  eligible: boolean;
  records: number;
}

/** Pure archive gate. Torn lines do not count; an all-torn file is ineligible. */
export function archiveEligibility(
  text: string,
  confirmed: ReadonlySet<string>,
): ArchiveEligibility {
  let records = 0;
  for (const line of text.split("\n")) {
    const record = parseDeadLetterLine(line);
    if (record === null) continue;
    records += 1;
    if (!confirmed.has(record.dl_id)) return { eligible: false, records };
  }
  return { eligible: records > 0, records };
}

export function runArchive(apply: boolean, dir = resolveDeadLetterDir()): void {
  if (!existsSync(dir)) {
    console.log(`[archive-dl] dead-letters dir ${dir} absent — nothing to do`);
    return;
  }
  const { db } = openDb(resolveDbPath(), {
    readonly: true,
    migrate: false,
    prepareStmts: false,
  });
  const recoveredRows = db
    .prepare(
      `SELECT d.dl_id AS dl_id
         FROM dead_letters d
        WHERE d.status = 'recovered'
          AND d.replayed_event_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM events e WHERE e.id = d.replayed_event_id)`,
    )
    .all() as { dl_id: string }[];
  db.close();
  const confirmed = new Set(recoveredRows.map((row) => row.dl_id));
  const archiveDir = join(dir, "archive");
  let filesArchived = 0;
  let recordsArchived = 0;
  let filesLeft = 0;
  let filesEmpty = 0;

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ndjson")) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
      const decision = archiveEligibility(readFileSync(full, "utf8"), confirmed);
      if (decision.records === 0) {
        filesEmpty += 1;
      } else if (!decision.eligible) {
        filesLeft += 1;
      } else {
        if (apply) {
          if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
          renameSync(full, join(archiveDir, name));
        }
        filesArchived += 1;
        recordsArchived += decision.records;
      }
    } catch {
      // A concurrently removed or unreadable file is retried by a later run.
    }
  }
  console.log(
    `[archive-dl] ${apply ? "ARCHIVED" : "DRY-RUN eligible"}: ${filesArchived} file(s), ${recordsArchived} record(s)` +
      (filesLeft ? ` | left (records not all landed): ${filesLeft}` : "") +
      (filesEmpty ? ` | left (no parseable record): ${filesEmpty}` : ""),
  );
  if (!apply && filesArchived > 0) {
    console.log(`[archive-dl] re-run with --apply to move them to ${archiveDir}`);
  }
}

if (import.meta.main) runArchive(process.argv.includes("--apply"));
