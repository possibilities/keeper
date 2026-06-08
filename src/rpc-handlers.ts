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
 * Currently registers THREE handlers:
 *
 * - `set_task_approval { epic_id, task_id, status }` — write the `approval`
 *   field into the gitignored runtime sidecar
 *   `<root>/.planctl/state/tasks/<task_id>.state.json` (create-if-absent, RMW
 *   preserving the sidecar's status/claim fields). (fn-732 — approval moved
 *   out of the committed def into the runtime sidecar so keeper folds it
 *   gate-free. Was schema v13 def-rewrite — fn-592-approval-as-planctl-field.)
 * - `set_epic_approval { epic_id, status }` — write the `approval` field into
 *   `<root>/.planctl/state/epics/<epic_id>.state.json` (create-if-absent).
 *   (Same fn-732 retarget.)
 * - `replay_dead_letter` (no params) — ASYNC RPC. Asks main to recover ONE
 *   oldest `waiting` dead-letter row by appending the stored bindings back
 *   into the `events` log and flipping the row to `recovered`, all in one
 *   `BEGIN IMMEDIATE` transaction. (Schema v37 — see fn-643 task .4.) The
 *   actual work runs on main (the sole writer of the events log); this
 *   handler routes through the worker→main bridge.
 *
 * The two approval handlers write the canonical planctl JSON form (see
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
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteFile, resolvePlanRoots, serializePlanctlJson } from "./db";
import {
  BadParamsError,
  type ReplayBridge,
  registerAsyncRpc,
  registerRpc,
} from "./server-worker";

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

/**
 * Fire-and-forget signal a successful approval write fires so main re-kicks
 * the plan-worker into a GATED `recheckPending()` (fn-701 task .2). The
 * approval RPC runs in the server-worker; mutating `<root>/.planctl/{epics,
 * tasks}/<id>.json`'s `approval` field makes that file dirty/uncommitted, so
 * absent a follow-on git pulse the only thing that drains the plan-worker's
 * pending set is the 60s heartbeat — the board-removal lag this kick closes.
 *
 * The kick is SUPPLEMENTARY: task .1's commit-driven bypass is the
 * load-bearing disappear-fix; this handles the approval-that-never-commits
 * gap. It is GATED, NOT a bypass — the plan-worker re-runs its fn-629
 * in-HEAD probe, so an uncommitted approval stays in pending and does NOT
 * emit (re-opening the fn-627 duplicate-dispatch incident is the regression
 * this gate prevents).
 *
 * Defaults to a no-op so a direct-handler test (or any caller that imports
 * a handler without wiring the bridge) keeps the pre-fn-701 behavior. The
 * server-worker's `main()` installs the real signal via
 * {@link setApprovalKickSignal}. Never throws — the cost of a failed kick is
 * a (rare) fallback to the heartbeat, never a failed approval write.
 */
let approvalKickSignal: () => void = () => {};

/**
 * Install the fire-and-forget kick signal the approval handlers fire on a
 * successful write (fn-701 task .2). Called once by the server-worker's
 * `main()` after `installRpcHandlers()`, wiring the signal to a
 * `parentPort.postMessage` toward main → plan-worker. Idempotent-by-last-
 * write; tests may install a spy or leave the default no-op.
 */
export function setApprovalKickSignal(signal: () => void): void {
  approvalKickSignal = signal;
}

/**
 * Invoke the approval kick signal, swallowing any throw — a transport hiccup
 * on a cosmetic fast-path must never fail the (already-durable) approval
 * write. The level-triggered 60s heartbeat is the lost-wakeup backstop.
 */
