/**
 * Concrete RPC handlers registered against the server-worker's `RPC_REGISTRY`.
 * The registry is process-global; importing this module from
 * `src/server-worker.ts` is what installs the handlers into the worker thread.
 * No side effect runs at main-thread import time other than the
 * `registerRpc(...)` calls at the bottom of the file — which is the design:
 * the worker module imports this, so registration happens once per worker
 * spawn, and tests that import the worker module piecemeal opt out by not
 * importing this file.
 *
 * Currently registers ONE handler:
 *
 * - `set_approval` — the first concrete RPC. UPSERTs (or DELETEs, on
 *   `status: "clear"`) one row of the `approvals` sidecar (schema v12, see
 *   `src/db.ts` `CREATE_APPROVALS`). Params shape `{ epic_id, task_key,
 *   status: "approved" | "rejected" | "clear" }`. The handler is the SOLE
 *   write path into `approvals`; the autopilot UI subscribes to the
 *   `approvals` collection (read-only) and reflects the rows this RPC lands.
 *
 * Why a separate module rather than living in `src/server-worker.ts`: the
 * server-worker file already carries the lock/dispatch/lifecycle/poll
 * machinery; piling per-RPC handler bodies into it would hide the dispatch
 * shell behind feature code. Adding a future RPC is one more handler here
 * plus one more `registerRpc(...)` call — no edit to `src/server-worker.ts`
 * required.
 *
 * Contract a handler MUST honor:
 * - Validate `params` shape and throw `BadParamsError` on mismatch (the
 *   dispatcher frames a `bad_params` error and the connection survives).
 * - Wrap any multi-statement write in a SQLite transaction (`BEGIN
 *   IMMEDIATE` per the epic's Best practices — DEFERRED upgrades mid-txn
 *   and ignores `busy_timeout`, surfacing as spurious `SQLITE_BUSY`).
 * - Return a plain JSON-stringifiable value; the dispatcher frames it as
 *   `rpc_result.value`.
 * - NEVER call `db.close()` — the connection's lifetime belongs to the
 *   server-worker's `main()`.
 */

import type { Database } from "bun:sqlite";
import { BadParamsError, registerRpc } from "./server-worker";
import type { Approval } from "./types";

/**
 * `set_approval` params shape: the natural key `(epic_id, task_key)` plus the
 * desired `status`. `status` is the wire-level vocabulary — `"approved"` /
 * `"rejected"` are persisted as-is; `"clear"` is the DELETE branch (absent row
 * = "pending" per the schema-v12 invariant) and never lands a stored status.
 */
export interface SetApprovalParams {
  epic_id: string;
  task_key: string;
  status: "approved" | "rejected" | "clear";
}

/**
 * The successful return shape on the approve/reject branches: the full row
 * (post-UPSERT) so the caller renders without a re-read. Mirrors the
 * `Approval` shape from `src/types.ts` — `approval_id` is the
 * `epic_id || ':' || task_key` composition the writer derives.
 */
export type SetApprovalUpsertResult = Approval;

/**
 * The successful return shape on the clear branch: a thin acknowledgment.
 * `cleared` is always `true`; the caller pairs it with the `(epic_id,
 * task_key)` it sent. `clear` is idempotent — DELETE of a non-existent row
 * still returns this success shape (no row matched is not an error here, just
 * a no-op).
 */
export interface SetApprovalClearResult {
  cleared: true;
  epic_id: string;
  task_key: string;
}

export type SetApprovalResult =
  | SetApprovalUpsertResult
  | SetApprovalClearResult;

/**
 * Validate the wire `params` shape into a typed object or throw
 * `BadParamsError`. All three fields are required + must be non-empty strings;
 * `status` must be one of the three literals. The dispatcher catches the
 * throw and frames a `bad_params` error.
 *
 * Validation happens at the wire boundary in addition to the DB-layer CHECK
 * constraint on `approvals.status` — defense in depth, per the epic's Best
 * practices. The CHECK catches direct writers and schema-level corruption;
 * this handler-side gate catches typos before paying SQLite cold-start cost
 * and surfaces a typed error frame the caller can show to the human.
 */
function validateSetApprovalParams(params: unknown): SetApprovalParams {
  if (params === null || typeof params !== "object") {
    throw new BadParamsError("set_approval: params must be an object");
  }
  const obj = params as Record<string, unknown>;

  if (typeof obj.epic_id !== "string" || obj.epic_id.length === 0) {
    throw new BadParamsError(
      "set_approval: `epic_id` must be a non-empty string",
    );
  }
  if (typeof obj.task_key !== "string" || obj.task_key.length === 0) {
    throw new BadParamsError(
      "set_approval: `task_key` must be a non-empty string",
    );
  }
  if (
    obj.status !== "approved" &&
    obj.status !== "rejected" &&
    obj.status !== "clear"
  ) {
    throw new BadParamsError(
      "set_approval: `status` must be one of approved|rejected|clear",
    );
  }
  return {
    epic_id: obj.epic_id,
    task_key: obj.task_key,
    status: obj.status,
  };
}

