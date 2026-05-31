#!/usr/bin/env bun
/**
 * `keeper jobs` — live jobs-list view over the keeper subscribe server.
 *
 * Sibling of `cli/board.ts` (epics-only) and `cli/git.ts` (git status).
 * Renders ONLY the bottom jobs list — the ambient-vs-plan-bound two
 * partition stack with nested sub-agent lines — plus the persistent
 * `[dead-letter:N]` warn banner and the `r` replay-dead-letter key.
 *
 * Frame shape:
 *
 *   {ambient jobs body}    ← jobs with NO plan_verb (one row per job)
 *   ~~~
 *   {plan-bound jobs body} ← jobs WITH a plan_verb (planner/worker/closer)
 *
 * Each row is followed by its nested sub-agent collapse lines (one per
 * `(job_id, subagent_type)` group via `collapseSubagentsByName`). The
 * empty-side drop rule applies: a partition with zero rows yields just
 * the other one, no divider; both empty yields an empty body.
 *
 * Sidecars + lifecycle / SIGINT / first-paint contract mirror the sibling
 * mains. Sidecar basenames key on `script: "jobs"` so files write to
 * `/tmp/keeper-jobs.<pid>.*` (state JSON + frame text + per-frame
 * unified diff against the previous emit) plus a session meta file at
 * `/tmp/keeper-jobs.<pid>.meta.txt`. Lifecycle events append to
 * `/tmp/keeper-jobs.<pid>.lifecycle.txt`.
 *
 * Persistent banner: the `[dead-letter:N]` warn pill from
 * `src/board-render.ts:renderDeadLetterPill` is re-stamped on EVERY
 * snapshot via `liveShell.setStatus()` — done BEFORE the body
 * byte-compare short-circuit so the pill reflects every snapshot, even
 * snapshots whose body is byte-stable (the count can change
 * independently of the rendered rows). `c` (copy) and `r` (replay-
 * dead-letter) share one banner-flash timer that restores the
 * persistent pill ~1.5s after a flash.
 *
 * `r` (replay-dead-letter) runs `sendReplayDeadLetterRpc` on a SEPARATE
 * connection (the subscribe socket is read-only — RPCs ride their own
 * sockets per the approve.ts pattern). Single-flight guarded so a
 * mashed key never stacks RPCs.
 *
 * First-paint gate: `subscribeReadiness` is the five-collection helper
 * shared with `cli/board.ts`; the gate clears only once all five
 * collections have produced their first `result`. The jobs view doesn't
 * render epics or git, but waiting on them costs nothing in the empty
 * steady state (each empty collection still produces a `result` with
 * `rows: []`) and the shared helper is the only way in. Don't narrow
 * the gate — board needs all five.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import {
  apiErrorPillSeg,
  colorizePillsInLine,
  inputRequestPillSeg,
  planVerbLabel,
  renderDeadLetterPill,
  sendReplayDeadLetterRpc,
  subagentLinesFor,
} from "../src/board-render";
import { buildDebugSnapshot, copyToClipboard } from "../src/clipboard-debug";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import { appendDiagnostic } from "../src/readiness-diagnostics";
import type { SubagentInvocation } from "../src/types";

const HELP = `keeper jobs — live jobs list over the keeper subscribe server

Usage: keeper jobs [--sock <path>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --help           Show this help

Real TUI mode (alt-screen + keyboard nav) when stdout is a TTY. Keys:
  ←/h/k prev frame, →/l/j next, g oldest, G/End/Esc return to live,
  c copy current frame + sidecar paths to clipboard,
  r replay one oldest waiting dead-letter (recovers a dropped hook event),
  q/Ctrl-C quit.
  Per-frame sidecars are indexed; lifecycle + warn output is appended
  to /tmp/keeper-jobs.<pid>.lifecycle.txt. Session paths print on exit.

Renders one row per live job, split into two stacked partitions separated
by a '~~~' line:

  {ambient body}    (jobs with NO plan_verb — ad-hoc sessions)
  ~~~
  {plan-bound body} (jobs WITH a plan_verb — planner/worker/closer)

Row shape:

  ({basename(cwd)}) {title} [{role}]? [{state}]{[failed:<kind>]}?
    [awaiting:<kind>]?                     (continuation line, when present)
    {subagent_type}({annotations})?: {description} [{status}]   (per sub-agent)

The optional [awaiting:<kind>] pill drops to its own indented
continuation line beneath the row so a long-running interactive stop
reads without wrapping; [state] / [failed:<kind>] stay inline. Nested
sub-agent lines collapse same-name invocations within one job to a
single line representing the most-recent (max turn_seq) row; (×N) and
'N stuck' annotations surface the folded count and any non-surviving
'running' rows.

A persistent [dead-letter:N] warn pill stamps in the banner whenever the
daemon's dead_letters collection has waiting rows (events the hook
tried to write and couldn't insert; recoverable via 'r'). The pill
drops cleanly at N=0.

The first frame waits until ALL FIVE readiness collections have landed
their first result (the shared subscribeReadiness gate; jobs view
ignores epics/git/readiness but the gate is non-negotiable for the
shared helper). An empty section renders as NOTHING (no placeholder);
the '~~~' divider is dropped when either partition is empty. A new
frame prints only when the rendered body changes; the dead-letter
banner re-stamps on every snapshot regardless of body stability.

Sidecars: three indexed files per emitted frame
(/tmp/keeper-jobs.<pid>.state.<n>.json, .frame.<n>.txt, .diff.<n>.txt)
plus a session meta file at /tmp/keeper-jobs.<pid>.meta.txt accumulating
the index. Session paths print on exit.
`;

const seg = (v: unknown): string => (v == null ? "" : String(v));

/**
 * Render one job-row line. Mirrors the closure that previously lived in
 * `cli/board.ts:main()` — lifted to module scope here so
 * `test/jobs.test.ts` can assert the row shape directly without standing
 * up the subscribe loop.
 *
 * Shape: `({cwd-basename}) {title} [{role}]? [{state}]{[failed:<kind>]}?`
 * with the optional `[awaiting:<kind>]` segment dropped onto a continuation
 * line (two-space indent — same depth as the row's sub-agent lines, which
 * are appended by the caller via `subagentLinesFor`). The `(cwd)` prefix
 * is suppressed when `cwd` is null/empty; the role pill is suppressed
 * when `plan_verb` is null.
 */