function fireApprovalKick(): void {
  try {
    approvalKickSignal();
  } catch (err) {
    console.error(
      `[rpc-handlers] approval kick signal failed: ${err instanceof Error ? err.message : String(err)}`,
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
 * Map a committed plan-def file path
 * `<planctl>/{epics,tasks}/<id>.json` to its gitignored runtime sidecar
 * `<planctl>/state/{epics,tasks}/<id>.state.json` (fn-732). Pure path
 * arithmetic; mirrors the plan-worker's `taskDefPathFromStatePath` /
 * `epicDefPathFromStatePath` in reverse. Exported for unit reach.
 *
 * The def path is the RESOLVED path from {@link resolvePlanFile} — proven to
 * exist under a configured root's `.planctl/{epics,tasks}/` — so the derived
 * sidecar lands inside the SAME `.planctl`, and the leaf id is the same
 * already-traversal-guarded token. No new untrusted component enters the path.
 */
export function sidecarPathFromDef(
  defPath: string,
  collection: "epics" | "tasks",
): string {
  // `<planctl>/<collection>/<id>.json` → defDir = `<planctl>/<collection>`,
  // planctl = `<planctl>`. Insert `state/` and swap `.json` → `.state.json`.
  const collectionDir = dirname(defPath); // `<planctl>/<collection>`
  const planctlDir = dirname(collectionDir); // `<planctl>`
  const base = defPath.slice(collectionDir.length + 1); // `<id>.json`
  const id = base.endsWith(".json") ? base.slice(0, -".json".length) : base;
  return join(planctlDir, "state", collection, `${id}.state.json`);
}

/**
 * Write the runtime `approval` into the gitignored sidecar (fn-732),
 * create-if-absent and read-modify-write so EVERY pre-existing field on the
 * sidecar (notably a task sidecar's `status` / claim fields written by planctl
 * `LocalFileStateStore`) is preserved. Mirrors planctl's own RMW discipline
 * (load → set one key → atomic write); `serializePlanctlJson` + the
 * same-dir-temp + `renameSync` keep the on-disk form canonical and the write
 * atomic. Creates the `state/{epics,tasks}/` dir tree on first write.
 *
 * The previous (schema v13) implementation rewrote the approval on the
 * COMMITTED def file; fn-732 moves approval to the runtime sidecar so keeper
 * folds it gate-free (no commit on the critical path). The plan-worker's
 * PERMANENT ladder (sidecar → committed def → pending) keeps approval
 * resolvable on a keeper that hasn't been restarted yet.
 *
 * Throws on read/parse/write failure — the dispatcher's `rpc_failed` path
 * frames the error. Exported for unit reach.
 */
export function rewriteSidecarApproval(
  sidecarPath: string,
  status: ApprovalStatus,
): void {
  // RMW: start from the existing sidecar (preserving status / claim / evidence
  // fields) when present; otherwise start from an empty object (create).
  let obj: Record<string, unknown> = {};
  if (existsSync(sidecarPath)) {
    const raw = readFileSync(sidecarPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw new Error(`${sidecarPath}: planctl sidecar is not a JSON object`);
    }
    obj = parsed as Record<string, unknown>;
  }
  obj.approval = status;
  // `atomicWriteFile` does not mkdir; ensure the `state/{epics,tasks}/` tree
  // exists before the same-dir temp+rename (create-if-absent on first write).
  mkdirSync(dirname(sidecarPath), { recursive: true });
  atomicWriteFile(sidecarPath, serializePlanctlJson(obj));
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
  // Resolve the committed def first — it proves the task exists and locates the
  // owning `.planctl`; the sidecar (which may not exist yet) is derived from it
  // so create-if-absent lands in the right tree (fn-732).
  const defPath = resolvePlanFile(roots, "tasks", task_id);
  if (defPath === null) {
    throw new Error(
      `set_task_approval: no planctl task file found for task_id '${task_id}' in any configured plan root`,
    );
  }
  const sidecarPath = sidecarPathFromDef(defPath, "tasks");
  // RMW preserves the sidecar's runtime fields (status / claim / evidence)
  // written by planctl; we only set `approval`.
  rewriteSidecarApproval(sidecarPath, status);
  // fn-701 task .2: kick the plan-worker into a GATED recheck so an approval
  // converges promptly instead of waiting on the 60s heartbeat. KEPT for now —
  // fn-732 task .4 removes it once the sidecar fold is the sole path.
  fireApprovalKick();
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
  const defPath = resolvePlanFile(roots, "epics", epic_id);
  if (defPath === null) {
    throw new Error(
      `set_epic_approval: no planctl epic file found for epic_id '${epic_id}' in any configured plan root`,
    );
  }
  const sidecarPath = sidecarPathFromDef(defPath, "epics");
  rewriteSidecarApproval(sidecarPath, status);
  // fn-701 task .2: kick the plan-worker into a GATED recheck (see the
  // matching call in `setTaskApprovalHandler`). KEPT for now — removed in
  // fn-732 task .4.
  fireApprovalKick();
  return { ok: true, epic_id, approval: status };
}

// ---------------------------------------------------------------------------
// `replay_dead_letter` (async — routes through the worker→main bridge)
// ---------------------------------------------------------------------------

/**
 * Successful return shape for `replay_dead_letter`. Mirrors the bridge's
 * resolved `{ok, recovered_dl_id}` directly so the wire `value` is a
 * one-line JSON object a client (board / CLI) can render verbatim.
 *
 * - `ok: true, recovered_dl_id: string` — one row flipped `waiting →
 *   recovered`; the appended events row is in flight to the reducer.
 * - `ok: true, recovered_dl_id: null` — no `waiting` rows remained at
 *   the moment main processed the request. Clean no-op ack; the board
 *   re-renders with the same (zero) waiting count.
 */
export interface ReplayDeadLetterResult {
  ok: true;
  recovered_dl_id: string | null;
}

/**
 * `replay_dead_letter` handler. Bridges the worker→main request/reply
 * round-trip (fn-643 task .4); main does the actual recovery in one
 * `BEGIN IMMEDIATE` transaction.
 *
 * Wire `params` MUST be either absent / `null` / an empty object — there is
 * NO way to target a specific row from the client. The server picks the
 * oldest `waiting` row (by `(dl_written_at ASC, dl_id ASC)`) on every
 * invocation; the human's keypress recovers ONE at a time and the board's
 * count drops by one. A future "replay all" or "replay this specific
 * dl_id" verb is out of scope and would land as a sibling RPC.
 *
 * Failure modes routed through the dispatcher:
 * - main's recovery transaction throws → bridge resolves `{ok:false,
 *   error}` → handler throws an Error → dispatcher frames `rpc_failed`.
 * - bridge times out (default 5s) → bridge rejects → dispatcher frames
 *   `rpc_failed` with a "no response from main" message.
 *
 * No bridge timeout is forced shorter inside the handler — the bridge's
 * own deadline IS the timeout contract for this RPC.
 */
export async function replayDeadLetterHandler(
  params: unknown,
  bridge: ReplayBridge,
): Promise<ReplayDeadLetterResult> {
  // Wire validation: accept null / absent / an empty object. A non-empty
  // object surfaces as `BadParamsError` so a caller passing a stray field
  // by mistake gets a typed wire error rather than a silent ignore.
  if (params !== undefined && params !== null) {
    if (typeof params !== "object" || Array.isArray(params)) {
      throw new BadParamsError(
        "replay_dead_letter: params must be absent, null, or an empty object",
      );
    }
    if (Object.keys(params as Record<string, unknown>).length > 0) {
      throw new BadParamsError(
        "replay_dead_letter: params must have no keys (no client-side row targeting; server picks oldest waiting)",
      );
    }
  }
  const result = await bridge.replay();
  if (!result.ok) {
    // Main posted back a typed failure. Throw with main's error message
    // so the dispatcher frames `rpc_failed` carrying the same text.
    throw new Error(
      result.error ?? "replay_dead_letter: main reported failure",
    );
  }
  return {
    ok: true,
    // Normalize undefined → null so the wire value carries an explicit
    // sentinel for "nothing to replay" rather than dropping the field.
    recovered_dl_id: result.recovered_dl_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// `set_autopilot_paused` (async — bridges through main to flip the in-memory
// paused flag and relay a `{type:"set-paused"}` command to the autopilot
// worker; fn-661 task .4)
// ---------------------------------------------------------------------------

/** `set_autopilot_paused` wire params. */
export interface SetAutopilotPausedParams {
  paused: boolean;
}

/** Successful return shape for `set_autopilot_paused`. */
export interface SetAutopilotPausedResult {
  ok: true;
  paused: boolean;
}

function validateSetAutopilotPausedParams(
  params: unknown,
): SetAutopilotPausedParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new BadParamsError(
      "set_autopilot_paused: params must be an object with `paused: boolean`",
    );
  }
  const obj = params as Record<string, unknown>;
  if (typeof obj.paused !== "boolean") {
    throw new BadParamsError(
      "set_autopilot_paused: `paused` must be a boolean",
    );
  }
  return { paused: obj.paused };
}

/**
 * `set_autopilot_paused` handler. Validates the `paused: boolean` wire
 * shape and bridges to main, which (a) flips the in-memory `paused` flag
 * and (b) relays a `{ type: "set-paused", paused }` command to the
 * autopilot worker. Returns `{ ok: true, paused }` once main has
 * acknowledged. Failure modes (main reports `ok:false`, bridge timeout)
 * surface as `rpc_failed` per the {@link replayDeadLetterHandler}
 * pattern.
 *
 * The flag is in-memory only on main and NEVER persisted — boots-paused
 * is the safety default (every keeperd restart re-enters paused).
 */
export async function setAutopilotPausedHandler(
  params: unknown,
  bridge: ReplayBridge,
): Promise<SetAutopilotPausedResult> {
  const { paused } = validateSetAutopilotPausedParams(params);
  const result = await bridge.setAutopilotPaused(paused);
  if (!result.ok) {
    throw new Error(
      result.error ?? "set_autopilot_paused: main reported failure",
    );
  }
  return { ok: true, paused };
}

// ---------------------------------------------------------------------------
// `retry_dispatch` (async — bridges through main to mint a `DispatchCleared`
// synthetic event; fn-661 task .4)
// ---------------------------------------------------------------------------

/**
 * The three planctl verbs the reconciler dispatches. Mirrors the
 * `Verb` union in `src/autopilot-worker.ts` (kept local rather than
 * re-imported to keep the rpc-handlers module's import graph narrow —
 * no `bun:sqlite` / `Database` types cross from the worker file).
 */
export type RetryDispatchVerb = "work" | "close" | "approve";

const RETRY_DISPATCH_VERBS = new Set<RetryDispatchVerb>([
  "work",
  "close",
  "approve",
]);

/** `retry_dispatch` wire params. */
export interface RetryDispatchParams {
  /** Composite dispatch key — exactly `${verb}::${id}`. */
  id: string;
}

/** Successful return shape for `retry_dispatch`. */
export interface RetryDispatchResult {
  ok: true;
  verb: RetryDispatchVerb;
  id: string;
}

/**
 * Split + validate a `${verb}::${id}` composite key. Returns the parsed
 * pair; throws `BadParamsError` on any miss. Pure — exported for unit
 * reach.
 *
 * Validation rules (id shape ONLY — launch params come from the
 * projection read at the next reconcile, never the RPC payload):
 *
 * - Non-empty string with exactly one `::` separator.
 * - `verb` is one of `work` / `close` / `approve`.
 * - `id` is a non-empty token AND passes the {@link rejectPathTraversal}
 *   filename-safety predicate (no path separators, no embedded null, no
 *   leading dot). The `dispatch_id` never feeds a filesystem path, but
 *   the predicate is a cheap belt-and-suspenders against a wire token
 *   that looks like a path-traversal probe.
 */
export function parseDispatchKey(value: unknown): {
  verb: RetryDispatchVerb;
  id: string;
} {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadParamsError(
      "retry_dispatch: `id` must be a non-empty string of the form `verb::id` (e.g. `work::fn-1-foo.3`)",
    );
  }
  const sep = value.indexOf("::");
  if (sep <= 0 || sep === value.length - 2) {
    throw new BadParamsError(
      "retry_dispatch: `id` must contain exactly one `::` separator with non-empty halves",
    );
  }
  // A second `::` is also a malformed key — the verb half MUST be a
  // simple token, and the id half MUST NOT contain `::` either (the
  // composite key is `verb::id`, not nested).
  if (value.indexOf("::", sep + 2) !== -1) {
    throw new BadParamsError(
      "retry_dispatch: `id` must contain exactly ONE `::` separator",
    );
  }
  const verbRaw = value.slice(0, sep);
  const idRaw = value.slice(sep + 2);
  if (!RETRY_DISPATCH_VERBS.has(verbRaw as RetryDispatchVerb)) {
    throw new BadParamsError(
      `retry_dispatch: \`verb\` must be one of work|close|approve (got ${JSON.stringify(verbRaw)})`,
    );
  }
  rejectDispatchIdToken(idRaw);
  return { verb: verbRaw as RetryDispatchVerb, id: idRaw };
}

/**
 * Reject any `id` half that looks like a path-traversal probe or an
 * empty token. The id never feeds a filesystem path inside the
 * reconciler, but rejecting weaponizable shapes at the wire boundary is
 * cheap defense against future code paths that might (e.g. a viewer
 * that ever serialized an id into a path). Mirrors the
 * {@link rejectPathTraversal} predicate the approval handlers apply.
 */
function rejectDispatchIdToken(value: string): void {
  if (
    value.length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith(".")
  ) {
    throw new BadParamsError(
      "retry_dispatch: `id` half is empty or weaponizable (path-traversal token rejected)",
    );
  }
}

function validateRetryDispatchParams(params: unknown): RetryDispatchParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new BadParamsError(
      "retry_dispatch: params must be an object with `id: 'verb::id'` (e.g. `work::fn-1-foo.3`)",
    );
  }
  const obj = params as Record<string, unknown>;
  // Reject any field other than `id` — the spec says "launch params
  // come from the projection read, never the RPC payload"; a stray
  // `cwd` / `tier` / `verb` / `command` field is a sign of param
  // injection and gets surfaced as a typed bad_params rather than
  // silently ignored.
  const stray = Object.keys(obj).filter((k) => k !== "id");
  if (stray.length > 0) {
    throw new BadParamsError(
      `retry_dispatch: params must contain ONLY \`id\` (got stray keys: ${stray.join(", ")})`,
    );
  }
  return { id: obj.id as string };
}

