#!/usr/bin/env bun
/**
 * `keeper jobs` — live jobs-list view over the keeper subscribe server.
 *
 * Sibling of `cli/board.ts` (epics-only) and `cli/git.ts` (git status).
 * Renders ONLY the bottom jobs list — one section per
 * `backend_exec_session_id` (tmux session) with nested sub-agent lines
 * — plus the persistent `[dead-letter:N]` warn banner and the `r`
 * replay-dead-letter key.
 *
 * Frame shape:
 *
 *   --- <session-a> ---
 *   {jobs whose backend_exec_session_id == session-a}
 *   --- <session-b> ---
 *   {jobs whose backend_exec_session_id == session-b}
 *   --- (no session) ---
 *   {jobs with null backend_exec_session_id}
 *
 * Sessions render in first-seen order (the wire order of the first job
 * that names each session). Each job row CAN be followed by its nested
 * sub-agent collapse lines (one per `(job_id, subagent_type)` group via
 * `collapseSubagentsByName`) — but those are COLLAPSE-BY-DEFAULT, shown
 * only when the job has been expanded in insert mode (see below). The
 * session headings mirror `cli/autopilot.ts`'s `--- current --- /
 * --- predicted ---` style: a heading is emitted ONLY when its section
 * is non-empty. An empty `jobs` map yields an empty body.
 *
 * Insert mode (`i` to enter, `Esc` to leave): a modal, job-local
 * navigation layer. While active the view CAPTURES the whole keyboard
 * (via `createViewShell`'s `captureKeys`), so the global frame-scrub /
 * copy / replay keys go inert and only Ctrl-C still quits. The whole UI
 * indents two spaces, EVERY job row gains a Nerd Font disclosure
 * triangle (`GLYPH_COLLAPSED`/`GLYPH_EXPANDED` — every row has SOMETHING
 * to disclose, since the backend-coords pill is itself
 * collapse-controlled), and the selected row is shown by a full-width
 * background highlight (no `> ` marker — the head line is prefixed with
 * `SELECTED_LINE_PREFIX`, which the view-shell paints as the highlight).
 * `j`/`k`/↓/↑ move the selection; space toggles the selected job's
 * collapse-controlled lines (`expanded` — the backend-coords pill and
 * sub-agent lines). The render state lives in `main` and is threaded
 * into `renderJobsBody` via `JobsRenderOptions`; a keypress re-emits the
 * stashed snapshot so the repaint is immediate.
 *
 * Sidecars + lifecycle / SIGINT / first-paint contract mirror the sibling
 * mains. Sidecar basenames key on `script: "jobs"` so files write to
 * `/tmp/keeper-jobs.<pid>.*` (state JSON + frame text + per-frame
 * unified diff against the previous emit) plus a session meta file at
 * `/tmp/keeper-jobs.<pid>.meta.txt`. Lifecycle events append to
 * `/tmp/keeper-jobs.<pid>.lifecycle.txt`.
 *
 * Persistent banner: the `[focus <session>:<win> %<pane>]` pill
 * (`src/board-render.ts:renderTmuxFocusPill`, `[focus: none]` floor)
 * COMPOSED with the `[dead-letter:N]` warn pill
 * (`renderDeadLetterPill`) is re-stamped on EVERY snapshot via
 * `liveShell.setStatus()` — done BEFORE the body byte-compare
 * short-circuit so both pills reflect every snapshot, even snapshots
 * whose body is byte-stable (the dead-letter count or the focused pane
 * can change independently of the rendered rows). `c` (copy) and `r`
 * (replay-dead-letter) share one banner-flash timer that restores the
 * composed persistent pill ~1.5s after a flash.
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
  permissionPromptPillSeg,
  pill,
  pillOrEmpty,
  planVerbLabel,
  renderDeadLetterPill,
  renderTmuxFocusPill,
  scheduledTaskLinesFor,
  sendReplayDeadLetterRpc,
  sessionTelemetryPillSeg,
  subagentLinesFor,
} from "../src/board-render";
import { resolveSockPath } from "../src/db";
import { createTmuxPaneOps } from "../src/exec-backend";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import { appendDiagnostic } from "../src/readiness-diagnostics";
import { resolveSnapshotMode, SnapshotCliMisuseError } from "../src/snapshot";
import type { ScheduledTask, SubagentInvocation } from "../src/types";
import { createViewShell, SELECTED_LINE_PREFIX } from "../src/view-shell";
import { buildParseOptions, VIEWER_FLAGS } from "./descriptor";

const HELP = `keeper jobs — live jobs list over the keeper subscribe server

Usage: keeper jobs [--sock <path>] [--snapshot | --watch] [--timeout <s>]

Flags:
  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --snapshot       Force one-shot snapshot mode (one frame + keeper-meta: line)
  --watch          Force the live subscribe stream even when piped
  --timeout <s>    Snapshot wait before the timeout escape (default ~2s)
  --help           Show this help

A non-TTY stdout (piped into an agent) auto-detects snapshot; a TTY gets the
live TUI. \`CI\` / \`TERM=dumb\` force snapshot.

TUI keys (TTY only):
  ←/h/k prev frame · →/l/j next · g oldest · G/End/Esc return to live
  c copy frame + sidecar paths · r replay oldest waiting dead-letter
  i insert mode · q/Ctrl-C quit
  Insert mode (job-local nav): j/k or ↓/↑ select · space expand/collapse the
  row's pane + sub-agent lines · v focus the job's tmux pane · Esc leaves.
  Other keys are inert in insert mode (Ctrl-C still quits).

Rows are grouped into \`--- <session> ---\` sections by backend_exec_session_id
(null-session jobs under \`--- (no session) ---\`), one row per live job. A
persistent [dead-letter:N] banner shows recoverable dropped hook events.
Examples:
  keeper jobs --snapshot       one frame, then exit (agent-friendly)
  keeper jobs | tail -1        just the latest snapshot line

Render shape, pills, sidecars, and the readiness gate are documented in the
cli/jobs.ts module header.
`;

const seg = (v: unknown): string => (v == null ? "" : String(v));

/**
 * Render one job-row line. Mirrors the closure that previously lived in
 * `cli/board.ts:main()` — lifted to module scope here so
 * `test/jobs.test.ts` can assert the row shape directly without standing
 * up the subscribe loop.
 *
 * Shape: `({cwd-basename}) {title} [{role}]? [{state}]?{[failed:<kind>]}?`
 * with the optional `[awaiting:<kind>]` segment dropped onto a continuation
 * line (two-space indent — same depth as the row's sub-agent lines, which
 * are appended by the caller via `subagentLinesFor`). The `(cwd)` prefix
 * is suppressed when `cwd` is null/empty; the role pill is suppressed
 * when `plan_verb` is null.
 *
 * The backend-coords pill (`[<tab> p<pane>]`, see {@link backendCoordsSeg})
 * is NOT rendered here — `renderJobsBody` emits it as part of the
 * collapse-controlled region so it appears only when the job is expanded
 * in insert mode (alongside sub-agent lines). The `[awaiting:<kind>]`
 * continuation line, by contrast, stays always-visible: an awaiting prompt
 * is something the human needs to see at a glance.
 *
 * fn-708 (T1, J2): the `[state]` pill is omit-default — `stopped` (a
 * session at rest, the common idle-worker case) renders NO pill; absence
 * ≡ `stopped` (the omit-default convention, documented in `keeper jobs
 * --help`). `working` / `ended` / `killed` still render verbatim.
 */