export function projectJobRow(row: Record<string, unknown>): string {
  const title = seg(row.title);
  const cwd = row.cwd == null ? "" : basename(String(row.cwd));
  const cwdSeg = cwd === "" ? "" : `(${cwd}) `;
  const role = planVerbLabel(row.plan_verb);
  const roleSeg = role == null ? "" : ` [${role}]`;
  const awaiting = inputRequestPillSeg(
    row.last_input_request_at,
    row.last_input_request_kind,
  );
  const head = `${cwdSeg}${title}${roleSeg} [${seg(row.state)}]${apiErrorPillSeg(row.last_api_error_at, row.last_api_error_kind)}`;
  return awaiting === "" ? head : `${head}\n  ${awaiting.trimStart()}`;
}

/**
 * Render the full jobs body — two stacked partitions joined by `~~~`.
 * Top partition: jobs with NO `plan_verb` (ambient sessions). Bottom:
 * jobs WITH `plan_verb` (planner/worker/closer — epic-bound work).
 * Within each partition we preserve the helper's wire order (the
 * `Map<job_id, Job>` insertion order matches the server's row order),
 * and each row is followed by its `subagentLinesFor(..., "  ")` block.
 *
 * Empty-side drop rule: a partition with zero rows yields just the
 * other one with no divider; both empty yields `""`.
 */
