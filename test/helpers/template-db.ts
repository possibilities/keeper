/**
 * Template-DB helper for the fast unit-test tier (fn-769).
 *
 * REPLACES the `openDb(":memory:")`-per-test pattern in pure in-process unit
 * tests (reducer.test.ts and friends). The default `bun test` run paid its
 * dominant cost in ~1,200 per-test `openDb()` calls, each re-running the full
 * 63-version `migrate()` ladder (~27-40ms each ≈ 48s of CPU jamming `--parallel`
 * on the dev machine). The migration is deterministic and identical across every
 * test, so we run it ONCE per process and hand each test a private clone of the
 * already-migrated image:
 *
 *  1. Build the template ONCE (lazily, module-scope): `openDb(":memory:")` runs
 *     the full ladder, then `db.serialize()` captures the migrated image as an
 *     immutable `Buffer`. The source connection is closed; only the Buffer
 *     survives. Validated by probe: reducer.test.ts 470/470 pass, 28.9s → 6.5s.
 *  2. Per test, `Database.deserialize(TEMPLATE)` clones that image into a fresh
 *     private writable DB (~0.2ms — no migration). Each clone gets its OWN
 *     writable copy; the template Buffer is NEVER handed to anything that writes.
 *
 * SERIALIZE PATH IS `:memory:`-ONLY. `sqlite3_deserialize` rejects WAL-mode
 * images with SQLITE_CANTOPEN. `journal_mode = WAL` is a silent no-op on a
 * `:memory:` DB (memory DBs have no rollback journal / WAL file), so the image
 * built from `:memory:` is a plain non-WAL page image and deserializes cleanly.
 * A file-built template WOULD be a WAL image and would fail — never build the
 * template from a file path. This same property makes the serialized image a
 * valid standalone DB FILE (see `freshDbFile`): writing the Buffer to disk
 * yields a non-WAL DB with no `-wal` sidecar to strand.
 *
 * STALE-TEMPLATE GUARD. The build asserts `meta.schema_version === SCHEMA_VERSION`
 * and hard-throws on mismatch. If a future migration bumps SCHEMA_VERSION but
 * the serialized image somehow lagged, the throw fires loudly instead of
 * silently handing tests a sub-current schema. (`prepareStmts` is a second
 * implicit guard: its static `insertEvent` names every events column, so it
 * throws "no such column" on any sub-v63 template.)
 *
 * PRAGMAS ARE NOT SERIALIZED. Connection-local PRAGMAs (`foreign_keys`,
 * `busy_timeout`, etc.) do NOT travel in the serialized image — a fresh clone
 * has `foreign_keys` OFF immediately post-deserialize (verified). Every clone
 * MUST re-run `applyPragmas`; the helper never skips it.
 *
 * RE-FOLD DETERMINISM. Same-connection rewind (DELETE the projection tables +
 * re-drain on the SAME `db` handle) still holds on a deserialized clone — the
 * clone is an ordinary writable DB, just one that skipped migration. No clone
 * shares state with another, so a test rewinding its own connection is unaffected.
 *
 * @see test/helpers/sandbox-env.ts — the SIBLING helper for PROCESS-SPAWN
 *   isolation (real hook/CLI subprocesses). Use `sandboxEnv` when a test spawns
 *   a subprocess that opens its own DB; use THIS helper for pure in-process unit
 *   tests that just need a migrated schema cheaply.
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import {
  applyPragmas,
  type KeeperDb,
  openDb,
  prepareStmts,
  SCHEMA_VERSION,
} from "../../src/db";

/**
 * Lazily-memoized migrated `:memory:` image, built once per file-process.
 *
 * Under `bun test --parallel` (bun ≥1.3.13, one process per file) this rebuilds
 * per file-process — ~8-40ms once, amortized across that file's whole test set.
 * There is no cross-file sharing to lose. The Buffer is immutable: every
 * consumer gets a PRIVATE writable copy via `Database.deserialize`; the template
 * itself is never written.
 *
 * NOTE: `reducer_state.updated_at` (and any other build-time wall-clock column)
 * is frozen at template-build time and SHARED by every clone in this process —
 * never assert per-test freshness on it.
 */
let TEMPLATE: Buffer | undefined;

function template(): Buffer {
  if (TEMPLATE === undefined) {
    const { db } = openDb(":memory:");
    const stored = Number(
      (
        db
          .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
          .get() as { value: string } | null
      )?.value ?? "0",
    );
    if (stored !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `template-db: built schema_version ${stored} !== SCHEMA_VERSION ${SCHEMA_VERSION} ` +
          "(stale template — re-build the :memory: image against the current migrate() ladder)",
      );
    }
    // `serialize()` of a `:memory:` DB is a plain non-WAL page image (WAL is a
    // no-op on memory DBs), so it is both deserialize-safe AND a valid standalone
    // DB file. Capture it, then drop the source connection — only the Buffer lives.
    TEMPLATE = db.serialize();
    db.close();
  }
  return TEMPLATE;
}

/**
 * Fresh in-process clone of the migrated template — the drop-in replacement for
 * `openDb(":memory:")` in pure unit tests. Returns the exact {@link KeeperDb}
 * shape (`{ db, stmts }`) so call sites swap one constructor for another.
 *
 * `Database.deserialize` clones the image into a private writable `:memory:` DB
 * skipping the full migration; we then re-apply the connection-local pragmas
 * (deserialize does NOT carry them — `foreign_keys` would be OFF otherwise) and
 * build fresh prepared statements (statements never cross `Database` instances).
 */
export function freshMemDb(): KeeperDb {
  // Options-object form. FOOTGUN: the positional-boolean overload
  // `Database.deserialize(buf, true)` sets `strict`, NOT `readonly` — passing a
  // bare `true` here would silently give a writable strict-mode DB, not the
  // read-only one a reader might expect. Always use the options object.
  const db = Database.deserialize(template());
  applyPragmas(db);
  const stmts = prepareStmts(db);
  return { db, stmts };
}

/**
 * Fresh on-disk clone of the migrated template for MULTI-CONNECTION tests (a
 * body opens a second `openDb(path, { readonly: true })` against the same file).
 *
 * The serialized `:memory:` image is a valid non-WAL DB file by construction, so
 * we just write the Buffer to `path` and reopen with migration skipped — no
 * WAL-checkpoint dance, no `-wal` sidecar to strand. Returns the same
 * {@link KeeperDb} shape as `openDb`.
 */
export function freshDbFile(path: string): KeeperDb {
  // Write a fresh PRIVATE copy of the template image to disk. `Buffer.from`
  // defensively copies so a downstream truncation/append can never reach the
  // shared immutable template Buffer.
  writeFileSync(path, Buffer.from(template()));
  return openDb(path, { migrate: false });
}
