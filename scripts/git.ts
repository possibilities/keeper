#!/usr/bin/env bun
/**
 * keeper-git — watch the keeperd `git` collection as frames.
 *
 * The daemon-side git worker polls planctl-backed git worktrees and folds
 * synthetic `GitSnapshot` events into the `git` collection. This script is the
 * primitive frame UI for that surface, mirroring the sibling scripts' sidecars.
 *
 * Connection lifecycle is owned by `subscribeCollection` in
 * `src/readiness-client.ts` — same capped-backoff reconnect, per-collection
 * coalesce, steady-poll backstop, and `dispose()` contract as
 * `subscribeReadiness` (used by board.ts and autopilot.ts). The script's
 * job is rendering rows + writing sidecars; the helper handles everything
 * below the rows.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { buildDebugSnapshot, copyToClipboard } from "../src/clipboard-debug";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import { subscribeCollection } from "../src/readiness-client";

const COLLECTION = "git";

const HELP = `keeper-git — live git status frames over the keeper subscribe server

Usage: bun scripts/git.ts [--sock <path>] [--project-dir <path>]

  --sock <path>         Socket path override ($KEEPER_SOCK / default otherwise)
  --project-dir <path>  Filter to one git worktree root
  --help                Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  c copy current frame + sidecar paths to clipboard, q/Ctrl-C quit.
  Per-frame sidecars are indexed; lifecycle output is
  appended to /tmp/keeper-git.<pid>.lifecycle.txt. Session paths print
  on exit.

Rows show one planctl-backed git worktree, its dirty / orphan /
unattributed counts, and per-file source-badged attribution
(\`tool@<session>, bash@<session>, inferred@<session>\`). Files with
no attribution at all render as \`<orphan>\` in the attribution slot.
`;

function seg(v: unknown): string {
  return v == null ? "" : String(v);
}

/**
 * Approximate render width budget per file line — when the source-badged
 * attribution list would overflow this, the renderer truncates the trailing
 * entries into a `+N more` suffix. Empirical guideline from the task spec
 * (~100 chars per file line); tuned down a hair so the standard prefix
 * (`  path/to/file.ts [xy] `) plus 2-3 short labels fits in 100 cols.
 */
const MAX_ATTRIBUTION_LINE = 100;

/**
 * One entry in the per-file `attributions[]` array the reducer writes into
 * `git_status.dirty_files[].attributions`. See `RenderedAttribution` in
 * `src/reducer.ts`; this is the wire-side mirror with permissive types so
 * a malformed row from the read boundary degrades gracefully.
 */
interface AttributionEntry {
  session_id?: unknown;
  title?: unknown;
  state?: unknown;
  last_touch_at?: unknown;
  op?: unknown;
  source?: unknown;
}

/**
 * Short label for a session — the embedded job title (set by the
 * `TranscriptTitle` synthetic event or the SessionStart fallback) when
 * present, otherwise the session/job UUID. Mirrors the `title ?? job_id`
 * fallback that board.ts uses for `job_links` rendering.
 */
function attributionLabel(a: AttributionEntry): string {
  const title = seg(a.title);
  if (title.length > 0) return title;
  return seg(a.session_id);
}

/**
 * Compose one attribution badge: `<source>@<label>`. The source verb
 * (`tool` / `bash` / `inferred`) is the per-entry provenance — `tool`
 * from a Write/Edit/MultiEdit/NotebookEdit mutation event, `bash` from
 * the hook-stamped bash mutation deriver, `inferred` from the reducer's
 * mtime-bracket fallback pass.
 */
function attributionBadge(a: AttributionEntry): string {
  const source = seg(a.source);
  // Defensive fallback — the reducer constrains source to a closed enum,
  // but a malformed row from the read boundary should still render
  // something the human can interpret rather than the empty string.
  const verb = source.length > 0 ? source : "?";
  return `${verb}@${attributionLabel(a)}`;
}

/**
 * Render the attribution badges for one dirty file. Sort `last_touch_at`
 * descending so the most-recent mutation appears first. Cap the total
 * line width at `MAX_ATTRIBUTION_LINE` — when the joined badge list
 * exceeds that, truncate trailing entries and append `+N more`. Returns
 * the literal `<orphan>` token when no attributions exist (strict-mystery
 * semantic from the reducer's pass-4 orphan count).
 */
