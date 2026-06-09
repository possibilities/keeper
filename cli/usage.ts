#!/usr/bin/env bun
/**
 * `keeper usage` — watch the keeperd `usage` + `jobs` collections as a single
 * composed frame.
 *
 * Moved from `scripts/usage.ts` under epic fn-646 task .3 (OpenTUI cutover).
 * The `main(argv: string[])` signature lets the `cli/keeper.ts` dispatcher
 * pass through subcommand argv directly; the `import.meta.main` guard is
 * neutralized — the dispatcher is the canonical entry. The exported
 * `renderRowLines` / `renderSessionLines` pure-function helpers survive the
 * move so `test/usage.test.ts` continues to assert against the same row
 * layout.
 *
 * Two `subscribeCollection` calls drive one composed frame. The `usage`
 * stream renders the per-profile quota stacks (top); the `jobs` stream
 * renders the `recent sessions` log (bottom — the last 20 jobs newest-first,
 * each labeled with its `profile_name`). Either stream changing re-emits the
 * whole frame; each is change-gated on its own raw-field hash, so a
 * relative-time tick or a fetch-only refresh never forges a frame. Each
 * usage row renders as a stacked block — a header line with the id chip +
 * target/multiplier chip, then one indented body line per quota window
 * (session, week, and sonnet where present). As of schema v35 (fn-642) the
 * rate-limit annotation is colocated onto the same `usage` row via
 * `last_rate_limit_at` + `last_rate_limit_session_id`, so a tracked stack
 * carries a `rate-limited <rel>` line under its quota lines when the row
 * has been rate-limited; as of schema v41 (fn-651) that line is a
 * forward-looking lift countdown (`rate-limited for <rel>` when
 * `rate_limit_lifts_at` is known and future, `rate-limited n/a` when it
 * is absent or already past — never a confusing "<rel> ago" countdown
 * and never falling back to the fired-time `last_rate_limit_at`).
 * Profiles that have never hit a limit (and the codex stack, which has
 * no rate-limit concept) omit the line. A v41 freshness signal rides
 * the same row via `last_usage_fold_at`: a row whose stamp is older
 * than `STALENESS_THRESHOLD_MS` (driven ONLY off that stamp — never
 * `updated_at`, which a rate-limit fold bumps, and never agentuse's own
 * `status`, which tracks its scrape failures rather than keeper's
 * ingestion health) picks up an indented `stale Nm` line so a wedged
 * usage worker becomes visible instead of silently frozen. Stale, idle,
 * and rate-limited stay visually distinct (stale is its own labelled
 * line; idle is a header chip; rate-limited is the colocated countdown
 * line). Untracked profiles (a rate-limit without an agentuse usage
 * row) do not render anywhere — the "drop untracked" decision.
 *
 * The daemon-side usage worker watches `~/.local/state/agentuse/<id>.json`
 * and folds synthetic `UsageSnapshot` / `UsageDeleted` events into the
 * `usage` collection. The reducer's bidirectional fan-out joins the
 * sibling `profiles` row via `usage.id = profiles.profile_name` and
 * mirrors `last_rate_limit_at` / `last_rate_limit_session_id` onto the
 * usage row inside the same `BEGIN IMMEDIATE`. This module is the
 * primitive frame UI for the colocated surface, mirroring `cli/git.ts`'s
 * sidecar discipline (per-frame state JSON carrying the row set + frame
 * text + unified diff under `/tmp/keeper-usage.<pid>.*`, indexed meta
 * sidecar, SIGINT teardown that prints sidecar paths).
 *
 * Connection lifecycle is owned by `subscribeCollection` in
 * `src/readiness-client.ts` — same capped-backoff reconnect, per-collection
 * coalesce, steady-poll backstop, and `dispose()` contract as `cli/git.ts`.
 * The module's job is rendering rows + writing sidecars; the helper handles
 * everything below the rows. SIGINT disposes the live shell first, then
 * both subscribe handles (the three-handle teardown).
 *
 * Reset cells render as minute-rounded humanized relative time
 * (`5d 21h`, `3h 5m`, `5m`, `now`) against the current wall clock —
 * future times drop the `in ` prefix since the column context (a reset
 * countdown) makes the direction unambiguous. A reset is strictly
 * FORWARD (agentuse resolves `*_resets_at` into the future at every
 * scrape), so a target that has slipped into the PAST is never a real
 * age — it's a prediction whose moment elapsed before a fresh scrape
 * replaced it, i.e. STALE. {@link resetCell} renders that as `—`
 * (`STALE_CELL`), not `now` and not `5h ago`: a 19h-dead producer
 * rendering a whole screen of confident `now` read as "everything just
 * reset." Two independent triggers dash a cell — the per-cell past check
 * above (catches one profile whose scrape is erroring while keeper keeps
 * folding the rest), and a whole-row `last_usage_fold_at` staleness flag
 * (catches a wholesale-frozen producer, dashing even a still-future reset
 * + the rate-limit lift so a dead row reads as uniformly dead). The
 * `stale Nm` line carries the age + the why. For the live frame in TUI
 * mode a 30s tick re-renders via `liveShell.refreshLive` so the visible
 * countdown ticks forward without growing history or writing sidecars;
 * historical scroll-back keeps each frame's at-capture rendering, so the
 * relative times you see when stepping back are the ones that were on
 * screen when that frame was first emitted. Under the OpenTUI port the
 * `refreshLive` overlay is a true no-op on identical text (linesEqual
 * skip guards the call entirely, AND the renderer's diff would short-
 * circuit anyway), so the 30s tick never flickers; when the live view
 * is scrolled back into history the overlay is dormant (refreshLive
 * updates the live slot only; history frames stay frozen).
 *
 * fn-660.1 deferral: `cli/usage.ts` does NOT use `createViewShell` (the
 * shared TUI shell harness adopted by board / jobs / git). Reason: usage
 * blends TWO subscribe streams (`usage` rows + `jobs` rows) into one
 * composed body, runs a 30s `refreshLive` tick for relative-time bleed
 * without growing history, and gates emit on raw projection-subset hash
 * keys (NOT rendered text) so a fetch-only `last_event_id` bump can't
 * forge a frame. Folding any of that into the shared shell would either
 * widen its API to a leaky abstraction or strip a load-bearing
 * change-gate from this view. Revisit if a second multi-stream sibling
 * appears.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildDebugSnapshot, copyToClipboard } from "../src/clipboard-debug";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import { subscribeCollection } from "../src/readiness-client";
import { armViewerExitTriggers } from "../src/view-shell";

const COLLECTION = "usage";

const HELP = `keeper usage — live usage frames over the keeper subscribe server

Usage: keeper usage [--sock <path>]

  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --help         Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  c copy current frame + sidecar paths to clipboard, q/Ctrl-C quit.
  Per-frame sidecars are indexed; lifecycle output is
  appended to /tmp/keeper-usage.<pid>.lifecycle.txt. Session paths
  print on exit.

Each profile renders as a stacked block — a header line with the id
chip + target/multiplier chip, then one indented body line per quota
window (session, week, and sonnet where present). Each body line
carries a 30-wide ASCII bar (\`█\` filled / \`░\` empty) followed by
the numeric pct and a bare relative reset countdown (\`5d 21h\` /
\`1h 16m\` / \`5m\` / \`now\`). On a STALE row the reset countdown — and
the rate-limit lift below — render as \`—\` instead of a confident-but-
elapsed value (the data is a frozen snapshot; their predicted times have
all passed). A tracked stack carrying a rate-limit
annotation (schema v35 / fn-642) gets a colocated \`rate-limited\` line
under its quota lines; as of schema v41 (fn-651) that line is a
forward-looking lift countdown — \`rate-limited for <rel>\` when
\`rate_limit_lifts_at\` is known and still in the future, \`rate-limited
n/a\` when it is absent or already past, \`rate-limited —\` when the row
is stale (never a "<rel> ago" countdown, never a fallback to the
fired-time). Codex and never-limited
stacks omit the line. A v41 \`stale Nm\` line appears under any row
whose \`last_usage_fold_at\` is older than the staleness threshold —
driven only off that stamp, never \`updated_at\` and never agentuse's
own \`status\` — surfacing a wedged ingestion path instead of silently
frozen gauges, and labelling the \`—\` cells above it. Untracked profiles (a rate-limit with no agentuse usage
row) do not render. Below the profile stacks, a \`recent sessions\` block logs the
last 20 jobs (any state) newest-first, each labeled with the profile
it ran under (\`profile_name\`, schema v36) plus a short id, title,
state, and age. The live frame re-renders every 30s so countdowns tick;
historical scroll-back stays frozen at each frame's capture time.
Per-frame sidecars under /tmp/keeper-usage.<pid>.{state,frame,diff}.<n>.*
with an indexed meta sidecar; session paths print on SIGINT.
`;

function seg(v: unknown): string {
  return v == null ? "" : String(v);
}

function pct(v: unknown): string {
  if (v == null) return "?";
  if (typeof v === "number") return `${v}%`;
  return `${String(v)}%`;
}

/**
 * Minute-rounded humanized relative time between `iso` and `nowMs`.
 * Returns `""` for an empty input (no reset known), the raw input string
 * if the ISO is unparseable (degrade gracefully — better than throwing
 * inside a render hot path), `"now"` at the round boundary, and
 * a two-unit-max largest-first form otherwise:
 *
 *   - `≥ 1 week`: `Nw Md` (residual hours dropped — at week scale,
 *     minute precision is noise; the residual hours under a day
 *     wouldn't be worth showing either).
 *   - `≥ 1 day`:  `Nd Mh` (residual minutes dropped).
 *   - `≥ 1 hour`: `Nh Mm`.
 *   - otherwise: `Mm`.
 *
 * Zero residuals collapse: `1w` not `1w 0d`, `1d` not `1d 0h`, `1h`
 * not `1h 0m`. Future times render bare (`<body>`) — the column
 * context (reset countdown) makes direction unambiguous; past times
 * render `<body> ago`.
 *
 * This is the AGE formatter: its `ago` branch is for cells that are
 * genuinely backward-looking (`error_at`, the recent-session timestamps).
 * The forward-looking reset cells DON'T call it directly — they go through
 * {@link resetCell}, which intercepts an elapsed (past) target and renders
 * `—` before this `ago` branch can mislabel an "until reset" value as an
 * age. So in practice `relTime` only ever produces `ago` for a real age.
 *
 * `nowMs` is a parameter (not `Date.now()` baked in) so tests can drive
 * deterministic snapshots AND so the 30s tick can pass a fresh clock
 * read without `renderRowLines` doing any wall-clock IO of its own.
 */
