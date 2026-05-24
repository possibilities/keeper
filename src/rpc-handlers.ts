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
 * Currently registers TWO handlers (the planctl-native approval pair, schema
 * v13 — see the fn-592-approval-as-planctl-field epic):
 *
 * - `set_task_approval { epic_id, task_id, status }` — mutate the `approval`
 *   field on `<root>/.planctl/tasks/<task_id>.json` to `status`.
 * - `set_epic_approval { epic_id, status }` — mutate the `approval` field on
 *   `<root>/.planctl/epics/<epic_id>.json` to `status`.
 *
 * Both handlers write the canonical planctl JSON form (see
 * `serializePlanctlJson` in `src/db.ts`) atomically (temp file in same dir,
 * `<final>.tmp.<pid>.<crypto.randomUUID()>` suffix, `renameSync`). The
 * round-trip back into the projection happens via the existing
 * `@parcel/watcher` → plan-worker → reducer pipeline; the RPC return does
 * NOT claim the projection is updated (eventual consistency on the order
 * of one `data_version` poll, ~50ms).
 *
 * Per-file serialization: the dispatcher invokes handlers synchronously on
 * a single thread, and the handler's I/O (`readFileSync` / `writeFileSync` /
 * `renameSync`) is itself synchronous. So two concurrent same-file writes
 * arriving on different connections process strictly in arrival order — the
 * single-flight property holds by virtue of JS being single-threaded on
 * synchronous code, with no explicit lock needed. A future async-handler
 * refactor would need to revisit this with an explicit per-file
 * `Map<path, Promise<void>>` chain (the pattern the planning spec called
 * out), but today's contract is sync-throughout.
 *
 * Contract a handler MUST honor:
 * - Validate `params` shape and throw `BadParamsError` on mismatch (the
 *   dispatcher frames a `bad_params` error and the connection survives).
 * - Reject path-traversal in id fields (`..`, `/`, `\`, embedded null, dot
 *   prefixes) at the wire boundary — never trust foreign-process JSON
 *   identifiers as filesystem path components.
 * - Return a plain JSON-stringifiable value; the dispatcher frames it as
 *   `rpc_result.value`.
 * - NEVER call `db.close()` — the connection's lifetime belongs to the
 *   server-worker's `main()`.
 *
 * The `db` argument is no longer used by these handlers (the file is the
 * canonical source; the round-trip back into the DB happens via the
 * watcher → plan-worker → reducer pipeline), but the dispatcher's
 * `RpcHandler` signature still takes it for protocol compatibility with
 * any future SQL-mutating RPC.
 */

import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, resolvePlanRoots, serializePlanctlJson } from "./db";
import { BadParamsError, registerRpc } from "./server-worker";

/**
 * The planctl-native approval enum. Wire-validated by each handler (a wire
 * value off this enum throws `BadParamsError`). MUST match the planctl
 * serializer (task `.1` evidence) and the plan-worker's `Approval` type.
 */
export type ApprovalStatus = "approved" | "rejected" | "pending";

const APPROVAL_STATUSES = new Set<ApprovalStatus>([
  "approved",
  "rejected",
  "pending",
]);

/** `set_task_approval` wire params. */
export interface SetTaskApprovalParams {
  epic_id: string;
  task_id: string;
  status: ApprovalStatus;
}

/** `set_epic_approval` wire params. */
export interface SetEpicApprovalParams {
  epic_id: string;
  status: ApprovalStatus;
}

/** Successful return shape for `set_task_approval`. */
export interface SetTaskApprovalResult {
  ok: true;
  epic_id: string;
  task_id: string;
  approval: ApprovalStatus;
}

/** Successful return shape for `set_epic_approval`. */
export interface SetEpicApprovalResult {
  ok: true;
  epic_id: string;
  approval: ApprovalStatus;
}

// ---------------------------------------------------------------------------
// Wire-boundary validation
// ---------------------------------------------------------------------------

/**
 * Reject any id token that could escape its target dir (`<root>/.planctl/{epics,tasks}/`)
 * via path-traversal. We disallow path separators (`/`, `\`), embedded null
 * bytes, and any leading-dot value (`.`, `..`, `..foo`, `.hidden`). An
 * id-shaped token (`fn-1-foo`, `fn-1-foo.3`) sails through; a weaponizable
 * token throws `BadParamsError`.
 *
 * NOTE: planctl ids are NOT validated for shape (the slug parser lives in
 * planctl); we only enforce the safety-critical "is this a safe filename
 * component" predicate. Wire validation, not semantic validation.
 */
function rejectPathTraversal(field: string, value: string): void {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith(".")
  ) {
    throw new BadParamsError(
      `set_*_approval: invalid \`${field}\`: rejected path-traversal or empty token`,
    );
  }
}

function validateApprovalStatus(value: unknown): ApprovalStatus {
  if (
    typeof value !== "string" ||
    !APPROVAL_STATUSES.has(value as ApprovalStatus)
  ) {
    throw new BadParamsError(
      "set_*_approval: `status` must be one of approved|rejected|pending",
    );
  }
  return value as ApprovalStatus;
}