export function projectJobRow(row: Record<string, unknown>): string {
  const title = seg(row.title);
  const cwd = row.cwd == null ? "" : basename(String(row.cwd));
  const cwdSeg = cwd === "" ? "" : `(${cwd}) `;
  const role = planVerbLabel(row.plan_verb);
  const roleSeg = role == null ? "" : ` ${pill(role)}`;
  const awaiting = inputRequestPillSeg(
    row.last_input_request_at,
    row.last_input_request_kind,
  );
  // Schema v52 / fn-686: permission-prompt / elicitation awaiting pill,
  // always-visible alongside the input-request pill so a parked dialog
  // is visible at a glance even when the job row is collapsed in insert
  // mode.
  const awaitingPP = permissionPromptPillSeg(
    row.last_permission_prompt_at,
    row.last_permission_prompt_kind,
  );
  // Durable worktree-lane pill — always-visible (a stable launch-context
  // identity, NOT collapse-controlled like the backend pane pill). "" on a
  // serial / non-worktree job. Self-delimited with a leading space so it slots
  // between the role and state pills without a stray gap when absent.
  const worktree = worktreeLaneSeg(row);
  const worktreeSeg = worktree === "" ? "" : ` ${worktree}`;
  const head = `${cwdSeg}${title}${roleSeg}${worktreeSeg}${pillOrEmpty(row.state, "stopped")}${apiErrorPillSeg(row.last_api_error_at, row.last_api_error_kind)}${sessionTelemetryPillSeg(row)}`;
  // Continuation lines under the head, at the 2-space depth shared with
  // sub-agent lines. Only the always-visible `awaiting` pills ride here;
  // the backend-coords pill moved out to `renderJobsBody`'s
  // collapse-controlled region.
  const lines = [head];
  if (awaiting !== "") {
    lines.push(`  ${awaiting.trimStart()}`);
  }
  if (awaitingPP !== "") {
    lines.push(`  ${awaitingPP.trimStart()}`);
  }
  return lines.join("\n");
}

