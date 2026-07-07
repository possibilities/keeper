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
 * `cli/board.ts` re-exports every name `test/board.test.ts` and
 * `scripts/drain-dead-letters.ts` import from it, so external import paths
 * keep resolving.
 */

import { classifyDispatchFailure } from "./dispatch-failure-pill";
import { glyphForToken } from "./icon-theme";
import {
  type ClientFrame,
  encodeFrame,
  LineBuffer,
  type ServerFrame,
} from "./protocol";
import type { Verdict } from "./readiness";
import { collapseSubagentsByName } from "./readiness-client";
import type { ScheduledTask, SubagentInvocation } from "./types";

// ---------------------------------------------------------------------------
// Iconized pill core
// ---------------------------------------------------------------------------
//
// Every STATE pill is rendered as `[<glyph>::<token-text>]` — the `::`
// delimiter separates the Nerd Font icon (from the active `IconTheme`) from
// the text the colorizer still tints. A token the theme doesn't know (dep
// refs `#2` / `arthack#633`, the backend-coords `p3` label, the grouped dep
// summary) gets no icon and renders as a plain `[<token>]` pill — so the
// icon layer is additive, never lossy. The companion change is "show
// defaults": the resting value of every fixed-slot enum now renders an
// explicit pill (reversing the omit-default convention) so a viewer
// sees every state, never an absence to decode.

/** The body of an iconized pill (no brackets): `"<glyph>::<token>"` or, when
 * the token isn't a themed state, the bare `"<token>"`. */
export function iconizeToken(token: string): string {
  const glyph = glyphForToken(token);
  return glyph === null ? token : `${glyph}::${token}`;
}

/** A full bracketed, icon-prefixed pill for one token: `[<glyph>::<token>]`. */
export function pill(token: string): string {
  return `[${iconizeToken(token)}]`;
}

/** Re-wrap already-bracketed pill text (e.g. `formatPill`'s `"[ready]"`) into
 * the iconized form, leaving non-themed pills (`[#2]`) untouched. Used so the
 * pure verdict formatter in `readiness.ts` stays icon-free (its tests don't
 * move) while the board still renders verdict glyphs. */
export function iconizePills(bracketed: string): string {
  return bracketed.replace(/\[([^\]]+)\]/g, (_m, inner: string) => pill(inner));
}

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
  return ` ${pill(`failed:${k}`)}`;
}

/**
 * Render the optional `[awaiting:<kind>]` pill segment from the
 * `jobs.(last_input_request_at, last_input_request_kind)` pair (schema
 * v25 — the two-field signal cloned one-for-one off the
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
  return ` ${pill(`awaiting:${k}`)}`;
}

/**
 * Render the optional `[awaiting:<kind>]` pill segment from the
 * `jobs.(last_permission_prompt_at, last_permission_prompt_kind)` pair
 * (schema v52 — a near-exact clone of {@link inputRequestPillSeg}
 * with the one structural divergence noted below).
 *
 * The reducer stamps both columns together on the `Notification` fold
 * for the two whitelisted `event_type` values (`permission_prompt` —
 * Claude Code's tool-permission dialog; `elicitation_dialog` — an MCP
 * server requesting input mid-tool-call), unlike the InputRequest pair
 * which mints a synthetic event from a transcript match. The clear arms
 * mirror the InputRequest set with one addition: `UserPromptSubmit` /
 * `SessionStart` unconditionally, `PreToolUse` / `PostToolUse` gated on
 * `last_permission_prompt_at IS NOT NULL`, AND `Stop` as the session-
 * level backstop.
 *
 * The kind is taken straight off `last_permission_prompt_kind` — one of
 * `"permission"` / `"elicitation"`, mapped one-for-one from the
 * `event_type` value at the reducer boundary. No allow-list narrowing
 * here; the kind comes off the reducer already and renders verbatim.
 *
 * **Structural divergence from {@link inputRequestPillSeg}.** The
 * underlying reducer arm does NOT flip `state` — the pill layers on top
 * of the live `[working]` state rather than replacing it (the worker is
 * blocked on the human but structurally still mid-turn from keeper's
 * POV; no Stop fired). The renderer side is unaffected: this seg only
 * decides whether to drop the pill onto its own continuation line; the
 * `[working]` state pill comes from the row's `state` column unchanged.
 *
 * **Paired-NULL invariant.** The reducer guarantees `at` and `kind`
 * move together. The defensive fallback to `"unknown"` matches
 * {@link inputRequestPillSeg}.
 *
 * Returns the leading `' '` so the segment is self-delimiting —
 * empty string when `at` is null, ` [awaiting:<kind>]` otherwise. Every
 * caller drops THIS segment onto its own indented continuation line
 * beneath the row (`.trimStart()`-ed of the leading space) so a long-
 * running parked dialog reads without wrapping. Colored yellow on a TTY
 * via the colorizer's `awaiting:*` prefix fallback to the `warn` bucket
 * (the same bucket as {@link inputRequestPillSeg}'s
 * `[awaiting:ask_user_question]` — no colorizer change needed).
 */
