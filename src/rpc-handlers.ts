/**
 * Concrete RPC handlers registered against the server-worker's `RPC_REGISTRY`.
 * The registry is process-global; importing this module from
 * `src/server-worker.ts` is what installs the handlers into the worker thread.
 * No side effect runs at main-thread import time other than the
 * `registerAsyncRpc(...)` calls at the bottom of the file — which is the
 * design:
 * the worker module imports this, so registration happens once per worker
 * spawn, and tests that import the worker module piecemeal opt out by not
 * importing this file.
 *
 * Registers the dead-letter replay + the autopilot-control async handlers:
 *
 * - `replay_dead_letter` (no params) — ASYNC RPC. Asks main to recover ONE
 *   oldest `waiting` dead-letter row by appending the stored bindings back
 *   into the `events` log and flipping the row to `recovered`, all in one
 *   `BEGIN IMMEDIATE` transaction. (Schema v37 — see fn-643 task .4.) The
 *   actual work runs on main (the sole writer of the events log); this
 *   handler routes through the worker→main bridge.
 * - `set_autopilot_paused` / `set_autopilot_mode` / `set_epic_armed` /
 *   `retry_dispatch` — the autopilot control plane (each round-trips through a
 *   synthetic event via the worker→main bridge).
 *
 * There is no approval RPC surface (`set_task_approval` / `set_epic_approval`):
 * keeper completes work on worker/closer-done alone.
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

import {
  parseDispatchKey as parseDispatchKeyResult,
  type RetryDispatchVerb,
} from "./dispatch-command";
import {
  BadParamsError,
  type ReplayBridge,
  registerAsyncRpc,
} from "./server-worker";

// Re-export the verb type for downstream importers that read it off this
// module (the validator itself now lives in the dep-free `./dispatch-command`
// leaf; this module re-wraps its discriminated result into `BadParamsError`).
export type { RetryDispatchVerb };

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
// `set_autopilot_mode` (async — bridges through main to APPEND an
// `AutopilotMode` synthetic event; fn-751 task .3)
// ---------------------------------------------------------------------------

/** The two legal autopilot modes (fn-751). Mirrors the reducer's enum. */
export type AutopilotMode = "yolo" | "armed";

const AUTOPILOT_MODES = new Set<AutopilotMode>(["yolo", "armed"]);

/** `set_autopilot_mode` wire params. */
export interface SetAutopilotModeParams {
  mode: AutopilotMode;
}

/** Successful return shape for `set_autopilot_mode`. */
export interface SetAutopilotModeResult {
  ok: true;
  mode: AutopilotMode;
}

function validateSetAutopilotModeParams(
  params: unknown,
): SetAutopilotModeParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new BadParamsError(
      "set_autopilot_mode: params must be an object with `mode: 'yolo'|'armed'`",
    );
  }
  const obj = params as Record<string, unknown>;
  if (
    typeof obj.mode !== "string" ||
    !AUTOPILOT_MODES.has(obj.mode as AutopilotMode)
  ) {
    throw new BadParamsError(
      `set_autopilot_mode: \`mode\` must be one of yolo|armed (got ${JSON.stringify(obj.mode)})`,
    );
  }
  return { mode: obj.mode as AutopilotMode };
}

/**
 * `set_autopilot_mode` handler. Validates the `mode: 'yolo'|'armed'` enum and
 * bridges to main, which APPENDS an `AutopilotMode` synthetic event onto the
 * writable connection and pumps a wake — NO relay to the autopilot worker
 * (deliberately unlike {@link setAutopilotPausedHandler}: the level-triggered
 * reconciler re-reads mode from the `autopilot_state` projection every cycle,
 * woken by the fold's `data_version` bump). Returns `{ ok: true, mode }` once
 * main has appended. Mode is DURABLE user intent (persisted in the projection),
 * not a safety reset like paused — so there is no boot re-arm. Fn-751 task .3.
 */