/**
 * Compose the backend-coords PILL for one jobs row: `[p<pane>]`.
 *
 * Session-less and type-less by design — the row is already grouped under
 * its `--- <session> ---` heading (see `renderJobsBody`), and the row is
 * already grouped by session, so the per-row pill
 * just identifies the pane within that session. Bracketed so
 * `colorizePillsInLine` tints it like the other status pills. (The tab
 * id/name slots were dropped in fn-710 T2 — their dead feed was reaped
 * and the columns are gone from the projection.)
 *
 * Fallbacks:
 *   - missing pane → `""` (nothing left worth showing).
 *
 * Emitted as plain text (no SGR codes baked in) — the pill colorizer
 * paints brackets at render time. Strings are bound from the projection;
 * never interpolated as SQL or shell.
 *
 * Exported for `test/jobs.test.ts`.
 */
export function backendCoordsSeg(row: Record<string, unknown>): string {
  const paneId = row.backend_exec_pane_id;
  const paneSeg = paneId == null ? "" : `p${String(paneId)}`;
  if (paneSeg === "") {
    return "";
  }
  return `[${paneSeg}]`;
}

/**
 * Compose the durable worktree-lane PILL for one jobs row: `[⑂ <lane>]` where
 * <lane> is the stored `jobs.worktree` branch with the `keeper/epic/` prefix
 * stripped (base lane `keeper/epic/fn-986` → `⑂ fn-986`; rib
 * `keeper/epic/fn-986--fn-986.2` → `⑂ fn-986--fn-986.2`). A NULL / empty
 * `worktree` (serial / non-worktree job) → `""` so the pill drops entirely,
 * never an empty bracket. Reuses `pill` so the bracket survives
 * `colorizePillsInLine` (the `⑂ <lane>` token is themeless, rendering uncolored
 * by design — same as the `[p<pane>]` coord pill). Exported for `test/jobs.test.ts`.
 */
export function worktreeLaneSeg(row: Record<string, unknown>): string {
  const branch = row.worktree;
  if (typeof branch !== "string" || branch === "") {
    return "";
  }
  const PREFIX = "keeper/epic/";
  const lane = branch.startsWith(PREFIX) ? branch.slice(PREFIX.length) : branch;
  return pill(`⑂ ${lane}`);
}

// Nerd Font disclosure-triangle glyphs (the human's call): caret-right
// for collapsed, caret-down for expanded. One cell each.
const GLYPH_COLLAPSED = "\uf0da"; // nf-fa-caret_right (U+F0DA) ▸
const GLYPH_EXPANDED = "\uf0d7"; // nf-fa-caret_down (U+F0D7) ▾

/**
 * Per-job live-monitor lines (schema v51 / fn-682, enriched fn-718). Reads
 * from the `jobs.monitors` JSON-array projection (snapshot-replace on each
 * Stop — see `src/reducer.ts:computeMonitors`); each entry is
 * `{id, kind, command?, description?}` where `kind` is the three-way
 * provenance label `monitor` / `bash-bg` / `ambient` (Monitor tool / Bash
 * `run_in_background` / plugin- or harness-armed).
 *
 * Output shape per entry (fn-718, task 1): a PRIMARY line
 * `<indent>[<kind>] <label>` where `<label>` is the entry's `description`
 * (falling back to its `id` when description is empty), and — ONLY when
 * `command` is non-empty — a CONTINUATION line at `<indent>    ` (four extra
 * spaces) carrying the command/script. The command is NOT the primary
 * label (avoid double-emit). An entry with no command renders a single
 * line (today's id-only fallback). A multi-line command (1KB+ heredocs
 * exist in the wild) collapses to the FIRST non-empty line so the
 * continuation row stays one terminal line tall.
 *
 * `status` is deliberately NOT rendered — empirically always `"running"`,
 * so the projection never carries it (fn-708 J7 precedent, fn-718 confirmed).
 *
 * Pure function of `monitorsJson` + `indent` — no SGR codes baked in
 * (the colorize-at-render convention; `colorizePillsInLine` paints
 * brackets at the view-shell layer). Malformed JSON folds to `[]`
 * (return value) so a bad projection blob can never crash the render
 * — matches the reducer's "safe value on malformed payload" stance.
 *
 * Exported for `test/jobs.test.ts`.
 */