function relTime(iso: string, nowMs: number): string {
  if (iso === "") return "";
  const target = Date.parse(iso);
  return relTimeFromMs(target, nowMs, iso);
}

/**
 * Numeric (unix-seconds) variant of {@link relTime}. The `usage` collection
 * carries reset timestamps as ISO strings; the schema-v35 colocated
 * `last_rate_limit_at` on the same row rides as REAL unix-SECONDS (matching
 * `jobs.last_api_error_at` — both values live on the usage row now, but
 * they're in different units, so the renderer routes each through the
 * matching helper). Feeding raw seconds into `relTime` would do `Date.parse`
 * and yield NaN, so we route numeric inputs through this thin shim —
 * converting once to ms and sharing the same minute-rounding body. Returns
 * `""` for `null`/`undefined` (no rate limit known); otherwise the same
 * `"now"` / `"Nh Mm"` / `"Mm ago"` shape as `relTime`.
 */
function relTimeFromUnixSec(
  sec: number | null | undefined,
  nowMs: number,
): string {
  if (sec == null) return "";
  return relTimeFromMs(sec * 1000, nowMs, "");
}

/**
 * Shared body for {@link relTime} (ISO callers) and {@link relTimeFromUnixSec}
 * (unix-seconds callers). `targetMs` is the parsed absolute time in ms;
 * `fallback` is what to return on NaN (the raw ISO for ISO callers, `""`
 * for numeric callers since "we have a number" is already a parse). Pure
 * function — no wall-clock IO of its own.
 */
function relTimeFromMs(
  targetMs: number,
  nowMs: number,
  fallback: string,
): string {
  if (Number.isNaN(targetMs)) return fallback;
  const diffMin = Math.round((targetMs - nowMs) / 60000);
  if (diffMin === 0) return "now";
  const past = diffMin < 0;
  const total = Math.abs(diffMin);
  const days = Math.floor(total / 1440);
  const weeks = Math.floor(days / 7);
  let body: string;
  if (weeks >= 1) {
    const d = days % 7;
    body = d > 0 ? `${weeks}w ${d}d` : `${weeks}w`;
  } else if (days >= 1) {
    const h = Math.floor((total - days * 1440) / 60);
    body = h > 0 ? `${days}d ${h}h` : `${days}d`;
  } else {
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h > 0) {
      body = m > 0 ? `${h}h ${m}m` : `${h}h`;
    } else {
      body = `${m}m`;
    }
  }
  return past ? `${body} ago` : body;
}

