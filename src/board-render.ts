/**
 * Shared render primitives consumed by both the epics view (`cli/board.ts`)
 * and the jobs view (`cli/jobs.ts`, forthcoming). Pure-function helpers
 * for pill colorization, pill segment rendering, role labels, the
 * sub-agent collapse line builder, the dead-letter banner pill, and
 * the one-shot RPC client for the dead-letter replay path.
 *
 * Convention: shared infra lives in `src/`, view rendering lives in
 * `cli/<sub>.ts`. This module imports ONLY from `src/` so the
 * dependency direction stays `cli/ → src/` — never the reverse — and
 * Bun's silent `undefined`-on-cycle behavior can't bite. The
 * `subagentLinesFor` helper is a pure module function taking its
 * `subagentIndex` / `jobId` / `indent` args directly (no closure over
 * a `main()`-scoped `seg`); the trivial `v == null ? "" : String(v)`
 * is inlined here for the one call site.
 *
 * History: extracted from `cli/board.ts` (~lines 300-897, 1060-1086)
 * via fn-658.1 ahead of splitting `keeper board` into a sibling
 * `keeper board` (epics-only) + `keeper jobs` pair. Behavior is
 * unchanged — only the module boundary moves. `cli/board.ts` re-
 * exports every name `test/board.test.ts` and `scripts/drain-dead-letters.ts`
 * already import from it, so external import paths keep resolving.
 */

import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "./protocol";
import { collapseSubagentsByName } from "./readiness-client";
import type { SubagentInvocation } from "./types";

// ---------------------------------------------------------------------------
// Role label
// ---------------------------------------------------------------------------

/**
 * Map a plan_verb to its noun-form role label for the `[{role}]` pill.
 * Returns `null` when the input is null (the caller drops the pill).
 */
const PLAN_VERB_LABELS: Record<string, string> = {
  plan: "planner",
  work: "worker",
  close: "closer",
};

export function planVerbLabel(v: unknown): string | null {
  if (v == null) {
    return null;
  }
  const s = typeof v === "string" ? v : "";
  return PLAN_VERB_LABELS[s] ?? s;
}

// ---------------------------------------------------------------------------
// Pill segment helpers (api-error + input-request)
// ---------------------------------------------------------------------------

/**
 * Render the optional `[failed:<kind>]` pill segment from the
 * `jobs.(last_api_error_at, last_api_error_kind)` pair (schema v24 — the
 * two-field signal that replaced the v17 single `rate_limited_at` slot).
 * The reducer stamps both columns together on the dual-case
 * `RateLimited` / `ApiError` fold and clears them together to
 * `(NULL, NULL)` on the next `UserPromptSubmit` revival (see
 * `src/reducer.ts`), so a non-null `at` means "this stoppage was
 * api-error-caused, the human hasn't picked up since".
 *
 * The kind is taken straight off `last_api_error_kind` — one of
 * `rate_limit | authentication_failed | billing_error | server_error |
 * invalid_request | unknown`. Anything outside that allow-list already
 * folded to `"unknown"` at the matcher / reducer boundary (see
 * `matchApiError` in `src/transcript-worker.ts`); the recoverable
 * `max_output_tokens` kind is excluded at the matcher and never lands
 * here.
 *
 * **Paired-NULL invariant.** The reducer guarantees `at` and `kind`
 * move together — both NULL or both non-NULL. The fallback to
 * `"unknown"` when `at` is non-null but `kind` happens to be null is
 * defensive only (should be unreachable); keeps the pill from
 * collapsing to `[failed:]` if a future shape-skew bug appears.
 *
 * Returns the leading `' '` so the caller can append unconditionally —
 * empty string when `at` is null, ` [failed:<kind>]` otherwise. The
 * underlying lifecycle pill (`[stopped]`) is rendered separately from
 * `jobs.state` and always shows first; this annotation stacks after it
 * and is colored red on a TTY via the colorizer's `failed:*` prefix
 * fallback to the `error` bucket.
 */
