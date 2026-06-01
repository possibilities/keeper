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
 *   --- interactive ---
 *   {ambient jobs body}    ← jobs with NO plan_verb (one row per job)
 *   --- autopilot ---
 *   {plan-bound jobs body} ← jobs WITH a plan_verb (planner/worker/closer)
 *
 * Each row is followed by its nested sub-agent collapse lines (one per
 * `(job_id, subagent_type)` group via `collapseSubagentsByName`). The
 * `--- interactive ---` / `--- autopilot ---` headings mirror
 * `cli/autopilot.ts`'s `--- current --- / --- predicted ---` style: a
 * heading is emitted ONLY when its section is non-empty. A partition
 * with zero rows yields neither its heading nor a placeholder; both
 * empty yields an empty body.
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
import { resolveSockPath } from "../src/db";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import { appendDiagnostic } from "../src/readiness-diagnostics";
import type { SubagentInvocation } from "../src/types";
import { createViewShell } from "../src/view-shell";

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

Renders one row per live job, split into two stacked partitions each
introduced by an autopilot-style heading:

  --- interactive ---
  {ambient body}    (jobs with NO plan_verb — ad-hoc sessions)
  --- autopilot ---
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
shared helper). An empty section renders as NOTHING — neither its
heading nor a placeholder — when its partition is empty. A new
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
 * Render the full jobs body — two stacked partitions, each introduced by
 * an autopilot-style heading (`cli/autopilot.ts:renderBody`). Top
 * partition `--- interactive ---`: jobs with NO `plan_verb` (ambient
 * sessions). Bottom partition `--- autopilot ---`: jobs WITH `plan_verb`
 * (planner/worker/closer — epic-bound work). Within each partition we
 * preserve the helper's wire order (the `Map<job_id, Job>` insertion
 * order matches the server's row order), and each row is followed by its
 * `subagentLinesFor(..., "  ")` block.
 *
 * Heading-drop rule (mirrors autopilot): a heading is emitted ONLY when
 * its partition has rows. A partition with zero rows yields neither its
 * heading nor a placeholder; both empty yields `""`.
 */