function renderAttributions(
  attributions: AttributionEntry[],
  prefixLen: number,
): string {
  if (attributions.length === 0) return "<orphan>";

  // Sort by `last_touch_at` desc. Defensive `Number(...) || 0` because
  // a malformed JSON entry from the read boundary could land as a string.
  const sorted = [...attributions].sort((a, b) => {
    const at = Number(a.last_touch_at) || 0;
    const bt = Number(b.last_touch_at) || 0;
    return bt - at;
  });

  const badges = sorted.map(attributionBadge);
  const budget = MAX_ATTRIBUTION_LINE - prefixLen;
  // Fast path: full list fits, no truncation needed.
  const fullJoin = badges.join(", ");
  if (fullJoin.length <= budget) return fullJoin;

  // Truncated path: keep adding badges while the running join + the
  // worst-case `+N more` suffix still fits the budget. `more` always
  // refers to the REMAINING badges; recompute the suffix per step.
  const kept: string[] = [];
  for (let i = 0; i < badges.length; i++) {
    const badge = badges[i];
    if (badge == null) continue;
    const tentative =
      kept.length === 0 ? badge : `${kept.join(", ")}, ${badge}`;
    const remaining = badges.length - (i + 1);
    const suffix = remaining > 0 ? `, +${remaining} more` : "";
    if (tentative.length + suffix.length > budget && kept.length > 0) {
      // Stop here — emit what we've already accepted plus a suffix for
      // every badge we DIDN'T include (badges.length - kept.length).
      const dropped = badges.length - kept.length;
      return `${kept.join(", ")}, +${dropped} more`;
    }
    kept.push(badge);
  }
  // Loop completed without truncating — shouldn't happen given the
  // fast-path check above, but the fallback is the full join.
  return kept.join(", ");
}

/**
 * Render the `git`-collection rows into the per-frame block list. Each row
 * with non-zero ahead / dirty / orphan counts produces one block; rows
 * with all zeroes are dropped (the empty-row filter matches the
 * pre-refactor behavior). Exported as `string[]` (one entry per kept
 * block) so the live-shell wrapper consumes lines, not a joined string;
 * the script's emit seam still joins with `\n` for stdout / sidecar
 * writes.
 *
 * Layout (file-centric, one line per dirty file with source-badged
 * multi-attribution):
 *
 *   (project) [branch +ahead -behind] dirty=N orphan=M unattributed=K
 *     path/to/file.ts [M ] tool@sess-a, bash@sess-b, inferred@sess-c
 *       ↳ renamed from path/to/orig.ts
 *     path/to/other.ts [??] <orphan>
 *
 * `dirty=` carries the project-wide dirty file count (`dirty_count`);
 * `orphan=` is the strict-mystery `orphaned_count` (files with zero
 * attributions); `unattributed=` is computed locally as the count of
 * dirty files whose attribution set contains no live session. Per-file
 * attributions ride on the `dirty_files[].attributions[]` JSON the
 * reducer writes — sorted `last_touch_at` desc, capped at
 * MAX_ATTRIBUTION_LINE with `+N more` truncation for dense lines.
 */
export function renderRowBlocks(rows: Record<string, unknown>[]): string[] {
  const blocks: string[] = [];
  for (const row of rows) {
    const dir = seg(row.project_dir);
    const name = basename(dir) || dir;
    const branch = row.branch == null ? "detached" : seg(row.branch);
    const aheadCount =
      typeof row.ahead === "number" && row.ahead > 0 ? row.ahead : 0;
    const ahead = aheadCount > 0 ? ` +${aheadCount}` : "";
    const behind =
      typeof row.behind === "number" && row.behind > 0 ? ` -${row.behind}` : "";
    const dirtyCount =
      typeof row.dirty_count === "number" ? row.dirty_count : 0;
    const orphanedCount =
      typeof row.orphaned_count === "number" ? row.orphaned_count : 0;
    if (aheadCount === 0 && dirtyCount === 0 && orphanedCount === 0) continue;

    const dirtyFiles = Array.isArray(row.dirty_files)
      ? (row.dirty_files as Record<string, unknown>[])
      : [];

    // Local unattributed count — dirty files whose attribution set
    // contains no live session (state ∈ {working, stopped}). The reducer
    // stamps this onto `jobs.git_unattributed_to_live_count`, but the
    // git_status row doesn't carry the scalar directly. We re-derive
    // from the per-file attributions so the header line stays a pure
    // function of the wire payload.
    const LIVE_STATES = new Set(["working", "stopped"]);
    let unattributedCount = 0;
    for (const file of dirtyFiles) {
      const atts = Array.isArray(file.attributions)
        ? (file.attributions as AttributionEntry[])
        : [];
      if (atts.length === 0) {
        unattributedCount++;
        continue;
      }
      let hasLive = false;
      for (const a of atts) {
        if (LIVE_STATES.has(seg(a.state))) {
          hasLive = true;
          break;
        }
      }
      if (!hasLive) unattributedCount++;
    }

    const lines = [
      `(${name}) [${branch}${ahead}${behind}] dirty=${dirtyCount} orphan=${orphanedCount} unattributed=${unattributedCount}`,
    ];

    // One line per dirty file: indented path + xy code + badge list.
    // Renames carry an extra `↳ renamed from <orig_path>` continuation
    // line so the rename-pair stays legible without bloating the
    // primary line. Attribution truncation budgets the primary line
    // only — continuations are short by construction.
    for (const file of dirtyFiles) {
      const xy = seg(file.xy).padEnd(2, " ");
      const path = seg(file.path);
      const atts = Array.isArray(file.attributions)
        ? (file.attributions as AttributionEntry[])
        : [];
      // Prefix is `  <path> [xy] ` — width drives the attribution
      // truncation budget below.
      const prefix = `  ${path} [${xy}] `;
      const attrText = renderAttributions(atts, prefix.length);
      lines.push(`${prefix}${attrText}`);
      const orig = seg(file.orig_path);
      if (orig.length > 0 && orig !== path) {
        lines.push(`    ↳ renamed from ${orig}`);
      }
    }

    blocks.push(lines.join("\n"));
  }
  return blocks;
}