export function apiErrorPillSeg(at: unknown, kind: unknown): string {
  if (at == null) {
    return "";
  }
  const k = typeof kind === "string" && kind.length > 0 ? kind : "unknown";
  return ` [failed:${k}]`;
}

/**
 * Render the optional `[awaiting:<kind>]` pill segment from the
 * `jobs.(last_input_request_at, last_input_request_kind)` pair (schema
 * v25 — the two-field signal cloned one-for-one off fn-616's
 * `apiErrorPillSeg` shape). The reducer stamps both columns together on
 * the `InputRequest` fold (a synthetic event minted by
 * `matchAskUserQuestion` in `src/transcript-worker.ts` when a real
 * assistant turn carries an `AskUserQuestion` tool_use) and clears them
 * together on the next `UserPromptSubmit` / `SessionStart` revival or
 * any `PreToolUse` / `PostToolUse` (the hot-path arms are gated on
 * `last_input_request_at IS NOT NULL`), so a non-null `at` means
 * "this stoppage is awaiting a human answer to an interactive
 * tool-use that fires no hook of its own."
 *
 * The kind is taken straight off `last_input_request_kind` — currently
 * the single-member union `ask_user_question`, future-extensible to
 * any built-in interactive tool that surfaces a question without a
 * hook (e.g. `ExitPlanMode`). No allow-list narrowing here; the kind
 * comes off the matcher / reducer boundary already and renders
 * verbatim.
 *
 * **Paired-NULL invariant.** The reducer guarantees `at` and `kind`
 * move together — both NULL or both non-NULL. The fallback to
 * `"unknown"` when `at` is non-null but `kind` happens to be null is
 * defensive only (should be unreachable); keeps the pill from
 * collapsing to `[awaiting:]` if a future shape-skew bug appears.
 *
 * Returns the leading `' '` so the segment is self-delimiting —
 * empty string when `at` is null, ` [awaiting:<kind>]` otherwise. Unlike
 * `[state]` / `[failed:<kind>]` (which stay inline on the row), every
 * caller drops THIS segment onto its own indented continuation line
 * beneath the row (`.trimStart()`-ed of the leading space) so a
 * long-running interactive stop reads without wrapping. Colored yellow
 * on a TTY via the colorizer's `awaiting:*` prefix fallback to the
 * `warn` bucket.
 */
export function inputRequestPillSeg(at: unknown, kind: unknown): string {
  if (at == null) {
    return "";
  }
  const k = typeof kind === "string" && kind.length > 0 ? kind : "unknown";
  return ` [awaiting:${k}]`;
}

// ---------------------------------------------------------------------------
// Pill colorization
// ---------------------------------------------------------------------------

/**
 * ANSI SGR sequences for the pill palette. Five semantic buckets keyed off
 * exact pill strings (plus `blocked:*`, `failed:*`, and `awaiting:*`
 * prefix fallbacks) so the colorizer stays purely string-driven — no
 * structural knowledge of which column a pill came from. Standard
 * 16-color ANSI for cross-terminal portability.
 *
 * Bucket rationale:
 *   - active  (bright cyan): in motion right now, look here
 *   - blue    (bright blue): live in-motion work — a `running` work pill
 *                            (worker / sub-agent / planner motion) and the
 *                            `working` interactive-session state pill, both
 *                            in their own hue distinct from the cyan `active`
 *                            family
 *   - success (green):       positive resolution
 *   - error   (red):         failure / needs intervention
 *   - warn    (yellow):      blocked / something is in the way
 *   - faded   (dim gray):    terminal + historical / recede
 *
 * Tokens NOT in this table render uncolored on purpose — once everything
 * else is colored, the eye picks `pending` / `todo` / `unvalidated` /
 * `unknown` / `open` and the role labels (`planner|worker|closer|creator|
 * refiner`) out by ABSENCE of color. Coloring them too is noise.
 *
 * Only the inner token gets the SGR; the brackets stay default so the
 * pill grid is still scannable.
 */
