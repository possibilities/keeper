#!/usr/bin/env bun
/**
 * keeper-usage — watch the keeperd `usage` collection as frames.
 *
 * The daemon-side usage worker watches `~/.local/state/agentuse/<id>.json`
 * and folds synthetic `UsageSnapshot` / `UsageDeleted` events into the
 * `usage` collection. This script is the primitive frame UI for that
 * surface, mirroring `scripts/git.ts`'s sidecar discipline (per-frame
 * state JSON + frame text + unified diff under `/tmp/keeper-usage.<pid>.*`,
 * indexed meta sidecar, SIGINT teardown that prints sidecar paths).
 *
 * Connection lifecycle is owned by `subscribeCollection` in
 * `src/readiness-client.ts` — same capped-backoff reconnect, per-collection
 * coalesce, steady-poll backstop, and `dispose()` contract as
 * `scripts/git.ts`. The script's job is rendering rows + writing sidecars;
 * the helper handles everything below the rows.
 *
 * Reset cells render as minute-rounded humanized relative time
 * (`in 5d 21h`, `in 3h 5m`, `in 5m`, `now`, `2h 5m ago`) against the
 * current wall clock. For the live frame in
 * TUI mode a 30s tick re-renders via `liveShell.refreshLive` so the visible
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
window (session, week, and sonnet where present). Reset times render
as minute-rounded humanized relative time (\`in 5d 21h\` / \`in 1h 16m\`
/ \`in 5m\` / \`now\`). The live frame re-renders every 30s so countdowns
tick; historical scroll-back stays frozen at each frame's capture time.
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
 * not `1h 0m`. Suffix is `in <body>` for the future, `<body> ago` for
 * the past.
 *
 * `nowMs` is a parameter (not `Date.now()` baked in) so tests can drive
 * deterministic snapshots AND so the 30s tick can pass a fresh clock
 * read without `renderRowLines` doing any wall-clock IO of its own.
 */
function relTime(iso: string, nowMs: number): string {
  if (iso === "") return "";
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return iso;
  const diffMin = Math.round((target - nowMs) / 60000);
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
  return past ? `${body} ago` : `in ${body}`;
}

/**
 * Render the `usage`-collection rows into a stacked, indented block per
 * profile — a header line carrying the id chip + target/multiplier chip,
 * then one indented body line per quota window:
 *
 *   (claude-multi-3) [claude 20x]
 *                    session 16% (resets in 29m)
 *                    week    36% (resets in 4d 5h)
 *                    sonnet   8% (resets in 4d 5h)
 *
 * Body indent equals `wId + 1` so labels line up under the `[` of the
 * chip. Labels (`session` / `week` / `sonnet`) padEnd to the widest of
 * the labels ACTUALLY rendered across the row set — `sonnet` only joins
 * that pool when at least one row has `sonnet_week_percent` data, so a
 * sonnet-less screen still aligns pct values cleanly. Pct cells padStart
 * to the widest pct across every body line that will render (session,
 * week, and sonnet wherever present), so a `100%` in any row pushes a
 * matching column of right-aligned digits everywhere.
 *
 * The `(resets <rel>)` tail is unpadded — the closing `)` lands wherever
 * the rel-time text ends. The line above is the alignment grid.
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
    sPct: string;
    sReset: string;
    wPct: string;
    wReset: string;
    // null when this row's envelope carried no sonnet_week sub-object.
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
      sPct: pct(row.session_percent),
      sReset: relTime(seg(row.session_resets_at), nowMs),
      wPct: pct(row.week_percent),
      wReset: relTime(seg(row.week_resets_at), nowMs),
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
  const renderBody = (label: string, pctStr: string, rel: string): string =>
    `${indent}${label.padEnd(wLabel, " ")} ${pctStr.padStart(wPct, " ")} (resets ${rel})`;

  const lines: string[] = [];
  for (const c of cells) {
    const id = c.id.padStart(wId, " ");
    const targetChip =
      c.target === "" && c.mult === ""
        ? ""
        : `[${c.target.padEnd(wTarget, " ")} ${c.mult.padStart(wMult, " ")}x]`;
    lines.push(targetChip === "" ? id : `${id} ${targetChip}`);
    lines.push(renderBody("session", c.sPct, c.sReset));
    lines.push(renderBody("week", c.wPct, c.wReset));
    if (c.swPct != null) {
      lines.push(renderBody("sonnet", c.swPct, c.swReset));
    }
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
  let lastRows: Record<string, unknown>[] = [];
  // Projection-meaningful subset of the last emit. Gating `emitFrame` on
  // this — not on the rendered text — keeps a fetch-only refresh that
  // bumps `last_event_id` / `updated_at` from flapping a new frame, AND
  // keeps minute-tick relative-time bleed from forging one either. Cleared
  // on `disconnected` so a post-reconnect first emit always paints.
  let lastRowsKey: string | null = null;
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
    writeFileSync(sState, `${JSON.stringify(lastRows, null, 2)}\n`);
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
   * Stringify the projection-meaningful subset of the row set into a stable
   * hash key. `last_event_id` / `updated_at` are excluded on purpose — they
   * bump on every fetch-only refresh even when no rendered field changed —
   * and so is anything else the renderer doesn't read. Keeps the gate
   * insensitive to wall-clock-driven relative-time bleed too: the inputs
   * are raw ISO timestamps + percents, not the minute-rounded prose.
   */
  function rowsHashKey(rows: Record<string, unknown>[]): string {
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
   * Helper-driven row callback. Gates on the raw projection subset (see
   * {@link rowsHashKey}) — NOT on rendered text — so a fetch-only refresh
   * that bumps `last_event_id` / `updated_at` produces no new frame, and a
   * minute-boundary crossing between two same-data emits can't forge one
   * either. Rendering is still against `Date.now()` so the frozen
   * at-capture text in history reflects what was on screen the moment the
   * data landed; the 30s tick below keeps the live view ticking forward
   * via `refreshLive` without growing history.
   */
  function emitFrame(rows: Record<string, unknown>[]): void {
    const rowsKey = rowsHashKey(rows);
    if (rowsKey === lastRowsKey) return;
    lastRowsKey = rowsKey;
    lastRows = rows;
    const bodyLines = renderRowLines(rows, Date.now());
    const frameText = ["---", ...bodyLines].join("\n");
    frameCount += 1;
    liveShell.pushFrame(bodyLines);
    lastLiveLines = bodyLines;
    writeSidecars(frameText);
    lastFrame = frameText;
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
  // at-capture text. Skipped when there's no data yet OR when the render
  // hasn't changed (minute-rounding holds for most ticks). 30s gives the
  // worst-case half-minute lag on a minute boundary, which is plenty for
  // minute-precision display.
  const tickHandle = setInterval(() => {
    if (lastRows.length === 0) return;
    const bodyLines = renderRowLines(lastRows, Date.now());
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
    // On disconnect, clear both gates so the next first-paint always emits
    // — even if the post-reconnect snapshot matches the last pre-disconnect
    // row set (raw or rendered) byte-for-byte.
    if (event === "disconnected") {
      lastFrame = null;
      lastRowsKey = null;
    }
  }

  const handle = subscribeCollection({
    sockPath,
    idPrefix: "usage",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "id", dir: "asc" },
    onRows: emitFrame,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
    // Stop the relative-time tick FIRST so it can't fire against a
    // disposed shell (refreshLive is no-op post-dispose, but skipping
    // the rendered-rows + lines-equal work is cleaner).
    clearInterval(tickHandle);
    // Terminal restoration before subscription teardown.
    liveShell.dispose();
    handle.dispose();
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
