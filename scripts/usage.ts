#!/usr/bin/env bun
/**
 * keeper-usage — watch the keeperd `usage` AND `profiles` collections as
 * one composed frame.
 *
 * Two independent `subscribeCollection` calls share one frame: the
 * `usage` stacks (per-profile session/week quota bars with reset
 * countdowns) render on top, and a "Rate limits by profile" block
 * (keyed by `config_dir`, showing each Claude profile's last rate-limit
 * relative time) renders below. The two streams have disjoint key spaces
 * (usage `id` is the agentuse profile id; profiles key is `config_dir`),
 * so the blocks are presented stacked-but-disjoint — not as a row-to-row
 * correlation. Each stream owns its own change-gate and module-locals;
 * either `onRows` triggers a combined re-render against the latest-of-each.
 *
 * The daemon-side usage worker watches `~/.local/state/agentuse/<id>.json`
 * and folds synthetic `UsageSnapshot` / `UsageDeleted` events into the
 * `usage` collection. The reducer maintains the `profiles` projection
 * inline on SessionStart (seed by `COALESCE(config_dir,'')`) and on
 * `rate_limit` ApiError (upsert `last_rate_limit_at` +
 * `last_rate_limit_session_id`). This script is the primitive frame UI
 * for both surfaces, mirroring `scripts/git.ts`'s sidecar discipline
 * (per-frame state JSON carrying BOTH row sets + frame text + unified
 * diff under `/tmp/keeper-usage.<pid>.*`, indexed meta sidecar, SIGINT
 * teardown that prints sidecar paths).
 *
 * Connection lifecycle is owned by `subscribeCollection` in
 * `src/readiness-client.ts` — same capped-backoff reconnect, per-collection
 * coalesce, steady-poll backstop, and `dispose()` contract as
 * `scripts/git.ts`. The script's job is rendering rows + writing sidecars;
 * the helper handles everything below the rows. Each subscribe opens its
 * own connection; SIGINT must dispose both handles.
 *
 * Reset cells render as minute-rounded humanized relative time
 * (`5d 21h`, `3h 5m`, `5m`, `now`, `2h 5m ago`) against the current
 * wall clock — future times drop the `in ` prefix since the column
 * context (a reset countdown) makes the direction unambiguous; past
 * times keep `ago` to flag the inversion. For the live frame in TUI
 * mode a 30s tick re-renders via `liveShell.refreshLive` so the visible
 * countdown ticks forward without growing history or writing sidecars;
 * historical scroll-back keeps each frame's at-capture rendering, so the
 * relative times you see when stepping back are the ones that were on
 * screen when that frame was first emitted.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildDebugSnapshot, copyToClipboard } from "../src/clipboard-debug";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import { subscribeCollection } from "../src/readiness-client";

const COLLECTION = "usage";
const PROFILES_COLLECTION = "profiles";

const HELP = `keeper-usage — live usage frames over the keeper subscribe server

Usage: bun scripts/usage.ts [--sock <path>]

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
the numeric pct and a bare relative reset time (\`5d 21h\` / \`1h 16m\`
/ \`5m\` / \`now\` / \`2m ago\`). Below the usage stacks, a "Rate limits
by profile" block lists each Claude profile (keyed by config_dir; the
default \`~/.claude\` renders as \`(default)\`) with the relative time
of the last rate-limit error, or \`—\` for profiles that have never hit
one. The live frame re-renders every 30s so countdowns tick; historical
scroll-back stays frozen at each frame's capture time. Per-frame sidecars
under /tmp/keeper-usage.<pid>.{state,frame,diff}.<n>.* with an indexed
meta sidecar; session paths print on SIGINT.
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
 * keep the `<body> ago` suffix to flag the inversion.
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
 * carries reset timestamps as ISO strings; the `profiles` collection carries
 * `last_rate_limit_at` as REAL unix-SECONDS (matching `jobs.last_api_error_at`).
 * Feeding raw seconds into `relTime` would do `Date.parse` and yield NaN, so
 * we route numeric inputs through this thin shim — converting once to ms and
 * sharing the same minute-rounding body. Returns `""` for `null`/`undefined`
 * (no rate limit known); otherwise the same `"now"` / `"Nh Mm"` / `"Mm ago"`
 * shape as `relTime`.
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

const BAR_WIDTH = 30;

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
 *                    session [█████░░░░░░░░░░░░░░░░░░░░░░░░░]  16% 29m
 *                    week    [███████████░░░░░░░░░░░░░░░░░░░]  36% 4d 5h
 *                    sonnet  [██░░░░░░░░░░░░░░░░░░░░░░░░░░░░]   8% 4d 5h
 *
 * Body indent equals `wId + 1` so labels line up under the `[` of the
 * chip. Labels (`session` / `week` / `sonnet`) padEnd to the widest of
 * the labels ACTUALLY rendered across the row set — `sonnet` only joins
 * that pool when at least one row has `sonnet_week_percent` data, so a
 * sonnet-less screen still aligns pct values cleanly. The bar is fixed
 * `BAR_WIDTH + 2`-col width (bracket + BAR_WIDTH cells + bracket) so no
 * per-row width math is needed; pct cells padStart to the widest pct
 * across every body line that will render (session, week, and sonnet
 * wherever present), so a `100%` in any row pushes a matching column
 * of right-aligned digits everywhere.
 *
 * The bare relative-time tail is unpadded — it lands wherever the
 * pct column ends, with a single separating space. Rows whose reset
 * ISO was empty render no tail at all (no trailing whitespace).
 *
 * Rows without sonnet data simply omit the sonnet body line; they do NOT
 * render an empty placeholder.
 *
 * Reset cells are rendered against the supplied `nowMs` — the caller
 * passes `Date.now()` from the data-change emit AND from the 30s tick,
 * and tests pass a fixed clock.
 */