const SGR = {
  active: "\x1b[96m",
  blue: "\x1b[94m",
  success: "\x1b[32m",
  error: "\x1b[31m",
  warn: "\x1b[33m",
  faded: "\x1b[2;37m",
  reset: "\x1b[0m",
} as const;

type PillBucket = Exclude<keyof typeof SGR, "reset">;

const PILL_COLORS: Record<string, PillBucket> = {
  running: "blue",
  in_progress: "active",
  // fn-669: `working` (a live interactive session in the `keeper jobs`
  // TUI) joins `running` in the bright-blue "in motion right now" hue.
  // It was previously `active`/cyan, which reads as nearly-default
  // foreground on many terminals — the blue is the visible signal a
  // live working session deserves. `running` and `working` never share
  // a single TUI (the board emits `running:*` verdicts; `keeper jobs`
  // emits the bare `working` state pill), so the shared hue introduces
  // no in-view ambiguity.
  working: "blue",
  // Schema v29: the `[slotted-after-closer]` epic-header pill (rendered
  // when `epics.created_by_closer_of != null`). Active/cyan bucket — this
  // is "live, structural relationship visible to the human" rather than
  // a success/error/warn state. See `renderEpicBlock` for the placement.
  "slotted-after-closer": "active",
  ok: "success",
  approved: "success",
  validated: "success",
  ready: "success",
  done: "success",
  failed: "error",
  rejected: "error",
  killed: "error",
  // fn-635: a structurally-broken cross-project epic dep (full-id miss,
  // bare-id miss, or ambiguous bare-id with no same-project disambiguator)
  // renders red — distinct from the amber `[blocked]` family. The
  // colorizer's prefix branch below routes `blocked:dep-on-epic-dangling
  // <id>` to this bucket; the bare `[dep-on-epic-dangling]` token (e.g.
  // a future direct-pill render path) also lands here via exact match.
  "dep-on-epic-dangling": "error",
  blocked: "warn",
  completed: "faded",
  superseded: "faded",
  exited: "faded",
  stopped: "faded",
};

/**
 * Apply SGR coloring to bracketed pill tokens in a single rendered line.
 * Pure string→string: matches `[<token>]`, looks the inner token up in
 * `PILL_COLORS`, and falls back to the `warn` bucket for any `blocked:*`
 * payload (so `[blocked:dep-on-task fn-614.2]` colors the same as
 * `[blocked]`) AND to the `error` bucket for any `failed:*` payload (so
 * the six `[failed:<kind>]` api-error pills minted by `apiErrorPillSeg`
 * color the same as a bare `[failed]`) AND to the `warn` bucket for any
 * `awaiting:*` payload (so the `[awaiting:<kind>]` input-request pills
 * minted by `inputRequestPillSeg` — currently just
 * `[awaiting:ask_user_question]`, future-extensible to any built-in
 * interactive tool — color the same as a bare `[blocked]`) AND to the
 * `warn` bucket for any `task-repo:*` payload (so the
 * `[task-repo:<basename>]` divergence pill minted by `taskRepoPillSeg`
 * colors the same as `[blocked]`) AND to the `blue` (bright blue) bucket
 * for any `running:*` payload (so the `[running:<kind>]` motion pills minted
 * by `formatPill` for the four reasons split out of `BlockReason` —
 * `job-running`, `sub-agent-running`, `planner-running`, and (fn-638.4)
 * `sub-agent-stale` — color the same as a bare `[running]`, EXCEPT the
 * `running:sub-agent-stale` payload, which is routed to the `warn`
 * (yellow) bucket by a more-specific branch above the generic
 * `running:*` fallback so a possibly-stuck orphan sub-agent renders
 * distinctly from fresh in-flight work). Unknown tokens pass through
 * verbatim.
 *
 * Module-level + exported so `test/board.test.ts` can assert the coloring
 * contract without standing up the subscribe loop. Sidecars and the
 * byte-compare body stay plain — only the lines shipped to `pushFrame`
 * pass through this helper, gated on the TTY + NO_COLOR check in `main`.
 */