export async function setAutopilotModeHandler(
  params: unknown,
  bridge: ReplayBridge,
): Promise<SetAutopilotModeResult> {
  const { mode } = validateSetAutopilotModeParams(params);
  const result = await bridge.setAutopilotMode(mode);
  if (!result.ok) {
    throw new Error(
      result.error ?? "set_autopilot_mode: main reported failure",
    );
  }
  return { ok: true, mode };
}

// ---------------------------------------------------------------------------
// `set_epic_armed` (async — bridges through main to APPEND an `EpicArmed`
// synthetic event; fn-751 task .3)
// ---------------------------------------------------------------------------

/** `set_epic_armed` wire params. */
export interface SetEpicArmedParams {
  epic_id: string;
  armed: boolean;
}

/** Successful return shape for `set_epic_armed`. */
export interface SetEpicArmedResult {
  ok: true;
  epic_id: string;
  armed: boolean;
}

function validateSetEpicArmedParams(params: unknown): SetEpicArmedParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new BadParamsError(
      "set_epic_armed: params must be an object with `epic_id: string, armed: boolean`",
    );
  }
  const obj = params as Record<string, unknown>;
  if (typeof obj.epic_id !== "string" || obj.epic_id.length === 0) {
    throw new BadParamsError(
      "set_epic_armed: `epic_id` must be a non-empty string",
    );
  }
  if (typeof obj.armed !== "boolean") {
    throw new BadParamsError("set_epic_armed: `armed` must be a boolean");
  }
  return { epic_id: obj.epic_id, armed: obj.armed };
}

/**
 * `set_epic_armed` handler. Validates the `{ epic_id, armed }` shape and
 * bridges to main, which APPENDS an `EpicArmed` synthetic event onto the
 * writable connection and pumps a wake (no relay — same level-triggered
 * re-read contract as {@link setAutopilotModeHandler}).
 *
 * NO existence validation on `epic_id`: the event is appended (almost)
 * unconditionally to avoid the fold-lag race where a freshly-planned epic
 * isn't yet in the `epics` projection but the human wants to arm it now. The
 * reconciler reads the armed set against the live projection each cycle, so an
 * arm for an epic that never materializes is a harmless no-op (it pulls in
 * nothing). The SOLE rejection (fn-774 task .2, enforced main-side where the
 * writer DB lives): an `armed:true` request against an epic that is PRESENT
 * and `status='done'` is refused — a completed epic can't be (re)armed, and a
 * `done` epic is definitionally folded so the fold-lag tolerance above is
 * untouched (`armed:false` and a not-yet-folded epic both still append).
 * Returns `{ ok: true, epic_id, armed }` once main has appended. Fn-751 task
 * .3.
 */
export async function setEpicArmedHandler(
  params: unknown,
  bridge: ReplayBridge,
): Promise<SetEpicArmedResult> {
  const { epic_id, armed } = validateSetEpicArmedParams(params);
  const result = await bridge.setEpicArmed(epic_id, armed);
  if (!result.ok) {
    throw new Error(result.error ?? "set_epic_armed: main reported failure");
  }
  return { ok: true, epic_id, armed };
}

// ---------------------------------------------------------------------------
// `request_handoff` (async — the SIXTH mutating RPC; bridges through main to
// APPEND a `HandoffRequested` synthetic event into the durable `handoffs`
// projection; fn-946 task .2)
// ---------------------------------------------------------------------------

/** `request_handoff` wire params. */
export interface RequestHandoffParams {
  /** Stably-minted idempotency key (CLI-minted, the `handoffs` row PK). */
  handoff_id: string;
  /** The contextful brief (already capped CLI-side at 64KB — NOT re-checked here). */
  doc: string;
  /** Optional human title. */
  title: string | null;
  /** The resolved target tmux session the handoff-ee launches into. */
  target_session: string;
  /** Raw initiator coords — always carried even when the pane isn't yet folded. */
  initiator_session: string | null;
  initiator_pane: string | null;
}

/** Successful return shape for `request_handoff`. */
export interface RequestHandoffResult {
  ok: true;
  handoff_id: string;
}

