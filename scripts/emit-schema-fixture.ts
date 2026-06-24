#!/usr/bin/env bun
/**
 * Emit the sitter's consumer-driven schema contract — a FRESH-migrate dump of
 * keeper's DDL at the current SCHEMA_VERSION — to stdout. The sitter's
 * `bun run repin-schema` helper (~/code/sitter/scripts/repin-schema.ts) invokes
 * this via SUBPROCESS so it can regenerate `test/fixtures/schema-v<N>.sql`
 * without importing keeper source (the sitter's zero-keeper-import fence).
 *
 * Provenance is the load-bearing constraint: the sitter fixture mirrors keeper's
 * MIGRATED shape, not a live keeper.db. A live DB carries history a fresh
 * migrate sheds — legacy ghost tables (e.g. a pre-v7 `tasks` table the v6->v7
 * migration only drops `IF EXISTS`) and ALTER-appended columns flattened inline
 * by SQLite — so dumping the live DB would diverge from the committed fixture by
 * dozens of lines. Opening a fresh on-disk DB and running the full `migrate()`
 * ladder reproduces the fixture byte-identically.
 *
 * Output (stdout): the SCHEMA_VERSION integer on the first line, then the DDL
 * body — one `CREATE …;` per `sqlite_master` row, tables before indexes, each
 * group by name, verbatim `sql` preserved, trailing newline. The ORDER BY
 * matches the committed fixture's generation so an unchanged schema regenerates
 * to a no-op diff. `sqlite_`-internal objects are excluded (SQLite re-creates
 * them on demand and rejects re-execution by name).
 *
 * Usage:
 *   bun scripts/emit-schema-fixture.ts   # → "<version>\n<ddl-body>" on stdout
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION } from "../src/db";

/**
 * The DDL dump ORDER BY. `(type='index')` sorts tables (false → 0) before
 * indexes (true → 1); `name` orders within each group. Changing this reorders
 * the fixture and defeats the no-op-diff regen contract.
 */
const DUMP_QUERY =
  "SELECT sql FROM sqlite_master " +
  "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
  "ORDER BY (type='index'), name";

function emitFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "keeper-schema-fixture-"));
  const path = join(dir, "fresh.db");
  // openDb on a fresh path runs the full migrate() ladder to SCHEMA_VERSION.
  const { db } = openDb(path);
  try {
    const rows = db.query(DUMP_QUERY).all() as { sql: string }[];
    // Preserve each `sql` verbatim; terminate with `;` + newline, plus a
    // trailing newline after the last statement — the diff IS the signal.
    const body = `${rows.map((r) => `${r.sql};`).join("\n")}\n`;
    return `${SCHEMA_VERSION}\n${body}`;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function main(): void {
  process.stdout.write(emitFixture());
}

if (import.meta.main) {
  main();
}