export function colorizePillsInLine(line: string): string {
  return line.replace(/\[([^\]]+)\]/g, (match, inner: string) => {
    let bucket = PILL_COLORS[inner];
    // fn-635: route `blocked:dep-on-epic-dangling <id>` to the `error`
    // bucket (red) — distinct from the amber `blocked:*` family. This
    // check MUST precede the generic `blocked:` → `warn` fallback below,
    // otherwise a dangling dep would render amber. The exact-match
    // `PILL_COLORS["dep-on-epic-dangling"] = "error"` entry above
    // handles the bare-token path; this prefix branch handles the
    // wrapped `blocked:dep-on-epic-dangling <upstream>` payload.
    if (
      bucket === undefined &&
      inner.startsWith("blocked:dep-on-epic-dangling")
    ) {
      bucket = "error";
    }
    if (bucket === undefined && inner.startsWith("blocked:")) {
      bucket = "warn";
    }
    if (bucket === undefined && inner.startsWith("failed:")) {
      bucket = "error";
    }
    if (bucket === undefined && inner.startsWith("awaiting:")) {
      bucket = "warn";
    }
    if (bucket === undefined && inner.startsWith("task-repo:")) {
      bucket = "warn";
    }
    // fn-643.5: `[dead-letter:N]` is the persistent banner pill the board
    // stamps when the daemon's `dead_letters` collection has waiting rows.
    // Warn/yellow bucket — "things to fix right now," same family as
    // `[blocked]` / `[awaiting:*]` / `[task-repo:*]`. The pill is dropped
    // entirely at count 0 (renderDeadLetterPill returns ""), so the
    // colorizer only sees this branch when there is actually a backlog.
    if (bucket === undefined && inner.startsWith("dead-letter:")) {
      bucket = "warn";
    }
    // fn-638.4: route `running:sub-agent-stale` to the `warn` bucket
    // (yellow) so a possibly-stuck orphan sub-agent renders distinctly
    // from a fresh `running:*` (cyan). Placed BEFORE the generic
    // `running:*` → `active` fallback so the more-specific staleness
    // signal wins. The other three `RunningReason` kinds
    // (`job-running`, `sub-agent-running`, `planner-running`) fall
    // through to `active` as before.
    if (bucket === undefined && inner === "running:sub-agent-stale") {
      bucket = "warn";
    }
    if (bucket === undefined && inner.startsWith("running:")) {
      bucket = "blue";
    }
    if (bucket === undefined) {
      return match;
    }
    return `[${SGR[bucket]}${inner}${SGR.reset}]`;
  });
}

// ---------------------------------------------------------------------------
// Dead-letter banner pill
// ---------------------------------------------------------------------------

/**
 * Render the persistent `[dead-letter:N]` warn pill for the banner status
 * line. `N` is the native waiting-row count from the `dead_letters`
 * collection (descriptor `defaultFilter: { status: "waiting" }`); zero
 * returns an empty string so the banner drops the pill cleanly when there
 * is no backlog. A `null` / negative input also collapses to empty —
 * defensive against a malformed snapshot. The returned string is plain
 * text; the banner colorizer applies `warn` (yellow) via the
 * `dead-letter:*` prefix branch in {@link colorizePillsInLine}.
 *
 * Module-level + exported so `test/board.test.ts` can assert the pill
 * shape without standing up the subscribe loop.
 */
export function renderDeadLetterPill(waitingCount: number): string {
  if (!Number.isFinite(waitingCount) || waitingCount <= 0) {
    return "";
  }
  return `[dead-letter:${waitingCount}]`;
}