export function permissionPromptPillSeg(at: unknown, kind: unknown): string {
  if (at == null) {
    return "";
  }
  const k = typeof kind === "string" && kind.length > 0 ? kind : "unknown";
  return ` ${pill(`awaiting:${k}`)}`;
}

/** Max rendered width of the `[<model>]` telemetry pill body before it is
 * truncated with a trailing `…` — keeps a long raw model id from blowing out
 * the finite board width. */
const TELEMETRY_MODEL_MAX = 20;

/**
 * Render the optional per-session telemetry pill segment from the six v100
 * `SessionTelemetry` jobs columns — a live session's CURRENT model,
 * reasoning effort, and context-window fill, projected verbatim from the
 * Claude Code statusLine payload and folded latest-wins onto the row.
 *
 * Shape (each piece a self-delimited pill; the whole segment is leading-space
 * so callers append it unconditionally):
 *   - `[<model>]` — `current_model_display` preferred over the raw
 *     `current_model_id`, truncated to {@link TELEMETRY_MODEL_MAX} with a
 *     trailing `…` when longer.
 *   - `[effort:<level>]`, or `[effort:—]` when `current_effort` is NULL. The
 *     em-dash is the tri-state's "unknown" — effort is NEVER defaulted to
 *     `low`. Always rendered once the segment shows.
 *   - `[ctx:<n>%]` — `context_used_percentage` rounded; dropped entirely when
 *     NULL (no placeholder — a session with no context snapshot shows no ctx
 *     pill).
 *
 * Returns `""` until the first snapshot lands (model / effort / context% all
 * NULL) so a job that never emitted telemetry — any pre-v100 row, an ambient
 * non-agent session — renders exactly as before. Pure function of the row
 * (no wall-clock, no env); strings are bound straight from the projection,
 * never interpolated as SQL/shell.
 */
export function sessionTelemetryPillSeg(row: Record<string, unknown>): string {
  const modelDisplay =
    typeof row.current_model_display === "string" &&
    row.current_model_display !== ""
      ? row.current_model_display
      : null;
  const modelId =
    typeof row.current_model_id === "string" && row.current_model_id !== ""
      ? row.current_model_id
      : null;
  const model = modelDisplay ?? modelId;
  const effort =
    typeof row.current_effort === "string" && row.current_effort !== ""
      ? row.current_effort
      : null;
  const pct =
    typeof row.context_used_percentage === "number" &&
    Number.isFinite(row.context_used_percentage)
      ? row.context_used_percentage
      : null;
  // Gate: no snapshot has landed → drop the whole segment, so pre-v100 /
  // ambient sessions render unchanged.
  if (model === null && effort === null && pct === null) {
    return "";
  }
  const segs: string[] = [];
  if (model !== null) {
    const truncated =
      model.length > TELEMETRY_MODEL_MAX
        ? `${model.slice(0, TELEMETRY_MODEL_MAX - 1)}…`
        : model;
    segs.push(pill(truncated));
  }
  // Effort always renders once the segment shows — `—` is the "unknown"
  // placeholder, never a fabricated `low`.
  segs.push(pill(`effort:${effort ?? "—"}`));
  if (pct !== null) {
    segs.push(pill(`ctx:${Math.round(pct)}%`));
  }
  return ` ${segs.join(" ")}`;
}

