#!/usr/bin/env bun
/**
 * `keeper usage` — watch the keeperd `usage` + `jobs` collections as a single
 * composed frame. The exported `renderRowLines` / `renderSessionLines`
 * pure-function helpers are asserted against by `test/usage.test.ts`.
 *
 * Two `subscribeCollection` calls drive one composed frame: the `usage` stream
 * renders the per-profile quota stacks (top), the `jobs` stream the `recent
 * sessions` log (bottom). Each is change-gated on its own raw-field hash, so a
 * relative-time tick or a fetch-only refresh never forges a frame. Each usage
 * row is a stacked block — a header chip plus one indented body line per quota
 * window (session, week, sonnet, codex-spark), a Claude picker reserve line,
 * and, when present, a `limited lifts in <rel>` line and a `stale Nm` line. The
 * daemon-side usage worker folds synthetic
 * `UsageSnapshot` / `UsageDeleted` events into the `usage` collection; the
 * reducer's fan-out mirrors `last_rate_limit_at` onto the usage row in the same
 * `BEGIN IMMEDIATE`. This module renders rows + writes sidecars;
 * `subscribeCollection` owns connection lifecycle.
 *
 * For the live TUI a 30s tick re-renders via `liveShell.refreshLive` so the
 * countdown ticks forward without growing history or writing sidecars;
 * historical scroll-back keeps each frame's at-capture rendering. The
 * `refreshLive` overlay is a no-op on identical text (an explicit linesEqual
 * skip guards the call) so the tick never flickers.
 *
 * Unlike board / jobs / git, usage does NOT use `createViewShell`: it blends
 * TWO subscribe streams into one composed body, runs a 30s relative-time tick,
 * and gates emit on raw projection-subset hash keys (NOT rendered text) — none
 * of which the shared shell supports without a leaky API widening or losing a
 * load-bearing change-gate.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  findShadowProfileDirs,
  type ShadowProfileFinding,
} from "../src/agent/shadow-profiles";
import { buildDebugSnapshot, copyToClipboard } from "../src/clipboard-debug";
import { resolveConfig, resolveSockPath } from "../src/db";
import {
  createFramesEmitter,
  defaultDiffFn,
  defaultFramesIo,
  type FramesEmitter,
  type TrailerReason,
} from "../src/frames-emitter";
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
import { usageModelAliases } from "../src/usage-models";
import {
  listProfiles,
  SESSION_THRESHOLD,
  WEEK_THRESHOLD,
} from "../src/usage-picker";
import { armViewerExitTriggers } from "../src/view-shell";
import { buildParseOptions, VIEWER_FLAGS } from "./descriptor";
import { parseDuration } from "./duration";

const COLLECTION = "usage";

const HELP = `keeper usage — live usage frames over the keeper subscribe server

Usage: keeper usage [--sock <path>] [--snapshot | --watch] [--timeout <dur>]
       keeper usage scrape --target <claude|codex> --profile <name> [...]

Subcommands:
  scrape         One-shot TUI usage scrape → schema-1 JSON contract
                 (\`keeper usage scrape --help\` for its flags)

  --sock <path>  Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot     Force one-shot snapshot mode (print one composed frame + a
                 machine-parseable keeper-meta: line, then exit) even on a TTY
  --watch        Force the live subscribe stream even when piped
  --timeout <dur>  Snapshot wait before the timeout escape (default ~2s;
                   unit required, e.g. 500ms, 2s)
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
window (session, week, sonnet where present, and codex-spark where present). The
multiplier reads \`?x\` ("tier unknown") when the account is authed but its tier
metadata is absent (a \`/login\` restored the keychain but not the
\`oauthAccount\` tier cache) — never a confident-but-wrong \`1x\`; a
signed-out / no-subscription row drops the suffix entirely. Each body line
carries a 30-wide ASCII bar (\`█\` filled / \`░\` empty) followed by
the numeric pct and a bare relative reset countdown (\`5d 21h\` /
\`1h 16m\` / \`5m\` / \`now\`; an elapsed-but-fresh reset reads \`now\`).
On a keeper-STALE row every reset countdown renders \`—\` (a frozen
snapshot's predicted times have all passed) and the \`limited\` line is
dropped. A weekly-depleted row (week >= 100%) suppresses its \`session\`
line — the panel collapses the session window to a reset-less 0%. An active
Claude quota stack gets a \`balance · reserve at session ≥${SESSION_THRESHOLD}% / week ≥${WEEK_THRESHOLD}%\`
line under its bars, making the picker reserve visible before the hard quota.
A stack with a known FUTURE lift (\`rate_limit_lifts_at\`, schema v41 / fn-651)
gets a colocated \`limited lifts in <rel>\` line under its quota lines
(\`limited lifts now\` within the rounding gap). The line is OMITTED when
the lift is past/unknown, when the row is stale, and for codex stacks.
A \`stale Nm\` line appears under any row whose stale anchor —
\`max(last_usage_fold_at, rate_limit_lifts_at)\` (fn-754) — is older than
the staleness threshold; anchoring to the lift keeps a depleted-but-quiet
row (agentusage paused polling until its lift) FRESH while the lift is
future. Driven only off that anchor, never \`updated_at\` and never
agentusage's own \`status\` — surfacing a wedged ingestion path instead of
silently frozen gauges, and labelling the \`—\` cells above it. A profile with no
quota bars renders a one-line reason on the stable \`account_state\` axis instead
of vanishing: \`auth · signed out\` (logged out), \`no active subscription\` (no
plan on this account), or — when a scrape genuinely failed — the existing
\`<kind>\` stale-error line. Untracked profiles (a rate-limit with no agentusage
usage row) still do not render. Below the profile stacks, a \`recent sessions\` block logs the
last 20 jobs (any state) newest-first, each labeled with the profile
it ran under (\`profile_name\`, schema v36) plus a short id, title,
state, and age. The live frame re-renders every 30s so countdowns tick;
historical scroll-back stays frozen at each frame's capture time.
Per-frame sidecars under /tmp/keeper-usage.<pid>.{state,frame,diff}.<n>.*
with an indexed meta sidecar; session paths print on SIGINT.

An auth-bearing reserved profile-shadow dir (e.g. a login stranded in
\`~/.claude-profiles/default\`) surfaces a one-line advisory banner above the
stacks; run \`keeper agent profiles check\` to inspect and reconcile it.
`;

/**
 * Help for the `keeper usage scrape` subverb. Owned here rather than in the
 * merged scrape CLI so `keeper usage scrape --help` stays a pure, spawn-free
 * help path — the scrape entry (which spawns a TUI and writes stdout) is never
 * imported on the help route.
 */
export const SCRAPE_HELP = `keeper usage scrape — one-shot TUI usage scrape (schema-1 JSON contract)

Usage: keeper usage scrape --target <claude|codex> --profile <name>
                           [--command <path>] [--rows <n>] [--cols <m>]

  --target <claude|codex>  Which agent's usage panel to scrape
  --profile <name>         Account profile ('default' = native ~/.claude)
  --command <path>         Override the agent binary path
  --rows <n>               PTY row count for the scrape
  --cols <m>               PTY column count for the scrape
  --help                   Show this help

Prints ONE discriminated JSON object on stdout (all diagnostics to stderr)
and mirrors the entry's exit codes: 0 ok, 1 scrape/parse error, 2 bad args.
`;