function validateRequestHandoffParams(params: unknown): RequestHandoffParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new BadParamsError(
      "request_handoff: params must be an object with `handoff_id: string, doc: string, target_session: string`",
    );
  }
  const obj = params as Record<string, unknown>;
  if (typeof obj.handoff_id !== "string" || obj.handoff_id.length === 0) {
    throw new BadParamsError(
      "request_handoff: `handoff_id` must be a non-empty string",
    );
  }
  if (typeof obj.doc !== "string" || obj.doc.length === 0) {
    throw new BadParamsError(
      "request_handoff: `doc` must be a non-empty string",
    );
  }
  if (
    typeof obj.target_session !== "string" ||
    obj.target_session.length === 0
  ) {
    throw new BadParamsError(
      "request_handoff: `target_session` must be a non-empty string",
    );
  }
  // The nullable coordinate fields accept string OR null (absent → null).
  const optStr = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") {
      throw new BadParamsError(
        `request_handoff: \`${field}\` must be a string or null`,
      );
    }
    return v;
  };
  const title = optStr(obj.title, "title");
  const initiator_session = optStr(obj.initiator_session, "initiator_session");
  const initiator_pane = optStr(obj.initiator_pane, "initiator_pane");
  return {
    handoff_id: obj.handoff_id,
    doc: obj.doc,
    title,
    target_session: obj.target_session,
    initiator_session,
    initiator_pane,
  };
}

/**
 * `request_handoff` handler — the SIXTH mutating RPC. Validates the
 * `{ handoff_id, doc, target_session, ... }` shape and bridges to main, which
 * resolves `initiator_job_id` best-effort by pane then APPENDS a
 * `HandoffRequested` synthetic event onto the writable connection and pumps a
 * wake (no relay — the dispatcher worker re-reads the requested set each cycle).
 *
 * The 64KB doc cap is enforced CLI-side (the doc rides inline in `events.data`
 * forever, a replay-cost cap), NOT here — a foreign caller hitting this RPC
 * directly only bypasses a courtesy guard, never a correctness one (the cap is a
 * replay-budget protection, and the event log already bounds line size). Returns
 * `{ ok: true, handoff_id }` once main has appended. Fn-946 task .2.
 */
export async function requestHandoffHandler(
  params: unknown,
  bridge: ReplayBridge,
): Promise<RequestHandoffResult> {
  const req = validateRequestHandoffParams(params);
  const result = await bridge.requestHandoff(req);
  if (!result.ok) {
    throw new Error(result.error ?? "request_handoff: main reported failure");
  }
  return { ok: true, handoff_id: req.handoff_id };
}

// ---------------------------------------------------------------------------
// `retry_dispatch` (async — bridges through main to mint a `DispatchCleared`
// synthetic event; fn-661 task .4)
// ---------------------------------------------------------------------------

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
 * Split + validate a `${verb}::${id}` composite key, throwing `BadParamsError`
 * on any miss. A thin re-wrap of the dep-free validator in
 * `./dispatch-command` — the pure logic and validation rules live there; this
 * wrapper maps its `{ ok: false }` discriminated result onto the
 * `BadParamsError` the RPC dispatcher frames as `bad_params`, keeping the wire
 * contract byte-identical. Pure — exported for unit reach.
 */
export function parseDispatchKey(value: unknown): {
  verb: RetryDispatchVerb;
  id: string;
} {
  const result = parseDispatchKeyResult(value);
  if (!result.ok) {
    throw new BadParamsError(result.error);
  }
  return { verb: result.verb, id: result.id };
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
  registerAsyncRpc("replay_dead_letter", replayDeadLetterHandler);
  registerAsyncRpc("set_autopilot_paused", setAutopilotPausedHandler);
  registerAsyncRpc("set_autopilot_mode", setAutopilotModeHandler);
  registerAsyncRpc("set_epic_armed", setEpicArmedHandler);
  registerAsyncRpc("retry_dispatch", retryDispatchHandler);
  registerAsyncRpc("request_handoff", requestHandoffHandler);
}
