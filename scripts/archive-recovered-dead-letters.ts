#!/usr/bin/env bun
/**
 * Maintenance one-off (fn-739 task .1): archive per-pid dead-letter NDJSON
 * files whose records have ALREADY been recovered into `events`, so the
 * daemon's boot scan + watcher re-scan stop re-reading a 50M backlog of
 * already-landed records on every tick.
 *
 * BACKGROUND. The dead-letter drain (`replay_dead_letter` RPC, MAIN-only
 * writer) flips each `dead_letters` row from `waiting` → `recovered` and mints
 * the real `events` row — but it NEVER removes the on-disk per-pid file the
 * record came from. The `scanDeadLetterDir` import path is idempotent
 * (`INSERT OR IGNORE` on `dl_id`), so leaving the files in place is correct but
 * wasteful: every boot + every `@parcel/watcher` tick re-reads + re-parses the
 * whole tree. This helper performs the cleanup leg of the drain — the leg the
 * existing `drain-dead-letters.ts` (and the launchd `deadletter-drain.{sh,ts}`)
 * omit.
 *
 * DATA-SAFETY CONTRACT (the load-bearing part):
 *
 * - This is a PURE READ-ONLY OBSERVER of `keeper.db` — it opens the DB
 *   `readonly`, NEVER writes a row, NEVER emits a synthetic event, NEVER calls
 *   an RPC. Recovery itself stays MAIN-only via `replay_dead_letter`; this
 *   helper only moves files AFTER recovery is confirmed durable.
 * - A file is archived ONLY when EVERY parseable record in it is `recovered`
 *   in `dead_letters` AND its `replayed_event_id` row exists in `events`. A
 *   file containing even one record that is still `waiting` (or whose recovered
 *   row somehow lacks a landed `events` row) is LEFT IN PLACE for the drain to
 *   finish — never archived on a guess.
 * - A torn/garbage final line (`parseDeadLetterLine` → null) is SKIPPED for the
 *   eligibility decision (it was never a recoverable record), mirroring the
 *   import path's torn-tail contract. A file made up ENTIRELY of unparseable
 *   lines (zero records) is NOT archived — there is nothing to confirm landed.
 * - Files are MOVED to an `archive/` subdir, never deleted, so the recovery is
 *   reversible if a confirmation turns out wrong. Re-runnable: an
 *   already-archived file is simply absent on the next pass.
 *
 * USAGE:
 *   bun scripts/archive-recovered-dead-letters.ts            # dry run (report only)
 *   bun scripts/archive-recovered-dead-letters.ts --apply    # move eligible files
 */
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

const apply = process.argv.includes("--apply");
const dir = resolveDeadLetterDir();

if (!existsSync(dir)) {
  console.log(`[archive-dl] dead-letters dir ${dir} absent — nothing to do`);
  process.exit(0);
}

// Read-only observer connection. `migrate:false` (read-only can't migrate) and
// `prepareStmts:false` (skip the schema-pinned static statements — this script
// only runs ad-hoc SELECTs) so a schema-skewed live DB doesn't fail the open.
const { db } = openDb(resolveDbPath(), {
  readonly: true,
  migrate: false,
  prepareStmts: false,
});

// Set of dl_ids that are confirmed recovered AND whose replayed event row
// actually exists in `events`. A row marked `recovered` with a missing
// `replayed_event_id` (should never happen) is deliberately EXCLUDED so its
// file is not archived.
const recoveredRows = db
  .prepare(
    `SELECT d.dl_id AS dl_id
       FROM dead_letters d
      WHERE d.status = 'recovered'
        AND d.replayed_event_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM events e WHERE e.id = d.replayed_event_id)`,
  )
  .all() as { dl_id: string }[];
const confirmed = new Set(recoveredRows.map((r) => r.dl_id));
db.close();

const archiveDir = join(dir, "archive");

let filesArchived = 0;
let recordsArchived = 0;
let filesLeft = 0;
let filesEmpty = 0;

for (const name of readdirSync(dir)) {
  if (!name.endsWith(".ndjson")) continue;
  const full = join(dir, name);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(full);
  } catch {
    continue; // vanished between readdir and stat — skip
  }
  if (!st.isFile()) continue;

  let text: string;
  try {
    text = readFileSync(full, "utf8");
  } catch {
    continue;
  }

  // Parse every line. A null (torn / garbage) line is skipped for the
  // eligibility decision — mirrors the import path's torn-tail contract.
  const ids: string[] = [];
  let allConfirmed = true;
  for (const line of text.split("\n")) {
    const record = parseDeadLetterLine(line);
    if (record === null) continue;
    ids.push(record.dl_id);
    if (!confirmed.has(record.dl_id)) {
      allConfirmed = false;
      break;
    }
  }

  if (ids.length === 0) {
    // No recoverable record in this file (all lines torn/garbage). Nothing to
    // confirm landed — leave it untouched, don't archive on a guess.
    filesEmpty++;
    continue;
  }
  if (!allConfirmed) {
    filesLeft++;
    continue;
  }

  // Every parseable record in this file is confirmed landed → safe to archive.
  if (apply) {
    if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
    renameSync(full, join(archiveDir, name));
  }
  filesArchived++;
  recordsArchived += ids.length;
}

console.log(
  `[archive-dl] ${apply ? "ARCHIVED" : "DRY-RUN eligible"}: ${filesArchived} file(s), ${recordsArchived} record(s)` +
    (filesLeft ? ` | left (records not all landed): ${filesLeft}` : "") +
    (filesEmpty ? ` | left (no parseable record): ${filesEmpty}` : ""),
);
if (!apply && filesArchived > 0) {
  console.log(`[archive-dl] re-run with --apply to move them to ${archiveDir}`);
}
