#!/usr/bin/env bun
/**
 * `keeper git` — watch the keeperd `git` collection as frames.
 *
 * Moved from `scripts/git.ts` as the early proof point of the OpenTUI
 * port (epic fn-646 task .2). The `main(argv: string[])` signature lets
 * the `cli/keeper.ts` dispatcher pass through subcommand argv directly;
 * the `import.meta.main` guard is neutralized — the dispatcher is the
 * canonical entry. The exported `renderRowBlocks` / `renderRowLines`
 * survive the move so `test/git.test.ts` continues to assert against
 * the same pure-function row layout.
 *
 * The daemon-side git worker polls plan-backed git worktrees and
 * folds synthetic `GitSnapshot` events into the `git` collection. This
 * is the primitive frame UI for that surface, mirroring the sibling
 * scripts' sidecars.
 *
 * Connection lifecycle is owned by `subscribeCollection` in
 * `src/readiness-client.ts` — same capped-backoff reconnect,
 * per-collection coalesce, steady-poll backstop, and `dispose()`
 * contract as `subscribeReadiness` (used by board.ts and autopilot.ts).
 * The script's job is rendering rows + writing sidecars; the helper
 * handles everything below the rows.
 */

import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  createFramesEmitter,
  defaultDiffFn,
  defaultFramesIo,
} from "../src/frames-emitter";
import { subscribeCollection } from "../src/readiness-client";
import { resolveSnapshotMode, SnapshotCliMisuseError } from "../src/snapshot";
import { createViewShell } from "../src/view-shell";
import { buildParseOptions, GIT_FLAGS } from "./descriptor";
import { parseDuration } from "./duration";

const COLLECTION = "git";