export function monitorLinesFor(
  monitorsJson: unknown,
  indent: string,
): string[] {
  if (typeof monitorsJson !== "string" || monitorsJson === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(monitorsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return [];
  }
  const lines: string[] = [];
  for (const raw of parsed) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const e = raw as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind : "ambient";
    // Defensive lift of the enrichment fields (fn-718). A pre-fn-718 v51
    // monitors row lacks command/description → both fold to `""` and the
    // entry renders id-only, never throwing.
    const command = typeof e.command === "string" ? e.command : "";
    const description = typeof e.description === "string" ? e.description : "";
    const id = typeof e.id === "string" ? e.id : "";
    // PRIMARY line: `[kind] <description>` (fall back to id when the
    // description is empty). The command is NOT the primary label — it
    // goes on the continuation line below so we never double-emit it.
    const label =
      description !== "" ? description : id !== "" ? id : "(unknown)";
    lines.push(`${indent}${pill(kind)} ${label}`);
    // CONTINUATION line: the command/script on its own indented line,
    // emitted ONLY when command is non-empty. Truncate a multi-line
    // command to the first non-empty line — a 1KB+ heredoc must stay one
    // terminal row. `\r` normalized too so a CRLF payload is not exempt.
    const firstLine = command.split(/\r?\n/).find((s) => s.trim() !== "") ?? "";
    if (firstLine !== "") {
      lines.push(`${indent}    ${firstLine}`);
    }
  }
  return lines;
}

/**
 * Insert-mode render state, owned by `cli/jobs.ts:main` and threaded into
 * `renderJobsBody`. Absent → normal mode: rows render flush-left exactly
 * as before, EXCEPT sub-agent lines are collapse-by-default (shown only
 * when their job is in `expanded`).
 *
 * - `insertMode` — when true, every line gets a 2-space base indent,
 *   EVERY job row carries a disclosure column (collapsed / expanded
 *   triangle — the row always has SOMETHING to disclose, since the
 *   backend-coords pill is itself collapse-controlled), and the selected
 *   job's head line is prefixed with `SELECTED_LINE_PREFIX` (the
 *   view-shell paints it as a full-width background highlight).
 * - `selectedIndex` — index into the selectable job rows (sections
 *   concatenated in first-seen `backend_exec_session_id` order — the
 *   order `selectableJobIds` produces). Clamped to range inside
 *   `renderJobsBody` so a stale index from a since-shrunk list is safe.
 * - `expanded` — set of `job_id`s whose collapse-controlled lines (the
 *   backend-coords pill + sub-agent lines) are visible. The one piece of
 *   state that survives leaving insert mode.
 */
export interface JobsRenderOptions {
  insertMode: boolean;
  selectedIndex: number;
  expanded: Set<string>;
}

/**
 * Group jobs by tmux session in first-seen wire order — the LIVE
 * `backend_exec_session_id`, falling back to the forensic
 * `backend_exec_birth_session_id` when the live session is unresolved.
 * Jobs with a null/empty session id collect under the sentinel
 * `NO_SESSION_KEY`. Shared by `renderJobsBody` and `selectableJobIds`
 * so render order and selection order stay in lockstep.
 *
 * The return is an ordered Map keyed by the raw session id (or
 * `NO_SESSION_KEY`); values are arrays of `[job_id, row]` in wire
 * order. Re-folding the same `jobs` map produces a byte-identical
 * grouping — pure function of the input order.
 */
export const NO_SESSION_KEY = "\0no-session";

export function groupJobsBySession(
  jobs: Map<string, unknown>,
): Map<string, Array<[string, Record<string, unknown>]>> {
  const groups = new Map<string, Array<[string, Record<string, unknown>]>>();
  for (const [id, row] of jobs) {
    const r = row as Record<string, unknown>;
    const live = r.backend_exec_session_id;
    const sid =
      live != null && typeof live === "string" && live !== ""
        ? live
        : r.backend_exec_birth_session_id;
    const key =
      sid == null || typeof sid !== "string" || sid === ""
        ? NO_SESSION_KEY
        : sid;
    const arr = groups.get(key);
    if (arr === undefined) {
      groups.set(key, [[id, r]]);
    } else {
      arr.push([id, r]);
    }
  }
  return groups;
}

/**
 * The job rows insert-mode selection can land on, in render order
 * (one section per `backend_exec_session_id` in first-seen wire order,
 * with null-session jobs collected under `--- (no session) ---`).
 * Headings and sub-agent lines are NOT selectable. Shared by
 * `renderJobsBody` (to mark the selected row) and `cli/jobs.ts:main`'s
 * key handler (to clamp the selection and resolve the selected `job_id`
 * for space-to-expand) so the two never disagree on ordering.
 */
export function selectableJobIds(jobs: Map<string, unknown>): string[] {
  const out: string[] = [];
  for (const group of groupJobsBySession(jobs).values()) {
    for (const [id] of group) {
      out.push(id);
    }
  }
  return out;
}