/**
 * `retry_dispatch` handler. Validates the wire `id` shape (the
 * canonical `${verb}::${id}` composite key) — and ONLY the id shape;
 * no command / cwd / tier rides the RPC. The next reconcile pulls
 * launch params from the projection itself, so a malicious caller
 * cannot inject params via this surface.
 *
 * Bridges to main, which appends a `DispatchCleared` synthetic event
 * carrying the split `verb` / `id` pair. The reducer's fold arm
 * DELETEs the matching `dispatch_failures` row on the next drain, and
 * the autopilot reconciler will re-attempt the dispatch on its next
 * wake. Fn-661 task .4.
 */
export async function retryDispatchHandler(
  params: unknown,
  bridge: ReplayBridge,
): Promise<RetryDispatchResult> {
  const { id } = validateRetryDispatchParams(params);
  const { verb, id: dispatchId } = parseDispatchKey(id);
  const result = await bridge.retryDispatch(verb, dispatchId);
  if (!result.ok) {
    throw new Error(result.error ?? "retry_dispatch: main reported failure");
  }
  return { ok: true, verb, id: dispatchId };
}

/**
 * Install every handler in this module into the process-global registries
 * (`RPC_REGISTRY` for sync handlers, `ASYNC_RPC_REGISTRY` for async ones).
 * Called for its side effect by the server-worker module body — a single
 * import is enough to register every concrete RPC.
 *
 * Idempotency: `registerRpc` / `registerAsyncRpc` throw on duplicate methods
 * (a programming error, not a runtime condition); never call this twice from
 * the same process. Tests that want to drive a handler directly should
 * import the handler and call it, NOT re-register it.
 */
export function installRpcHandlers(): void {
  registerRpc("set_task_approval", setTaskApprovalHandler);
  registerRpc("set_epic_approval", setEpicApprovalHandler);
  registerAsyncRpc("replay_dead_letter", replayDeadLetterHandler);
  registerAsyncRpc("set_autopilot_paused", setAutopilotPausedHandler);
  registerAsyncRpc("retry_dispatch", retryDispatchHandler);
}