/**
 * `set_approval` handler. UPSERTs (or DELETEs on `status: "clear"`) one row of
 * the `approvals` sidecar.
 *
 * Approve / reject branch:
 *   - Derive `approval_id = epic_id || ':' || task_key` (the writer is the
 *     SOLE source of truth for the composition; the schema column is bare to
 *     keep `selectByIds` / `countAndToken` cheap — see `src/db.ts`).
 *   - UPSERT via `INSERT … ON CONFLICT(epic_id, task_key) DO UPDATE SET …`
 *     (NOT `REPLACE INTO`: `REPLACE` deletes the old row and re-inserts,
 *     firing DELETE triggers and disturbing any future FK children — UPSERT
 *     updates in place per the epic's Best practices). `updated_at` is
 *     `unixepoch('now','subsec')`. CAVEAT: SQLite's `unixepoch('now','subsec')`
 *     is sub-microsecond resolution per the docs; two UPSERTs landing in the
 *     same microsecond would tie `updated_at`, and the diff machinery's
 *     `version > lastSent` test would skip the second push. Vanishingly
 *     unlikely for a human-driven approval CLI; a higher-frequency writer
 *     would need an explicit version-bump.
 *   - Re-SELECT the row inside the same transaction and return it as the
 *     `rpc_result.value` (so the caller renders without a re-read).
 *
 * Clear branch:
 *   - DELETE WHERE `(epic_id, task_key)` — leverages the UNIQUE index. A
 *     zero-row DELETE is NOT an error (absent row = "pending", which is what
 *     `clear` means); the handler returns `{ cleared: true, epic_id,
 *     task_key }` either way (idempotent). The "clear" overload of a single
 *     RPC keeps the wire surface small at the cost of obscuring DELETEs in
 *     any future audit log — acceptable tradeoff for this iteration; a
 *     future split to a peer `delete_approval` is straightforward.
 *
 * Transaction:
 *   - Wrapped in `BEGIN IMMEDIATE` (the writer-mode default is DEFERRED,
 *     which upgrades to writer mid-statement and ignores `busy_timeout`,
 *     surfacing as spurious `SQLITE_BUSY`). Both branches do a single SQLite
 *     statement, but wrapping is cheap and uniform — and the upsert branch's
 *     re-SELECT MUST see the just-written row, which is only guaranteed
 *     within the writer's own transaction.
 *
 * Throws `BadParamsError` on malformed `params`; the dispatcher catches and
 * frames `bad_params`. Any other throw (e.g. a SQLITE_BUSY past timeout)
 * falls through as `rpc_failed`. The handler NEVER calls `db.close()` —
 * the writer connection's lifetime belongs to the server-worker.
 */
export function setApprovalHandler(
  db: Database,
  params: unknown,
): SetApprovalResult {
  const { epic_id, task_key, status } = validateSetApprovalParams(params);

  // BEGIN IMMEDIATE: take the writer lock up front rather than upgrading
  // mid-statement. Avoids the "SQLITE_BUSY despite busy_timeout" foot-gun the
  // epic's Best practices call out.
  db.run("BEGIN IMMEDIATE");
  try {
    if (status === "clear") {
      db.prepare(
        "DELETE FROM approvals WHERE epic_id = ? AND task_key = ?",
      ).run(epic_id, task_key);
      db.run("COMMIT");
      // Idempotent: a zero-row DELETE still resolves to "cleared". The caller
      // owns the (epic_id, task_key) it sent — echo it for symmetry with the
      // upsert branch's full-row return.
      return { cleared: true, epic_id, task_key };
    }

    const approval_id = `${epic_id}:${task_key}`;
    // INSERT … ON CONFLICT … DO UPDATE — never REPLACE (see the docstring's
    // "Approve / reject branch" note). `unixepoch('now','subsec')` provides
    // sub-µs resolution; the descriptor uses `updated_at` as `version` so the
    // diff fires on every UPSERT (modulo the same-µs tie caveat).
    db.prepare(
      `INSERT INTO approvals (approval_id, epic_id, task_key, status, updated_at)
       VALUES (?, ?, ?, ?, unixepoch('now', 'subsec'))
       ON CONFLICT(epic_id, task_key)
         DO UPDATE SET status = excluded.status,
                       updated_at = excluded.updated_at`,
    ).run(approval_id, epic_id, task_key, status);
    // Re-SELECT inside the same transaction so the return value reflects the
    // freshly-written row (caller renders without a re-query).
    const row = db
      .prepare(
        "SELECT approval_id, epic_id, task_key, status, updated_at FROM approvals WHERE approval_id = ?",
      )
      .get(approval_id) as Approval | null;
    db.run("COMMIT");

    if (!row) {
      // Should be unreachable: the UPSERT just landed the row inside this
      // transaction. Surface a typed throw rather than `null` so the
      // dispatcher's `rpc_failed` path engages — this would be a real bug.
      throw new Error(
        `set_approval: UPSERT succeeded but re-SELECT found no row for ${approval_id}`,
      );
    }
    return row;
  } catch (err) {
    // ROLLBACK on any throw inside the transaction so the writer lock is
    // released and the next call doesn't inherit a half-written state. The
    // re-throw routes through the dispatcher's catch (BadParamsError →
    // bad_params; anything else → rpc_failed).
    try {
      db.run("ROLLBACK");
    } catch {
      // Best-effort: a ROLLBACK on a never-opened or already-failed txn
      // throws; that's fine, we're already unwinding.
    }
    throw err;
  }
}

/**
 * Install every handler in this module into the process-global
 * `RPC_REGISTRY`. Called for its side effect by the server-worker module
 * body — a single import is enough to register every concrete RPC.
 *
 * Idempotency: `registerRpc` throws on duplicate methods (a programming
 * error, not a runtime condition); never call this twice from the same
 * process. Tests that want to drive `setApprovalHandler` directly should
 * import the handler and call it, NOT re-register it.
 */
export function installRpcHandlers(): void {
  registerRpc("set_approval", setApprovalHandler);
}