/**
 * Render a quota-reset countdown cell (`session` / `week` / `sonnet`).
 *
 * A reset is a strictly-FORWARD value — "when does this window refill."
 * agentuse resolves `*_resets_at` into the future at every scrape, so a
 * healthy cell is always a positive countdown. A target that has slipped
 * into the PAST is therefore never a real "<rel> ago" age — it's a
 * prediction whose moment elapsed before a fresh scrape replaced it, i.e.
 * STALE. Rendering it as `now` (it just reset) or `5h ago` (an age) both
 * lie; a 19h-dead producer rendered a whole screen of confident `now`
 * that read as "everything just reset." So:
 *
 *   - future        → the countdown (`3d 2h`, `29m`)
 *   - exactly now    → `now` (genuine zero-crossing, ±30s rounding)
 *   - elapsed (past) → `STALE_CELL` (`—`) — the prediction can't be trusted
 *
 * `rowStale` forces `—` regardless of this cell's own value: when keeper's
 * ingestion is stale (`last_usage_fold_at` past `STALENESS_THRESHOLD_MS`)
 * the ENTIRE row is a frozen snapshot, so even a still-future reset on it
 * is suspect — dash uniformly so a dead row reads as dead. The two
 * triggers are complementary: `rowStale` catches a wholesale-frozen
 * producer; the per-cell past check catches a single profile whose scrape
 * is erroring while keeper keeps folding the others (its resets go stale
 * even though the row's fold stamp is fresh). Empty input → `""` (no reset
 * known); an unparseable ISO passes through verbatim (graceful degrade).
 */
function resetCell(iso: string, nowMs: number, rowStale: boolean): string {
  if (iso === "") return "";
  if (rowStale) return STALE_CELL;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  if (Math.round((ms - nowMs) / 60000) < 0) return STALE_CELL;
  return relTime(iso, nowMs);
}

const BAR_WIDTH = 30;

/**
 * Cutoff for the `stale` per-row warning, in ms. A usage row whose
 * `last_usage_fold_at` (v41, fn-651 — the unix-seconds event ts of
 * the last successful usage fold) is older than this threshold against
 * the renderer's `nowMs` picks up an indented `stale Nm` line under
 * its quota lines. Tuned to ~3x agentuse's normal envelope-write
 * cadence (the daemon refreshes every ~5m on idle / faster under load),
 * so a brief lull between writes does not flap the warning while a
 * genuinely wedged ingestion path surfaces within ~15-20m. Single
 * named constant so future tuning is one edit.
 */
const STALENESS_THRESHOLD_MS = 15 * 60_000;

/**
 * Placeholder rendered in a forward-looking time cell (a quota-reset
 * countdown or the rate-limit lift) when the row is STALE. A stale row's
 * gauges are a frozen snapshot of a producer that may be dead, so its
 * "when does this reset / when does the limit lift" predictions are
 * provably untrustworthy — every such time has already elapsed. Rendering
 * a confident `now` / `n/a` there reads as "everything just reset," the
 * exact lie that made a 19h-dead agentuse look healthy. An em-dash reads
 * as "unknown"; the adjacent `stale Nm` line carries the age + the why.
 */
const STALE_CELL = "—";

/**
 * Fixed-width ASCII progress bar — bracket + `BAR_WIDTH` cells + bracket,
 * identical width across every row so the pct column to its right stays
 * aligned without per-row width math. `█` is filled, `░` is empty; the
 * fill count rounds half-up against `BAR_WIDTH`, so at 30-wide 5% → 2
 * cells, 4% → 1 cell, 1% → 0 cells. Clamped to `[0, 100]` and folds
 * unknown / non-numeric input to an all-empty bar — matches `pct`'s
 * `?` fallback so a row missing data still renders a uniform cell.
 */