export function renderJobsBody(
  jobs: Map<string, unknown>,
  subagentIndex: Map<string, SubagentInvocation[]>,
): string {
  if (jobs.size === 0) {
    return "";
  }
  const noRole: string[] = [];
  const withRole: string[] = [];
  for (const [id, row] of jobs) {
    const r = row as Record<string, unknown>;
    const block = [
      projectJobRow(r),
      ...subagentLinesFor(subagentIndex, id, "  "),
    ].join("\n");
    if (r.plan_verb == null) {
      noRole.push(block);
    } else {
      withRole.push(block);
    }
  }
  const top = noRole.join("\n");
  const bottom = withRole.join("\n");
  if (top === "") {
    return bottom;
  }
  if (bottom === "") {
    return top;
  }
  return `${top}\n~~~\n${bottom}`;
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
  // Readiness diagnostics JSONL log — same sibling location as board.ts /
  // autopilot.ts (POSIX O_APPEND under PIPE_BUF gives atomicity, no flock).
  const diagnosticsLogPath = join(
    dirname(sockPath),
    "readiness-diagnostics.jsonl",
  );
  const log = (s: string) => process.stdout.write(`${s}\n`);
  // Forward-reference slot for the `c` / `r` key handler — wired further
  // down once the in-scope state (lastFrameText, sidecar paths, noteLine,
  // banner-flash timer) is in scope.
  let onKey: ((key: string) => void) | undefined;
  const liveShell = createLiveShell({
    enabled: true,
    title: "jobs",
    onUnhandledKey: (key) => onKey?.(key),
  });
  let frameCount = 0;

  // Color is for human eyes on a TTY. Pipes / redirects / NO_COLOR stay
  // plain so consumers (grep, diff, `tee` to a file) see clean text.
  // Sidecars are ALWAYS plain — only the lines passed to `pushFrame`
  // pass through the colorizer.
  const colorEnabled =
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true &&
    process.env.NO_COLOR == null;

  // `lastBody` byte-compares the rendered body — internal row churn that
  // doesn't surface in the render is invisible by design. Cleared on
  // disconnect so the next first-paint always emits.
  let lastBody: string | null = null;

  // Persistent banner pill backing-store: the latest waiting dead-letter
  // count from the readiness snapshot. Refreshed in `emitFrame` on every
  // snapshot, BEFORE the body byte-compare short-circuit, so the pill
  // reflects every snapshot regardless of body stability.
  let waitingDeadLetterCount = 0;
  function persistentBannerPill(): string {
    const raw = renderDeadLetterPill(waitingDeadLetterCount);
    if (raw === "") {
      return "";
    }
    return colorEnabled ? colorizePillsInLine(raw) : raw;
  }

  /**
   * Render the body lines for one snapshot — pure function of (jobs map,
   * per-frame subagent index). Returns one element per output line so the
   * live-shell can consume lines (per-line ANSI diff). The caller joins
   * with `\n` for stdout / sidecar / byte-compare.
   */
  function renderBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string[] {
    const body = renderJobsBody(
      snap.jobs as unknown as Map<string, unknown>,
      subagentIndex,
    );
    return body === "" ? [] : body.split("\n");
  }

  // Internal scratch path for the previous frame text — fed to `diff -u`
  // as its "before" file. Overwritten each tick; not surfaced in meta.
  const prevFrameTmp = `/tmp/keeper-jobs.${process.pid}.prev.frame.txt`;
  // Session-level meta file: one tab-separated line per frame.
  const metaSidecar = `/tmp/keeper-jobs.${process.pid}.meta.txt`;
  // Alt-screen owns stdout; lifecycle / warn output appends here instead.
  const lifecycleSidecar = `/tmp/keeper-jobs.${process.pid}.lifecycle.txt`;
  const noteLine = (s: string): void => {
    try {
      appendFileSync(lifecycleSidecar, `${s}\n`);
    } catch {
      // best-effort — the sidecar is observational
    }
  };
  // In-memory copy of the last emitted frame's text (lead + body), used
  // as the "before" side of the per-frame unified diff. `null` until the
  // first frame lands (sentinel written instead).
  let lastFrameText: string | null = null;

  function writeSidecars(
    snap: ReadinessClientSnapshot,
    frameText: string,
  ): void {
    const sState = `/tmp/keeper-jobs.${process.pid}.state.${frameCount}.json`;
    const sFrame = `/tmp/keeper-jobs.${process.pid}.frame.${frameCount}.txt`;
    const sDiff = `/tmp/keeper-jobs.${process.pid}.diff.${frameCount}.txt`;
    // State JSON carries the inputs this view actually rendered against —
    // jobs (the row source), subagentInvocations (the nested-line source),
    // and the dead-letter backlog (the banner source). Epics + gitStatus
    // are excluded — jobs.ts doesn't render them, so including them would
    // bloat the sidecar without aiding postmortem.
    const stateJson = {
      jobs: Array.from(snap.jobs.values()),
      subagentInvocations: snap.subagentInvocations,
      deadLetters: snap.deadLetters,
    };
    try {
      writeFileSync(sState, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      noteLine(`# warn: sidecar write failed: ${(err as Error).message}`);
    }
    // Per-frame unified diff against the previous emit. `diff -u` exits 1
    // when files differ — expected here (we only get here when the body
    // changed), so we ignore the exit code and take stdout.
    let diffText: string;
    if (lastFrameText == null) {
      diffText = "# first frame — no previous to diff against\n";
    } else {
      try {
        writeFileSync(prevFrameTmp, `${lastFrameText}\n`);
        const proc = Bun.spawnSync({
          cmd: ["diff", "-u", prevFrameTmp, sFrame],
        });
        diffText = proc.stdout.toString();
        if (diffText.length === 0) {
          diffText = "# diff: no textual difference\n";
        }
      } catch (err) {
        diffText = `# diff failed: ${(err as Error).message}\n`;
      }
    }
    try {
      writeFileSync(sDiff, diffText);
    } catch (err) {
      noteLine(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    try {
      appendFileSync(
        metaSidecar,
        `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
      );
    } catch (err) {
      noteLine(`# warn: meta write failed: ${(err as Error).message}`);
    }
    lastFrameText = frameText;
  }

  /**
   * Helper-driven snapshot callback. Drains readiness diagnostics,
   * re-stamps the persistent dead-letter banner BEFORE the body
   * byte-compare (count can change while the body is byte-stable),
   * builds the per-frame `job_id → invocations` index, renders the body,
   * and writes sidecars + stdout when the render changes. The helper's
   * five-collection gate guarantees `snap` is fully populated when we
   * get here.
   */
  function emitFrame(snap: ReadinessClientSnapshot): void {
    for (const d of snap.readiness.diagnostics) {
      appendDiagnostic(d, diagnosticsLogPath);
    }
    // Refresh the persistent banner pill BEFORE the body-stability
    // short-circuit — the dead-letter count can change independently of
    // the body (a new waiting row landing while the jobs render stays
    // byte-stable). Always re-stamp so the pill reflects every snapshot.
    // `setStatus` is itself a no-op when the string is unchanged.
    waitingDeadLetterCount = snap.deadLetters.length;
    liveShell.setStatus(persistentBannerPill());
    // Per-frame `job_id → invocations` index — re-entrant sub-agents
    // within one session sit on the same `job_id` bucket, ordered by
    // `turn_seq asc` so the nested list reads in invocation order. The
    // projection promotes `superseded` natively (task fn-605.2) so no
    // client-side marking pass is required.
    const subagentIndex = new Map<string, SubagentInvocation[]>();
    for (const inv of snap.subagentInvocations) {
      const arr = subagentIndex.get(inv.job_id);
      if (arr === undefined) {
        subagentIndex.set(inv.job_id, [inv]);
      } else {
        arr.push(inv);
      }
    }
    for (const arr of subagentIndex.values()) {
      arr.sort((a, b) => a.turn_seq - b.turn_seq);
    }
    const bodyLines = renderBody(snap, subagentIndex);
    const body = bodyLines.join("\n");
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    frameCount += 1;
    const frameText = ["---", ...bodyLines].join("\n");
    // Only lines shipped to the screen pick up SGR coloring. Gated on
    // TTY + NO_COLOR so piped/redirected output stays clean. `---` is
    // kept in frameText for sidecars/non-TTY but not passed to the shell.
    const linesForShell = colorEnabled
      ? bodyLines.map(colorizePillsInLine)
      : bodyLines;
    liveShell.pushFrame(linesForShell);
    writeSidecars(snap, frameText);
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
    // On disconnect clear `lastBody` so the next first-paint emits even
    // if the post-reconnect snapshot matches the last pre-disconnect
    // body byte-for-byte. (The helper resets its own collection state
    // and re-gates first-paint behind a fresh five-collection set.)
    if (event === "disconnected") {
      lastBody = null;
    }
  }

  // Shared banner-flash timer. `c` (copy) and `r` (replay-dead-letter)
  // both push a transient `[...]` status pill into the banner via
  // `setStatus`; this single timer restores the persistent
  // `[dead-letter:N]` (or empty) pill after the flash window. One timer
  // (vs. per-key) means a fresh flash from EITHER key cancels a
  // still-pending restore from the OTHER — last-flash-wins, no leaked
  // banner state.
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleFlashRestore(): void {
    if (flashTimer !== undefined) {
      clearTimeout(flashTimer);
    }
    flashTimer = setTimeout(() => {
      flashTimer = undefined;
      liveShell.setStatus(persistentBannerPill());
    }, 1500);
  }

  // `c` copies a debug snapshot (current frame + sidecar paths) to the
  // clipboard via `pbcopy`. Flashes `[copied frame N]` / `[copy failed]`
  // in the banner via setStatus; the shared flash-restore timer puts
  // the persistent dead-letter pill back after ~1.5s. Skipped silently
  // before the first frame lands.
  function handleCopyKey(): void {
    if (lastFrameText == null) {
      return;
    }
    const payload = buildDebugSnapshot({
      script: "jobs",
      pid: process.pid,
      frame: lastFrameText,
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
        noteLine(`# warn: clipboard copy failed: ${res.error}`);
        liveShell.setStatus("[copy failed]");
      }
      scheduleFlashRestore();
    });
  }

  // `r` recovers ONE oldest waiting dead-letter via the
  // `replay_dead_letter` RPC over a fresh short-lived UDS connection
  // (the subscribe socket is read-only; the RPC rides a SEPARATE
  // connection per the approve.ts pattern). Flashes `[replaying…]`
  // immediately, then `[recovered <dl_id>]` / `[nothing to replay]` /
  // `[replay failed: <reason>]` on the RPC reply. A single-flight guard
  // suppresses double-fires while a replay is in flight — the keypress
  // would otherwise stack pending RPCs. The persistent `[dead-letter:N]`
  // pill drops on the next frame (the recovered row leaves the waiting
  // page); the recovered session appears via its `events`-side fold.
  let replayInFlight = false;
  function handleReplayKey(): void {
    if (replayInFlight) {
      // Already a replay in flight — refuse silently rather than queue
      // another. The flash timer will restore the banner soon enough.
      return;
    }
    replayInFlight = true;
    liveShell.setStatus("[replaying…]");
    // Do NOT schedule the flash restore yet — the `[replaying…]` pill
    // must persist until the RPC resolves. The reply path schedules
    // the restore AFTER stamping the final flash text.
    void sendReplayDeadLetterRpc(sockPath)
      .then(
        (result) => {
          if (result.recovered_dl_id === null) {
            liveShell.setStatus("[nothing to replay]");
          } else {
            liveShell.setStatus(`[recovered ${result.recovered_dl_id}]`);
          }
          scheduleFlashRestore();
        },
        (err: Error) => {
          noteLine(`# warn: dead-letter replay failed: ${err.message}`);
          // Trim a possibly-multiline error message into a single
          // banner-safe segment. The full message lives in the
          // lifecycle sidecar via the noteLine above.
          const oneLine = err.message.split("\n", 1)[0] ?? err.message;
          liveShell.setStatus(`[replay failed: ${oneLine}]`);
          scheduleFlashRestore();
        },
      )
      .finally(() => {
        replayInFlight = false;
      });
  }

  onKey = (key: string): void => {
    if (key === "c") {
      handleCopyKey();
      return;
    }
    if (key === "r") {
      handleReplayKey();
      return;
    }
  };

  const handle = subscribeReadiness({
    sockPath,
    idPrefix: "jobs",
    onSnapshot: emitFrame,
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

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/jobs.ts` would
// bypass the dispatcher's arg-pruning; if you really need it, run
// `bun cli/keeper.ts jobs <args>` instead.