/**
 * Render the full jobs body — one section per `backend_exec_session_id`
 * in first-seen wire order, each introduced by an autopilot-style heading
 * (`cli/autopilot.ts:renderBody`): `--- <session> ---`, or
 * `--- (no session) ---` for the bucket of jobs with a null/empty
 * session id. Grouping comes from {@link groupJobsBySession}, which is
 * also what {@link selectableJobIds} uses — render order and selection
 * order stay in lockstep by construction.
 *
 * Sub-agent lines, the live-monitors lines (schema v51 / fn-682), AND
 * the backend-coords pill are COLLAPSE-BY-DEFAULT: all three render
 * only when the job's `job_id` is in `render.expanded`. Wire order
 * inside the expanded region is `backendCoordsSeg` → monitors →
 * `subagentLinesFor`. Without a `render` arg (or with an empty
 * `expanded`) none of them show. The `[awaiting:<kind>]` continuation
 * line stays always-visible (it's emitted by `projectJobRow`).
 *
 * Insert-mode decoration (`render.insertMode === true`): every line gets
 * a 2-space base indent; EVERY job row carries a disclosure column
 * (`GLYPH_COLLAPSED`/`GLYPH_EXPANDED` — the caret shows even on jobs
 * with no sub-agents, because the pill itself is collapse-controlled);
 * the selected job row (`render.selectedIndex` into `selectableJobIds`)
 * has its head line prefixed with `SELECTED_LINE_PREFIX` for the
 * view-shell's full-width highlight.
 *
 * Heading-drop rule: a heading is emitted ONLY when its section has
 * rows. An empty `jobs` map yields `""`.
 */
export function renderJobsBody(
  jobs: Map<string, unknown>,
  subagentIndex: Map<string, SubagentInvocation[]>,
  scheduledTaskIndex: Map<string, ScheduledTask[]>,
  render?: JobsRenderOptions,
): string {
  if (jobs.size === 0) {
    return "";
  }
  const insertMode = render?.insertMode === true;
  const expanded = render?.expanded ?? new Set<string>();
  // Resolve the selected row by `job_id`, NOT by raw Map-iteration index —
  // `selectedIndex` indexes `selectableJobIds`, which walks
  // `groupJobsBySession` (sections concatenated in first-seen order). The
  // render loop below walks the SAME grouping, so the two orderings agree
  // by construction — but we still resolve the selected id up front so
  // each iteration is a simple `id === selectedId` check.
  const groups = groupJobsBySession(jobs);
  const selectableIds: string[] = [];
  for (const group of groups.values()) {
    for (const [id] of group) {
      selectableIds.push(id);
    }
  }
  const selectedId =
    selectableIds.length === 0
      ? undefined
      : selectableIds[
          Math.min(
            Math.max(render?.selectedIndex ?? 0, 0),
            selectableIds.length - 1,
          )
        ];

  // Insert-mode line prefixing. The selected row is shown by a full-width
  // background highlight (not a `> ` marker), so there is no selection
  // gutter — insert mode just adds a flat 2-space base indent to headings,
  // continuation lines, and sub-agent ("child") lines, and a 2-col
  // disclosure column to EVERY job row (a caret triangle — collapsed or
  // expanded; not gated on `hasChildren` anymore because the backend pill
  // itself is collapse-controlled, so every row has SOMETHING the caret
  // discloses). The selected job's HEAD line is prefixed with
  // `SELECTED_LINE_PREFIX`; the view-shell strips that and repaints the
  // row as a highlighted full-width line. Normal mode is a pass-through.
  const decorateHeadingOrChild = (line: string): string =>
    insertMode ? `  ${line}` : line;
  const decorateJobRow = (
    line: string,
    o: { isExpanded: boolean; isSelected: boolean },
  ): string => {
    if (!insertMode) {
      return line;
    }
    const tri = `${o.isExpanded ? GLYPH_EXPANDED : GLYPH_COLLAPSED} `;
    return `${o.isSelected ? SELECTED_LINE_PREFIX : ""}${tri}${line}`;
  };

  const sections: string[] = [];
  for (const [sessionKey, group] of groups) {
    const heading =
      sessionKey === NO_SESSION_KEY
        ? "--- (no session) ---"
        : `--- ${sessionKey} ---`;
    const blocks: string[] = [];
    for (const [id, r] of group) {
      const isExpanded = expanded.has(id);
      // `projectJobRow` may return a multi-line block: the head row plus
      // an always-visible `[awaiting:<kind>]` continuation line. Decorate
      // the head line as the job row; any continuations are decorated
      // like child lines so the whole block shares the insert-mode base
      // indent. The backend pill is NOT in projectJobRow's output any
      // more — it lives in the collapse-controlled region below.
      const [headLine = "", ...contLines] = projectJobRow(r).split("\n");
      const lines: string[] = [
        decorateJobRow(headLine, {
          isExpanded,
          isSelected: insertMode && id === selectedId,
        }),
        ...contLines.map(decorateHeadingOrChild),
      ];
      if (isExpanded) {
        const backend = backendCoordsSeg(r);
        if (backend !== "") {
          lines.push(decorateHeadingOrChild(`  ${backend}`));
        }
        // Schema v51 (fn-682): the live `Monitors` section — one line per
        // entry in `jobs.monitors` (snapshot-replace on each Stop). Sits
        // BETWEEN the backend-coords pill and the sub-agent lines inside
        // the same collapse-controlled region, in spec wire order
        // (`backendCoordsSeg` + monitors + `subagentLinesFor`). The
        // helper is a pure JSON-parse with `[]` fallback; a missing /
        // empty / malformed `monitors` value renders nothing here.
        for (const mon of monitorLinesFor(r.monitors, "  ")) {
          lines.push(decorateHeadingOrChild(mon));
        }
        for (const sub of subagentLinesFor(subagentIndex, id, "  ")) {
          lines.push(decorateHeadingOrChild(sub));
        }
        // Schema v68 (fn-813): the per-job scheduled-tasks (cron) section.
        // Established expanded-row order is backend pill -> monitors ->
        // sub-agents -> scheduled tasks, so this sits LAST. `r.state` is the
        // job-liveness authority for the spent/expired marking — a terminal
        // (`ended` / `killed`) session can never fire its crons again.
        const jobTerminal = r.state === "ended" || r.state === "killed";
        for (const line of scheduledTaskLinesFor(
          scheduledTaskIndex,
          id,
          "  ",
          jobTerminal,
        )) {
          lines.push(decorateHeadingOrChild(line));
        }
      }
      blocks.push(lines.join("\n"));
    }
    sections.push([decorateHeadingOrChild(heading), ...blocks].join("\n"));
  }
  return sections.join("\n");
}

