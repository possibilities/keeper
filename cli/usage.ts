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
 * (session, week, and sonnet where present). As of schema v41 (fn-651)
 * `rate_limit_lifts_at` (the soonest reset among >=100% windows) rides the
 * `usage` row, and (fn-754) a `limited lifts in <rel>` line renders under
 * the quota lines whenever a non-codex row has a known FUTURE lift
 * (`limited lifts now` within the ±30s rounding gap; a past lift omits the
 * line). The `limited` line is gated purely on a parseable future lift —
 * NOT on the fired-time `last_rate_limit_at` — so a depleted-but-quiet row
 * (weekly 100%, agentuse paused polling until its known lift) still surfaces
 * its countdown. The codex stack (no rate-limit concept) omits the line.
 * A v41 freshness signal rides the same row via `last_usage_fold_at`, but
 * (fn-754) the stale clock is anchored to `max(last_usage_fold_at,
 * rate_limit_lifts_at)`: a row with a future lift stays FRESH even though
 * agentuse froze its fold stamp (a deliberately-idle producer with a known
 * resume time is not dead). A row whose anchor is older than
 * `STALENESS_THRESHOLD_MS` (driven ONLY off that stamp + lift — never
 * `updated_at`, which a rate-limit fold bumps, and never agentuse's own
 * `status`, which tracks its scrape failures rather than keeper's
 * ingestion health) picks up an indented `stale Nm` line so a wedged
 * usage worker becomes visible instead of silently frozen. Stale, idle,
 * and limited stay visually distinct (stale is its own labelled line;
 * idle is a header chip; limited is the colocated lift countdown line).
 * Untracked profiles (a rate-limit without an agentuse usage row) do not
 * render anywhere — the "drop untracked" decision.
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
 * scrape), so a target that has slipped into the PAST on a fresh row is
 * not an age — it's "the reset is due, a fresh scrape just hasn't landed"
 * — and renders `now`, never `<rel> ago`. The ONLY `—` trigger is a
 * keeper-stale row (the `max(last_usage_fold_at, rate_limit_lifts_at)`
 * anchor older than the threshold): the whole row is a frozen snapshot, so
 * every reset cell dashes uniformly (and the `limited` line is dropped
 * entirely — by then the lift has elapsed past the grace), with the
 * `stale Nm` line carrying the why. There is no per-cell dash. For the live
 * frame in TUI
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
import { resolveConfig, resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import { subscribeCollection } from "../src/readiness-client";
import {
  createSnapshotLatch,
  DEFAULT_SNAPSHOT_TIMEOUT_MS,
  formatNoFrameOutput,
  formatSnapshotOutput,
  resolveSnapshotMode,
  SNAPSHOT_SCHEMA_VERSION,
  SnapshotCliMisuseError,
  type SnapshotLatchOutcome,
  type SnapshotMeta,
  type SnapshotStatus,
} from "../src/snapshot";
import { armViewerExitTriggers } from "../src/view-shell";

const COLLECTION = "usage";

const HELP = `keeper usage — live usage frames over the keeper subscribe server

Usage: keeper usage [--sock <path>] [--snapshot | --watch] [--timeout <s>]

  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot     Force one-shot snapshot mode (print one composed frame + a
                 machine-parseable keeper-meta: line, then exit) even on a TTY
  --watch        Force the live subscribe stream even when piped
  --timeout <s>  Snapshot wait before the timeout escape (default ~2s)
  --help         Show this help

By default, stdout that is NOT a TTY (piped into an agent) auto-detects
snapshot mode; a TTY gets the live TUI. \`CI\` / \`TERM=dumb\` force snapshot.

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
\`1h 16m\` / \`5m\` / \`now\`; an elapsed-but-fresh reset reads \`now\`).
On a keeper-STALE row every reset countdown renders \`—\` (a frozen
snapshot's predicted times have all passed) and the \`limited\` line is
dropped. A weekly-depleted row (week >= 100%) suppresses its \`session\`
line — the panel collapses the session window to a reset-less 0%. A
stack with a known FUTURE lift (\`rate_limit_lifts_at\`, schema v41 / fn-651)
gets a colocated \`limited lifts in <rel>\` line under its quota lines
(\`limited lifts now\` within the rounding gap). The line is OMITTED when
the lift is past/unknown, when the row is stale, and for codex stacks.
A \`stale Nm\` line appears under any row whose stale anchor —
\`max(last_usage_fold_at, rate_limit_lifts_at)\` (fn-754) — is older than
the staleness threshold; anchoring to the lift keeps a depleted-but-quiet
row (agentuse paused polling until its lift) FRESH while the lift is
future. Driven only off that anchor, never \`updated_at\` and never
agentuse's own \`status\` — surfacing a wedged ingestion path instead of
silently frozen gauges, and labelling the \`—\` cells above it. Untracked profiles (a rate-limit with no agentuse usage
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

/**
 * Resolve an agentuse account id to its configured display alias (purely
 * cosmetic; see `KeeperConfig.accountAliases`, sourced from `account_aliases`
 * in `~/.config/keeper/config.yaml`). An unmapped id — including `codex` and
 * any account the human hasn't aliased — passes through verbatim. The alias
 * never touches row identity; it is applied only at the render edge.
 */
function aliasOf(id: string, aliases: Record<string, string>): string {
  return aliases[id] ?? id;
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
 * into the PAST on a fresh row is therefore not an age and not bad data —
 * it's "the reset is due; a fresh scrape just hasn't landed yet." So:
 *
 *   - future            → the countdown (`3d 2h`, `29m`)
 *   - at / just-past now → `now` (the ±30s rounding boundary AND any
 *                          elapsed-but-fresh target collapse here — never
 *                          `<rel> ago`, never `—`)
 *
 * `—` (`STALE_CELL`) is reserved EXCLUSIVELY for a keeper-stale row
 * (`rowStale`, off `last_usage_fold_at` past `STALENESS_THRESHOLD_MS`): the
 * ENTIRE row is then a frozen snapshot, so every cell dashes uniformly and
 * the `stale Nm` line carries the why. There is NO per-cell staleness — a
 * single elapsed cell on an otherwise-fresh row reads `now`, not `—`. Empty
 * input → `""` (no reset known); an unparseable ISO passes through verbatim.
 */
function resetCell(iso: string, nowMs: number, rowStale: boolean): string {
  if (iso === "") return "";
  if (rowStale) return STALE_CELL;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  // Forward-only: a target at/behind `now` on a fresh row is "reset is due,
  // data refreshing" → `now`, never `<rel> ago`. relTime already returns `now`
  // at the ±30s boundary; intercept anything further past so its `ago` branch
  // can't mislabel an until-reset value as an age. `—` is keeper-stale ONLY.
  if (Math.round((ms - nowMs) / 60000) < 0) return "now";
  return relTime(iso, nowMs);
}

const BAR_WIDTH = 30;

/**
 * Cutoff for the `stale` per-row warning, in ms. A usage row whose stale
 * anchor — `max(last_usage_fold_at, rate_limit_lifts_at)` (fn-754;
 * `last_usage_fold_at` is the v41/fn-651 unix-seconds event ts of the last
 * successful usage fold) — is older than this threshold against the
 * renderer's `nowMs` picks up an indented `stale Nm` line under its quota
 * lines. Anchoring to the lift keeps a depleted-but-quiet row (agentuse
 * paused polling until its known lift, freezing the fold stamp) FRESH while
 * the lift is future. Tuned to ~3x agentuse's normal envelope-write
 * cadence (the daemon refreshes every ~5m on idle / faster under load),
 * so a brief lull between writes does not flap the warning while a
 * genuinely wedged ingestion path surfaces within ~15-20m. Single
 * named constant so future tuning is one edit.
 */
const STALENESS_THRESHOLD_MS = 15 * 60_000;

/**
 * Placeholder rendered in a forward-looking quota-reset countdown cell when
 * the row is STALE. A stale row's gauges are a frozen snapshot of a producer
 * that may be dead, so its "when does this reset" predictions are provably
 * untrustworthy — every such time has already elapsed. Rendering a confident
 * `now` there reads as "everything just reset," the exact lie that made a
 * 19h-dead agentuse look healthy. An em-dash reads as "unknown"; the adjacent
 * `stale Nm` line carries the age + the why. (The `limited` lift line is
 * dropped entirely on a stale row rather than dashed — by the time the row
 * is stale its lift anchor has elapsed past the grace, so there is no
 * trustworthy lift to show.)
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
 *                    session  [█████░░░░░░░░░░░░░░░░░░░░░░░░░]  16% 29m
 *                    week     [███████████░░░░░░░░░░░░░░░░░░░]  36% 4d 5h
 *                    sonnet   [██░░░░░░░░░░░░░░░░░░░░░░░░░░░░]   8% 4d 5h
 *                    limited  · lifts in 1h 2m
 *                    stale    17m
 *
 * Body indent equals `wId + 1` so labels line up under the `[` of the
 * chip. Labels (`session` / `week` / `sonnet` / `limited` /
 * `stale`) padEnd to the widest of the labels ACTUALLY rendered across
 * the row set — `sonnet` only joins that pool when at least one row
 * has `sonnet_week_percent` data, `limited` only when at least
 * one non-codex row has a parseable future lift, and `stale` only
 * when at least one row's stale anchor is older than the staleness
 * threshold — so a sonnet-less / limit-less / fresh screen still aligns
 * pct values cleanly. (`limited` is 7 chars — no wider than
 * `session` — so it never widens the label column past `session`.)
 * The bar is fixed
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
 * render an empty placeholder. Same rule for the `limited` line: it renders
 * ONLY when a non-codex row has a parseable FUTURE lift (`rate_limit_lifts_at`,
 * schema v41 / fn-651). The gate is NOT the fired-time `last_rate_limit_at`
 * (fn-754 dropped that) — a depleted-but-quiet row (weekly 100%, agentuse
 * paused polling until its lift, `last_rate_limit_at` NULL) still surfaces
 * its countdown. When it renders: `limited lifts in <rel>` while the lift
 * is future, `limited lifts now` within the ±30s rounding gap. The line is
 * OMITTED when the lift is NULL/unparseable, already past (`<= now` rounds
 * negative — never the misleading "<rel> ago" countdown), or the row is
 * stale (a frozen row's lift has elapsed; the `stale Nm` line is the single
 * signal). The codex stack (id `codex` / target `codex` — no rate-limit
 * concept) omits it unconditionally. The `stale` line (also v41) renders
 * only when the stale anchor — `max(last_usage_fold_at,
 * rate_limit_lifts_at)` (fn-754) — is older than `STALENESS_THRESHOLD_MS`,
 * driven exclusively off that stamp + lift, not `updated_at` (which a
 * rate-limit fold bumps) or agentuse's own `status` (which tracks its
 * scrape failures rather than keeper's ingestion health).
 *
 * Reset cells are rendered against the supplied `nowMs` — the caller
 * passes `Date.now()` from the data-change emit AND from the 30s tick,
 * and tests pass a fixed clock. The `limited` cell uses the same `nowMs`,
 * routed through {@link relTime} against the ISO `rate_limit_lifts_at`
 * value. The `stale` cell renders the age of the stale anchor against the
 * same `nowMs`.
 */
export function renderRowLines(
  rows: Record<string, unknown>[],
  nowMs: number,
  aliases: Record<string, string> = {},
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
    // True when the weekly window is depleted (>=100%). The session window
    // then collapses to a bar-less 0% with no reset on the /usage panel
    // (agentuse emits it with a null reset), so the session BODY LINE is
    // suppressed entirely — a `session [____] 0%` row under a maxed week is
    // noise. Only `week` (+ `sonnet`) render for the row.
    weekDepleted: boolean;
    // null when this row's envelope carried no sonnet_week sub-object.
    swBar: string | null;
    swPct: string | null;
    // Empty string when no sonnet data; otherwise the rendered relative
    // time (or "" inside the rendered cell if sonnet_resets_at was null).
    swReset: string;
    // Empty string when no `limited` line renders — a NULL/unparseable or
    // already-past lift, a stale row, or the codex stack. Otherwise the
    // rendered tail of the `limited` line (fn-754): `lifts in <rel>` when
    // `rate_limit_lifts_at` is known and still in the future (the lift
    // countdown), `lifts now` within the ±30s rounding gap. Gated on the
    // future lift itself — NOT the fired-time `last_rate_limit_at` (dropped
    // in fn-754) — so a depleted-but-quiet row still surfaces its countdown.
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
    // Lift-aware staleness anchor. `rate_limit_lifts_at` is the soonest
    // reset among >=100% windows; agentuse deliberately STOPS polling a
    // maxed account until its lift, so `last_usage_fold_at` freezes and a
    // depleted-but-validly-quiet row would otherwise trip the threshold. We
    // anchor the stale clock to `max(foldAt, lift)` so a row with a future
    // lift stays fresh (a weekly-100% cannot drop before its week boundary =
    // lift, so showing the lift on a frozen-but-accurate row is correct).
    // Parsed ABOVE `isStale` (unlike the v41 site) so the anchor can consult
    // it; reuse the same `seg()` + NaN-on-empty guard.
    const liftIso = seg(row.rate_limit_lifts_at);
    const liftMs = liftIso === "" ? Number.NaN : Date.parse(liftIso);
    // Unconditional `max`: while the lift is future, `max` picks `liftMs` →
    // not stale; after the lift passes (no fresh fold yet), `max` still picks
    // `liftMs`, so the normal 15m grace is measured FROM the lift. A null/NaN
    // lift falls back to `foldAtMs`; a never-folded row (foldAtMs NaN) stays
    // fresh via the `-1` short-circuit (Math.max with NaN is NaN → -1).
    const staleAnchorMs = Number.isNaN(liftMs)
      ? foldAtMs
      : Math.max(foldAtMs, liftMs);
    const staleAgeMs = Number.isNaN(staleAnchorMs) ? -1 : nowMs - staleAnchorMs;
    const isStale = staleAgeMs >= STALENESS_THRESHOLD_MS;
    // The `stale Nm` line carries the age + the human-readable "why" behind
    // the dashed cells. `relTimeFromMs` returns "<body> ago" for past times;
    // the `stale` label already conveys direction, so trim the suffix for a
    // tighter `stale 17m` body.
    const staleRel = isStale
      ? relTimeFromUnixSec(foldAtRaw as number, nowMs).replace(/ ago$/, "")
      : "";
    // fn-754: the `limited` line shows a live, forward lift on a non-stale
    // row — `rate_limit_lifts_at` (ISO) is the soonest reset among >=100%
    // windows. `lifts in <rel>` while the lift is future, `lifts now` within
    // the ±30s rounding gap. Gated ONLY on `!isCodex` (codex has no
    // rate-limit concept) and a parseable lift; the v41 `hasFiredTime`
    // (`last_rate_limit_at`) gate is DROPPED — a depletion case has
    // `last_rate_limit_at` NULL but a known future lift, and that gate was
    // exactly what suppressed it. The line is OMITTED when:
    //   - keeper-stale row → a frozen snapshot's lift can't be trusted; the
    //     `stale` line surfaces the problem, so no `limited` line at all
    //     (note: a FUTURE lift now keeps the row fresh via the anchor above,
    //     so this arm only fires once the lift has elapsed past the grace).
    //   - lift clearly past → the limit has lifted; a lingering line would
    //     lie (`liftDiffMin < 0` → empty, omit the line).
    //   - NULL/unparseable lift → no lift to show.
    // So the line's mere PRESENCE now means "limited, lifts soon."
    let rlRel = "";
    if (!isCodex && !isStale && !Number.isNaN(liftMs)) {
      // Round only for DISPLAY (the ±30s convention); the stale anchor above
      // compares raw ms.
      const liftDiffMin = Math.round((liftMs - nowMs) / 60000);
      if (liftDiffMin > 0) rlRel = `lifts in ${relTime(liftIso, nowMs)}`;
      else if (liftDiffMin === 0) rlRel = "lifts now";
    }
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
      id: `(${aliasOf(seg(row.id), aliases)})`,
      target: seg(row.target),
      mult: seg(row.multiplier),
      status: seg(row.status),
      sBar: bar(row.session_percent),
      sPct: pct(row.session_percent),
      sReset: resetCell(seg(row.session_resets_at), nowMs, isStale),
      wBar: bar(row.week_percent),
      wPct: pct(row.week_percent),
      wReset: resetCell(seg(row.week_resets_at), nowMs, isStale),
      weekDepleted:
        typeof row.week_percent === "number" && row.week_percent >= 100,
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
    if (!c.weekDepleted) allPcts.push(c.sPct);
    allPcts.push(c.wPct);
    if (c.swPct != null) allPcts.push(c.swPct);
  }
  const wPct = widest(allPcts);

  // Label width across the labels actually rendered. `sonnet` joins the
  // pool only when at least one row has sonnet data — keeps a sonnet-
  // less screen from padding `week` against an absent label. Same rule
  // for `limited`: only joins the pool when at least one row will
  // render that line. fn-645: `error` joins the pool only when at least
  // one visible row will render a stale-error line, mirroring the same
  // conditional-widen rule. (`limited` is 7 chars — no wider than
  // `session`/`week` — so it never widens `wLabel` beyond `session`.)
  const labels: string[] = [];
  // `session` only joins the width pool when at least one row actually renders
  // it — a weekly-depleted row suppresses its session line, so an all-depleted
  // frame must not pad `week` against an absent `session` label.
  if (cells.some((c) => !c.weekDepleted)) labels.push("session");
  labels.push("week");
  if (cells.some((c) => c.swPct != null)) labels.push("sonnet");
  if (cells.some((c) => c.rlRel !== "")) labels.push("limited");
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

  // The `limited` line has no bar and no pct — just `label · rel`. Indent
  // and label-padding match the quota body lines; a middot separates the
  // label from the lift body (the line carries no bar/pct column, so the
  // separator reads as "label, then its value" rather than a bare gap).
  // The `rel` body is `lifts in <rel>` (future lift) or `lifts now`
  // (within the ±30s gap) — composed in the cell mapping above; a past
  // lift omits the line.
  const renderLimited = (rel: string): string =>
    `${indent}${"limited".padEnd(wLabel, " ")} · ${rel}`;

  // The stale line mirrors the `limited` line — `label age` with the
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
    // Suppress the session line on a weekly-depleted row — see RowCells.
    if (!c.weekDepleted) {
      lines.push(renderBody("session", c.sBar, c.sPct, c.sReset));
    }
    lines.push(renderBody("week", c.wBar, c.wPct, c.wReset));
    if (c.swPct != null && c.swBar != null) {
      lines.push(renderBody("sonnet", c.swBar, c.swPct, c.swReset));
    }
    if (c.rlRel !== "") {
      lines.push(renderLimited(c.rlRel));
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
  aliases: Record<string, string> = {},
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
    // Empty/NULL profile_name stays the `(default)` sentinel (unknown, not the
    // literal `default` account); a real id resolves through the alias map so
    // the session log matches the usage block above it.
    const profile =
      pn == null || pn === ""
        ? DEFAULT_PROFILE_LABEL
        : aliasOf(String(pn), aliases);
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
      snapshot: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      // parseArgs has no number type — capture as a string and validate
      // manually below (exit 2 on a non-positive / non-numeric value).
      timeout: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // Resolve the run mode (flag > CI/TERM=dumb > stdout.isTTY !== true).
  // Both `--snapshot` and `--watch` → typed misuse error → exit 2. Shared
  // with the other four views via `src/snapshot.ts` so the precedence
  // (and the exit-2 contract) can never drift.
  let mode: "snapshot" | "watch";
  try {
    mode = resolveSnapshotMode({
      snapshotFlag: values.snapshot ?? false,
      watchFlag: values.watch ?? false,
      stdoutIsTTY: process.stdout.isTTY,
      env: process.env,
    });
  } catch (err) {
    if (err instanceof SnapshotCliMisuseError) {
      process.stderr.write(`keeper usage: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Validate `--timeout` (seconds) only when snapshotting — a bad value is
  // CLI misuse (exit 2). Watch mode ignores it.
  let timeoutMs = DEFAULT_SNAPSHOT_TIMEOUT_MS;
  if (values.timeout !== undefined) {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      process.stderr.write(
        `keeper usage: --timeout must be a positive number of seconds (got '${values.timeout}')\n`,
      );
      process.exit(2);
    }
    timeoutMs = Math.round(secs * 1000);
  }
  const isSnapshot = mode === "snapshot";

  const sockPath = values.sock ?? resolveSockPath();
  // Account display aliases (cosmetic) resolved once at startup from
  // ~/.config/keeper/config.yaml. Best-effort — a missing/bad config yields
  // `{}` (no aliasing). Read once: the config file is operator-edited, not a
  // live stream, so a restart picks up edits (consistent with the daemon's
  // own config read).
  const accountAliases = resolveConfig().accountAliases;
  // Forward-reference slot for the `c`-key copy handler — wired further
  // down once sidecar paths and the last frame text are in scope.
  let onKey: ((key: string) => void) | undefined;
  // Snapshot mode never paints a live frame: pass `enabled: false` so no
  // OpenTUI renderer is constructed and the shell's `pushFrame` /
  // `refreshLive` / `dispose` are inert no-ops. The snapshot path short-
  // circuits before any `pushFrame` anyway (it captures rows + composes
  // once at latch resolution), but a disabled shell is the belt-and-
  // suspenders guarantee that nothing reaches stdout to corrupt the
  // single-frame snapshot output — mirrors `createViewShell`'s snapshot
  // gate in `src/view-shell.ts`.
  const liveShell = createLiveShell({
    enabled: !isSnapshot,
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

  // Snapshot-mode (fn-772) wiring. Forward-reference report slots wired by
  // `runSnapshot` to the latch's `reportStream`; no-ops until then so a
  // callback that races ahead of `runSnapshot` (shouldn't happen — we wire
  // subscriptions then call it synchronously) is captured into the row caches
  // and replayed via the once-flags below. Per-stream once-guards keep the
  // latch's raw report count honest (one report per distinct stream). The
  // `sawConnected` latch lets the no-frame trailer distinguish `timeout`
  // (daemon serving, no frame in time) from `daemon-unreachable`.
  let reportUsageStream: () => void = () => {};
  let reportJobsStream: () => void = () => {};
  let usageStreamReported = false;
  let jobsStreamReported = false;
  let sawConnected = false;

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
        // drive renderer-visible state (the `limited lifts in <rel>`
        // countdown and the per-row `stale Nm` warning — and, since fn-754,
        // the lift also feeds the staleness anchor) but neither is in the
        // gate above, so a lift-only or freshness-only change would silently
        // fail to repaint without these. Raw ISO + raw unix-seconds — never
        // the minute-rounded rendered prose — so a clock tick can't forge a
        // frame.
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
    const usageLines = renderRowLines(lastUsageRows, nowMs, accountAliases);
    const sessionLines = renderSessionLines(
      lastJobsRows,
      nowMs,
      accountAliases,
    );
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
    // Snapshot mode captures rows only — the composition + sidecar write +
    // stdout print all happen ONCE at latch resolution (`finishSnapshot`),
    // never per-emit. The row caches (`lastUsageRows` / `lastJobsRows`) are
    // already updated by the stream callbacks before this fires, so there's
    // nothing to do here; the per-stream latch report lives in the callbacks.
    if (isSnapshot) {
      return;
    }
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
    // Snapshot mode: report the `usage` stream to the latch exactly once on
    // its first delivery. The readiness client's first paint always passes
    // the change-gate (initial key is `null`), so this fires on the first
    // real frame; the once-guard keeps a later changed delivery from
    // over-reporting. Inert in live mode (`reportUsageStream` is a no-op).
    if (isSnapshot && !usageStreamReported) {
      usageStreamReported = true;
      reportUsageStream();
    }
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
    // Snapshot mode: report the `jobs` stream to the latch exactly once on
    // its first delivery (mirrors `emitUsage`). Both streams reporting
    // satisfies the `streamCount: 2` latch — the composed frame reflects the
    // fully-folded usage + jobs blend, not fold-ordering luck.
    if (isSnapshot && !jobsStreamReported) {
      jobsStreamReported = true;
      reportJobsStream();
    }
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
  // and the colocated `limited` cells re-render against the same
  // `Date.now()` so the full stack stays fresh on the same tick.
  //
  // Under the OpenTUI port: `refreshLive` updates the LIVE slot only,
  // never history — when the human has scrolled back, the overlay is
  // dormant against the visible (historical) frame and resumes painting
  // on the next snap-to-live (G/End/Esc). The identical-text guard above
  // makes the tick a true no-op when minute-rounding holds, so the live
  // view never flickers between ticks.
  // NEVER armed in snapshot mode: the one-shot path composes once and exits,
  // so a live 30s `refreshLive` tick would (a) keep the process alive past
  // the intended exit and (b) push overlay lines that could corrupt the
  // single-frame stdout. The shell is `enabled: false` in snapshot mode
  // anyway (refreshLive is inert), but skipping the interval entirely is the
  // load-bearing tick-leak fix — `clearInterval` alone wouldn't help if the
  // snapshot path never reached the teardown.
  const tickHandle = isSnapshot
    ? undefined
    : setInterval(() => {
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
    // Snapshot mode: latch whether we ever reached `connected` so the
    // no-frame trailer reports `timeout` vs `daemon-unreachable` honestly.
    if (event === "connected") {
      sawConnected = true;
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

  // Snapshot mode (fn-772): one-shot. Wait (via the shared `streamCount: 2`
  // latch) until BOTH the usage + jobs streams have folded their first frame,
  // compose the body ONCE, write the sidecars once, print the frame + the
  // shared `keeper-meta:` trailer, dispose the handles, and exit. The trailer
  // is assembled from the shared `SnapshotMeta` type + `SNAPSHOT_SCHEMA_VERSION`
  // and serialized via the shared `formatSnapshotOutput` / `formatNoFrameOutput`
  // formatters, so usage's `keeper-meta:` line is byte-shape-identical to the
  // four `createViewShell` siblings — only `script: "usage"` differs. Mirrors
  // `runSnapshot`/`finish` in `src/view-shell.ts`.
  if (isSnapshot) {
    runSnapshot();
    return;
  }

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
    if (tickHandle !== undefined) {
      clearInterval(tickHandle);
    }
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

  // ── snapshot driver ──────────────────────────────────────────────────
  // Declared after the subscriptions so it can dispose both handles; only
  // reached on the `isSnapshot` early-return above (live mode never calls it).
  function runSnapshot(): void {
    let settled = false;

    function buildMeta(input: {
      status: SnapshotStatus;
      truncated: boolean;
      frame: number | null;
      state: string | null;
      frameTxt: string | null;
    }): SnapshotMeta {
      return {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        script: "usage",
        pid: process.pid,
        status: input.status,
        frame: input.frame,
        frame_count: input.frame === null ? 0 : 1,
        truncated: input.truncated,
        state: input.state,
        frame_txt: input.frameTxt,
        lifecycle: lifecycleSidecar,
        meta: metaSidecar,
        ts: new Date().toISOString(),
      };
    }

    function disposeAll(): void {
      liveShell.dispose();
      usageHandle.dispose();
      jobsHandle.dispose();
    }

    function finish(outcome: SnapshotLatchOutcome): void {
      if (settled) {
        return;
      }
      settled = true;
      latch.cancel();

      // A frame is available iff at least one stream reported — i.e. we have
      // real row data to compose. `ready` (both streams) and a timeout-degrade
      // (≥1 stream) both compose; only a 0-report timeout is the no-frame case.
      const haveFrame = usageStreamReported || jobsStreamReported;
      if (haveFrame) {
        const truncated = outcome.kind === "timeout";
        // Compose the body ONCE against the current clock — same renderer the
        // live path uses, so the snapshot text matches a live frame captured
        // at the same instant. `writeSidecars` reads `frameCount` for the
        // filenames, so bump to 1 first.
        const bodyLines = composeBody(Date.now());
        const frameText = ["---", ...bodyLines].join("\n");
        frameCount = 1;
        const stateSidecar = `/tmp/keeper-usage.${process.pid}.state.${frameCount}.json`;
        const frameSidecar = `/tmp/keeper-usage.${process.pid}.frame.${frameCount}.txt`;
        writeSidecars(frameText);
        lastFrame = frameText;
        const meta = buildMeta({
          status: "ok",
          truncated,
          frame: frameCount,
          state: stateSidecar,
          frameTxt: frameSidecar,
        });
        // The printed frame drops the sidecar's `---` lead (a sidecar/diff
        // artifact, not part of the human/agent frame).
        process.stdout.write(
          formatSnapshotOutput({ frameText: bodyLines.join("\n"), meta }),
        );
        disposeAll();
        process.exit(0);
      }

      // No frame before the deadline. `daemon-unreachable` iff we never saw a
      // `connected` lifecycle; otherwise the daemon was serving but didn't
      // deliver a frame in time → `timeout`.
      const status: SnapshotStatus = sawConnected
        ? "timeout"
        : "daemon-unreachable";
      const meta = buildMeta({
        status,
        truncated: true,
        frame: null,
        state: null,
        frameTxt: null,
      });
      const diagnostic =
        status === "daemon-unreachable"
          ? `keeper usage: no frame before ${timeoutMs}ms timeout (daemon unreachable)`
          : `keeper usage: no frame before ${timeoutMs}ms timeout (daemon connected but did not deliver a frame)`;
      const { stdout, stderr } = formatNoFrameOutput({ meta, diagnostic });
      process.stderr.write(stderr);
      process.stdout.write(stdout);
      disposeAll();
      process.exit(1);
    }

    const latch = createSnapshotLatch({
      streamCount: 2,
      timeoutMs,
      onResolve: finish,
    });
    // Wire the latch into the per-stream reports + replay any first-frame
    // report that landed before the latch was armed (a stream `onRows` racing
    // this synchronous open path).
    reportUsageStream = () => latch.reportStream();
    reportJobsStream = () => latch.reportStream();
    if (usageStreamReported) {
      latch.reportStream();
    }
    if (jobsStreamReported) {
      latch.reportStream();
    }
  }
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/usage.ts` would
// bypass the dispatcher's arg-pruning; if you really need it, run
// `bun cli/keeper.ts usage <args>` instead.