// ---------------------------------------------------------------------------
// Omit-default pill helpers (T1) + verdict-aware suppression (T2/T3)
// ---------------------------------------------------------------------------

/**
 * The lossless-consolidation primitive (transform T1
 * "omit-default"). Render a ` [value]` pill segment ONLY when `value`
 * differs from its single resting/default value; render `""` (no pill)
 * at the default. Absence of the pill ≡ the default — a uniform rule
 * documented in each view's `--help` (the omit-default convention).
 *
 * Returns the leading `' '` so callers append unconditionally (same
 * self-delimiting convention as {@link apiErrorPillSeg} /
 * {@link inputRequestPillSeg}). A non-string / null value coalesces to the
 * default (→ `""`) so a malformed projection cell never emits `[null]`.
 *
 * Pure function of its args (no wall-clock, no env) — the live-shell
 * byte-compare and the existing test style hold.
 */
export function pillOrEmpty(value: unknown, dflt: string): string {
  // SHOW the default (reverses the omit-default convention). The
  // resting value now renders an explicit iconized pill so the viewer sees
  // every state. A null / non-string / empty value coalesces to `dflt` (so a
  // malformed projection cell renders the resting pill, never `[]`). The
  // name is retained for import stability; it no longer returns empty.
  const v = typeof value === "string" && value !== "" ? value : dflt;
  return ` ${pill(v)}`;
}

/**
 * Map the epic's `last_validated_at` to the omit-default `[validated]`
 * pill segment (T1). The producer-side `asString`
 * (`src/plan-worker.ts`) already collapses empty-string / non-string
 * values to `null`, so the predicate is simply `v != null`: render
 * ` [validated]` when validated, `""` otherwise (absence ≡ `unvalidated`).
 * Reinforced by the verdict (`epic-not-validated` covers the visible
 * blocked case).
 *
 * Returns the leading `' '` so the caller appends unconditionally. Pure
 * function.
 */
export function validatedPill(lastValidatedAt: unknown): string {
  // SHOW both states: `[validated]` when validated, `[unvalidated]` otherwise.
  return lastValidatedAt != null
    ? ` ${pill("validated")}`
    : ` ${pill("unvalidated")}`;
}

/**
 * Render the trailing `[armed]` pill segment for a board EPIC HEADER.
 * Omit-default convention (the same rule as the other omit-default pills):
 * ` [armed]` when the epic is explicitly armed, `""` otherwise — absence ≡
 * not armed. v1 surfaces EXPLICIT-armed epics only (matches the autopilot
 * screen's armed list); the dep-pulled-in closure is a documented future
 * enhancement. Routes through `pill` so it picks up the icon theme; returns
 * its own leading space so the caller appends self-delimited. Pure.
 */
export function armedPill(isArmed: boolean): string {
  return isArmed ? ` ${pill("armed")}` : "";
}

/**
 * Render the trailing `[started]` pill segment for a board EPIC HEADER. Marks
 * the started-first reorder (`orderEpicsForScheduling`) legible: ` [started]`
 * when the epic has real worker activity (`isEpicStarted`), `""` otherwise —
 * absence ≡ not started. Same omit-default convention as `armedPill`; routes
 * through `pill` for the icon theme and returns its own leading space so the
 * caller appends self-delimited. Pure.
 */
export function startedPill(isStarted: boolean): string {
  return isStarted ? ` ${pill("started")}` : "";
}

/** Render fixed model/effort cells for every board TASK LINE. */
export function renderTaskCellPills(task: Record<string, unknown>): string {
  let out = "";
  const model =
    typeof task.model === "string" && task.model !== "" ? task.model : null;
  const effort =
    typeof task.tier === "string" && task.tier !== "" ? task.tier : null;
  out += ` ${pill(`model:${model ?? "—"}`)}`;
  out += ` ${pill(`effort:${effort ?? "—"}`)}`;
  return out;
}