// ---------------------------------------------------------------------------
// Sub-agent collapse line builder
// ---------------------------------------------------------------------------

/**
 * Per-job sub-agent lines. Reads from a per-frame `subagentIndex` (the
 * `job_id → SubagentInvocation[]` map the caller builds for each
 * emit). Same-name invocations within one job collapse to a single
 * line via `collapseSubagentsByName` — see that helper's docstring
 * for the operating assumption (no parallel like-named sub-agents
 * in practice). Each line carries
 * `{subagent_type}{annotations}: {description} [pill]` — `description`
 * is dropped when null/empty so the pill stays anchored next to the
 * type. `annotations` is a parenthesized comma-joined block that
 * appears only when there's something to say:
 *   - `×N` when the group folded more than one row
 *   - `N stuck` when one or more non-surviving rows are still
 *     `status='running'` (orphans whose `SubagentStop` never landed)
 * A clean group of one row renders with no parenthesized block.
 * `indent` is supplied per caller: embedded jobs (already three-
 * space indented inside an epic block) get six spaces; bottom-
 * section jobs (flush left) get three. Returns `[]` for jobs with
 * no recorded invocations so callers can spread unconditionally.
 *
 * Pure module function — fn-658.1 lifted this out of `cli/board.ts`'s
 * `main()` closure so the shared module can serve both the board and
 * jobs renderers. The trivial `seg` helper the closure used
 * (`v == null ? "" : String(v)`) is inlined at the one call site
 * below — no closure capture, no module-level `seg` import.
 */
export function subagentLinesFor(
  subagentIndex: Map<string, SubagentInvocation[]>,
  jobId: string,
  indent: string,
): string[] {
  const hits = subagentIndex.get(jobId);
  if (hits === undefined || hits.length === 0) {
    return [];
  }
  const groups = collapseSubagentsByName(hits);
  return groups.map((g) => {
    const type = g.row.subagent_type ?? "subagent";
    const desc = g.row.description ?? "";
    const annotations: string[] = [];
    if (g.count > 1) {
      annotations.push(`×${g.count}`);
    }
    if (g.stuck > 0) {
      annotations.push(`${g.stuck} stuck`);
    }
    const annSeg =
      annotations.length === 0 ? "" : ` (${annotations.join(", ")})`;
    const head = `${type}${annSeg}`;
    const label = desc === "" ? head : `${head}: ${desc}`;
    const status = g.row.status == null ? "" : String(g.row.status);
    return `${indent}${label} [${status}]`;
  });
}

// ---------------------------------------------------------------------------
// Dead-letter replay RPC client
// ---------------------------------------------------------------------------

/**
 * Hard upper bound on how long the `r` replay keypress waits for the
 * `replay_dead_letter` RPC to reply. The handler's bridge already
 * deadlines on the worker→main round-trip (`src/server-worker.ts`); 5s
 * mirrors approve.ts's RESPONSE_TIMEOUT_MS so the board never wedges
 * on a stuck daemon.
 */
export const REPLAY_DEAD_LETTER_TIMEOUT_MS = 5000;

/**
 * Shape of a successful `replay_dead_letter` RPC reply.
 * `recovered_dl_id: null` is the "nothing to replay" no-op ack; a string
 * value is the freshly-recovered row's `dl_id` (the row that flipped
 * `waiting → recovered`). Mirrors `ReplayDeadLetterResult` in
 * `src/rpc-handlers.ts` — kept structural here so the board doesn't
 * pull a server-side import.
 */
export interface ReplayDeadLetterRpcResult {
  recovered_dl_id: string | null;
}