export function renderJobsBody(
  jobs: Map<string, unknown>,
  subagentIndex: Map<string, SubagentInvocation[]>,
): string {
  if (jobs.size === 0) {
    return "";
  }
  const interactive: string[] = [];
  const autopilot: string[] = [];
  for (const [id, row] of jobs) {
    const r = row as Record<string, unknown>;
    const block = [
      projectJobRow(r),
      ...subagentLinesFor(subagentIndex, id, "  "),
    ].join("\n");
    if (r.plan_verb == null) {
      interactive.push(block);
    } else {
      autopilot.push(block);
    }
  }
  const sections: string[] = [];
  if (interactive.length > 0) {
    sections.push(["--- interactive ---", ...interactive].join("\n"));
  }
  if (autopilot.length > 0) {
    sections.push(["--- autopilot ---", ...autopilot].join("\n"));
  }
  return sections.join("\n");
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
  // Persistent banner pill backing-store: the latest waiting dead-letter
  // count from the readiness snapshot. Refreshed in `emitFrame` on every
  // snapshot, BEFORE the body byte-compare short-circuit, so the pill
  // reflects every snapshot regardless of body stability.
  let waitingDeadLetterCount = 0;
  // `colorEnabled` is owned by the view-shell, but we need the same
  // gate here to decide whether to colorize the banner pill text the
  // view-shell will hand back to us via `persistentBannerPill`. Same
  // condition the shell uses internally — kept in sync by construction
  // (this is the documented `createLiveShell` gate).
  const colorEnabled =
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true &&
    process.env.NO_COLOR == null;
  function persistentBannerPill(): string {
    const raw = renderDeadLetterPill(waitingDeadLetterCount);
    if (raw === "") {
      return "";
    }
    return colorEnabled ? colorizePillsInLine(raw) : raw;
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
  //
  // `[replaying…]` is stamped via `liveShell.setStatus` directly (not
  // `flashStatus`) so the pill persists until the RPC resolves —
  // `flashStatus` would schedule the restore immediately. The reply
  // path uses `view.flashStatus` for the terminal text so the persistent
  // dead-letter pill returns after the 1.5s window.
  let replayInFlight = false;
  function handleReplayKey(): void {
    if (replayInFlight) {
      // Already a replay in flight — refuse silently rather than queue
      // another. The flash timer will restore the banner soon enough.
      return;
    }
    replayInFlight = true;
    view.liveShell.setStatus("[replaying…]");
    void sendReplayDeadLetterRpc(sockPath)
      .then(
        (result) => {
          if (result.recovered_dl_id === null) {
            view.flashStatus("[nothing to replay]");
          } else {
            view.flashStatus(`[recovered ${result.recovered_dl_id}]`);
          }
        },
        (err: Error) => {
          view.noteLine(`# warn: dead-letter replay failed: ${err.message}`);
          // Trim a possibly-multiline error message into a single
          // banner-safe segment. The full message lives in the
          // lifecycle sidecar via the noteLine above.
          const oneLine = err.message.split("\n", 1)[0] ?? err.message;
          view.flashStatus(`[replay failed: ${oneLine}]`);
        },
      )
      .finally(() => {
        replayInFlight = false;
      });
  }

  // fn-660.1: lifecycle + sidecars + copy key + SIGINT moved into
  // `createViewShell` — see `src/view-shell.ts`. Jobs adds the
  // persistent `[dead-letter:N]` banner (via `persistentBannerPill`)
  // and the `r` replay key (via `onKey`).
  const view = createViewShell<ReadinessClientSnapshot>({
    script: "jobs",
    title: "jobs",
    persistentBannerPill,
    onKey: (key) => {
      if (key === "r") {
        handleReplayKey();
      }
    },
    renderBody: (snap) => {
      // Per-frame `job_id → invocations` index — re-entrant sub-agents
      // within one session sit on the same `job_id` bucket, ordered by
      // `turn_seq asc` so the nested list reads in invocation order.
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
      const body = renderJobsBody(
        snap.jobs as unknown as Map<string, unknown>,
        subagentIndex,
      );
      return {
        bodyLines: body === "" ? ["no jobs"] : body.split("\n"),
        // State JSON carries the inputs this view actually rendered
        // against — jobs (the row source), subagentInvocations (the
        // nested-line source), and the dead-letter backlog (the banner
        // source). Epics + gitStatus are excluded — jobs.ts doesn't
        // render them, so including them would bloat the sidecar
        // without aiding postmortem.
        stateJson: {
          jobs: Array.from(snap.jobs.values()),
          subagentInvocations: snap.subagentInvocations,
          deadLetters: snap.deadLetters,
        },
      };
    },
  });

  function emitFrame(snap: ReadinessClientSnapshot): void {
    for (const d of snap.readiness.diagnostics) {
      appendDiagnostic(d, diagnosticsLogPath);
    }
    // Refresh the persistent banner pill BEFORE the view-shell's body
    // byte-compare short-circuit — the dead-letter count can change
    // independently of the body (a new waiting row landing while the
    // jobs render stays byte-stable). Always re-stamp so the pill
    // reflects every snapshot. `setStatus` is itself a no-op when the
    // string is unchanged.
    waitingDeadLetterCount = snap.deadLetters.length;
    view.liveShell.setStatus(persistentBannerPill());
    view.emit(snap);
  }

  const handle = subscribeReadiness({
    sockPath,
    idPrefix: "jobs",
    onSnapshot: emitFrame,
    onLifecycle: view.emitLifecycle,
  });

  view.installSigintHandler(() => handle.dispose());
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/jobs.ts` would
// bypass the dispatcher's arg-pruning; if you really need it, run
// `bun cli/keeper.ts jobs <args>` instead.