/**
 * Render runtime task state pills for every board TASK LINE: current
 * `runtime_status` plus current `worker_phase`, both with defaults shown.
 */
export function renderTaskPills(
  task: Record<string, unknown>,
  _verdict: Verdict,
): string {
  // SHOW every fixed-slot enum at its current value
  // (reverses the omit-default convention AND drops the verdict-aware T3 suppression)
  // — runtime_status / worker_phase now render on every task row, defaults
  // included, each as an iconized `[<glyph>::<token>]` pill. The `_verdict`
  // arg is retained for call / test arity but no longer consulted.
  let out = "";

  // runtime_status (B10): `blocked` relabels to `rt:blocked` so it never
  // collides with the verdict `[blocked:*]` family; everything else verbatim.
  const rtRaw = task.runtime_status;
  const rt = typeof rtRaw === "string" && rtRaw !== "" ? rtRaw : "todo";
  out += ` ${pill(rt === "blocked" ? "rt:blocked" : rt)}`;

  // worker_phase (B11): `done` renders the labeled `worker-done` (never bare
  // `done`, which collides with runtime `done`); `open` is the resting value.
  out += ` ${pill(task.worker_phase === "done" ? "worker-done" : "open")}`;

  return out;
}

/**
 * Render the trailing pill segment for a board CLOSE ROW —
 * the consolidated `[${status}]` closure. Pure `f(epicRow, verdict)`. There
 * is no `[approval]` pill: the approval surface does not exist.
 *
 *   - **close status (B15)** — the board filter is `status='open'`, so this
 *     pill is the constant `[open]` on the default view; it renders anyway so
 *     a custom-filtered view that surfaces non-open epics carries the value.
 *
 * Returns `""` when nothing survives, else a `' '`-prefixed pill string.
 */
export function renderClosePills(
  epicRow: Record<string, unknown>,
  _verdict: Verdict,
): string {
  // SHOW the close-row status at its current value. On the default board
  // filter `status` is the constant `open`; it renders anyway so every row
  // carries the full state. The `_verdict` arg is retained for call / test
  // arity. There is no approval pill.
  let out = "";
  const statusRaw = epicRow.status;
  const status =
    typeof statusRaw === "string" && statusRaw !== "" ? statusRaw : "open";
  out += ` ${pill(status)}`;
  return out;
}

/**
 * Render the trailing `[failed:<kind>]` pill for a board row whose dispatch is
 * parked STICKY in the `dispatch_failures` projection — a `close::<epic>` the
 * reconciler ATTEMPTED and that jammed (e.g. a worktree merge conflict at
 * `finalizeEpic`), OR a `work::<task>` the reconciler rejected (e.g. a
 * `worktree-multi-repo` gate). `computeReadiness` is pure and never reads that
 * projection, so the row's readiness verdict still reads `ready`; without this
 * pill the board would show a dispatchable row while autopilot is jammed on the
 * sticky failure. The pill carries only the failure KIND (via
 * `classifyDispatchFailure` — the short display vocab) so a multi-line `reason`
 * (the conflict dump) stays one scannable pill; the colorizer routes `failed:*`
 * to the red `error` bucket.
 *
 * Returns `""` when there is no sticky failure, else a `' '`-prefixed pill
 * string.
 */
export function renderDispatchFailurePill(reason: string | undefined): string {
  if (reason === undefined || reason === "") {
    return "";
  }
  return ` ${pill(`failed:${classifyDispatchFailure(reason)}`)}`;
}

/** One flagged epic as {@link selectionReviewLines} reads it — its id plus the
 *  raw `selection_review` JSON blob (defensively coerced; the collection serves
 *  it verbatim as TEXT). */
export interface SelectionReviewEpic {
  epic_id?: unknown;
  selection_review?: unknown;
}