/**
 * Routing decision for a `keeper usage` invocation. The `scrape` subverb is
 * owned by this leading-token pre-pass ahead of the view's own `parseArgs`,
 * mirroring the established multi-subverb split: bare `keeper usage`, its
 * snapshot modes, and `keeper usage --help` stay byte-unchanged, and the view's
 * cold-start import set gains nothing — `main` pulls the scrape entry in via a
 * lazy import in the `scrape` arm only.
 */
export type UsageRoute =
  | { kind: "view" }
  | { kind: "scrape-help" }
  | { kind: "scrape"; argv: string[] };

/**
 * Classify a `keeper usage` argv. A leading `scrape` token routes to the merged
 * scrape CLI, forwarding the remaining argv verbatim; a `--help`/`-h` anywhere
 * in the scrape tail is the subverb's own pure help. Any other leading token
 * (including a bare argv or a leading flag like `--snapshot` / `--help`) is the
 * view path, unchanged.
 */
export function routeUsage(argv: string[]): UsageRoute {
  if (argv[0] !== "scrape") {
    return { kind: "view" };
  }
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) {
    return { kind: "scrape-help" };
  }
  return { kind: "scrape", argv: rest };
}

function seg(v: unknown): string {
  return v == null ? "" : String(v);
}

/**
 * Format a raw nullable multiplier into its chip token. A resolved tier renders
 * `<N>x` (`20x`, `1x`); an UNRESOLVED tier (`null` — a `/login` restored the
 * keychain but not the `~/.claude/.claude.json` `oauthAccount` tier cache)
 * renders `?x` ("tier unknown") rather than a confident-but-wrong `1x`. The
 * full token carries the trailing `x`, so it feeds the `wMult` width pool
 * directly and `?x` / `20x` right-align in the chip. The display boundary is the
 * ONLY place the null collapses — the column + envelope stay `INTEGER|NULL`.
 */
function formatMultiplier(raw: number | null): string {
  return raw == null ? "?x" : `${raw}x`;
}

// Short stale-error labels keyed by the projection's stable `error_kind`. A
// null or unrecognized kind degrades to the generic `error` label so the
// detailed `<type>: <message>` body is never hidden behind an unknown class.
const ERROR_KIND_LABELS: Record<string, string> = {
  format_changed: "format",
  panel_missing: "panel",
  scrape_failed: "scrape",
  upstream_limited: "upstream",
  runner_failed: "runner",
};

function errorKindLabel(kind: string): string {
  return ERROR_KIND_LABELS[kind] ?? "error";
}

// Standalone annotation phrases keyed by the stable `account_state` axis. A row
// in one of these states renders ONE line under its header — no bars, no
// stale/limited line, nothing to age. The phrase intentionally stays OUT of the
// `wLabel` pool (it is 17 / 22 chars) so it never shoves a healthy row's bars
// rightward; only the row's id/target/mult feed the width pools.
const ACCOUNT_STATE_LABELS: Record<string, string> = {
  signed_out: "auth · signed out",
  no_subscription: "no active subscription",
};

/**
 * Resolve an agentusage account id to its configured display alias (purely
 * cosmetic). An unmapped id passes through verbatim. The alias never touches
 * row identity; it is applied only at the render edge.
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
 * Minute-rounded humanized relative time between `iso` and `nowMs`. Returns
 * `""` for an empty input, the raw input string if the ISO is unparseable
 * (degrade rather than throw in a render hot path), `"now"` at the round
 * boundary, and a two-unit-max largest-first form otherwise (`Nw Md` / `Nd Mh`
 * / `Nh Mm` / `Mm`, zero residuals collapsing). Future times render bare; past
 * times render `<body> ago`.
 *
 * This is the AGE formatter — its `ago` branch is for genuinely
 * backward-looking cells. The forward-looking reset cells go through
 * {@link resetCell}, which intercepts an elapsed target before this `ago`
 * branch can mislabel an until-reset value as an age. `nowMs` is a parameter
 * (not `Date.now()`) so the 30s tick and tests drive a deterministic clock
 * without wall-clock IO here.
 */
function relTime(iso: string, nowMs: number): string {
  if (iso === "") return "";
  const target = Date.parse(iso);
  return relTimeFromMs(target, nowMs, iso);
}

/**
 * Numeric (unix-seconds) variant of {@link relTime}. Reset timestamps ride as
 * ISO strings but `last_rate_limit_at` rides as REAL unix-SECONDS, so this thin
 * shim converts once to ms and shares the same minute-rounding body (feeding
 * raw seconds into `relTime` would `Date.parse` to NaN). Returns `""` for
 * `null`/`undefined`.
 */
function relTimeFromUnixSec(
  sec: number | null | undefined,
  nowMs: number,
): string {
  if (sec == null) return "";
  return relTimeFromMs(sec * 1000, nowMs, "");
}

/**
 * Shared body for {@link relTime} and {@link relTimeFromUnixSec}. `targetMs` is
 * the parsed absolute time in ms; `fallback` is returned on NaN. Pure — no
 * wall-clock IO of its own.
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
 * A reset is a strictly-FORWARD value — agentusage resolves `*_resets_at` into
 * the future at every scrape, so a target slipped into the PAST on a fresh row
 * is "the reset is due, a fresh scrape just hasn't landed," not an age:
 *
 *   - future            → the countdown (`3d 2h`, `29m`)
 *   - at / just-past now → `now` — never `<rel> ago`, never `—`
 *
 * `—` (`STALE_CELL`) is reserved EXCLUSIVELY for a keeper-stale row: the whole
 * row is then a frozen snapshot, so every cell dashes uniformly and the
 * `stale Nm` line carries the why. There is NO per-cell staleness. Empty input
 * → `""`; an unparseable ISO passes through verbatim.
 */
function resetCell(iso: string, nowMs: number, rowStale: boolean): string {
  if (iso === "") return "";
  if (rowStale) return STALE_CELL;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  // Forward-only: a target at/behind `now` on a fresh row → `now`, never `<rel>
  // ago`. Intercept anything past the ±30s boundary so relTime's `ago` branch
  // can't mislabel an until-reset value as an age. `—` is keeper-stale ONLY.
  if (Math.round((ms - nowMs) / 60000) < 0) return "now";
  return relTime(iso, nowMs);
}

const BAR_WIDTH = 30;

/**
 * Cutoff for the `stale` per-row warning, in ms. A row whose stale anchor —
 * `max(last_usage_fold_at, rate_limit_lifts_at)` (`last_usage_fold_at` is the
 * unix-seconds event ts of the last successful usage fold) — is older than this
 * against the renderer's `nowMs` picks up an indented `stale Nm` line.
 * Anchoring to the lift keeps a depleted-but-quiet row FRESH while the lift is
 * future. Tuned to ~3x agentusage's ~5m envelope-write cadence, so a brief lull
 * doesn't flap the warning while a wedged ingestion path surfaces within
 * ~15-20m.
 */
const STALENESS_THRESHOLD_MS = 15 * 60_000;

/**
 * Placeholder rendered in a forward-looking quota-reset countdown cell when the
 * row is STALE. A stale row's gauges are a frozen snapshot of a possibly-dead
 * producer, so its reset predictions are untrustworthy (all elapsed). A
 * confident `now` would read as "everything just reset"; the em-dash reads as
 * "unknown" and the adjacent `stale Nm` line carries the why. The `limited`
 * lift line is dropped on a stale row rather than dashed.
 */
const STALE_CELL = "—";