/**
 * Top-level renderer — returns the frame body as one element per output
 * line, suitable for `liveShell.pushFrame`. Internally fans out via
 * `renderRowBlocks` (one multi-line block per non-empty worktree row),
 * joins those blocks with `\n`, then splits on `\n` so each individual
 * row becomes its own array element. The caller joins with `\n` for
 * stdout / sidecar / byte-compare.
 */
export function renderRowLines(rows: Record<string, unknown>[]): string[] {
  const body = renderRowBlocks(rows).join("\n");
  return body === "" ? [] : body.split("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      "project-dir": { type: "string" },
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
    title: "git",
    onUnhandledKey: (key) => onKey?.(key),
  });
  let lastFrame: string | null = null;
  let frameCount = 0;
  let lastRows: Record<string, unknown>[] = [];

  const prevFrameTmp = `/tmp/keeper-git.${process.pid}.prev.frame.txt`;
  const metaSidecar = `/tmp/keeper-git.${process.pid}.meta.txt`;
  // The alt-screen owns stdout; lifecycle events append here instead.
  const lifecycleSidecar = `/tmp/keeper-git.${process.pid}.lifecycle.txt`;

  // `c` copies a debug snapshot to the clipboard. See board.ts for the
  // shared shape — same payload, swap script name and sidecar paths.
  let copyStatusTimer: ReturnType<typeof setTimeout> | undefined;
  onKey = (key: string): void => {
    if (key !== "c") return;
    if (lastFrame == null) return;
    const payload = buildDebugSnapshot({
      script: "git",
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
    const sState = `/tmp/keeper-git.${process.pid}.state.${frameCount}.json`;
    const sFrame = `/tmp/keeper-git.${process.pid}.frame.${frameCount}.txt`;
    const sDiff = `/tmp/keeper-git.${process.pid}.diff.${frameCount}.txt`;
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
   * Helper-driven row callback. Renders the row list, byte-compares
   * against the last emit, and writes sidecars + stdout when the render
   * changes. The helper handles the first-paint gate, reconnect, and the
   * `meta`/`patch` refetch coalescer — by the time this fires, `rows`
   * carries the freshest `result` frame in wire order.
   */
  function emitFrame(rows: Record<string, unknown>[]): void {
    lastRows = rows;
    const bodyLines = renderRowLines(rows);
    const frameText = ["---", ...bodyLines].join("\n");
    if (frameText === lastFrame) return;
    frameCount += 1;
    liveShell.pushFrame(bodyLines);
    writeSidecars(frameText);
    lastFrame = frameText;
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
    // On disconnect, clear `lastFrame` so the next first-paint emits even
    // if the post-reconnect snapshot happens to match the last pre-
    // disconnect frame byte-for-byte. (The helper resets its own
    // collection state and re-gates first-paint behind a fresh `result`.)
    if (event === "disconnected") {
      lastFrame = null;
    }
  }

  const projectDir = values["project-dir"];
  const handle = subscribeCollection({
    sockPath,
    idPrefix: "git",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "project_dir", dir: "asc" },
    ...(projectDir === undefined
      ? {}
      : { filter: { project_dir: projectDir } }),
    onRows: emitFrame,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
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