/** The three-way selection-review verdicts, in canonical render order. A misfit
 *  flag is raised only for a non-right-sized verdict (ADR 0011); `right_sized`
 *  renders for context when the blob carries it. */
const SELECTION_REVIEW_VERDICTS = [
  "underpowered",
  "right_sized",
  "overpowered",
] as const;

/** Format one flagged epic's `selection_review` blob to its verdict-counts
 *  segment — `underpowered:N right_sized:N overpowered:N` for whichever
 *  canonical keys the parsed `counts` object carries (numeric only), stable
 *  order. An unparseable / count-less blob degrades to `?` so the line still
 *  renders (the epic still needs an operator clear). Pure; never throws. */
function selectionReviewCountsSeg(blob: unknown): string {
  if (typeof blob !== "string") {
    return "?";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return "?";
  }
  const counts =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { counts?: unknown }).counts
      : undefined;
  if (counts === null || typeof counts !== "object") {
    return "?";
  }
  const rec = counts as Record<string, unknown>;
  const segs: string[] = [];
  for (const v of SELECTION_REVIEW_VERDICTS) {
    const n = rec[v];
    if (typeof n === "number") {
      segs.push(`${v}:${n}`);
    }
  }
  return segs.length === 0 ? "?" : segs.join(" ");
}

/**
 * Render the top-of-board `selection review (N)` block — the DISPLAY-ONLY
 * needs-human class (ADR 0011) that surfaces a completed epic's close-time
 * selection-review flag until an operator clears it. One line per flagged epic:
 * its id, the verdict counts parsed off the `selection_review` blob, and the
 * clear-verb hint. Sourced from the NARROW unfiltered read (any status), so a
 * flagged CLOSED epic still renders. This block NEVER contributes to the jam
 * `needs human (N)` count — it neither gates nor blocks anything. Empty input
 * (no flagged epics) renders nothing. Sorted by epic id for a byte-stable frame.
 */