export async function main(argv: string[]): Promise<void> {
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
      process.stderr.write(`keeper jobs: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Validate `--timeout` (seconds) only when snapshotting — a bad value is
  // CLI misuse (exit 2). Watch mode ignores it.
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      process.stderr.write(
        `keeper jobs: --timeout must be a positive number of seconds (got '${values.timeout}')\n`,
      );
      process.exit(2);
    }
    timeoutMs = Math.round(secs * 1000);
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
  // fn-952: the latest `tmux_client_focus` singleton row, refreshed in
  // `emitFrame` on every snapshot (BEFORE the body byte-compare short-circuit)
  // so the composed focus pill reflects every snapshot regardless of body
  // stability. `undefined` ⇒ `[focus: none]`.
  let tmuxFocus: ReadinessClientSnapshot["tmuxFocus"];
  // `colorEnabled` is owned by the view-shell, but we need the same
  // gate here to decide whether to colorize the banner pill text the
  // view-shell will hand back to us via `persistentBannerPill`. Same
  // condition the shell uses internally — kept in sync by construction
  // (this is the documented `createLiveShell` gate).
  const colorEnabled =
    process.stdout.isTTY === true &&
    process.stdin.isTTY === true &&
    process.env.NO_COLOR == null;
  // fn-952: the persistent banner composes the focus pill with the dead-letter
  // warn pill. The focus pill is ALWAYS present (`[focus: none]` floor); the
  // dead-letter pill drops to "" when the backlog is empty. Order: focus first,
  // then dead-letter (the actionable warn pill sits closest to the edge). The
  // ~1.5s flash-restore timer in `view-shell` calls THIS function, so both pills
  // rebuild on restore for free.
  function persistentBannerPill(): string {
    const focusRaw = renderTmuxFocusPill(tmuxFocus);
    const deadLetterRaw = renderDeadLetterPill(waitingDeadLetterCount);
    const raw =
      deadLetterRaw === "" ? focusRaw : `${focusRaw} ${deadLetterRaw}`;
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

  // `v` (insert mode only) — focus the selected job's tmux pane via the direct
  // `createTmuxPaneOps` seam (focusPane targets the server-global tmux ids the
  // hook stamps, so no per-row backend resolution is needed). Looks up the row
  // by `job_id` (the same resolution `space` uses for expand-toggle), reads
  // `backend_exec_session_id` / `backend_exec_pane_id`; a NULL session/pane →
  // flash `[no backend pane]` and exit before the seam call. `noteLine` funnels
  // backend warnings to the same lifecycle sidecar `view.noteLine` writes to.
  // Otherwise stamp `[focusing…]` via setStatus (persistent until
  // the RPC resolves — `flashStatus` would restore the banner too quickly),
  // then await `backend.focusPane(session, pane)` and flash the result
  // (`[focused]` / `[focus failed: <reason>]`). Single-flight guarded so a
  // mashed key never stacks RPCs against the backend.
  let focusInFlight = false;
  function handleFocusKey(): void {
    if (focusInFlight) {
      return;
    }
    if (lastSnap === null) {
      return;
    }
    const ids = selectableJobIds(
      lastSnap.jobs as unknown as Map<string, unknown>,
    );
    if (ids.length === 0) {
      return;
    }
    const id = ids[Math.min(Math.max(selectedIndex, 0), ids.length - 1)];
    if (id === undefined) {
      return;
    }
    const row = (
      lastSnap.jobs as unknown as Map<string, Record<string, unknown>>
    ).get(id);
    if (row == null) {
      return;
    }
    const sessionId = row.backend_exec_session_id;
    const paneId = row.backend_exec_pane_id;
    if (
      sessionId == null ||
      typeof sessionId !== "string" ||
      sessionId === "" ||
      paneId == null ||
      typeof paneId !== "string" ||
      paneId === ""
    ) {
      view.flashStatus("[no backend pane]");
      return;
    }
    // Direct tmux pane-ops seam: focusPane targets server-global tmux ids the
    // hook stamps, so it is backend-agnostic (no per-row `backend_exec_type`
    // resolution needed).
    const backend = createTmuxPaneOps({
      noteLine: (line: string) => {
        view.noteLine(line);
      },
    });
    focusInFlight = true;
    view.liveShell.setStatus("[focusing…]");
    void backend
      .focusPane(sessionId, paneId)
      .then(
        (result) => {
          if (result.ok) {
            view.flashStatus("[focused]");
          } else {
            view.noteLine(`# warn: backend focus-pane failed: ${result.error}`);
            const oneLine = result.error.split("\n", 1)[0] ?? result.error;
            view.flashStatus(`[focus failed: ${oneLine}]`);
          }
        },
        (err: Error) => {
          // Defense-in-depth — `focusPane` is documented never to throw,
          // but a future code path could. Treat the same as `ok: false`.
          view.noteLine(`# warn: backend focus-pane threw: ${err.message}`);
          const oneLine = err.message.split("\n", 1)[0] ?? err.message;
          view.flashStatus(`[focus failed: ${oneLine}]`);
        },
      )
      .finally(() => {
        focusInFlight = false;
      });
  }

  // Insert-mode state. Sub-agent lines are collapse-by-default; the
  // human enters a modal "insert mode" (`i`) to navigate job rows
  // (`j`/`k`/↑/↓), toggle a row's sub-agents (space), and leaves with
  // Escape. While in insert mode the view captures EVERY key (via
  // `captureKeys` below) so it's fully local to the job list — the
  // global frame-scrub / copy / replay keys go inert. `expanded` is the
  // only piece that survives leaving the mode. `lastSnap` is the most
  // recent snapshot, re-emitted on each keypress so a mode/selection/
  // expansion change repaints without waiting for the next daemon tick.
  let insertMode = false;
  let selectedIndex = 0;
  const expanded = new Set<string>();
  let lastSnap: ReadinessClientSnapshot | null = null;

  function reemit(): void {
    if (lastSnap !== null) {
      // Insert-mode nav/expand repaint: `repaintLocal` ships the body via a
      // live overlay so moving the selection cursor doesn't mint a history
      // frame (or a sidecar triple) on every keypress — selection is
      // ephemeral UI state, not a data frame.
      view.repaintLocal(lastSnap);
    }
  }

  // Handle a key while the insert-mode state machine owns it. Returns
  // `true` when the key was consumed (so the caller skips the normal-mode
  // `r` binding). Outside insert mode only `i` is consumed (to enter);
  // inside insert mode EVERY key is consumed — `escape`/nav/space act,
  // all others are swallowed so globals stay inert. Ctrl-C still quits
  // (the core handles it before it ever reaches here).
  function handleInsertKey(key: string): boolean {
    if (!insertMode) {
      if (key === "i") {
        insertMode = true;
        selectedIndex = 0;
        reemit();
        return true;
      }
      return false;
    }
    const ids = lastSnap
      ? selectableJobIds(lastSnap.jobs as unknown as Map<string, unknown>)
      : [];
    const maxIdx = Math.max(ids.length - 1, 0);
    switch (key) {
      case "escape":
        insertMode = false;
        break;
      case "up":
      case "k":
        selectedIndex = Math.max(0, selectedIndex - 1);
        break;
      case "down":
      case "j":
        selectedIndex = Math.min(maxIdx, selectedIndex + 1);
        break;
      case "space":
      case " ": {
        const id = ids[Math.min(Math.max(selectedIndex, 0), maxIdx)];
        if (id !== undefined) {
          if (expanded.has(id)) {
            expanded.delete(id);
          } else {
            expanded.add(id);
          }
        }
        break;
      }
      case "v":
        // Focus the selected job's tmux pane via `ExecBackend.focusPane`.
        // No re-emit needed — the visual feedback is the banner flash from
        // `handleFocusKey` itself; the row list shape is unchanged.
        handleFocusKey();
        return true;
      default:
        // Swallow — insert mode is local; everything else is inert.
        break;
    }
    reemit();
    return true;
  }

  // fn-660.1: lifecycle + sidecars + copy key + SIGINT moved into
  // `createViewShell` — see `src/view-shell.ts`. Jobs adds the
  // persistent `[dead-letter:N]` banner (via `persistentBannerPill`),
  // the `r` replay key, and the `i`-driven insert mode (via `onKey` +
  // `captureKeys`).
  const view = createViewShell<ReadinessClientSnapshot>({
    script: "jobs",
    title: "jobs",
    persistentBannerPill,
    // fn-772 snapshot branch: jobs is fed by a SINGLE handle
    // (`subscribeReadiness` → `emitFrame` → `view.emit`), so `streamCount:
    // 1`. The modal insert-mode `captureKeys` is irrelevant in snapshot
    // mode — `runSnapshot` never wires the key layer (no live shell).
    mode: mode === "snapshot" ? "snapshot" : "live",
    streamCount: 1,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    // Insert mode captures the whole keyboard so navigation is local to
    // the job list (frame-scrub / copy / replay suppressed).
    captureKeys: () => insertMode,
    onKey: (key) => {
      if (handleInsertKey(key)) {
        return;
      }
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
      // Per-frame `job_id -> ScheduledTask[]` index from the collection's
      // flat row stream (composite `(job_id, cron_id)` rows the wire pk would
      // otherwise collapse). `scheduledTaskLinesFor` does the deleted-filter,
      // ts/cron_id sort, and spent/expired marking, so this is a plain bucket.
      const scheduledTaskIndex = new Map<string, ScheduledTask[]>();
      for (const task of snap.scheduledTasks) {
        const arr = scheduledTaskIndex.get(task.job_id);
        if (arr === undefined) {
          scheduledTaskIndex.set(task.job_id, [task]);
        } else {
          arr.push(task);
        }
      }
      const body = renderJobsBody(
        snap.jobs as unknown as Map<string, unknown>,
        subagentIndex,
        scheduledTaskIndex,
        { insertMode, selectedIndex, expanded },
      );
      return {
        bodyLines: body === "" ? ["no jobs"] : body.split("\n"),
        // State JSON carries the inputs this view actually rendered
        // against — jobs (the row source), subagentInvocations + scheduledTasks
        // (the expanded-row nested-line sources), and the dead-letter backlog
        // (the banner source). Epics + gitStatus are excluded — jobs.ts doesn't
        // render them, so including them would bloat the sidecar
        // without aiding postmortem.
        stateJson: {
          jobs: Array.from(snap.jobs.values()),
          subagentInvocations: snap.subagentInvocations,
          scheduledTasks: snap.scheduledTasks,
          deadLetters: snap.deadLetters,
        },
      };
    },
  });

  function emitFrame(snap: ReadinessClientSnapshot): void {
    // Stash for keypress-driven re-emits (insert-mode nav/expand repaint
    // without waiting for the next daemon snapshot).
    lastSnap = snap;
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
    // fn-952: refresh the focus backing-store alongside the dead-letter count,
    // BEFORE the byte-compare short-circuit — the focus pill can change while
    // the rendered job rows stay byte-stable (a window switch never touches the
    // job list).
    tmuxFocus = snap.tmuxFocus;
    view.liveShell.setStatus(persistentBannerPill());
    view.emit(snap);
  }

  const handle = subscribeReadiness({
    sockPath,
    idPrefix: "jobs",
    onSnapshot: emitFrame,
    onLifecycle: view.emitLifecycle,
  });

  if (mode === "snapshot") {
    view.runSnapshot(() => handle.dispose());
  } else {
    view.installSigintHandler(() => handle.dispose());
  }
}

// `import.meta.main` guard neutralized — `cli/keeper.ts` is the
// canonical entry. Direct invocation via `bun cli/jobs.ts` would
// bypass the dispatcher's arg-pruning; if you really need it, run
// `bun cli/keeper.ts jobs <args>` instead.