function bar(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  const safe = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
  const filled = Math.round((safe / 100) * BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
}

/**
 * Render the `usage`-collection rows into a stacked, indented block per
 * profile — a header line carrying the id chip + target/multiplier chip,
 * then one indented body line per quota window:
 *
 *   (claude-multi-3) [claude 20x]
 *                    session       [█████░░░░░░░░░░░░░░░░░░░░░░░░░]  16% 29m
 *                    week          [███████████░░░░░░░░░░░░░░░░░░░]  36% 4d 5h
 *                    sonnet        [██░░░░░░░░░░░░░░░░░░░░░░░░░░░░]   8% 4d 5h
 *                    rate-limited  for 1h 2m
 *                    stale         17m
 *
 * Body indent equals `wId + 1` so labels line up under the `[` of the
 * chip. Labels (`session` / `week` / `sonnet` / `rate-limited` /
 * `stale`) padEnd to the widest of the labels ACTUALLY rendered across
 * the row set — `sonnet` only joins that pool when at least one row
 * has `sonnet_week_percent` data, `rate-limited` only when at least
 * one non-codex row has `last_rate_limit_at` set, and `stale` only
 * when at least one row's `last_usage_fold_at` is older than the
 * staleness threshold — so a sonnet-less / limit-less / fresh screen
 * still aligns pct values cleanly. The bar is fixed
 * `BAR_WIDTH + 2`-col width (bracket + BAR_WIDTH cells + bracket) so no
 * per-row width math is needed; pct cells padStart to the widest pct
 * across every body line that will render (session, week, and sonnet
 * wherever present), so a `100%` in any row pushes a matching column
 * of right-aligned digits everywhere.
 *
 * The bare relative-time tail is unpadded — it lands wherever the
 * pct column ends, with a single separating space. Rows whose reset
 * ISO was empty render no tail at all (no trailing whitespace). The
 * reset tail is the `STALE_CELL` dash (`—`) — see {@link resetCell} —
 * whenever its prediction can't be trusted: either the value itself has
 * elapsed (a frozen / erroring profile) or the whole row is keeper-stale.
 * Only a genuine zero-crossing renders `now`; a future reset renders its
 * countdown.
 *
 * Rows without sonnet data simply omit the sonnet body line; they do NOT
 * render an empty placeholder. Same rule for the `rate-limited` line:
 * a NULL `last_rate_limit_at` omits the whole line, and
 * the codex stack (id `codex` / target `codex` — no rate-limit concept)
 * omits it unconditionally. When the line DOES render it is a
 * forward-looking lift countdown derived from `rate_limit_lifts_at`
 * (schema v41 / fn-651) — `rate-limited for <rel>` when the
 * lift instant is known and still in the future, `rate-limited
 * n/a` when the column is NULL OR the lift instant is already `<= now`
 * (a past-reset guard — never the misleading "<rel> ago" countdown
 * `relTime` would otherwise produce, and never a fallback to the
 * fired-time `last_rate_limit_at`), and `rate-limited —` (`STALE_CELL`)
 * when the row is stale — the lift, like the resets, can't be trusted. The `stale` line (also v41) renders
 * only when `last_usage_fold_at` is older than `STALENESS_THRESHOLD_MS`
 * — driven exclusively off that stamp, not `updated_at` (which a
 * rate-limit fold bumps) or agentuse's own `status` (which tracks its
 * scrape failures rather than keeper's ingestion health).
 *
 * Reset cells are rendered against the supplied `nowMs` — the caller
 * passes `Date.now()` from the data-change emit AND from the 30s tick,
 * and tests pass a fixed clock. The `rate-limited` cell uses the same
 * `nowMs`, routed through {@link relTime} against the ISO
 * `rate_limit_lifts_at` value (the v35 fired-time `last_rate_limit_at`
 * — REAL unix-SECONDS — is no longer rendered; only used to detect
 * whether the row has ever been rate-limited). The `stale` cell renders
 * the age of `last_usage_fold_at` against the same `nowMs`.
 */
export function renderRowLines(
  rows: Record<string, unknown>[],
  nowMs: number,
): string[] {
  if (rows.length === 0) return [];

  // fn-645: subscription_active gating. A row whose envelope confirmed no
  // subscription (`subscription_active === 0` on the wire — the reducer
  // coerced the producer's `false`) renders empty `?` bars with no actionable
  // signal; suppress entirely. `null` (unknown — e.g. codex's never-observed
  // axis) and `1` (true) both stay visible. The filter runs FIRST so width
  // math + label-pool decisions only see visible rows; an all-hidden input
  // returns an empty array (matching the empty-input early-out).
  const visible = rows.filter((r) => r.subscription_active !== 0);
  if (visible.length === 0) return [];

  interface RowCells {
    id: string;
    target: string;
    mult: string;
    // fn-645: envelope freshness token rendered as a trailing chip on the
    // header line ("active" / "idle" / "stale"). Empty when the envelope
    // omitted the field (pre-fn-3 producer); rendered for all three real
    // values.
    status: string;
    sBar: string;
    sPct: string;
    sReset: string;
    wBar: string;
    wPct: string;
    wReset: string;
    // null when this row's envelope carried no sonnet_week sub-object.
    swBar: string | null;
    swPct: string | null;
    // Empty string when no sonnet data; otherwise the rendered relative
    // time (or "" inside the rendered cell if sonnet_resets_at was null).
    swReset: string;
    // Empty string when no rate-limit annotation to render — NULL
    // `last_rate_limit_at`, or the codex stack (no rate-limit concept).
    // Otherwise the rendered tail of the `rate-limited` line as of
    // schema v41 (fn-651): `for <rel>` when `rate_limit_lifts_at` is
    // known and still in the future (the lift countdown), `n/a` when
    // the lift column is NULL OR the lift instant is already past (the
    // past-reset guard — never the misleading "<rel> ago" countdown
    // `relTime` would otherwise produce, and never a fallback to the
    // fired-time `last_rate_limit_at`).
    rlRel: string;
    // Empty string when this row is fresh per
    // `STALENESS_THRESHOLD_MS` (or `last_usage_fold_at` is NULL —
    // unknown → no claim either way). Otherwise the rendered age tail
    // for the `stale` line (e.g. "17m" / "1h 2m"). Driven exclusively
    // off `last_usage_fold_at`, never `updated_at` (a rate-limit fold
    // bumps that) and never agentuse's own `status` (which tracks its
    // scrape failures rather than keeper's ingestion health).
    staleRel: string;
    // fn-645: stale-error line body. Empty when no error to render
    // (`error_type` NULL — implies non-stale status); otherwise the
    // pre-formatted `<type>: <message>` content (without the trailing
    // relative-time stamp). The matching `errRel` is the ISO-derived
    // relative-time cell.
    errContent: string;
    errRel: string;
  }

  const cells: RowCells[] = visible.map((row) => {
    const hasSonnet = row.sonnet_week_percent != null;
    // codex has no rate-limit concept — suppress the line even if the
    // wire payload were to carry a non-null `last_rate_limit_at`.
    const isCodex = row.id === "codex" || row.target === "codex";
    const rlRaw = row.last_rate_limit_at;
    // Schema v41 (fn-651): per-row freshness gate, computed FIRST because
    // both the rate-limit line and the reset cells below key off it.
    // `last_usage_fold_at` is REAL unix-SECONDS stamped from the event ts
    // of the last SUCCESSFUL usage fold (never bumped by a rate-limit fold
    // or an idle/stale snapshot). A row older than `STALENESS_THRESHOLD_MS`
    // is STALE: its gauges are a frozen snapshot of a (possibly dead)
    // producer, so every forward-looking time on the row — the reset
    // countdowns (via {@link resetCell}, which ALSO dashes a single
    // elapsed cell even on a fresh row) AND the rate-limit lift — renders
    // as `STALE_CELL` instead of a confident-but-wrong `now` / `n/a`. A
    // NULL stamp means no successful fold to age — treat as fresh (a
    // never-folded row would otherwise always flap stale on first paint).
    // Codex carries the same freshness contract (its envelope also stamps
    // the field) — no codex exception.
    const foldAtRaw = row.last_usage_fold_at;
    const foldAtMs =
      typeof foldAtRaw === "number" ? foldAtRaw * 1000 : Number.NaN;
    const staleAgeMs = Number.isNaN(foldAtMs) ? -1 : nowMs - foldAtMs;
    const isStale = staleAgeMs >= STALENESS_THRESHOLD_MS;
    // The `stale Nm` line carries the age + the human-readable "why" behind
    // the dashed cells. `relTimeFromMs` returns "<body> ago" for past times;
    // the `stale` label already conveys direction, so trim the suffix for a
    // tighter `stale 17m` body.
    const staleRel = isStale
      ? relTimeFromUnixSec(foldAtRaw as number, nowMs).replace(/ ago$/, "")
      : "";
    // Schema v41 (fn-651): the rate-limited line is a forward-looking lift
    // countdown rather than the fired-time. `rate_limit_lifts_at` (ISO) is
    // the soonest reset among >=100% windows. Render the line when the row
    // has ever been rate-limited (presence of `last_rate_limit_at` — the
    // v35 fired-time still gates whether the line appears, just no longer
    // what it renders) AND skip for the codex stack. The tail is
    // `STALE_CELL` when the row is stale (the lift time can't be trusted);
    // else `for <rel>` when the lift is known and STILL IN THE FUTURE;
    // else `n/a` when the lift column is NULL OR `<= now` — the past-reset
    // guard intercepting `relTime`'s "<rel> ago" so the row never claims
    // to be rate-limited "for 3h ago".
    const liftIso = seg(row.rate_limit_lifts_at);
    const liftMs = liftIso === "" ? Number.NaN : Date.parse(liftIso);
    const liftKnownFuture = !Number.isNaN(liftMs) && liftMs > nowMs;
    const hasFiredTime = rlRaw != null && typeof rlRaw === "number";
    const rlRel =
      isCodex || !hasFiredTime
        ? ""
        : isStale
          ? STALE_CELL
          : liftKnownFuture
            ? `for ${relTime(liftIso, nowMs)}`
            : "n/a";
    // fn-645: stale-error line. Present only when `error_type` is set
    // (mirrors the agentuse contract — the `error` sub-object is non-null
    // only when status == "stale"). The content is `<type>: <message…>`;
    // the matching cell width pad happens at render time once we know
    // `wPct`. The relative-time cell uses the ISO `error_at` routed through
    // `relTime` (the same helper the quota resets use) so it ticks on the
    // 30s clock identically.
    const errType = seg(row.error_type);
    const errMsg = seg(row.error_message);
    const errAtIso = seg(row.error_at);
    const errContent = errType === "" ? "" : `${errType}: ${errMsg}`;
    const errRel = errType === "" ? "" : relTime(errAtIso, nowMs);
    return {
      id: `(${seg(row.id)})`,
      target: seg(row.target),
      mult: seg(row.multiplier),
      status: seg(row.status),
      sBar: bar(row.session_percent),
      sPct: pct(row.session_percent),
      sReset: resetCell(seg(row.session_resets_at), nowMs, isStale),
      wBar: bar(row.week_percent),
      wPct: pct(row.week_percent),
      wReset: resetCell(seg(row.week_resets_at), nowMs, isStale),
      swBar: hasSonnet ? bar(row.sonnet_week_percent) : null,
      swPct: hasSonnet ? pct(row.sonnet_week_percent) : null,
      swReset: hasSonnet
        ? resetCell(seg(row.sonnet_week_resets_at), nowMs, isStale)
        : "",
      rlRel,
      staleRel,
      errContent,
      errRel,
    };
  });

  const widest = (xs: string[]): number =>
    xs.reduce((acc, x) => Math.max(acc, x.length), 0);

  const wId = widest(cells.map((c) => c.id));
  const wTarget = widest(cells.map((c) => c.target));
  const wMult = widest(cells.map((c) => c.mult));

  // Pct width across every body line that will render.
  const allPcts: string[] = [];
  for (const c of cells) {
    allPcts.push(c.sPct, c.wPct);
    if (c.swPct != null) allPcts.push(c.swPct);
  }
  const wPct = widest(allPcts);

  // Label width across the labels actually rendered. `sonnet` joins the
  // pool only when at least one row has sonnet data — keeps a sonnet-
  // less screen from padding `week` against an absent label. Same rule
  // for `rate-limited`: only joins the pool when at least one row will
  // render that line, so a limit-less screen doesn't pad the quota
  // labels against the wider `rate-limited` literal. fn-645: `error` joins
  // the pool only when at least one visible row will render a stale-error
  // line, mirroring the same conditional-widen rule.
  const labels = ["session", "week"];
  if (cells.some((c) => c.swPct != null)) labels.push("sonnet");
  if (cells.some((c) => c.rlRel !== "")) labels.push("rate-limited");
  if (cells.some((c) => c.staleRel !== "")) labels.push("stale");
  if (cells.some((c) => c.errContent !== "")) labels.push("error");
  const wLabel = widest(labels);

  const indent = " ".repeat(wId + 1);
  const renderBody = (
    label: string,
    barStr: string,
    pctStr: string,
    rel: string,
  ): string => {
    const head = `${indent}${label.padEnd(wLabel, " ")} ${barStr} ${pctStr.padStart(wPct, " ")}`;
    // Skip the trailing space when there's no rel-time to follow — an
    // empty-ISO row shouldn't leave whitespace at end-of-line.
    return rel === "" ? head : `${head} ${rel}`;
  };

  // The rate-limit line has no bar and no pct — just `label rel`. Indent
  // and label-padding match the quota body lines so the relative time
  // aligns under the quota cells' relative times. The `rel` body is
  // either `for <rel>` (lift countdown) or `n/a` (past / unknown lift)
  // — composed in the cell mapping above.
  const renderRateLimit = (rel: string): string =>
    `${indent}${"rate-limited".padEnd(wLabel, " ")} ${rel}`;

  // The stale line mirrors the rate-limit line — `label age` with the
  // same indent + label-padding so it column-aligns under the other
  // body lines. The age body is bare (no `ago` suffix) since the
  // `stale` label already conveys direction.
  const renderStale = (age: string): string =>
    `${indent}${"stale".padEnd(wLabel, " ")} ${age}`;

  // fn-645: stale-error line. The body content `<type>: <message…>` occupies
  // the same `BAR_WIDTH + 2 + 1 + wPct` cell width the bar+space+pct
  // sequence does on quota lines (bracket + BAR_WIDTH cells + bracket =
  // `BAR_WIDTH + 2`, one separator space, then `wPct`-wide pct), so the
  // trailing relative-time stamp lands in the SAME column as the reset
  // stamps. Truncation cuts oversize content with an ellipsis; under-width
  // content padEnds with spaces to keep the rel-time column position
  // stable. The matching `errRel` is the ISO-derived relative-time cell.
  const errCellWidth = BAR_WIDTH + 2 + 1 + wPct;
  const renderError = (content: string, rel: string): string => {
    let body: string;
    if (content.length > errCellWidth) {
      body = `${content.slice(0, Math.max(0, errCellWidth - 1))}…`;
    } else {
      body = content.padEnd(errCellWidth, " ");
    }
    const head = `${indent}${"error".padEnd(wLabel, " ")} ${body}`;
    return rel === "" ? head : `${head} ${rel}`;
  };

  const lines: string[] = [];
  for (const c of cells) {
    const id = c.id.padStart(wId, " ");
    const targetChip =
      c.target === "" && c.mult === ""
        ? ""
        : `[${c.target.padEnd(wTarget, " ")} ${c.mult.padStart(wMult, " ")}x]`;
    // fn-645: status token as a trailing chip on the header line. Rendered
    // for any non-empty status; absent for pre-fn-3 envelopes (status NULL).
    // Two-space separator before the token to clearly distance it from the
    // chip — readability win over the single-space chip separator. When the
    // chip is absent (no target/mult), the token tags directly after the id.
    const header = (() => {
      const head = targetChip === "" ? id : `${id} ${targetChip}`;
      return c.status === "" ? head : `${head}  ${c.status}`;
    })();
    lines.push(header);
    lines.push(renderBody("session", c.sBar, c.sPct, c.sReset));
    lines.push(renderBody("week", c.wBar, c.wPct, c.wReset));
    if (c.swPct != null && c.swBar != null) {
      lines.push(renderBody("sonnet", c.swBar, c.swPct, c.swReset));
    }
    if (c.rlRel !== "") {
      lines.push(renderRateLimit(c.rlRel));
    }
    if (c.staleRel !== "") {
      lines.push(renderStale(c.staleRel));
    }
    if (c.errContent !== "") {
      lines.push(renderError(c.errContent, c.errRel));
    }
  }
  return lines;
}

/** How many most-recent jobs the "recent sessions" log renders. */
const SESSION_LOG_LIMIT = 20;
/** Title truncation width for the session log (ellipsis included). */
const SESSION_TITLE_MAX = 44;
/** Label for a job that ran under the default `~/.claude` profile. */
const DEFAULT_PROFILE_LABEL = "(default)";

/**
 * Render the `jobs`-collection rows into a "recent sessions" log — one line
 * per job, newest first, labeling each with the profile it ran under:
 *
 *   multi-claude-3  8449dda  infer attribution for discharged dirty files  ended    1h 5m ago
 *   multi-claude-3  23983ee  biome reflow of profiles backfill query        ended    2h ago
 *   (default)       9z8y7x1  <untitled>                                     killed   3h 12m ago
 *
 * `profile_name` rides the row natively (schema v36) — the reducer's
 * SessionStart fold stamps `projectBasename(config_dir)`, NULL when the
 * session ran under the default profile, so the renderer needs no join. A
 * NULL/empty name renders as {@link DEFAULT_PROFILE_LABEL}. Columns padEnd to
 * the widest value ACTUALLY present across the row set (profile / short id /
 * title / state), and the relative-time tail floats after the state column
 * with a two-space gap.
 *
 * `job_id` is sliced to 7 chars (a git-style short id); `title` falls back to
 * `<untitled>` and truncates to {@link SESSION_TITLE_MAX}. `created_at` is
 * REAL unix-SECONDS (matching `relTimeFromUnixSec`), so every session — being
 * in the past — renders an `<rel> ago` tail. `nowMs` is a parameter (not
 * `Date.now()` baked in) so the 30s tick and tests can drive a deterministic
 * clock without the renderer doing any wall-clock IO of its own — and so the
 * change-gate (which hashes the RAW `created_at`, never this rendered tail)
 * stays insensitive to minute-boundary bleed.
 */
export function renderSessionLines(
  jobs: Record<string, unknown>[],
  nowMs: number,
): string[] {
  if (jobs.length === 0) return [];

  interface SessionCell {
    profile: string;
    id: string;
    title: string;
    state: string;
    rel: string;
  }

  const cells: SessionCell[] = jobs.map((job) => {
    const pn = job.profile_name;
    const profile =
      pn == null || pn === "" ? DEFAULT_PROFILE_LABEL : String(pn);
    const idRaw = seg(job.job_id);
    const id = idRaw.length > 7 ? idRaw.slice(0, 7) : idRaw;
    const titleRaw = seg(job.title);
    const titleFull = titleRaw === "" ? "<untitled>" : titleRaw;
    const title =
      titleFull.length > SESSION_TITLE_MAX
        ? `${titleFull.slice(0, SESSION_TITLE_MAX - 1)}…`
        : titleFull;
    const createdAt = job.created_at;
    const rel =
      typeof createdAt === "number" ? relTimeFromUnixSec(createdAt, nowMs) : "";
    return { profile, id, title, state: seg(job.state), rel };
  });

  const widest = (xs: string[]): number =>
    xs.reduce((acc, x) => Math.max(acc, x.length), 0);
  const wProfile = widest(cells.map((c) => c.profile));
  const wId = widest(cells.map((c) => c.id));
  const wTitle = widest(cells.map((c) => c.title));
  const wState = widest(cells.map((c) => c.state));

  const lines: string[] = [];
  for (const c of cells) {
    const head = `${c.profile.padEnd(wProfile, " ")}  ${c.id.padEnd(wId, " ")}  ${c.title.padEnd(wTitle, " ")}  ${c.state.padEnd(wState, " ")}`;
    // Trim trailing pad when there's no rel-time tail (defensive — a NOT NULL
    // `created_at` always yields one, but a malformed row shouldn't leave
    // end-of-line whitespace).
    lines.push(c.rel === "" ? head.trimEnd() : `${head}  ${c.rel}`);
  }
  return lines;
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      sock: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  // Forward-reference slot for the `c`-key copy handler — wired further
  // down once sidecar paths and the last frame text are in scope.
  let onKey: ((key: string) => void) | undefined;
  const liveShell = createLiveShell({
    enabled: true,
    title: "usage",
    onUnhandledKey: (key) => onKey?.(key),
  });
  let lastFrame: string | null = null;
  let frameCount = 0;
  // Module-local row cache for the single `usage` subscription. Cleared
  // on `disconnected` (via `lastUsageRowsKey`) so the next first-paint
  // always emits.
  let lastUsageRows: Record<string, unknown>[] = [];
  // Module-local row cache for the single `jobs` subscription (the "recent
  // sessions" log). Same change-gate discipline as the usage cache.
  let lastJobsRows: Record<string, unknown>[] = [];
  // Projection-meaningful subset of the last emit. Gating `emitFrame` on
  // this — not on the rendered text — keeps a fetch-only refresh that
  // bumps `last_event_id` / `updated_at` from flapping a new frame, AND
  // keeps minute-tick relative-time bleed from forging one either.
  // Cleared on `disconnected` so a post-reconnect first emit always paints.
  let lastUsageRowsKey: string | null = null;
  // The same gate for the `jobs` stream — hashes RAW unrendered fields
  // (`created_at` as unix-seconds, never the minute-rounded `<rel> ago`
  // tail) so a relative-time tick or a fetch-only `last_event_id` bump
  // never forges a concrete frame; only real data movement does.
  let lastJobsRowsKey: string | null = null;
  // Last lines we pushed/refreshed to the live shell. Lets the 30s tick
  // skip the `refreshLive` call when minute-rounding produced identical
  // text — avoids even the cost of constructing the overlay (the
  // OpenTUI paint layer's diff would short-circuit too, but skipping
  // here is cheaper and clearer, AND it's the documented load-bearing
  // no-flicker guard for the live-tick path).
  let lastLiveLines: string[] = [];

  const prevFrameTmp = `/tmp/keeper-usage.${process.pid}.prev.frame.txt`;
  const metaSidecar = `/tmp/keeper-usage.${process.pid}.meta.txt`;
  const lifecycleSidecar = `/tmp/keeper-usage.${process.pid}.lifecycle.txt`;

  // `c` copies a debug snapshot to the clipboard. See board.ts for the
  // shared shape — same payload, swap script name and sidecar paths.
  let copyStatusTimer: ReturnType<typeof setTimeout> | undefined;
  onKey = (key: string): void => {
    if (key !== "c") return;
    if (lastFrame == null) return;
    const payload = buildDebugSnapshot({
      script: "usage",
      pid: process.pid,
      frame: lastFrame,
      frameNumber: frameCount,
      metaSidecar,
      lifecycleSidecar,
      nowIso: new Date().toISOString(),
    });
    const flashed = frameCount;
    void copyToClipboard(payload).then((res) => {
      if (res.ok) {
        liveShell.setStatus(`[copied frame ${flashed}]`);
      } else {
        try {
          appendFileSync(
            lifecycleSidecar,
            `# warn: clipboard copy failed: ${res.error}\n`,
          );
        } catch {
          // best-effort
        }
        liveShell.setStatus("[copy failed]");
      }
      if (copyStatusTimer !== undefined) {
        clearTimeout(copyStatusTimer);
      }
      copyStatusTimer = setTimeout(() => liveShell.setStatus(""), 1500);
    });
  };

  function log(s: string): void {
    process.stdout.write(`${s}\n`);
  }

  function writeSidecars(frameText: string): void {
    const sState = `/tmp/keeper-usage.${process.pid}.state.${frameCount}.json`;
    const sFrame = `/tmp/keeper-usage.${process.pid}.frame.${frameCount}.txt`;
    const sDiff = `/tmp/keeper-usage.${process.pid}.diff.${frameCount}.txt`;
    // State JSON — the `usage` row set plus the `jobs` row set are the full
    // input to the rendered frame (rate-limit annotations ride the usage row
    // via schema v35 / fn-642; per-job `profile_name` rides the jobs row via
    // schema v36).
    writeFileSync(
      sState,
      `${JSON.stringify({ usage: lastUsageRows, jobs: lastJobsRows }, null, 2)}\n`,
    );
    writeFileSync(sFrame, `${frameText}\n`);
    let diff = "# first frame - no previous to diff against\n";
    if (lastFrame != null) {
      writeFileSync(prevFrameTmp, `${lastFrame}\n`);
      const res = Bun.spawnSync(["diff", "-u", prevFrameTmp, sFrame], {
        stdout: "pipe",
        stderr: "pipe",
      });
      diff = res.stdout.toString() || "# no rendered diff\n";
    }
    writeFileSync(sDiff, diff);
    appendFileSync(
      metaSidecar,
      `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
    );
  }

  /**
   * Stringify the projection-meaningful subset of the `usage` row set into
   * a stable hash key. `last_event_id` / `updated_at` are excluded on
   * purpose — they bump on every fetch-only refresh even when no rendered
   * field changed — and so is anything else the renderer doesn't read.
   * Keeps the gate insensitive to wall-clock-driven relative-time bleed
   * too: the inputs are raw ISO timestamps + percents, not the
   * minute-rounded prose.
   */
  function usageRowsHashKey(rows: Record<string, unknown>[]): string {
    return JSON.stringify(
      rows.map((r) => [
        r.id,
        r.target,
        r.multiplier,
        r.session_percent,
        r.session_resets_at,
        r.week_percent,
        r.week_resets_at,
        r.sonnet_week_percent,
        r.sonnet_week_resets_at,
        r.last_rate_limit_at,
        // fn-645: envelope status / subscription / error axes. `error_at` is
        // safe to include here because the WORKER's change-gate
        // (`usageGateKey`) is what suppresses synthetic-event churn during
        // an outage; the wire-side `error_at` only moves when the gated
        // fields move, so including it in the renderer's hash key cannot
        // forge a frame.
        r.status,
        r.subscription_active,
        r.error_type,
        r.error_message,
        r.error_at,
        // fn-651 (v41): the lift instant and the freshness stamp. Both
        // drive renderer-visible state (the `rate-limited for <rel>` /
        // `n/a` countdown and the per-row `stale Nm` warning) but
        // neither is currently in the gate above, so a lift-only or
        // freshness-only change would silently fail to repaint without
        // these. Raw ISO + raw unix-seconds — never the minute-rounded
        // rendered prose — so a clock tick can't forge a frame.
        r.rate_limit_lifts_at,
        r.last_usage_fold_at,
      ]),
    );
  }

  /**
   * Stringify the projection-meaningful subset of the `jobs` row set into a
   * stable hash key. Hashes ONLY the RAW unrendered fields the session log
   * reads — `job_id` (identity + short id), `profile_name` (the label),
   * `created_at` (raw unix-seconds, NOT the minute-rounded tail), `state`,
   * and `title`. Deliberately excludes `last_event_id` / `updated_at` (they
   * bump on every fetch-only refresh) so the gate fires only on real data
   * movement, and keys off raw `created_at` so a minute-boundary crossing
   * between two same-data emits can't forge a frame.
   */
  function jobsRowsHashKey(rows: Record<string, unknown>[]): string {
    return JSON.stringify(
      rows.map((r) => [
        r.job_id,
        r.profile_name,
        r.created_at,
        r.state,
        r.title,
      ]),
    );
  }

  /**
   * Compose the full frame body against `nowMs`: the per-profile usage stacks
   * on top, then — when at least one job is present — a blank-line-separated
   * `recent sessions` block. Both streams render against the SAME clock so a
   * single 30s tick keeps every relative-time cell (quota resets, rate-limit
   * annotations, AND session ages) fresh together.
   */
  function composeBody(nowMs: number): string[] {
    const usageLines = renderRowLines(lastUsageRows, nowMs);
    const sessionLines = renderSessionLines(lastJobsRows, nowMs);
    if (sessionLines.length === 0) return usageLines;
    if (usageLines.length === 0) {
      return ["recent sessions", ...sessionLines];
    }
    return [...usageLines, "", "recent sessions", ...sessionLines];
  }

  /**
   * Composed emitter. Renders both streams against `Date.now()` so the frozen
   * at-capture text in history reflects what was on screen the moment the data
   * landed; the 30s tick keeps the live view ticking forward via `refreshLive`
   * without growing history.
   */
  function emitFrame(): void {
    const now = Date.now();
    const bodyLines = composeBody(now);
    const frameText = ["---", ...bodyLines].join("\n");
    frameCount += 1;
    liveShell.pushFrame(bodyLines);
    lastLiveLines = bodyLines;
    writeSidecars(frameText);
    lastFrame = frameText;
  }

  /**
   * `usage`-stream row callback. Gates on the raw projection subset (see
   * {@link usageRowsHashKey}) — NOT on rendered text — so a fetch-only
   * refresh that bumps `last_event_id` / `updated_at` produces no new
   * frame, and a minute-boundary crossing between two same-data emits
   * can't forge one either.
   */
  function emitUsage(rows: Record<string, unknown>[]): void {
    const rowsKey = usageRowsHashKey(rows);
    if (rowsKey === lastUsageRowsKey) return;
    lastUsageRowsKey = rowsKey;
    lastUsageRows = rows;
    emitFrame();
  }

  /**
   * `jobs`-stream row callback for the "recent sessions" log. Same change-gate
   * contract as {@link emitUsage} — gates on {@link jobsRowsHashKey} (raw
   * fields, not rendered text), so a fetch-only refresh or a minute-boundary
   * crossing produces no new frame.
   */
  function emitJobs(rows: Record<string, unknown>[]): void {
    const rowsKey = jobsRowsHashKey(rows);
    if (rowsKey === lastJobsRowsKey) return;
    lastJobsRowsKey = rowsKey;
    lastJobsRows = rows;
    emitFrame();
  }

  function linesEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // 30s tick: re-render the live view's relative-time cells against the
  // current wall clock and overlay via `refreshLive`. No history growth,
  // no sidecar writes — historical scroll-back still shows each frame's
  // at-capture text. Skipped when there's no data yet OR when the
  // rendered text hasn't changed (minute-rounding holds for most ticks).
  // 30s gives the worst-case half-minute lag on a minute boundary, which
  // is plenty for minute-precision display. Both the quota-reset cells
  // and the colocated `rate-limited` cells re-render against the same
  // `Date.now()` so the full stack stays fresh on the same tick.
  //
  // Under the OpenTUI port: `refreshLive` updates the LIVE slot only,
  // never history — when the human has scrolled back, the overlay is
  // dormant against the visible (historical) frame and resumes painting
  // on the next snap-to-live (G/End/Esc). The identical-text guard above
  // makes the tick a true no-op when minute-rounding holds, so the live
  // view never flickers between ticks.
  const tickHandle = setInterval(() => {
    if (lastUsageRows.length === 0 && lastJobsRows.length === 0) return;
    const bodyLines = composeBody(Date.now());
    if (linesEqual(bodyLines, lastLiveLines)) return;
    lastLiveLines = bodyLines;
    liveShell.refreshLive(bodyLines);
  }, 30_000);

  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    const lines: string[] = ["...", `event: ${event}`];
    for (const [k, v] of Object.entries(detail)) {
      lines.push(`${k}: ${String(v)}`);
    }
    lines.push("...");
    try {
      appendFileSync(lifecycleSidecar, `${lines.join("\n")}\n`);
    } catch {
      // best-effort
    }
    // On disconnect, clear the change-gate so the next first-paint
    // always emits — even if the post-reconnect snapshot matches the
    // last pre-disconnect row set (raw or rendered) byte-for-byte.
    if (event === "disconnected") {
      lastFrame = null;
      lastUsageRowsKey = null;
      lastJobsRowsKey = null;
    }
  }

  // Single-collection subscription over `usage`. The schema-v35 colocated
  // rate-limit columns ride on the same row, so one subscribe and one
  // connection cover the full frame — no separate `profiles` stream and
  // no row-to-row blending in the renderer.
  const usageHandle = subscribeCollection({
    sockPath,
    idPrefix: "usage",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "id", dir: "asc" },
    onRows: emitUsage,
    onLifecycle: emitLifecycle,
  });

  // Second subscription: the `jobs` collection drives the "recent sessions"
  // log. `sort created_at desc` + `limit 20` is the last-N-sessions page, and
  // `filter { state: { not_in: [] } }` overrides the descriptor's default
  // terminal-hide scope (the empty `not_in` contributes no clause — see
  // `resolveFilter`) so the log includes `ended` / `killed` jobs — a true
  // "last 20 sessions", not "last 20 live sessions". `profile_name` rides each
  // row natively (schema v36), so no `profiles` join is needed here.
  const jobsHandle = subscribeCollection({
    sockPath,
    idPrefix: "usage",
    collection: "jobs",
    limit: SESSION_LOG_LIMIT,
    sort: { column: "created_at", dir: "desc" },
    filter: { state: { not_in: [] } },
    onRows: emitJobs,
    onLifecycle: emitLifecycle,
  });

  // Idempotency guard: SIGINT, SIGHUP, stdin-EOF and the ppid-poll can
  // all fire (and overlap) for one dying viewer. The tick-clear + dispose
  // calls are individually idempotent, but the log-then-exit tail must run
  // AT MOST ONCE so we don't double-print the banner or re-enter exit.
  let toreDown = false;
  const exitCleanly = (): void => {
    if (toreDown) {
      return;
    }
    toreDown = true;
    // Stop the relative-time tick FIRST so it can't fire against a
    // disposed shell (refreshLive is no-op post-dispose, but skipping
    // the rendered-rows + lines-equal work is cleaner).
    clearInterval(tickHandle);
    // Three-handle teardown: terminal restoration before subscription
    // teardown, then both subscribe handles disposed in declaration
    // order. Order is load-bearing — `liveShell.dispose()` first so the
    // alt-screen restores cleanly before any final stdout writes.
    liveShell.dispose();
    usageHandle.dispose();
    jobsHandle.dispose();
    log("...");
    log(`meta: ${metaSidecar}`);
    log(`lifecycle: ${lifecycleSidecar}`);
    log("...");
    process.exit(0);
  };
  // usage.ts owns its own SIGINT handler (it can't route through the
  // shared `installSigintHandler` — see the fn-660.1 deferral header).
  // SIGINT here, plus the parent-death / TTY-close triggers shared with
  // every other viewer (fn-723): SIGHUP, stdin-EOF, and the ppid===1 poll.
  process.on("SIGINT", exitCleanly);
  armViewerExitTriggers(exitCleanly);
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/usage.ts` would
// bypass the dispatcher's arg-pruning; if you really need it, run
// `bun cli/keeper.ts usage <args>` instead.