export function selectionReviewLines(
  epics: readonly SelectionReviewEpic[],
): string[] {
  const flagged = epics
    .filter((e) => (e.selection_review ?? null) !== null)
    .map((e) => ({
      epicId: e.epic_id == null ? "" : String(e.epic_id),
      counts: selectionReviewCountsSeg(e.selection_review),
    }))
    .sort((a, b) => a.epicId.localeCompare(b.epicId));
  if (flagged.length === 0) {
    return [];
  }
  const out = [`selection review (${flagged.length})`];
  for (const f of flagged) {
    out.push(
      `  ${f.epicId} — ${f.counts} · keeper plan selection-review ${f.epicId} --clear`,
    );
  }
  return out;
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
  // `working` (a live interactive session in the `keeper jobs`
  // TUI) joins `running` in the bright-blue "in motion right now" hue.
  // It was previously `active`/cyan, which reads as nearly-default
  // foreground on many terminals — the blue is the visible signal a
  // live working session deserves. `running` and `working` never share
  // a single TUI (the board emits `running:*` verdicts; `keeper jobs`
  // emits the bare `working` state pill), so the shared hue introduces
  // no in-view ambiguity.
  working: "blue",
  // Schema v62: the `[armed]` epic-header pill (rendered when the
  // epic is present in the `armed_epics` presence table). Active/cyan bucket
  // — a "live, human-chosen structural signal" rather than a
  // success/error/warn state.
  armed: "active",
  ok: "success",
  approved: "success",
  validated: "success",
  ready: "success",
  done: "success",
  // The labeled worker-phase survivor pill. `[worker-done]` is the
  // de-ambiguated render of `worker_phase=done` (never bare `[done]`, to
  // avoid collision with runtime `done`). Green/success — it is a done
  // signal, same family as bare `[done]`.
  "worker-done": "success",
  // The relabeled manual runtime block flag. `[rt:blocked]` is
  // `runtime_status=blocked` rendered with the `rt:` prefix so it never
  // collides with the verdict `[blocked:*]` family. Yellow/warn — same
  // "something is in the way" family as bare `[blocked]`.
  "rt:blocked": "warn",
  failed: "error",
  rejected: "error",
  killed: "error",
  // A structurally-broken cross-project epic dep (full-id miss,
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
 * payload (so `[blocked:dep-on-task <task-id>]` colors the same as
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
 * by `formatPill` for the reasons split out of `BlockReason` —
 * `job-running`, `sub-agent-running`, and
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
/**
 * Map a pill's TEXT token (the part after any `<glyph>::` icon prefix) to its
 * color bucket, or `undefined` to leave it uncolored. Pure string lookup +
 * the historical prefix fallbacks — unchanged routing, just lifted out of the
 * `replace` callback so it keys on the text token rather than the whole inner
 * (which now carries the icon).
 */
function bucketForToken(token: string): PillBucket | undefined {
  let bucket = PILL_COLORS[token];
  // `blocked:dep-on-epic-dangling <id>` → red (distinct from the amber
  // `blocked:*` family). MUST precede the generic `blocked:` → warn fallback.
  if (
    bucket === undefined &&
    token.startsWith("blocked:dep-on-epic-dangling")
  ) {
    bucket = "error";
  }
  if (bucket === undefined && token.startsWith("blocked:")) {
    bucket = "warn";
  }
  if (bucket === undefined && token.startsWith("failed:")) {
    bucket = "error";
  }
  if (bucket === undefined && token.startsWith("awaiting:")) {
    bucket = "warn";
  }
  if (bucket === undefined && token.startsWith("task-repo:")) {
    bucket = "warn";
  }
  // `dead-letter:N` banner pill → warn ("things to fix right now").
  if (bucket === undefined && token.startsWith("dead-letter:")) {
    bucket = "warn";
  }
  // `running:sub-agent-stale` → warn (distinct from fresh
  // `running:*` blue); MUST precede the generic `running:` fallback.
  // `running:monitor-stale` joins it — a past-soft-TTL live-worker
  // monitor still occupies the mutex but renders distinctly so a human sees
  // the possibly-abandoned slot.
  if (
    bucket === undefined &&
    (token === "running:sub-agent-stale" || token === "running:monitor-stale")
  ) {
    bucket = "warn";
  }
  if (bucket === undefined && token.startsWith("running:")) {
    bucket = "blue";
  }
  return bucket;
}

export function colorizePillsInLine(line: string): string {
  return line.replace(/\[([^\]]+)\]/g, (match, inner: string) => {
    // Iconized pills are `<glyph>::<token>`. Color keys on
    // the TEXT token (after `::`); the SGR wraps the WHOLE inner so the glyph
    // inherits the same hue. Plain pills (no `::` — dep refs, backend coords)
    // key on the whole inner, exactly as before.
    const sep = inner.indexOf("::");
    const token = sep === -1 ? inner : inner.slice(sep + 2);
    const bucket = bucketForToken(token);
    if (bucket === undefined) {
      return match;
    }
    return `[${SGR[bucket]}${inner}${SGR.reset}]`;
  });
}

// ---------------------------------------------------------------------------
// Epic header label
// ---------------------------------------------------------------------------

/**
 * Build the `{epic_number} {title}` label portion of an epic header line,
 * with an `epic_id` fallback so a half-scaffolded epic still renders a
 * legible, non-blank header.
 *
 * A keeper epic and its tasks fold as two separate single-event
 * transactions (`EpicSnapshot`, then `TaskSnapshot`); a freshly-minted
 * stub row exists before its `EpicSnapshot` lands with BOTH `epic_number`
 * and `title` still null. The legacy header build
 * (`${seg(epic_number)} ${seg(title)}`) collapsed that to a lone space —
 * surfacing as a blank `(keeper)  [unvalidated]` line with no way to tell
 * WHICH epic the row belonged to. Per the "show it blocked, don't
 * hide" decision, fall back to the `epic_id` (non-null on the `Epic`
 * projection — `src/types.ts`) so the row is always identifiable, never
 * hidden.
 *
 * Pure module function — extracted out of `cli/board.ts`'s
 * non-exported `renderEpicBlock` closure (mirroring the
 * {@link renderJobLinkLines} / {@link subagentLinesFor} extractions) so
 * `test/board.test.ts` can assert the fallback directly without standing
 * up the subscribe loop. The trivial `v == null ? "" : String(v)`
 * coalescer the closure used (`seg`) is inlined here for the one call
 * site — no closure capture.
 *
 * Returns ONLY the label (no `(dir)` prefix, no dep / validated /
 * readiness pills); the caller assembles those around it unchanged.
 *   - both `epic_number` and `title` present → `"12 Add OAuth"`
 *   - `epic_number` null, `title` present    → `"Add OAuth"`
 *   - `title` null, `epic_number` present    → `"12"`
 *   - both null                              → `epicId` (the fallback)
 */
export function epicHeaderLabel(
  epicNumber: unknown,
  title: unknown,
  epicId: string,
): string {
  const numSeg = epicNumber == null ? "" : String(epicNumber);
  const titleSeg = title == null ? "" : String(title);
  const label = `${numSeg} ${titleSeg}`.trim();
  return label === "" ? epicId : label;
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
  return pill(`dead-letter:${waitingCount}`);
}

// ---------------------------------------------------------------------------
// tmux client-focus banner pill
// ---------------------------------------------------------------------------

/**
 * Render the persistent `[focus <session>:<win> %<pane>]` banner pill from the
 * `tmux_client_focus` singleton. Renders `[focus: none]` when the
 * singleton is absent (no-tmux env or a worker that never connected) OR its
 * `status` is anything other than `'focused'` (the worker's `'none'` derivation),
 * OR the location fields are missing/malformed. `pane_id` already carries tmux's
 * `%` prefix (e.g. `%9`), so it renders verbatim. A null `window_index` collapses
 * the `:<win>` segment (`[focus main %9]`) rather than printing `null`.
 *
 * The token is informational (no `focus`/`focus:` entry in the icon theme or
 * `PILL_COLORS`), so it renders icon-free + uncolored — distinct from the warn
 * `[dead-letter:N]` pill it composes with on the banner. Module-level + exported
 * so the banner-composition test can assert the shape without the subscribe loop.
 */
export function renderTmuxFocusPill(
  focus:
    | {
        status?: string | null;
        session_name?: string | null;
        window_index?: number | null;
        pane_id?: string | null;
      }
    | null
    | undefined,
): string {
  if (
    focus == null ||
    focus.status !== "focused" ||
    typeof focus.session_name !== "string" ||
    focus.session_name === "" ||
    typeof focus.pane_id !== "string" ||
    focus.pane_id === ""
  ) {
    return "[focus: none]";
  }
  const win =
    typeof focus.window_index === "number" &&
    Number.isInteger(focus.window_index)
      ? `:${focus.window_index}`
      : "";
  return `[focus ${focus.session_name}${win} ${focus.pane_id}]`;
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
 * `{subagent_type}{annotations}: {description}{ status-pill}` —
 * `description` is dropped when null/empty so any status pill stays
 * anchored next to the type. The status pill follows the
 * omit-default rule (T1, B18): it is rendered ONLY for the non-resting
 * states (`running` / `failed` / `unknown` / `superseded`); `ok`, a
 * null/missing status, and the empty string all encode the resting value
 * and render NO pill (absence ≡ ok). `annotations` is a parenthesized
 * comma-joined block that
 * appears only when there's something to say:
 *   - `×N` when the group folded more than one row
 *   - `N stuck` when one or more non-surviving rows are still in flight
 *     (open turn: NULL `duration_ms`, status running|ok — orphans whose
 *     `SubagentStop` never landed)
 * A clean group of one row renders with no parenthesized block.
 * `indent` is supplied per caller: embedded jobs (already three-
 * space indented inside an epic block) get six spaces; bottom-
 * section jobs (flush left) get three. Returns `[]` for jobs with
 * no recorded invocations so callers can spread unconditionally.
 *
 * Pure module function — lifted out of `cli/board.ts`'s
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
    // T1, B18: omit the status pill at its resting/absent values —
    // `ok` (the chosen resting-success value), a null/missing status, and the
    // empty string all fold to NO pill (absence ≡ ok). Previously a null
    // status emitted a literal empty `[]`; that latent noise is gone here.
    // Keep the four non-resting states visible: `running` (blue),
    // `failed` (red), `unknown` (uncolored), `superseded` (faded).
    //
    // The static `SubagentInvocation.status` type is the five-member union
    // (no null / empty), but the runtime value off a narrowed wire frame can
    // arrive null/undefined (cf. the safe-7 decode), so the guard is
    // read through `unknown` to keep the defensive null/empty drop honest —
    // same posture as the prior `g.row.status == null ? "" : String(...)`.
    // SHOW the status at its current value, `ok` included
    // (reverses the omit-default convention), as an iconized pill. A null / empty
    // status coalesces to the resting `ok`.
    const statusRaw: unknown = g.row.status;
    const status =
      typeof statusRaw === "string" && statusRaw !== "" ? statusRaw : "ok";
    const statusSeg = ` ${pill(status)}`;
    return `${indent}${label}${statusSeg}`;
  });
}