const HELP = `keeper git — live git status frames over the keeper subscribe server

Usage: keeper git [--sock <path>] [--project-dir <path>]
                  [--snapshot | --watch] [--timeout <dur>]

  --sock <path>         Socket path override ($KEEPER_SOCK / default otherwise)
  --project-dir <path>  Filter to one git worktree root
  --snapshot            Force one-shot snapshot mode (print one frame + a
                        machine-parseable keeper-meta: line, then exit) even
                        on a TTY
  --watch               Force the live subscribe stream even when piped
  --timeout <dur>       Snapshot wait before the timeout escape (default ~2s;
                        unit required, e.g. 500ms, 2s)
  --help                Show this help

By default, stdout that is NOT a TTY (piped into an agent) auto-detects
snapshot mode; a TTY gets the live TUI. \`CI\` / \`TERM=dumb\` force snapshot.

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  c copy current frame + sidecar paths to clipboard, q/Ctrl-C quit.
  Per-frame sidecars are indexed; lifecycle output is
  appended to /tmp/keeper-git.<pid>.lifecycle.txt. Session paths print
  on exit.

Rows show one plan-backed git worktree, its dirty / orphan /
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
  return body === "" ? ["no changes"] : body.split("\n");
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    // Derived from the pure-data descriptor (ADR 0008). parseArgs has no number
    // type — `timeout` is a string, validated manually below.
    options: buildParseOptions(GIT_FLAGS),
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // Resolve the run mode (flag > CI/TERM=dumb > stdout.isTTY !== true).
  // Both `--snapshot` and `--watch` → typed misuse error → exit 2.
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
      process.stderr.write(`keeper git: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Validate `--timeout` (shared duration grammar) only when snapshotting — a
  // bad value is CLI misuse (exit 2). Watch mode ignores it.
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const parsed = parseDuration(values.timeout);
    if (!parsed.ok) {
      process.stderr.write(`keeper git: --timeout ${parsed.message}\n`);
      process.exit(2);
    }
    timeoutMs = parsed.ms;
  }

  const sockPath = values.sock ?? resolveSockPath();
  const projectDir = values["project-dir"];

  await runGit({
    mode: mode === "snapshot" ? "snapshot" : "live",
    sockPath,
    ...(projectDir === undefined ? {} : { projectDir }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** Data-frame bound + `--prev-frame` seed for `keeper frames --view git`. */
export interface GitFramesConfig {
  maxFrames?: number | null;
  durationMs?: number | null;
  prevFrameText?: string | null;
}

export interface RunGitConfig {
  mode: "live" | "snapshot" | "frames";
  sockPath: string;
  projectDir?: string;
  timeoutMs?: number;
  frames?: GitFramesConfig;
}

/**
 * Drive the git viewer in `frames` mode — the entry `keeper frames --view git`
 * dispatch calls. Mirrors `runBoardFrames`: builds the prod frames emitter
 * (view `git`, `diff -u` seam, real sidecar IO, the caller's chunk bounds) and
 * hands it to the shared runner on its OWN flag grammar (`maxFrames` /
 * `durationMs` / `prevFrameText`), never `resolveSnapshotMode`.
 */
export async function runGitFrames(config: {
  sockPath?: string;
  projectDir?: string;
  maxFrames?: number | null;
  durationMs?: number | null;
  prevFrameText?: string | null;
}): Promise<void> {
  await runGit({
    mode: "frames",
    sockPath: config.sockPath ?? resolveSockPath(),
    ...(config.projectDir === undefined
      ? {}
      : { projectDir: config.projectDir }),
    frames: {
      maxFrames: config.maxFrames ?? null,
      durationMs: config.durationMs ?? null,
      prevFrameText: config.prevFrameText ?? null,
    },
  });
}

/**
 * Shared git-viewer runner. `main` drives it in `live` / `snapshot`;
 * `runGitFrames` drives it in `frames`. All three share ONE `subscribeCollection`
 * wiring so the row fold, sort, and diagnostics cannot drift between modes.
 */
export async function runGit(config: RunGitConfig): Promise<void> {
  const { mode, sockPath, projectDir, timeoutMs } = config;
  // Frames mode: build the prod emitter (view `git`, `diff -u` seam, real
  // sidecar IO, the caller's chunk bounds + `--prev-frame` seed). Inert in
  // live/snapshot.
  const framesEmitter =
    mode === "frames"
      ? createFramesEmitter({
          view: "git",
          writeStdout: (line) => void process.stdout.write(line),
          diffFn: defaultDiffFn,
          io: defaultFramesIo(),
          maxFrames: config.frames?.maxFrames ?? null,
          durationMs: config.frames?.durationMs ?? null,
          prevFrameText: config.frames?.prevFrameText ?? null,
        })
      : null;

  // fn-660.1: lifecycle + sidecars + copy key + SIGINT live in `createViewShell`.
  // fn-772 added the snapshot branch; fn-1161 adds the frames branch. Git is a
  // single-stream view, so `streamCount: 1`.
  const view = createViewShell<Record<string, unknown>[]>({
    script: "git",
    title: "git",
    renderBody: (rows) => ({
      bodyLines: renderRowLines(rows),
      stateJson: rows,
    }),
    mode,
    streamCount: 1,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(framesEmitter !== null
      ? {
          frames: {
            emitter: framesEmitter,
            durationMs: config.frames?.durationMs ?? null,
          },
        }
      : {}),
  });

  const handle = subscribeCollection({
    sockPath,
    idPrefix: "git",
    collection: COLLECTION,
    limit: 0,
    sort: { column: "project_dir", dir: "asc" },
    ...(projectDir === undefined
      ? {}
      : { filter: { project_dir: projectDir } }),
    onRows: (rows) => view.emit(rows),
    onLifecycle: view.emitLifecycle,
    // Thread the daemon fold cursor into the frames resume-cursor seam
    // (fn-1161). Inert in live/snapshot (the stored cursor is never read).
    onBootStatus: (boot) => view.noteCursor(String(boot.rev)),
  });

  if (mode === "snapshot") {
    view.runSnapshot(() => handle.dispose());
  } else if (mode === "frames") {
    view.runFrames(() => handle.dispose());
  } else {
    view.installSigintHandler(() => handle.dispose());
  }
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/git.ts` would
// bypass the dispatcher's arg-pruning; if you really need it, run
// `bun cli/keeper.ts git <args>` instead.