/**
 * Fixed-width ASCII progress bar — bracket + `BAR_WIDTH` cells + bracket,
 * identical width across every row so the pct column stays aligned without
 * per-row math. `█` filled, `░` empty; fill rounds half-up against `BAR_WIDTH`.
 * Clamped to `[0, 100]` and folds unknown / non-numeric input to an all-empty
 * bar (matching `pct`'s `?` fallback).
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
 *                    balance  · reserve at session ≥80% / week ≥95%
 *                    limited  · lifts in 1h 2m
 *                    stale    17m
 *
 * Body indent equals `wId + 1` so labels line up under the chip's `[`. Labels
 * padEnd to the widest label ACTUALLY rendered across the row set — `sonnet` /
 * `balance` / `limited` / `stale` only join that pool when at least one row
 * renders them — so a sonnet-less / limit-less / fresh screen still aligns pct cleanly. The
 * bar is fixed `BAR_WIDTH + 2` cols; pct cells padStart to the widest pct
 * across every rendered body line. The relative-time tail is unpadded; a row
 * whose reset ISO was empty renders no tail.
 *
 * The `balance` line renders under active Claude quota rows so the picker
 * reserve threshold is visible beside the hard-quota bars.
 * The `limited` line renders ONLY when a non-codex row has a parseable FUTURE
 * lift (`rate_limit_lifts_at`) — NOT the fired-time `last_rate_limit_at`, so a
 * depleted-but-quiet row still surfaces its countdown. `lifts in <rel>` while
 * future, `lifts now` within the ±30s gap; OMITTED when the lift is
 * NULL/unparseable, already past, the row is stale, or it's the codex stack.
 * The `stale` line renders only when the stale anchor (`max(last_usage_fold_at,
 * rate_limit_lifts_at)`) is older than `STALENESS_THRESHOLD_MS`, driven off
 * that stamp + lift — never `updated_at` (a rate-limit fold bumps it) or
 * agentusage's `status` (which tracks scrape failures, not ingestion health).
 *
 * All cells render against the supplied `nowMs` (the data-change emit, the 30s
 * tick, or a fixed test clock) so the renderer does no wall-clock IO.
 */
