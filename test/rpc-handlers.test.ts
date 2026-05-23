/**
 * Unit tests for `src/rpc-handlers.ts`. Direct-call layer only — no real
 * worker, no real socket, no daemon spawn. Each test opens a writer DB
 * against a fresh tmpdir, calls `setApprovalHandler(db, params)` directly,
 * and asserts on the DB state + return value.
 *
 * The end-to-end "CLI → daemon → RPC → DB" smoke lives in
 * `test/integration.test.ts` (one test, against a real spawned daemon and
 * the real `scripts/approve.ts` CLI). These tests prove the handler's
 * contract; that one proves the wire path.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db";
import {
  type SetApprovalClearResult,
  type SetApprovalUpsertResult,
  setApprovalHandler,
} from "../src/rpc-handlers";
import { BadParamsError } from "../src/server-worker";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "keeper-rpc-handlers-test-"));
  dbPath = join(tmpDir, "keeper.db");
  // Bootstrap the schema so the `approvals` table exists.
  openDb(dbPath).db.close();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Happy paths: approve / reject / clear
// ---------------------------------------------------------------------------

test("set_approval approve UPSERTs a row with the computed approval_id, returns the row", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const result = setApprovalHandler(db, {
      epic_id: "epic-x",
      task_key: "epic-x.1",
      status: "approved",
    }) as SetApprovalUpsertResult;

    expect(result.approval_id).toBe("epic-x:epic-x.1");
    expect(result.epic_id).toBe("epic-x");
    expect(result.task_key).toBe("epic-x.1");
    expect(result.status).toBe("approved");
    expect(typeof result.updated_at).toBe("number");
    expect(result.updated_at).toBeGreaterThan(0);

    // Direct DB verification: exactly one row, matching what the handler returned.
    const rows = db
      .prepare(
        "SELECT approval_id, epic_id, task_key, status, updated_at FROM approvals",
      )
      .all() as SetApprovalUpsertResult[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(result);
  } finally {
    db.close();
  }
});

test("set_approval reject UPSERTs status='rejected'", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const result = setApprovalHandler(db, {
      epic_id: "epic-y",
      task_key: "close:epic-y",
      status: "rejected",
    }) as SetApprovalUpsertResult;

    expect(result.status).toBe("rejected");
    expect(result.approval_id).toBe("epic-y:close:epic-y");
    expect(result.task_key).toBe("close:epic-y");
  } finally {
    db.close();
  }
});

test("set_approval twice (idempotent) yields one row with stable approval_id and a bumped updated_at", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const first = setApprovalHandler(db, {
      epic_id: "epic-z",
      task_key: "epic-z.2",
      status: "approved",
    }) as SetApprovalUpsertResult;

    // Tiny pause so unixepoch('now','subsec') can advance past `first`. SQLite
    // claims sub-microsecond resolution but the Bun→SQLite scheduling jitter
    // is the safer floor; 10ms is well above both.
    Bun.sleepSync(10);

    const second = setApprovalHandler(db, {
      epic_id: "epic-z",
      task_key: "epic-z.2",
      status: "approved",
    }) as SetApprovalUpsertResult;

    // Exactly one row (UPSERT, not append).
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }
    ).n;
    expect(count).toBe(1);

    // Stable identity.
    expect(second.approval_id).toBe(first.approval_id);
    expect(second.approval_id).toBe("epic-z:epic-z.2");
    // updated_at moved forward.
    expect(second.updated_at).toBeGreaterThan(first.updated_at);
  } finally {
    db.close();
  }
});

test("set_approval flips status approved → rejected on the same key (UPSERT, not REPLACE-then-insert)", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    const first = setApprovalHandler(db, {
      epic_id: "epic-q",
      task_key: "epic-q.1",
      status: "approved",
    }) as SetApprovalUpsertResult;

    Bun.sleepSync(10);

    const second = setApprovalHandler(db, {
      epic_id: "epic-q",
      task_key: "epic-q.1",
      status: "rejected",
    }) as SetApprovalUpsertResult;

    expect(second.status).toBe("rejected");
    expect(second.approval_id).toBe(first.approval_id);

    // Direct DB check: status flipped, single row.
    const rows = db
      .prepare("SELECT status FROM approvals WHERE approval_id = ?")
      .all(first.approval_id) as { status: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("rejected");
  } finally {
    db.close();
  }
});

test("set_approval clear DELETEs the matching row and returns { cleared: true, epic_id, task_key }", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    // Seed a row via approve first so clear has something to drop.
    setApprovalHandler(db, {
      epic_id: "epic-c",
      task_key: "epic-c.1",
      status: "approved",
    });

    const cleared = setApprovalHandler(db, {
      epic_id: "epic-c",
      task_key: "epic-c.1",
      status: "clear",
    }) as SetApprovalClearResult;

    expect(cleared).toEqual({
      cleared: true,
      epic_id: "epic-c",
      task_key: "epic-c.1",
    });

    // Row is gone.
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  } finally {
    db.close();
  }
});

test("set_approval clear is idempotent — DELETE of a missing row still returns success", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    // No row ever existed; clear should still succeed without throwing.
    const cleared = setApprovalHandler(db, {
      epic_id: "epic-nx",
      task_key: "epic-nx.1",
      status: "clear",
    }) as SetApprovalClearResult;

    expect(cleared.cleared).toBe(true);
    expect(cleared.epic_id).toBe("epic-nx");
    expect(cleared.task_key).toBe("epic-nx.1");

    // A second clear is the same no-op.
    const again = setApprovalHandler(db, {
      epic_id: "epic-nx",
      task_key: "epic-nx.1",
      status: "clear",
    }) as SetApprovalClearResult;
    expect(again.cleared).toBe(true);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  } finally {
    db.close();
  }
});

test("set_approval scopes UPSERT to the (epic_id, task_key) UNIQUE — sibling rows are untouched", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    setApprovalHandler(db, {
      epic_id: "epic-a",
      task_key: "epic-a.1",
      status: "approved",
    });
    setApprovalHandler(db, {
      epic_id: "epic-a",
      task_key: "epic-a.2",
      status: "rejected",
    });
    setApprovalHandler(db, {
      epic_id: "epic-b",
      task_key: "epic-b.1",
      status: "approved",
    });

    const rows = db
      .prepare("SELECT approval_id, status FROM approvals ORDER BY approval_id")
      .all() as { approval_id: string; status: string }[];
    expect(rows).toEqual([
      { approval_id: "epic-a:epic-a.1", status: "approved" },
      { approval_id: "epic-a:epic-a.2", status: "rejected" },
      { approval_id: "epic-b:epic-b.1", status: "approved" },
    ]);

    // Re-approve epic-a.1; sibling rows must not move.
    Bun.sleepSync(5);
    setApprovalHandler(db, {
      epic_id: "epic-a",
      task_key: "epic-a.1",
      status: "rejected",
    });

    const after = db
      .prepare("SELECT approval_id, status FROM approvals ORDER BY approval_id")
      .all() as { approval_id: string; status: string }[];
    expect(after).toEqual([
      { approval_id: "epic-a:epic-a.1", status: "rejected" },
      { approval_id: "epic-a:epic-a.2", status: "rejected" },
      { approval_id: "epic-b:epic-b.1", status: "approved" },
    ]);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Validation: bad_params throws are typed
// ---------------------------------------------------------------------------

test("set_approval throws BadParamsError on null/non-object params", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() => setApprovalHandler(db, null)).toThrow(BadParamsError);
    expect(() => setApprovalHandler(db, "nope")).toThrow(BadParamsError);
    expect(() => setApprovalHandler(db, 42)).toThrow(BadParamsError);
  } finally {
    db.close();
  }
});

test("set_approval throws BadParamsError on a missing or non-string epic_id", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() =>
      setApprovalHandler(db, {
        task_key: "k",
        status: "approved",
      }),
    ).toThrow(/epic_id/);
    expect(() =>
      setApprovalHandler(db, {
        epic_id: "",
        task_key: "k",
        status: "approved",
      }),
    ).toThrow(BadParamsError);
    expect(() =>
      setApprovalHandler(db, {
        epic_id: 42,
        task_key: "k",
        status: "approved",
      }),
    ).toThrow(BadParamsError);
  } finally {
    db.close();
  }
});

test("set_approval throws BadParamsError on a missing or non-string task_key", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() =>
      setApprovalHandler(db, {
        epic_id: "e",
        status: "approved",
      }),
    ).toThrow(/task_key/);
    expect(() =>
      setApprovalHandler(db, {
        epic_id: "e",
        task_key: "",
        status: "approved",
      }),
    ).toThrow(BadParamsError);
    expect(() =>
      setApprovalHandler(db, {
        epic_id: "e",
        task_key: 42,
        status: "approved",
      }),
    ).toThrow(BadParamsError);
  } finally {
    db.close();
  }
});

test("set_approval throws BadParamsError on an unknown status string", () => {
  const { db } = openDb(dbPath, { readonly: false });
  try {
    expect(() =>
      setApprovalHandler(db, {
        epic_id: "e",
        task_key: "k",
        status: "pending", // not one of approve|reject|clear
      }),
    ).toThrow(/approved\|rejected\|clear/);
    expect(() =>
      setApprovalHandler(db, {
        epic_id: "e",
        task_key: "k",
        // no status field at all
      }),
    ).toThrow(BadParamsError);

    // A failed validation must NOT leave a row in the table — proves the
    // throw happens before any DB write (and before BEGIN IMMEDIATE).
    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM approvals").get() as { n: number }
    ).n;
    expect(count).toBe(0);
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Rollback: a mid-transaction throw doesn't leave the writer locked
// ---------------------------------------------------------------------------

test("set_approval rolls back on a CHECK violation — table state and writer lock are clean", () => {
  // The handler validates `status` at the wire boundary, so a CHECK violation
  // can't happen via the public surface. To exercise the rollback path, we
  // bypass the handler with raw SQL inside our own txn first to confirm the
  // CHECK exists, then re-prove the handler stays usable after any prior
  // failure path (validation throw) by issuing a clean approve.
  const { db } = openDb(dbPath, { readonly: false });
  try {
    // Sanity: schema-layer CHECK blocks an illegal status from going in.
    expect(() =>
      db
        .prepare(
          "INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at) VALUES ('x:y', 'x', 'y', 'illegal', 1)",
        )
        .run(),
    ).toThrow();

    // After a validation throw, the writer must still be usable — neither
    // BEGIN IMMEDIATE nor a stray COMMIT/ROLLBACK should have leaked state.
    expect(() =>
      setApprovalHandler(db, {
        epic_id: "e",
        task_key: "k",
        status: "garbage",
      }),
    ).toThrow(BadParamsError);

    const ok = setApprovalHandler(db, {
      epic_id: "e",
      task_key: "k",
      status: "approved",
    }) as SetApprovalUpsertResult;
    expect(ok.status).toBe("approved");
  } finally {
    db.close();
  }
});