function validateSetTaskApprovalParams(params: unknown): SetTaskApprovalParams {
  if (params === null || typeof params !== "object") {
    throw new BadParamsError("set_task_approval: params must be an object");
  }
  const obj = params as Record<string, unknown>;
  if (typeof obj.epic_id !== "string" || obj.epic_id.length === 0) {
    throw new BadParamsError(
      "set_task_approval: `epic_id` must be a non-empty string",
    );
  }
  if (typeof obj.task_id !== "string" || obj.task_id.length === 0) {
    throw new BadParamsError(
      "set_task_approval: `task_id` must be a non-empty string",
    );
  }
  rejectPathTraversal("epic_id", obj.epic_id);
  rejectPathTraversal("task_id", obj.task_id);
  const status = validateApprovalStatus(obj.status);
  return { epic_id: obj.epic_id, task_id: obj.task_id, status };
}

function validateSetEpicApprovalParams(params: unknown): SetEpicApprovalParams {
  if (params === null || typeof params !== "object") {
    throw new BadParamsError("set_epic_approval: params must be an object");
  }
  const obj = params as Record<string, unknown>;
  if (typeof obj.epic_id !== "string" || obj.epic_id.length === 0) {
    throw new BadParamsError(
      "set_epic_approval: `epic_id` must be a non-empty string",
    );
  }
  rejectPathTraversal("epic_id", obj.epic_id);
  const status = validateApprovalStatus(obj.status);
  return { epic_id: obj.epic_id, status };
}

// ---------------------------------------------------------------------------
// Plan-file mutation
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to a planctl JSON file by id. Walks the
 * configured plan roots looking for the first existing file. Returns null if
 * none of the configured roots has a matching file (the caller surfaces this
 * as a typed error frame rather than a crash).
 *
 * The lookup is shallow — we try `<root>/.planctl/{epics,tasks}/<id>.json`
 * AND `<root>/<project>/.planctl/{epics,tasks}/<id>.json` (one level deep,
 * mirroring `runPlanctlApprovalMigration`'s lookup). A root with no
 * `.planctl` subdir is skipped.
 *
 * Exported for unit reach.
 */
export function resolvePlanFile(
  roots: string[],
  collection: "epics" | "tasks",
  id: string,
): string | null {
  const name = `${id}.json`;
  for (const root of roots) {
    // Try the root itself first.
    const direct = join(root, ".planctl", collection, name);
    if (existsSync(direct)) {
      return direct;
    }
    // Otherwise walk one level deep — `<root>/<project>/.planctl/...`.
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const child of entries) {
      const candidate = join(root, child, ".planctl", collection, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Load the JSON object at `path`, mutate `approval = status` (preserving every
 * other top-level field), serialize via `serializePlanctlJson`, atomic-write.
 *
 * Throws on read/parse/write failure — the dispatcher's `rpc_failed` path
 * frames the error. Exported for unit reach.
 */
export function rewriteApprovalField(
  path: string,
  status: ApprovalStatus,
): void {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: planctl file is not a JSON object`);
  }
  (parsed as Record<string, unknown>).approval = status;
  atomicWriteFile(path, serializePlanctlJson(parsed));
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * `set_task_approval` handler. Mutates the `approval` field on
 * `<root>/.planctl/tasks/<task_id>.json` to `status`. The filename keys on
 * the task id (not the epic id) per planctl's filename convention; `epic_id`
 * rides as wire context for the caller's UI and is validated but NOT used
 * to locate the file (planctl task ids encode the epic id as a prefix —
 * `<epic_id>.<n>`).
 *
 * Returns `{ ok: true, epic_id, task_id, approval }`. Eventual consistency:
 * the projection reflects the write on the next watcher → plan-worker round
 * trip (~50ms via `@parcel/watcher` + `PRAGMA data_version` poll).
 *
 * The `db` argument is unused (we write the file, not the DB); kept for
 * `RpcHandler` signature parity. The leading underscore swallows the
 * unused-arg lint.
 */
export function setTaskApprovalHandler(
  _db: Database,
  params: unknown,
): SetTaskApprovalResult {
  const { epic_id, task_id, status } = validateSetTaskApprovalParams(params);
  const roots = resolvePlanRoots();
  const path = resolvePlanFile(roots, "tasks", task_id);
  if (path === null) {
    throw new Error(
      `set_task_approval: no planctl task file found for task_id '${task_id}' in any configured plan root`,
    );
  }
  rewriteApprovalField(path, status);
  return { ok: true, epic_id, task_id, approval: status };
}

/**
 * `set_epic_approval` handler. Mutates the `approval` field on
 * `<root>/.planctl/epics/<epic_id>.json` to `status`. Returns
 * `{ ok: true, epic_id, approval }`. Same eventual-consistency contract as
 * `set_task_approval`.
 */
export function setEpicApprovalHandler(
  _db: Database,
  params: unknown,
): SetEpicApprovalResult {
  const { epic_id, status } = validateSetEpicApprovalParams(params);
  const roots = resolvePlanRoots();
  const path = resolvePlanFile(roots, "epics", epic_id);
  if (path === null) {
    throw new Error(
      `set_epic_approval: no planctl epic file found for epic_id '${epic_id}' in any configured plan root`,
    );
  }
  rewriteApprovalField(path, status);
  return { ok: true, epic_id, approval: status };
}

/**
 * Install every handler in this module into the process-global
 * `RPC_REGISTRY`. Called for its side effect by the server-worker module
 * body — a single import is enough to register every concrete RPC.
 *
 * Idempotency: `registerRpc` throws on duplicate methods (a programming
 * error, not a runtime condition); never call this twice from the same
 * process. Tests that want to drive a handler directly should import the
 * handler and call it, NOT re-register it.
 */
export function installRpcHandlers(): void {
  registerRpc("set_task_approval", setTaskApprovalHandler);
  registerRpc("set_epic_approval", setEpicApprovalHandler);
}