export function renderRowLines(
  rows: Record<string, unknown>[],
  nowMs: number,
  aliases: Record<string, string> = {},
): string[] {
  if (rows.length === 0) return [];

  // Every tracked row now renders. A no-bar row is classified onto the stable
  // `account_state` axis (see `stableState` below) and renders a single
  // annotation line instead of empty `?` bars — no row is hidden, so the
  // operator always sees why a profile has no quota stack.

  interface RowCells {
    id: string;
    target: string;
    mult: string;
    // Envelope freshness token rendered as a trailing header chip ("active" /
    // "idle" / "stale"). Empty when the envelope omitted the field.
    status: string;
    sBar: string;
    sPct: string;
    sReset: string;
    wBar: string;
    wPct: string;
    wReset: string;
    // True when the weekly window is depleted (>=100%); the session body line
    // is then suppressed (agentusage emits a bar-less 0% with no reset, which is
    // noise under a maxed week). Only `week` (+ `sonnet`) render.
    weekDepleted: boolean;
    // null when this row's envelope carried no sonnet_week sub-object.
    swBar: string | null;
    swPct: string | null;
    // Empty string when no sonnet data; otherwise the rendered relative
    // time (or "" inside the rendered cell if sonnet_resets_at was null).
    swReset: string;
    // null when this row's envelope carried no codex_spark_session sub-object.
    cssBar: string | null;
    cssPct: string | null;
    cssReset: string;
    // null when this row's envelope carried no codex_spark_week sub-object.
    cswBar: string | null;
    cswPct: string | null;
    cswReset: string;
    // Empty when no `balance` line renders. Otherwise the static picker-policy
    // note that makes the reserve threshold visible below the Claude bars.
    balanceText: string;
    // Empty when no `limited` line renders. Otherwise its tail: `lifts in
    // <rel>` while `rate_limit_lifts_at` is future, `lifts now` within the ±30s
    // gap. Gated on the future lift itself, not the fired-time
    // `last_rate_limit_at`, so a depleted-but-quiet row still surfaces it.
    rlRel: string;
    // Empty when this row is fresh (or `last_usage_fold_at` is NULL). Otherwise
    // the `stale` line's age tail. Driven off `last_usage_fold_at`, never
    // `updated_at` (a rate-limit fold bumps it) or agentusage's `status`.
    staleRel: string;
    // Stale-error line body — empty when `error_type` is NULL, else the
    // `<type>: <message>` content (the matching `errRel` is the rel-time cell).
    errContent: string;
    errRel: string;
    // Stale-error line LABEL — empty when `error_type` is NULL, else the
    // `error_kind`-derived short label (`format` / `panel` / `scrape` /
    // `upstream` / `runner`), falling back to `error` for a null/unknown kind.
    errLabel: string;
    // Stable account-state axis. Non-null ⇒ this row renders a single
    // standalone annotation line (`auth · signed out` / `no active
    // subscription`) under its header INSTEAD of bars / limited / stale (no
    // usage to age), and feeds nothing into the pct / label width pools. The
    // stale-error line takes precedence: a row with an active error line keeps
    // its bars + error line and is never reclassified.
    stableState: "signed_out" | "no_subscription" | null;
  }

  const cells: RowCells[] = rows.map((row) => {
    const hasSonnet = row.sonnet_week_percent != null;
    const hasCodexSparkSession = row.codex_spark_session_percent != null;
    const hasCodexSparkWeek = row.codex_spark_week_percent != null;
    // codex has no rate-limit concept — suppress the line even if the
    // wire payload were to carry a non-null `last_rate_limit_at`.
    const isCodex = row.id === "codex" || row.target === "codex";
    // Per-row freshness gate, computed FIRST because the rate-limit line and
    // the reset cells key off it. `last_usage_fold_at` is REAL unix-SECONDS
    // from the last SUCCESSFUL usage fold (never bumped by a rate-limit fold or
    // idle snapshot). A stale row renders every forward-looking time as
    // `STALE_CELL` instead of a confident-but-wrong `now`. A NULL stamp means
    // no fold to age — treat as fresh so a never-folded row doesn't flap stale.
    const foldAtRaw = row.last_usage_fold_at;
    const foldAtMs =
      typeof foldAtRaw === "number" ? foldAtRaw * 1000 : Number.NaN;
    // Lift-aware staleness anchor. agentusage STOPS polling a maxed account until
    // its lift, freezing `last_usage_fold_at`, so anchoring the stale clock to
    // `max(foldAt, lift)` keeps a depleted-but-quiet row with a future lift
    // fresh. After the lift passes (no fresh fold) the 15m grace is measured
    // FROM the lift; a null/NaN lift falls back to `foldAtMs`, and a
    // never-folded row stays fresh via the `-1` short-circuit below.
    const liftIso = seg(row.rate_limit_lifts_at);
    const liftMs = liftIso === "" ? Number.NaN : Date.parse(liftIso);
    const staleAnchorMs = Number.isNaN(liftMs)
      ? foldAtMs
      : Math.max(foldAtMs, liftMs);
    const staleAgeMs = Number.isNaN(staleAnchorMs) ? -1 : nowMs - staleAnchorMs;
    const isStale = staleAgeMs >= STALENESS_THRESHOLD_MS;
    // Trim the `ago` suffix (`relTimeFromMs` adds it for past times) since the
    // `stale` label already conveys direction → a tighter `stale 17m` body.
    const staleRel = isStale
      ? relTimeFromUnixSec(foldAtRaw as number, nowMs).replace(/ ago$/, "")
      : "";
    // The `limited` line shows a live forward lift on a non-stale row. Gated
    // only on `!isCodex` and a parseable lift, then omitted when the lift is
    // past (a lingering line would lie), the row is stale, or the lift is
    // NULL/unparseable — so its mere presence means "limited, lifts soon."
    let rlRel = "";
    if (!isCodex && !isStale && !Number.isNaN(liftMs)) {
      // Round only for DISPLAY (the ±30s convention); the stale anchor compares
      // raw ms.
      const liftDiffMin = Math.round((liftMs - nowMs) / 60000);
      if (liftDiffMin > 0) rlRel = `lifts in ${relTime(liftIso, nowMs)}`;
      else if (liftDiffMin === 0) rlRel = "lifts now";
    }
    // Stale-error line, present only when `error_type` is set. Content is
    // `<type>: <message…>`; the rel-time cell routes `error_at` through
    // `relTime` so it ticks on the 30s clock like the quota resets.
    const errType = seg(row.error_type);
    const errMsg = seg(row.error_message);
    const errAtIso = seg(row.error_at);
    const errContent = errType === "" ? "" : `${errType}: ${errMsg}`;
    const errRel = errType === "" ? "" : relTime(errAtIso, nowMs);
    const errLabel = errType === "" ? "" : errorKindLabel(seg(row.error_kind));
    // Stable account-state classification, precedence stale-error → account_state
    // → bars. A row with an active error line keeps its bars + error line (never
    // reclassified). `signed_out` outranks `no_subscription`; the
    // `subscription_active === 0` arm is back-compat for a no-sub row scraped
    // before v97 whose `account_state` is still NULL.
    let stableState: "signed_out" | "no_subscription" | null = null;
    if (errContent === "") {
      const accountState = seg(row.account_state);
      if (accountState === "signed_out") stableState = "signed_out";
      else if (
        accountState === "no_subscription" ||
        row.subscription_active === 0
      )
        stableState = "no_subscription";
    }
    // Multiplier chip token. A resolved tier renders `<N>x`; an unresolved tier
    // (null) renders `?x` on a subscription-active row, but a signed_out /
    // no_subscription row DROPS the suffix entirely (`[claude]`) — surfacing
    // `?x` there would imply a live-but-unknown tier on an account that has no
    // active plan, and it also fixes today's broken `[claude  x]`.
    const rawMult = typeof row.multiplier === "number" ? row.multiplier : null;
    const mult =
      rawMult === null && stableState !== null ? "" : formatMultiplier(rawMult);
    const balanceText =
      row.target === "claude" && stableState === null
        ? `reserve at session ≥${SESSION_THRESHOLD}% / week ≥${WEEK_THRESHOLD}%`
        : "";
    return {
      id: `(${aliasOf(seg(row.id), aliases)})`,
      target: seg(row.target),
      mult,
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
      cssBar: hasCodexSparkSession
        ? bar(row.codex_spark_session_percent)
        : null,
      cssPct: hasCodexSparkSession
        ? pct(row.codex_spark_session_percent)
        : null,
      cssReset: hasCodexSparkSession
        ? resetCell(seg(row.codex_spark_session_resets_at), nowMs, isStale)
        : "",
      cswBar: hasCodexSparkWeek ? bar(row.codex_spark_week_percent) : null,
      cswPct: hasCodexSparkWeek ? pct(row.codex_spark_week_percent) : null,
      cswReset: hasCodexSparkWeek
        ? resetCell(seg(row.codex_spark_week_resets_at), nowMs, isStale)
        : "",
      balanceText,
      rlRel,
      staleRel,
      errContent,
      errRel,
      errLabel,
      stableState,
    };
  });

  const widest = (xs: string[]): number =>
    xs.reduce((acc, x) => Math.max(acc, x.length), 0);

  // Id / target / mult pools span ALL cells — a stable-state row still renders a
  // header chip, so its id/target/mult legitimately participate in column width.
  const wId = widest(cells.map((c) => c.id));
  const wTarget = widest(cells.map((c) => c.target));
  const wMult = widest(cells.map((c) => c.mult));

  // Pct + label pools span ONLY bar-rendering rows. A stable-state row renders
  // no body lines, so its (absent) bars/labels must never pad the column —
  // crucially the annotation phrase never enters `wLabel`.
  const barCells = cells.filter((c) => c.stableState === null);

  // Pct width across every body line that will render.
  const allPcts: string[] = [];
  for (const c of barCells) {
    if (!c.weekDepleted) allPcts.push(c.sPct);
    allPcts.push(c.wPct);
    if (c.swPct != null) allPcts.push(c.swPct);
    if (c.cssPct != null) allPcts.push(c.cssPct);
    if (c.cswPct != null) allPcts.push(c.cswPct);
  }
  const wPct = widest(allPcts);

  // Label width across the labels ACTUALLY rendered — `sonnet` / `limited` /
  // `stale` / `error` join the pool only when at least one row renders them, so
  // an absent label never pads the column. `session` likewise drops out of an
  // all-depleted frame (every row suppresses its session line).
  const labels: string[] = [];
  if (barCells.some((c) => !c.weekDepleted)) labels.push("session");
  if (barCells.length > 0) labels.push("week");
  if (barCells.some((c) => c.swPct != null)) labels.push("sonnet");
  if (barCells.some((c) => c.cssPct != null)) labels.push("spark-5h");
  if (barCells.some((c) => c.cswPct != null)) labels.push("spark-week");
  if (barCells.some((c) => c.balanceText !== "")) labels.push("balance");
  if (barCells.some((c) => c.rlRel !== "")) labels.push("limited");
  if (barCells.some((c) => c.staleRel !== "")) labels.push("stale");
  for (const c of barCells) {
    if (c.errLabel !== "") labels.push(c.errLabel);
  }
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

  // The `balance` and `limited` lines have no bar/pct — just `label · text`,
  // indent and label-padding matching the quota body lines.
  const renderAnnotation = (label: string, text: string): string =>
    `${indent}${label.padEnd(wLabel, " ")} · ${text}`;

  // The stale line is `label age`, same indent + padding so it column-aligns.
  // The age is bare (no `ago` suffix) since `stale` conveys direction.
  const renderStale = (age: string): string =>
    `${indent}${"stale".padEnd(wLabel, " ")} ${age}`;

  // Stale-error line. Its `<type>: <message…>` body occupies the same
  // `BAR_WIDTH + 2 + 1 + wPct` width the bar+space+pct sequence does, so the
  // trailing rel-time stamp lands in the SAME column as the reset stamps.
  // Oversize content truncates with an ellipsis; under-width padEnds to keep
  // the rel-time column stable.
  const errCellWidth = BAR_WIDTH + 2 + 1 + wPct;
  const renderError = (label: string, content: string, rel: string): string => {
    let body: string;
    if (content.length > errCellWidth) {
      body = `${content.slice(0, Math.max(0, errCellWidth - 1))}…`;
    } else {
      body = content.padEnd(errCellWidth, " ");
    }
    const head = `${indent}${label.padEnd(wLabel, " ")} ${body}`;
    return rel === "" ? head : `${head} ${rel}`;
  };

  const lines: string[] = [];
  for (const c of cells) {
    const id = c.id.padStart(wId, " ");
    // The `x` rides inside the formatted token (`20x` / `?x`), so the chip just
    // padStarts the token under `wMult`. An empty token with a present target is
    // a dropped multiplier suffix (an unresolved tier on a signed_out /
    // no_subscription row) → the bare `[target]`, never the broken `[claude  x]`.
    const targetChip =
      c.target === "" && c.mult === ""
        ? ""
        : c.mult === ""
          ? `[${c.target.padEnd(wTarget, " ")}]`
          : `[${c.target.padEnd(wTarget, " ")} ${c.mult.padStart(wMult, " ")}]`;
    // Status token as a trailing header chip, rendered for any non-empty
    // status. Two-space separator distances it from the chip; when the chip is
    // absent it tags directly after the id.
    const header = (() => {
      const head = targetChip === "" ? id : `${id} ${targetChip}`;
      return c.status === "" ? head : `${head}  ${c.status}`;
    })();
    lines.push(header);
    // A stable account-state row renders ONE annotation line under its header
    // and nothing else — no bars to draw, no usage to age. The phrase sits at
    // the body indent but carries no `wLabel` padding (it is not a quota label).
    if (c.stableState !== null) {
      lines.push(`${indent}${ACCOUNT_STATE_LABELS[c.stableState]}`);
      continue;
    }
    // Suppress the session line on a weekly-depleted row — see RowCells.
    if (!c.weekDepleted) {
      lines.push(renderBody("session", c.sBar, c.sPct, c.sReset));
    }
    lines.push(renderBody("week", c.wBar, c.wPct, c.wReset));
    if (c.swPct != null && c.swBar != null) {
      lines.push(renderBody("sonnet", c.swBar, c.swPct, c.swReset));
    }
    if (c.cssPct != null && c.cssBar != null) {
      lines.push(renderBody("spark-5h", c.cssBar, c.cssPct, c.cssReset));
    }
    if (c.cswPct != null && c.cswBar != null) {
      lines.push(renderBody("spark-week", c.cswBar, c.cswPct, c.cswReset));
    }
    if (c.balanceText !== "") {
      lines.push(renderAnnotation("balance", c.balanceText));
    }
    if (c.rlRel !== "") {
      lines.push(renderAnnotation("limited", c.rlRel));
    }
    if (c.staleRel !== "") {
      lines.push(renderStale(c.staleRel));
    }
    if (c.errContent !== "") {
      lines.push(renderError(c.errLabel, c.errContent, c.errRel));
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
 * `profile_name` rides the row natively (the reducer's SessionStart fold stamps
 * it, NULL under the default profile) so the renderer needs no join; a
 * NULL/empty name renders as {@link DEFAULT_PROFILE_LABEL}. Columns padEnd to
 * the widest value present (profile / short id / title / state); the rel-time
 * tail floats after the state column with a two-space gap.
 *
 * `job_id` is sliced to a 7-char short id; `title` falls back to `<untitled>`
 * and truncates to {@link SESSION_TITLE_MAX}. `created_at` is REAL unix-SECONDS,
 * so every (past) session renders an `<rel> ago` tail. `nowMs` is a parameter
 * so the 30s tick and tests drive a deterministic clock without wall-clock IO
 * here, and so the change-gate (which hashes RAW `created_at`) stays insensitive
 * to minute-boundary bleed.
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

/**
 * One-line, non-fatal advisory for an AUTH-BEARING reserved profile shadow
 * (`isReservedShadow && hasAuth`) — a signed-in account stranded in a dir
 * (e.g. `~/.claude-profiles/default`) that nothing reads, the collision this
 * plank guards against. Returns a single banner line pointing at the read-only
 * `keeper agent profiles check` doctor, or `[]` when no such shadow exists.
 *
 * Pure over its findings input; the caller computes findings ONCE per frame (a
 * live fs read via `findShadowProfileDirs`, never a daemon round-trip), so the
 * usage render path stays db-free and the 30s redraw tick never re-reads dirs.
 * Stays NARROW: tracked-profile health (signed-out / no-subscription) is the
 * account-row's job, not this banner's — so it keys strictly off the
 * auth-bearing reserved-shadow predicate.
 */
export function formatShadowAdvisory(
  findings: ShadowProfileFinding[],
): string[] {
  const stranded = findings.filter((f) => f.isReservedShadow && f.hasAuth);
  if (stranded.length === 0) return [];
  const where = stranded.map((f) => `${f.agent} ${f.name}/`).join(", ");
  return [
    `! a signed-in account is stranded in a reserved profile shadow (${where}) — run \`keeper agent profiles check\` to reconcile`,
  ];
}

export async function main(argv: string[]): Promise<void> {
  // Subverb pre-pass — routes `keeper usage scrape ...` to the merged scrape
  // CLI before the view's parseArgs ever sees the argv. The scrape entry loads
  // via a LAZY import in this arm only, so the view's cold-start import set is
  // unchanged and `keeper usage scrape --help` stays spawn-free.
  const route = routeUsage(argv);
  if (route.kind === "scrape-help") {
    process.stdout.write(SCRAPE_HELP);
    process.exit(0);
  }
  if (route.kind === "scrape") {
    const { main: scrapeMain } = await import("../src/usage-scrape/scrape-cli");
    process.exit(await scrapeMain(route.argv));
  }

  const { values } = parseArgs({
    args: argv,
    // Derived from the pure-data descriptor (ADR 0008). parseArgs has no number
    // type — `timeout` is a string, validated manually below.
    options: buildParseOptions(VIEWER_FLAGS),
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

  // Validate `--timeout` (shared duration grammar) only when snapshotting — a
  // bad value is CLI misuse (exit 2). Watch mode ignores it.
  let timeoutMs = DEFAULT_SNAPSHOT_TIMEOUT_MS;
  if (values.timeout !== undefined) {
    const parsed = parseDuration(values.timeout);
    if (!parsed.ok) {
      process.stderr.write(`keeper usage: --timeout ${parsed.message}\n`);
      process.exit(2);
    }
    timeoutMs = parsed.ms;
  }
  const sockPath = values.sock ?? resolveSockPath();
  await runUsageView({ mode, sockPath, timeoutMs });
}

/** Resolved run config for the usage view shell. `frames` is present ONLY on
 *  the `keeper frames --view usage` path; live/snapshot leave it undefined. */
interface RunUsageConfig {
  mode: "snapshot" | "watch" | "frames";
  sockPath: string;
  timeoutMs: number;
  frames?: {
    /** The prod frames emitter (view `usage`, `diff -u` seam, real sidecar IO). */
    emitter: FramesEmitter;
    /** Duration bound in millis; `null` ⇒ unbounded (`--follow`). */
    durationMs?: number | null;
  };
}

/**
 * Drive the usage view shell in `live` / `snapshot` / `frames`. usage is the
 * open-coded outlier that cannot adopt `createViewShell` (it blends TWO
 * subscribe streams into one composed body, runs a 30s relative-time tick, and
 * gates emit on raw projection-subset hashes), so the frames path is open-coded
 * here too — the SAME `src/frames-emitter.ts` wire contract the shared shell
 * drives, plugged into the composed-frame emit site (the dual-consumer
 * invariant: one wire contract, two integration points, no re-open-coding).
 * `main` calls this in live/snapshot; `runUsageFrames` calls it in frames.
 */
async function runUsageView(config: RunUsageConfig): Promise<void> {
  const { mode, sockPath, timeoutMs } = config;
  const isSnapshot = mode === "snapshot";
  const isFrames = mode === "frames";
  const framesEmitter = config.frames?.emitter ?? null;
  // Account display aliases (cosmetic) derived once at startup from the
  // `usage_models` registry in ~/.config/keeper/config.yaml — the values carrying
  // a non-null alias. Best-effort — a missing/bad config yields `{}` (no
  // aliasing). Read once: the config file is operator-edited, not a live stream,
  // so a restart picks up edits (consistent with the daemon's own config read).
  const accountAliases = usageModelAliases(resolveConfig().usageModels);
  // Read-only detection of an auth-bearing reserved profile shadow (a login
  // stranded in `~/.claude-profiles/default` and friends). Computed ONCE here —
  // a live fs read, NEVER a daemon round-trip — and cached for the process'
  // lifetime so the 30s redraw tick never re-reads the dirs (no IO churn /
  // flicker). Db-free: `findShadowProfileDirs` + `listProfiles` import only
  // node:* + dep-free leaves, so the usage render path stays off `src/db.ts`.
  const shadowAdvisory = formatShadowAdvisory(
    findShadowProfileDirs(listProfiles, homedir()),
  );
  // Forward-reference slot for the `c`-key copy handler — wired further
  // down once sidecar paths and the last frame text are in scope.
  let onKey: ((key: string) => void) | undefined;
  // Only the live TUI (`watch`) paints. Snapshot and frames both pass
  // `enabled: false` so the shell's `pushFrame` / `refreshLive` / `dispose` are
  // inert no-ops — nothing reaches stdout to corrupt the single-frame snapshot
  // output OR the frames NDJSON stream.
  const liveShell = createLiveShell({
    enabled: mode === "watch",
    title: "usage",
    onUnhandledKey: (key) => onKey?.(key),
  });
  let lastFrame: string | null = null;
  let frameCount = 0;
  // The freshest daemon fold cursor (`BootStatus.rev`) fed by both streams'
  // `onBootStatus` — stamped on every frames envelope + the trailer's resume
  // cursor (the shared shell's `noteCursor` analog). `null` until the first boot
  // header lands; never read outside frames mode.
  let latestCursor: string | null = null;
  // Snapshot-mode wiring. Forward-reference report slots wired by `runSnapshot`
  // to the latch's `reportStream`; no-ops until then, replayed via the engine's
  // once-guards. `sawConnected` lets the no-frame trailer distinguish `timeout`
  // from `daemon-unreachable`.
  let reportUsageStream: () => void = () => {};
  let reportJobsStream: () => void = () => {};
  let sawConnected = false;
  // Frames-mode driver state — the open-coded analog of the shared shell's
  // `finishFrames`. The trailer flushes exactly ONCE, on the first of a tripped
  // bound (`maybeStopFrames`), the duration timer, or SIGINT / parent-death.
  let framesFinished = false;
  let framesTimer: ReturnType<typeof setTimeout> | undefined;

  // The composed-frame emit engine — the hash-gated dual-stream emit path,
  // shared by every mode. It owns the row caches, the raw-field change-gate
  // keys, and the frames baseline/frame routing; the shell owns the impure
  // sinks it calls (`onLiveFrame` history+sidecars, `onTickRefresh` the live
  // overlay, `onMaybeStop` the bound check) plus the snapshot latch reports.
  const engine = createUsageEmitEngine({
    mode,
    accountAliases,
    shadowAdvisory,
    framesEmitter,
    latestCursor: () => latestCursor,
    onMaybeStop: maybeStopFrames,
    onLiveFrame,
    onTickRefresh: (bodyLines) => liveShell.refreshLive(bodyLines),
    reportUsageStream: () => reportUsageStream(),
    reportJobsStream: () => reportJobsStream(),
    nowMs: () => Date.now(),
  });

  // Live-mode frame sink: append to scroll-back history + write the per-frame
  // sidecars. `frameCount` names the sidecar files; `lastFrame` seeds the next
  // diff. Never reached in snapshot/frames (the engine routes those elsewhere).
  function onLiveFrame(bodyLines: string[]): void {
    const frameText = ["---", ...bodyLines].join("\n");
    frameCount += 1;
    liveShell.pushFrame(bodyLines);
    writeSidecars(frameText);
    lastFrame = frameText;
  }

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
    // State JSON — the `usage` + `jobs` row sets are the full input to the
    // rendered frame (rate-limit annotations ride the usage row, per-job
    // `profile_name` the jobs row).
    writeFileSync(
      sState,
      `${JSON.stringify({ usage: engine.getUsageRows(), jobs: engine.getJobsRows() }, null, 2)}\n`,
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

  // 30s relative-time tick: re-render the live view's countdown cells against
  // the wall clock and overlay via `engine.tick` → `onTickRefresh` — no history
  // growth, no sidecar writes, and CRITICALLY no frames envelope (the emitter is
  // hooked at the hash-gated emit site, never the tick, so a countdown repaint
  // is never minted as a frame). Armed ONLY in the live TUI (`watch`): snapshot
  // is one-shot and frames streams NDJSON, so neither has a live overlay to
  // refresh, and arming the interval there would outlive the one-shot exit.
  const tickHandle =
    mode === "watch" ? setInterval(() => engine.tick(), 30_000) : undefined;

  // Frames-mode teardown: flush the always-final trailer (resume cursor +
  // honest coverage), tear down, and exit — mirroring the shared shell's
  // `finishFrames`. Exit code mirrors snapshot's daemon-unreachable precedent: a
  // run that emitted its baseline reached the daemon → 0; a run that never
  // rendered a frame never connected → 1. Idempotent across the SIGINT /
  // parent-death / duration-timer / bound-tripped triggers.
  function finishFrames(reason: TrailerReason): void {
    if (framesEmitter === null || framesFinished) return;
    framesFinished = true;
    if (framesTimer !== undefined) {
      clearTimeout(framesTimer);
      framesTimer = undefined;
    }
    framesEmitter.emitTrailer({ reason });
    liveShell.dispose();
    usageHandle.dispose();
    jobsHandle.dispose();
    process.exit(engine.framesBaselineEmitted() ? 0 : 1);
  }

  // After a frames data emit, flush the trailer if a bound (`--max-frames` /
  // `--for`) has tripped. Passed to the engine as `onMaybeStop`.
  function maybeStopFrames(): void {
    if (framesEmitter === null) return;
    const reason = framesEmitter.shouldStop();
    if (reason !== null) finishFrames(reason);
  }

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
    // On disconnect, clear the change-gate so the next first-paint always emits
    // — even if the post-reconnect snapshot matches the last pre-disconnect row
    // set byte-for-byte — and downgrade frames coverage to `gap_possible` (a
    // reconnect is the sole gap source the emitter's contiguous seq can't see).
    // The engine owns the change-gate keys + the emitter, so it clears both.
    if (event === "disconnected") {
      lastFrame = null;
      engine.noteDisconnect();
    }
    // Snapshot mode: latch whether we ever reached `connected` so the
    // no-frame trailer reports `timeout` vs `daemon-unreachable` honestly.
    if (event === "connected") {
      sawConnected = true;
    }
  }

  // Single-collection subscription over `usage`. The colocated rate-limit
  // columns ride the same row, so one subscribe covers the full frame — no
  // separate `profiles` stream, no row-to-row blending in the renderer.
  const usageHandle = subscribeCollection({
    sockPath,
    idPrefix: "usage",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "id", dir: "asc" },
    onRows: engine.emitUsage,
    onLifecycle: emitLifecycle,
    // Thread the freshest daemon fold cursor into the frames resume-cursor seam
    // — every frames envelope + the trailer stamp `String(rev)`. Inert in
    // live/snapshot (the stored cursor is never read).
    onBootStatus: (boot) => {
      latestCursor = String(boot.rev);
    },
  });

  // Second subscription: the `jobs` collection drives the "recent sessions"
  // log. `sort created_at desc` + `limit 20` is the last-N-sessions page;
  // `filter { state: { not_in: [] } }` overrides the descriptor's default
  // terminal-hide scope (the empty `not_in` contributes no clause) so the log
  // includes `ended` / `killed` jobs — a true "last 20 sessions". `profile_name`
  // rides each row natively, so no `profiles` join is needed.
  const jobsHandle = subscribeCollection({
    sockPath,
    idPrefix: "usage",
    collection: "jobs",
    limit: SESSION_LOG_LIMIT,
    sort: { column: "created_at", dir: "desc" },
    filter: { state: { not_in: [] } },
    onRows: engine.emitJobs,
    onLifecycle: emitLifecycle,
    onBootStatus: (boot) => {
      latestCursor = String(boot.rev);
    },
  });

  // Snapshot mode: one-shot. Wait (via the shared `streamCount: 2` latch) until
  // BOTH streams have folded their first frame, compose the body ONCE, write
  // the sidecars once, print the frame + the shared `keeper-meta:` trailer,
  // dispose the handles, and exit. The trailer uses the shared `SnapshotMeta`
  // formatters, so usage's `keeper-meta:` line is byte-shape-identical to the
  // `createViewShell` siblings — only `script: "usage"` differs.
  if (isSnapshot) {
    runSnapshot();
    return;
  }

  // Frames mode: one process, one `--view usage` NDJSON stream. The subscriptions
  // above already drive the engine's baseline/frame routing; here we arm the
  // trailer-flush triggers — SIGINT + the parent-death / TTY-close triggers, and
  // (when bounded) a duration teardown timer so a quiet stream past `--for`
  // still terminates with a resumable trailer. A `--max-frames` bound flushes
  // from inside the engine via `onMaybeStop`.
  if (isFrames) {
    const onInterrupt = (): void => finishFrames("interrupt");
    process.on("SIGINT", onInterrupt);
    armViewerExitTriggers(onInterrupt);
    const durationMs = config.frames?.durationMs ?? null;
    if (durationMs !== null) {
      framesTimer = setTimeout(() => finishFrames("duration"), durationMs);
    }
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
  // usage.ts owns its own SIGINT handler (it can't route through the shared
  // `installSigintHandler` — see the header). Plus the parent-death / TTY-close
  // triggers shared with every viewer: SIGHUP, stdin-EOF, and the ppid===1 poll.
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
      const haveFrame =
        engine.usageStreamReported() || engine.jobsStreamReported();
      if (haveFrame) {
        const truncated = outcome.kind === "timeout";
        // Compose the body ONCE against the current clock — same renderer the
        // live path uses, so the snapshot text matches a live frame captured
        // at the same instant. `writeSidecars` reads `frameCount` for the
        // filenames, so bump to 1 first.
        const bodyLines = engine.composeBody(Date.now());
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
    if (engine.usageStreamReported()) {
      latch.reportStream();
    }
    if (engine.jobsStreamReported()) {
      latch.reportStream();
    }
  }
}

/** The frames entry `keeper frames --view usage` dispatches to. Builds the prod
 *  frames emitter (view `usage`, `diff -u` seam, real sidecar IO, the caller's
 *  chunk bounds) and drives the shared usage view shell in `frames` mode — the
 *  open-coded analog of `runBoardFrames`, over the SAME `src/frames-emitter.ts`
 *  wire contract. In prod it never returns (the shell owns `process.exit`). */
export async function runUsageFrames(config: {
  sockPath?: string;
  maxFrames?: number | null;
  durationMs?: number | null;
  prevFrameText?: string | null;
}): Promise<void> {
  const emitter = createFramesEmitter({
    view: "usage",
    writeStdout: (line) => void process.stdout.write(line),
    diffFn: defaultDiffFn,
    io: defaultFramesIo(),
    maxFrames: config.maxFrames ?? null,
    durationMs: config.durationMs ?? null,
    prevFrameText: config.prevFrameText ?? null,
  });
  await runUsageView({
    mode: "frames",
    sockPath: config.sockPath ?? resolveSockPath(),
    timeoutMs: DEFAULT_SNAPSHOT_TIMEOUT_MS,
    frames: { emitter, durationMs: config.durationMs ?? null },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// The composed-frame emit engine
// ─────────────────────────────────────────────────────────────────────────

/**
 * Injected sinks + config for {@link createUsageEmitEngine}. The engine is pure
 * of subscribe / liveShell / process / clock — the shell wires the impure sinks
 * — so the whole hash-gate + compose + emit-decision path is covered in the
 * pure test tier with no daemon boot.
 */
export interface UsageEmitEngineDeps {
  mode: "snapshot" | "watch" | "frames";
  accountAliases: Record<string, string>;
  shadowAdvisory: string[];
  /** The prod frames emitter in `frames` mode; `null` in live/snapshot. */
  framesEmitter: FramesEmitter | null;
  /** Freshest daemon fold cursor for the frames resume seam, read per emit. */
  latestCursor: () => string | null;
  /** Called after a frames data emit so a tripped bound flushes the trailer. */
  onMaybeStop: () => void;
  /** Live-mode frame sink (history + sidecars). Never called in snapshot/frames. */
  onLiveFrame: (bodyLines: string[]) => void;
  /** Live-mode relative-time refresh sink (the 30s tick's overlay). */
  onTickRefresh: (bodyLines: string[]) => void;
  /** Snapshot latch per-stream reports (once-guarded here); no-ops elsewhere. */
  reportUsageStream: () => void;
  reportJobsStream: () => void;
  /** Wall clock for relative-time rendering (`Date.now` in prod). */
  nowMs: () => number;
}

/** The engine's surface — the stream callbacks + the tick, plus the accessors
 *  the shell's snapshot driver / sidecar writer read. */
export interface UsageEmitEngine {
  emitUsage: (rows: Record<string, unknown>[]) => void;
  emitJobs: (rows: Record<string, unknown>[]) => void;
  /** The 30s relative-time tick — re-renders, NEVER mints a frame. */
  tick: () => void;
  /** A disconnect edge: clear the change-gate + downgrade frames coverage. */
  noteDisconnect: () => void;
  composeBody: (nowMs: number) => string[];
  getUsageRows: () => Record<string, unknown>[];
  getJobsRows: () => Record<string, unknown>[];
  usageStreamReported: () => boolean;
  jobsStreamReported: () => boolean;
  /** Whether the frames baseline has been emitted (drives the exit code). */
  framesBaselineEmitted: () => boolean;
}

/**
 * Build the composed-frame emit engine — usage's open-coded analog of the shared
 * shell's emit path. Both subscribe streams feed ONE composed body; each is
 * change-gated on its own RAW-field hash (never rendered text), so a relative-
 * time tick or a fetch-only refresh never forges a frame. On a hash change it
 * routes to the active sink: live history+sidecars, a snapshot row-capture, or —
 * in frames mode — the shared `src/frames-emitter.ts` (baseline on the first
 * accepted frame, `frame` thereafter). The 30s tick re-renders the live overlay
 * only and never touches the emitter, so a countdown repaint is never a frame.
 */
export function createUsageEmitEngine(
  deps: UsageEmitEngineDeps,
): UsageEmitEngine {
  const isSnapshot = deps.mode === "snapshot";
  const framesEmitter = deps.framesEmitter;
  // Row caches for the two subscriptions, cleared-of-gate on `disconnected` so
  // the next first-paint always emits.
  let usageRows: Record<string, unknown>[] = [];
  let jobsRows: Record<string, unknown>[] = [];
  // Projection-meaningful RAW-field hashes — gating on these, NOT rendered text,
  // keeps a fetch-only `last_event_id` / `updated_at` bump AND a minute-tick
  // relative-time bleed from forging a frame; only real data movement does.
  let usageRowsKey: string | null = null;
  let jobsRowsKey: string | null = null;
  // Last lines painted to the live overlay — lets the tick skip an identical
  // re-render (the load-bearing no-flicker guard for the live-tick path).
  let lastLiveLines: string[] = [];
  // Per-stream once-guards keep the snapshot latch's report count honest (one
  // per stream); also gate the frames-mode coverage report.
  let usageReported = false;
  let jobsReported = false;
  // Frames mode: the FIRST accepted frame is the `baseline`, the rest `frame`s.
  let baselineEmitted = false;

  /**
   * Stringify the projection-meaningful subset of the `usage` row set into a
   * stable hash key. Excludes `last_event_id` / `updated_at` (they bump on
   * every fetch-only refresh) and keys off raw ISO timestamps + percents, not
   * minute-rounded prose, so the gate is insensitive to relative-time bleed.
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
        // Envelope status / subscription / error axes. `error_at` is safe to
        // include — the worker's change-gate suppresses synthetic-event churn,
        // so the wire-side `error_at` only moves when gated fields move.
        r.status,
        r.subscription_active,
        // Stable account-state axis — a flip (signed_out ⇄ no_subscription ⇄
        // subscribed) changes which annotation line vs bars render, so the
        // gate must repaint on it.
        r.account_state,
        r.error_type,
        r.error_message,
        r.error_at,
        // The lift instant + freshness stamp drive renderer-visible state (the
        // `limited` countdown, the `stale Nm` warning, the staleness anchor)
        // but aren't in the gate above, so a lift- or freshness-only change
        // would fail to repaint without these. Raw ISO + unix-seconds, never
        // rendered prose, so a clock tick can't forge a frame.
        r.rate_limit_lifts_at,
        r.last_usage_fold_at,
      ]),
    );
  }

  /**
   * Stringify the projection-meaningful subset of the `jobs` row set into a
   * stable hash key. Hashes ONLY the RAW unrendered fields the session log
   * reads (`job_id`, `profile_name`, `created_at`, `state`, `title`),
   * excluding `last_event_id` / `updated_at` and keying off raw `created_at` so
   * neither a fetch-only refresh nor a minute-boundary crossing forges a frame.
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
   * Compose the full frame body against `nowMs`: an optional shadow-profile
   * advisory banner on top (when an auth-bearing reserved shadow exists), then
   * the per-profile usage stacks, then — when at least one job is present — a
   * blank-line-separated `recent sessions` block. Both streams render against
   * the SAME clock so a single 30s tick keeps every relative-time cell (quota
   * resets, rate-limit annotations, AND session ages) fresh together; the
   * advisory is frame-static (computed once at startup, not per redraw).
   */
  function composeBody(nowMs: number): string[] {
    const usageLines = renderRowLines(usageRows, nowMs, deps.accountAliases);
    const sessionLines = renderSessionLines(
      jobsRows,
      nowMs,
      deps.accountAliases,
    );
    let body: string[];
    if (sessionLines.length === 0) {
      body = usageLines;
    } else if (usageLines.length === 0) {
      body = ["recent sessions", ...sessionLines];
    } else {
      body = [...usageLines, "", "recent sessions", ...sessionLines];
    }
    // Prepend the shadow advisory as a top banner separated by a blank line.
    // It sits ABOVE the stacks on its own lines, so it never feeds the
    // account-row width pools (renderRowLines derives column widths from rows
    // alone) and can't shift the table alignment.
    if (deps.shadowAdvisory.length === 0) return body;
    if (body.length === 0) return [...deps.shadowAdvisory];
    return [...deps.shadowAdvisory, "", ...body];
  }

  /**
   * Emit one composed frame to the active sink. Snapshot mode captures rows
   * only (the compose + print happen once at latch resolution). Frames mode
   * routes to the shared emitter — baseline first, `frame` thereafter, then a
   * bound check. Live mode appends to history + writes sidecars. The frame text
   * carries NO `---` lead — that is a live-sidecar artifact, not the wire frame.
   */
  function emitFrame(): void {
    if (isSnapshot) return;
    const bodyLines = composeBody(deps.nowMs());
    if (framesEmitter !== null) {
      const input = {
        cursor: deps.latestCursor(),
        frameText: bodyLines.join("\n"),
        stateJson: { usage: usageRows, jobs: jobsRows },
      };
      if (!baselineEmitted) {
        baselineEmitted = true;
        framesEmitter.emitBaseline(input);
      } else {
        framesEmitter.emitFrame(input);
      }
      deps.onMaybeStop();
      return;
    }
    // Live mode: keep `lastLiveLines` in sync so the next tick suppresses an
    // identical re-render, then hand the body to the history+sidecar sink.
    lastLiveLines = bodyLines;
    deps.onLiveFrame(bodyLines);
  }

  function emitUsage(rows: Record<string, unknown>[]): void {
    const rowsKey = usageRowsHashKey(rows);
    if (rowsKey === usageRowsKey) return;
    usageRowsKey = rowsKey;
    usageRows = rows;
    // Report the `usage` stream to the snapshot latch exactly once, on its first
    // delivery (the readiness client's first paint always passes the change-gate
    // — initial key is `null`). The once-guard keeps a later changed delivery
    // from over-reporting. Inert outside snapshot (`reportUsageStream` no-ops).
    if (!usageReported) {
      usageReported = true;
      deps.reportUsageStream();
    }
    emitFrame();
  }

  function emitJobs(rows: Record<string, unknown>[]): void {
    const rowsKey = jobsRowsHashKey(rows);
    if (rowsKey === jobsRowsKey) return;
    jobsRowsKey = rowsKey;
    jobsRows = rows;
    if (!jobsReported) {
      jobsReported = true;
      deps.reportJobsStream();
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

  return {
    emitUsage,
    emitJobs,
    // The tick re-renders the live overlay against the wall clock and NEVER
    // calls `emitFrame` — the raw-field hash gate stays the sole emit trigger,
    // so a countdown repaint is never minted as a frame (in frames mode the
    // overlay sink is inert, so the tick is a pure no-op).
    tick: () => {
      if (usageRows.length === 0 && jobsRows.length === 0) return;
      const bodyLines = composeBody(deps.nowMs());
      if (linesEqual(bodyLines, lastLiveLines)) return;
      lastLiveLines = bodyLines;
      deps.onTickRefresh(bodyLines);
    },
    noteDisconnect: () => {
      usageRowsKey = null;
      jobsRowsKey = null;
      framesEmitter?.noteReconnect();
    },
    composeBody,
    getUsageRows: () => usageRows,
    getJobsRows: () => jobsRows,
    usageStreamReported: () => usageReported,
    jobsStreamReported: () => jobsReported,
    framesBaselineEmitted: () => baselineEmitted,
  };
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the canonical
// entry; direct `bun cli/usage.ts` invocation bypasses the dispatcher's
// arg-pruning.
