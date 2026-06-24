/**
 * Self-test for the template-DB helper (fn-769). Pins the clone invariants so
 * the per-process serialize/deserialize swap can't silently regress:
 *
 *  - `applyPragmas` re-runs on every clone (deserialize does NOT carry
 *    connection-local pragmas — `foreign_keys` would be OFF otherwise);
 *  - the cloned schema is at the current `SCHEMA_VERSION` (stale-template guard);
 *  - a clone is a real writable DB that accepts an `events` INSERT and serves
 *    the shared `selectWorldRev` statement;
 *  - `freshDbFile` yields a valid on-disk DB file a SECOND readonly connection
 *    can open and read the same rows from.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION, selectWorldRev } from "../src/db";
import { freshDbFile, freshMemDb } from "./helpers/template-db";

/** Full named-binding object for the shared `insertEvent` statement. */
function eventBindings(ts: number): Record<string, string | number | null> {
  return {
    $ts: ts,
    $session_id: "sess-template",
    $pid: 4242,
    $hook_event: "SessionStart",
    $event_type: "SessionStart",
    $tool_name: null,
    $matcher: null,
    $cwd: "/tmp/work",
    $permission_mode: null,
    $agent_id: null,
    $agent_type: null,
    $stop_hook_active: null,
    $data: "{}",
    $subagent_agent_id: null,
    $spawn_name: null,
    $start_time: null,
    $slash_command: null,
    $skill_name: null,
    $plan_op: null,
    $plan_target: null,
    $plan_epic_id: null,
    $plan_task_id: null,
    $plan_subject_present: null,
    $tool_use_id: null,
    $config_dir: null,
    $bash_mutation_kind: null,
    $bash_mutation_targets: null,
    $plan_files: null,
    $backend_exec_type: null,
    $backend_exec_session_id: null,
    $backend_exec_pane_id: null,
    $background_task_id: null,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-template-db-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

test("freshMemDb clone has foreign_keys ON and current schema_version", () => {
  const { db } = freshMemDb();
  try {
    // PRAGMAs are NOT serialized — this asserts the helper re-runs applyPragmas.
    const fk = db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(fk.foreign_keys).toBe(1);

    const ver = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string };
    expect(Number(ver.value)).toBe(SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("freshMemDb clone accepts an events INSERT and serves selectWorldRev", () => {
  const { db, stmts } = freshMemDb();
  try {
    stmts.insertEvent.run(eventBindings(1000));
    const count = db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
      n: number;
    };
    expect(count.n).toBe(1);

    // Shared statement bundle works on the clone (fresh stmts per deserialize).
    expect(selectWorldRev(stmts)).toBe(0);
  } finally {
    db.close();
  }
});

test("freshMemDb clones are independent (template Buffer stays immutable)", () => {
  const a = freshMemDb();
  const b = freshMemDb();
  try {
    a.stmts.insertEvent.run(eventBindings(1000));
    const aCount = a.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
      n: number;
    };
    const bCount = b.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
      n: number;
    };
    // Writing clone A must not bleed into clone B (each got a private image).
    expect(aCount.n).toBe(1);
    expect(bCount.n).toBe(0);
  } finally {
    a.db.close();
    b.db.close();
  }
});

test("freshDbFile clone is a valid file a second readonly connection can read", () => {
  const path = join(tmpDir, "keeper.db");
  const writer = freshDbFile(path);
  try {
    writer.stmts.insertEvent.run(eventBindings(1000));
  } finally {
    writer.db.close();
  }

  // A serialized :memory: image is a non-WAL DB file, so a plain readonly open
  // (no WAL sidecar dance) sees the committed row.
  const reader = openDb(path, { readonly: true });
  try {
    const count = reader.db
      .prepare("SELECT COUNT(*) AS n FROM events")
      .get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  } finally {
    reader.db.close();
  }
});