export function renderRowLines(
  rows: Record<string, unknown>[],
  nowMs: number,
): string[] {
  if (rows.length === 0) return [];

  interface RowCells {
    id: string;
    target: string;
    mult: string;
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
  }

  const cells: RowCells[] = rows.map((row) => {
    const hasSonnet = row.sonnet_week_percent != null;
    return {
      id: `(${seg(row.id)})`,
      target: seg(row.target),
      mult: seg(row.multiplier),
      sBar: bar(row.session_percent),
      sPct: pct(row.session_percent),
      sReset: relTime(seg(row.session_resets_at), nowMs),
      wBar: bar(row.week_percent),
      wPct: pct(row.week_percent),
      wReset: relTime(seg(row.week_resets_at), nowMs),
      swBar: hasSonnet ? bar(row.sonnet_week_percent) : null,
      swPct: hasSonnet ? pct(row.sonnet_week_percent) : null,
      swReset: hasSonnet ? relTime(seg(row.sonnet_week_resets_at), nowMs) : "",
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
  // less screen from padding `week` against an absent label.
  const labels = ["session", "week"];
  if (cells.some((c) => c.swPct != null)) labels.push("sonnet");
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

  const lines: string[] = [];
  for (const c of cells) {
    const id = c.id.padStart(wId, " ");
    const targetChip =
      c.target === "" && c.mult === ""
        ? ""
        : `[${c.target.padEnd(wTarget, " ")} ${c.mult.padStart(wMult, " ")}x]`;
    lines.push(targetChip === "" ? id : `${id} ${targetChip}`);
    lines.push(renderBody("session", c.sBar, c.sPct, c.sReset));
    lines.push(renderBody("week", c.wBar, c.wPct, c.wReset));
    if (c.swPct != null && c.swBar != null) {
      lines.push(renderBody("sonnet", c.swBar, c.swPct, c.swReset));
    }
  }
  return lines;
}

const DEFAULT_PROFILE_LABEL = "(default)";

/**
 * Render the `profiles`-collection rows as a "Rate limits by profile" block —
 * one row per Claude profile (keyed by `config_dir`) showing the relative
 * time of the last `rate_limit` ApiError, or `—` when none has been observed.
 *
 *   (default)              5m ago
 *   (multi-claude-3)       3h 12m ago
 *   (multi-claude-7)       —
 *
 * The `''` sentinel `config_dir` (the default `~/.claude` profile, which
 * collapses every NULL-`CLAUDE_CONFIG_DIR` session onto a single PK) renders
 * as `(default)` rather than an empty chip — empty parens read as "missing
 * data," and the default profile is a known-correct value here, not absence.
 *
 * The two blocks (`usage` stacks + this "Rate limits by profile" table) are
 * INDEPENDENT in key space: usage `id` is the agentuse profile id (e.g.
 * `claude-multi-3`) while the profile key is the config_dir (e.g.
 * `~/.claude-profiles/multi-claude-3`). They are not joinable today — see
 * the epic notes — so this block is presented stacked-but-disjoint, not as
 * a per-row correlation.
 *
 * `last_rate_limit_at` arrives over the wire as REAL unix-SECONDS (matching
 * `jobs.last_api_error_at`); we route through {@link relTimeFromUnixSec} so
 * a raw float doesn't leak into the rendered text. `nowMs` is an explicit
 * parameter (same contract as `renderRowLines`) so tests can drive a fixed
 * clock and the 30s tick can pass `Date.now()` afresh.
 */
export function renderProfileLines(
  rows: Record<string, unknown>[],
  nowMs: number,
): string[] {
  if (rows.length === 0) return [];

  interface ProfileCells {
    chip: string;
    rel: string;
  }

  const cells: ProfileCells[] = rows.map((row) => {
    const cfg = row.config_dir;
    const cfgStr = cfg == null ? "" : String(cfg);
    // Wrap in parens to mirror the usage block's id-chip shape; the `''`
    // sentinel renders as the `(default)` literal rather than `()`.
    const chip = cfgStr === "" ? DEFAULT_PROFILE_LABEL : `(${cfgStr})`;
    const raw = row.last_rate_limit_at;
    let rel: string;
    if (raw == null) {
      // NULL last_rate_limit_at — no rate limit ever observed on this
      // profile (seed-only row from the SessionStart `INSERT OR IGNORE`,
      // or a quiet profile since the last cursor rewind).
      rel = "—";
    } else if (typeof raw === "number") {
      rel = relTimeFromUnixSec(raw, nowMs);
      // An empty string from the helper would only happen here if `raw`
      // were null/undefined — guarded above — but fold to `—` defensively
      // so a future helper change can't leak whitespace.
      if (rel === "") rel = "—";
    } else {
      // Defensive: a non-numeric `last_rate_limit_at` would be a wire-shape
      // bug. Render the raw value rather than throwing inside the render
      // hot path (matches `relTime`'s degrade-to-raw stance).
      rel = String(raw);
    }
    return { chip, rel };
  });

  const widest = (xs: string[]): number =>
    xs.reduce((acc, x) => Math.max(acc, x.length), 0);

  const wChip = widest(cells.map((c) => c.chip));

  const lines: string[] = ["Rate limits by profile"];
  for (const c of cells) {
    lines.push(`${c.chip.padEnd(wChip, " ")} ${c.rel}`);
  }
  return lines;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
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
  // Two parallel sets of module-locals — one per subscribed collection.
  // `emitFrame` composes ONE frame from the latest-of-each, so either
  // stream's `onRows` can trigger a combined re-render against whatever
  // the other stream most recently delivered.
  let lastUsageRows: Record<string, unknown>[] = [];
  let lastProfileRows: Record<string, unknown>[] = [];
  // Projection-meaningful subsets of the last emit per stream. Gating
  // `emitFrame` on these — not on the rendered text — keeps a fetch-only
  // refresh that bumps `last_event_id` / `updated_at` from flapping a new
  // frame, AND keeps minute-tick relative-time bleed from forging one
  // either. Cleared on `disconnected` so a post-reconnect first emit on
  // either stream always paints.
  let lastUsageRowsKey: string | null = null;
  let lastProfileRowsKey: string | null = null;
  // Last lines we pushed/refreshed to the live shell. Lets the 30s tick
  // skip the `refreshLive` call when minute-rounding produced identical
  // text — avoids even the cost of constructing the overlay (renderDiff
  // would short-circuit too, but skipping here is cheaper and clearer).
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
    // Dual-stream state JSON — both collections' row sets so a sidecar
    // captures the full input to the composed frame, not just one half.
    writeFileSync(
      sState,
      `${JSON.stringify({ usage: lastUsageRows, profiles: lastProfileRows }, null, 2)}\n`,
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
      ]),
    );
  }

  /**
   * Sibling gate for the `profiles` stream. Same exclusion rationale as
   * {@link usageRowsHashKey}: `last_event_id` / `updated_at` flap on
   * fetch-only refresh; rendering reads only `config_dir` and
   * `last_rate_limit_at`. Each stream owns its own change-gate so a noisy
   * fetch on one collection can't shake a re-emit on the other.
   */
  function profileRowsHashKey(rows: Record<string, unknown>[]): string {
    return JSON.stringify(
      rows.map((r) => [r.config_dir, r.last_rate_limit_at]),
    );
  }

  /**
   * Combined-render emitter. Composes ONE frame from the latest-of-each
   * stream — usage block on top, then the "Rate limits by profile" block
   * (with a blank-line separator when both blocks have content). Either
   * subscription's `onRows` triggers a combined re-render via {@link emitUsage}
   * or {@link emitProfiles}; each updates its own slice of state, advances
   * its own change-gate, and calls back into here. Rendering is against
   * `Date.now()` so the frozen at-capture text in history reflects what
   * was on screen the moment the data landed; the 30s tick keeps the live
   * view ticking forward via `refreshLive` without growing history.
   */
  function emitFrame(): void {
    const now = Date.now();
    const usageLines = renderRowLines(lastUsageRows, now);
    const profileLines = renderProfileLines(lastProfileRows, now);
    // Stitch the two blocks. A blank-line separator between them is only
    // useful when both have content; either-side-empty drops the gap so
    // the surviving block stays flush with the frame header.
    let bodyLines: string[];
    if (usageLines.length > 0 && profileLines.length > 0) {
      bodyLines = [...usageLines, "", ...profileLines];
    } else if (usageLines.length > 0) {
      bodyLines = usageLines;
    } else {
      bodyLines = profileLines;
    }
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
   * can't forge one either. Triggers a combined re-render against the
   * current `lastProfileRows` so both blocks stay in sync.
   */
  function emitUsage(rows: Record<string, unknown>[]): void {
    const rowsKey = usageRowsHashKey(rows);
    if (rowsKey === lastUsageRowsKey) return;
    lastUsageRowsKey = rowsKey;
    lastUsageRows = rows;
    emitFrame();
  }

  /**
   * `profiles`-stream row callback. Same change-gate discipline as
   * {@link emitUsage} but against the profile-specific hash key. Triggers
   * a combined re-render against the current `lastUsageRows`.
   */
  function emitProfiles(rows: Record<string, unknown>[]): void {
    const rowsKey = profileRowsHashKey(rows);
    if (rowsKey === lastProfileRowsKey) return;
    lastProfileRowsKey = rowsKey;
    lastProfileRows = rows;
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
  // at-capture text. Skipped when there's no data on either stream yet OR
  // when the composed render hasn't changed (minute-rounding holds for
  // most ticks). 30s gives the worst-case half-minute lag on a minute
  // boundary, which is plenty for minute-precision display. BOTH blocks
  // re-render against the same `Date.now()` so relative times in either
  // block stay fresh on the same tick.
  const tickHandle = setInterval(() => {
    if (lastUsageRows.length === 0 && lastProfileRows.length === 0) return;
    const now = Date.now();
    const usageLines = renderRowLines(lastUsageRows, now);
    const profileLines = renderProfileLines(lastProfileRows, now);
    let bodyLines: string[];
    if (usageLines.length > 0 && profileLines.length > 0) {
      bodyLines = [...usageLines, "", ...profileLines];
    } else if (usageLines.length > 0) {
      bodyLines = usageLines;
    } else {
      bodyLines = profileLines;
    }
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
    // On disconnect, clear every gate so the next first-paint always
    // emits — even if the post-reconnect snapshot matches the last
    // pre-disconnect row set (raw or rendered) byte-for-byte. The helper
    // emits one `disconnected` per torn-down connection regardless of
    // which subscription was carried on it, so we clear both streams'
    // gates uniformly — the next `result` on either side will repaint
    // the composed frame. The lifecycle source itself isn't part of the
    // detail bag, so we can't (and don't need to) discriminate per
    // collection here.
    if (event === "disconnected") {
      lastFrame = null;
      lastUsageRowsKey = null;
      lastProfileRowsKey = null;
    }
  }

  // Two independent single-collection subscriptions ride two connections
  // (one per `subscribeCollection` call). The dual-stream composition lives
  // in `emitFrame` — each `onRows` updates its own slice of state and the
  // composer renders against the latest-of-each. The two streams have
  // disjoint key spaces (usage `id` is the agentuse profile id; profiles
  // key is `config_dir`) so there is no row-to-row correlation to enforce
  // here.
  const usageHandle = subscribeCollection({
    sockPath,
    idPrefix: "usage",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "id", dir: "asc" },
    onRows: emitUsage,
    onLifecycle: emitLifecycle,
  });

  const profilesHandle = subscribeCollection({
    sockPath,
    idPrefix: "usage",
    collection: PROFILES_COLLECTION,
    limit: 0,
    sort: { column: "config_dir", dir: "asc" },
    onRows: emitProfiles,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
    // Stop the relative-time tick FIRST so it can't fire against a
    // disposed shell (refreshLive is no-op post-dispose, but skipping
    // the rendered-rows + lines-equal work is cleaner).
    clearInterval(tickHandle);
    // Terminal restoration before subscription teardown.
    liveShell.dispose();
    // Dispose BOTH subscription handles — leaking the second one would
    // leave a live `subscribeMulti` reconnect loop holding the event loop
    // open after exit.
    usageHandle.dispose();
    profilesHandle.dispose();
    log("...");
    log(`meta: ${metaSidecar}`);
    log(`lifecycle: ${lifecycleSidecar}`);
    log("...");
    process.exit(0);
  });
}

if (import.meta.main) {
  void main();
}