/**
 * One-shot RPC client for `replay_dead_letter`. Opens a fresh UDS
 * connection (the board's subscribe socket is read-only — RPCs ride
 * SEPARATE connections per the approve.ts pattern), sends a single
 * `rpc` frame, awaits the matching `rpc_result` / `error` frame by id,
 * closes. Rejects with an Error carrying the human-readable reason on
 * connect-fail, transport error, malformed frame, server-side close
 * before reply, server `error` frame, or
 * REPLAY_DEAD_LETTER_TIMEOUT_MS elapsing post-connect.
 *
 * Module-level + exported so `test/board.test.ts` can stand up a mock
 * server and exercise the wire shape without the live-shell loop.
 *
 * The `connect` parameter is optional for test injection only —
 * production callers pass nothing and get the real `Bun.connect`.
 */
export async function sendReplayDeadLetterRpc(
  sockPath: string,
  connect?: (path: string) => Promise<{
    write(data: string): void;
    end(): void;
  }>,
): Promise<ReplayDeadLetterRpcResult> {
  const rpcId = crypto.randomUUID();
  const send: ClientFrame = {
    type: "rpc",
    id: rpcId,
    method: "replay_dead_letter",
    params: {},
  };
  return new Promise<ReplayDeadLetterRpcResult>((resolve, reject) => {
    const buffer = new LineBuffer();
    let settled = false;
    let sock: { end(): void } | null = null;
    const settle = (
      err: Error | null,
      value: ReplayDeadLetterRpcResult | null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        sock?.end();
      } catch {
        // already torn down
      }
      if (err) {
        reject(err);
      } else if (value) {
        resolve(value);
      } else {
        reject(new Error("internal: settle called with neither err nor value"));
      }
    };
    const timeout = setTimeout(() => {
      settle(
        new Error(
          `no response from daemon within ${REPLAY_DEAD_LETTER_TIMEOUT_MS}ms`,
        ),
        null,
      );
    }, REPLAY_DEAD_LETTER_TIMEOUT_MS);
    timeout.unref?.();

    const handleFrame = (frame: ServerFrame): void => {
      if ((frame as { id?: string }).id !== rpcId) {
        // Unrelated frame — discard. The dispatcher today never leaks
        // unrelated frames into an RPC reply path, but the discipline
        // matches approve.ts's defensive id-match.
        return;
      }
      if (frame.type === "rpc_result") {
        const value = frame.value as { recovered_dl_id?: string | null };
        const recovered =
          typeof value?.recovered_dl_id === "string"
            ? value.recovered_dl_id
            : null;
        settle(null, { recovered_dl_id: recovered });
        return;
      }
      if (frame.type === "error") {
        settle(new Error(`server error ${frame.code}: ${frame.message}`), null);
        return;
      }
      settle(new Error(`unexpected frame type: ${frame.type}`), null);
    };

    const factory =
      connect ??
      ((path: string) =>
        Bun.connect({
          unix: path,
          socket: {
            open(s) {
              sock = s as unknown as { end(): void };
              s.write(encodeFrame(send));
            },
            data(_s, chunk) {
              let lines: string[];
              try {
                lines = buffer.push(chunk.toString("utf8"));
              } catch (err) {
                settle(
                  new Error(`protocol error: ${(err as Error).message}`),
                  null,
                );
                return;
              }
              for (const line of lines) {
                if (line.trim().length === 0) continue;
                let frame: ServerFrame;
                try {
                  frame = JSON.parse(line) as ServerFrame;
                } catch (err) {
                  settle(
                    new Error(
                      `malformed server frame: ${(err as Error).message}`,
                    ),
                    null,
                  );
                  return;
                }
                handleFrame(frame);
              }
            },
            close() {
              settle(
                new Error("daemon closed connection before responding"),
                null,
              );
            },
            error(_s, err) {
              settle(new Error(`socket error: ${err.message}`), null);
            },
          },
        }) as unknown as Promise<{ write(data: string): void; end(): void }>);

    factory(sockPath).catch((err: Error) => {
      settle(
        new Error(`failed to connect to ${sockPath}: ${err.message}`),
        null,
      );
    });
  });
}