// ---------------------------------------------------------------------------
// Scheduled-task (cron) line builder
// ---------------------------------------------------------------------------

/**
 * Per-job scheduled-task (cron) lines for the expanded job row. Reads from a
 * per-frame `scheduledTaskIndex` (the `job_id -> ScheduledTask[]` map the
 * caller builds for each emit, populated from `snapshot.scheduledTasks`, i.e.
 * the collection's `state.rows` — NOT `byId`, which collapses the composite
 * `(job_id, cron_id)` identity to one row per job). `deleted` rows are filtered
 * out (a CronDelete flipped them); the survivors sort by `ts` asc with a
 * `cron_id` tiebreak so the order is stable across re-paints.
 *
 * Each line carries `[<marker>] <schedule>: <prompt>` where:
 *   - `<marker>` is `recurring` or `one-shot`, upgraded to `spent` (a one-shot
 *     on a terminal job) or `expired` (a recurring on a terminal job). Job
 *     state is the authority here — the projection never flips a row's status;
 *     the renderer marks crons whose arming session has exited
 *     (`ended` / `killed`). This is the one place wall-clock / job-liveness is
 *     allowed to drive display, per the fold/render split.
 *   - `<schedule>` is `human_schedule` (the payload's pre-rendered form),
 *     falling back to the raw `cron` string when empty.
 *   - `<prompt>` is `prompt_summary` (already first-line + length capped by the
 *     fold; untrusted freeform text, rendered as plain text). Omitted when
 *     empty so a promptless cron stays one clean line.
 *
 * `durable` is stored on the row but deliberately not rendered. `indent` is
 * supplied per caller (matching `subagentLinesFor`). Returns `[]` for jobs with
 * no crons so callers can spread unconditionally. Exported for the render test.
 */
export function scheduledTaskLinesFor(
  scheduledTaskIndex: Map<string, ScheduledTask[]>,
  jobId: string,
  indent: string,
  jobTerminal: boolean,
): string[] {
  const hits = scheduledTaskIndex.get(jobId);
  if (hits === undefined || hits.length === 0) {
    return [];
  }
  const live = hits
    .filter((t) => t.status !== "deleted")
    .sort((a, b) => a.ts - b.ts || a.cron_id.localeCompare(b.cron_id));
  return live.map((t) => {
    const recurring = t.recurring === 1;
    // Job state is the authority: a cron on an exited session can never fire
    // again, so a one-shot is `spent` and a recurring is `expired`. A live job
    // keeps the plain `recurring` / `one-shot` marker.
    const marker = jobTerminal
      ? recurring
        ? "expired"
        : "spent"
      : recurring
        ? "recurring"
        : "one-shot";
    const schedule = t.human_schedule !== "" ? t.human_schedule : t.cron;
    const promptSeg = t.prompt_summary !== "" ? `: ${t.prompt_summary}` : "";
    return `${indent}${pill(marker)} ${schedule}${promptSeg}`;
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
