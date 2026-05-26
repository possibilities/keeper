#!/usr/bin/env bun
/**
 * keeper-board — a combined "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`) that streams the epics + jobs +
 * subagent_invocations collections as one frame per change: each frame is
 * the epics body + a `~~~` divider line + the jobs body, both refreshed
 * under the same poll/connect lifecycle so they always show the same
 * wall-clock snapshot of the daemon. `subagent_invocations` rows feed the
 * readiness pill AND nest as indented `[<status>]` lines under the
 * matching job row (in both the embedded-in-epic context and the bottom
 * jobs list), stamping the raw 5-value projection enum
 * `running|ok|failed|unknown|superseded` verbatim (no client-side collapse
 * — `superseded` is promoted natively by the projection, see task fn-605.2),
 * keyed on `job_id` and ordered by `turn_seq asc`.
 *
 * Frame shape (one `---` lead per frame):
 *
 *   ---
 *   {epics body}     ← one block per epic, see `renderEpicBlock` below
 *   ~~~
 *   {jobs body}      ← one row per job, see `projectJobRow` below
 *
 * The jobs body itself is split into two stacked sub-lists separated by a
 * `~~~` line: jobs with NO `plan_verb` (ambient / ad-hoc sessions) on top,
 * jobs WITH a `plan_verb` (planner/worker/closer — epic/task-bound work) on
 * the bottom. So a fully-populated frame can carry TWO `~~~` lines — one
 * between epics and jobs, one inside the jobs section. The empty-side drop
 * rule (below) applies at both levels.
 *
 * Connection / poll / coalesce / first-paint lifecycle is owned by
 * `subscribeReadiness` in `src/readiness-client.ts`. The board is the
 * RENDERER: it owns the sidecar writes, the per-frame `job_id →
 * SubagentInvocation[]` index used to nest sub-agent lines under jobs,
 * the `lastBody` byte-compare that suppresses no-op frames, and the
 * stdout emit. The helper handles the all-three-strict first-paint
 * gate, the per-collection refetch coalesce, the capped-backoff
 * reconnect, the steady-poll backstop, and (load-bearing) reads
 * subagent_invocations through `state.rows` so re-entrant sub-agents
 * sharing one `job_id` all reach `computeReadiness`.
 *
 * Empty-section policy: an empty collection renders as NOTHING (no
 * placeholder text). The `~~~` divider is dropped when either side is
 * empty, so a single populated section reads as a clean block under the
 * `---` lead, and a frame with both sides empty is just the lead. The
 * same rule applies to the jobs section's internal split: if one of the
 * two job partitions is empty, the inner `~~~` is dropped and the
 * populated partition reads as a single flat list.
 *
 * Filters: this view uses the SERVER defaults for both collections — epics:
 * `status = 'open' AND approval != 'approved'`; jobs: live only
 * (`working + stopped`, terminal states hidden). That's the common-case
 * "board" view; for explicit filters drop down to a custom subscribe client.
 *
 * Sidecar / SIGINT semantics: THREE combined sidecar files (state JSON +
 * frame text + per-frame unified diff against the previous emit) overwritten
 * each frame. The diff is `diff -u prev current` via the system tool —
 * universally-readable unified-diff format; the first frame writes a
 * sentinel since there's no prior to diff. SIGINT calls the helper's
 * `dispose()` (which drops every subscription on the connection via a
 * bare `unsubscribe`) and exits.
 *
 * Usage:
 *   bun scripts/board.ts [--sock <path>]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --help           Show this help.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import { createLiveShell } from "../src/live-shell";
import { formatPill, type Verdict } from "../src/readiness";
import {
  type ReadinessClientSnapshot,
  subscribeReadiness,
} from "../src/readiness-client";
import type { JobLinkEntry, SubagentInvocation } from "../src/types";

const HELP = `keeper-board — combined epics + jobs UI over the keeper subscribe server

Usage: bun scripts/board.ts [--sock <path>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --live           Real TUI mode (alt-screen + keyboard nav).
                   When not a TTY, behaves as if --live was not set.
                   Keys: ←/h/k prev frame, →/l/j next, g oldest,
                         G/End/Esc return to live, q/Ctrl-C quit.
                   Each frame's sidecars are written to indexed paths
                   instead of overwriting, and a session meta file at
                   /tmp/keeper-board.<pid>.meta.txt accumulates the full
                   index (tab-separated: frame# state frame diff).
                   Per-frame paths and lifecycle events are NOT printed
                   to stdout in --live mode (the alt-screen would scroll
                   and corrupt the differ); lifecycle + warn output is
                   appended to /tmp/keeper-board.<pid>.lifecycle.txt
                   instead. The session paths are printed once on exit.
  --help           Show this help

Renders both views as one frame per change, each frame led by '---':

  ---
  {epics body}      (one block per epic, see epic-header format below)
  ~~~
  {jobs body}       (one row per job: {basename(cwd)} {title} [role] [state])

Each epic block opens with a header line of the form:

  ({dir}) {epic_number} {title} [#dep,#dep] [validated|unvalidated] [<readiness>]

followed (when the epic carries job_links) by one indented creator/refiner
line per linked session — '{title} [creator|refiner] [state] [limited]?'
(title falls back to {job_id} when the embedded title is null; the
[limited] pill appears when the session was rate-limited and the human
hasn't picked up since). Schema v21 denormalized title / state /
rate_limited_at off the linked jobs row at the reducer's write boundary,
so the same line shape renders for live, terminal, and off-page sessions
— no live-jobs join, no off-page fallback branch — then the task lines
(one per embedded task,
'{n}. {title} [#dep,#dep] [runtime_status] [worker_phase] [approval]' —
the three native pills side-by-side: planctl runtime status
'todo|in_progress|done|blocked', derived worker-phase binary 'open|done',
and approval 'approved|rejected|pending'), and a final "Quality audit and
close" line for the epic itself. The [validated] / [unvalidated] pill
reflects planctl's last_validated_at timestamp on the epic file — flipped
by 'planctl validate --epic <id>'.

Sub-agent invocations nest under their owning job row as one indented
line each — '{subagent_type}: {description} [<status>]' — where <status>
is the raw 5-value projection enum 'running|ok|failed|unknown|superseded'.
'superseded' is rendered verbatim (no hiding) so the audit trail of
re-entrant attempts stays visible.

The [<readiness>] pill is one of [ready], [completed], or
[blocked:<reason>] — a pure-function verdict computed by src/readiness.ts
from the (epics, jobs, subagent_invocations) snapshot. For tasks and the
close row the pill stamps onto the indented "[<id>]" reference line beneath
the header; for the epic header (which has no id line) it stamps at the
end of the header itself. The bracket payload carries the full reason
(including any "dep-on-task <upstream>" id) so blocked rows need no
separate continuation.

The jobs body is itself split into two stacked sub-lists separated by a '~~~'
line: jobs with NO plan_verb (ambient sessions) on top, jobs WITH a plan_verb
(planner/worker/closer — epic-bound work) on the bottom. A fully-populated
frame can therefore show two '~~~' lines (one between epics and jobs, one
inside the jobs section).

The first frame waits until ALL THREE collections have landed their first
result, so first paint is never half-empty AND the readiness pill is never
computed against a partial snapshot. An empty section renders as NOTHING
(no placeholder text); the ~~~ divider is dropped when either side is
empty (this applies to the inner jobs split too). The page is refetched on
every change signal and on a steady poll; a new frame prints only when the
combined rendered output changes. All three subscriptions ride one
connection; an epics-only change refetches only epics (and vice versa).
Every emitted frame is mirrored to three /tmp sidecar files (combined JSON
state, combined frame text, unified diff vs. the previous emit), whose
paths print in a ...-fenced note.

The client waits for keeperd to come up and reconnects across restarts
instead of exiting; each connection-lifecycle change prints a ...-fenced
note (event: connecting|connected|waiting|disconnected). Ctrl-C exits
cleanly.

This view uses the SERVER defaults for all three collections (epics: open +
not-yet-approved; jobs: live only; subagent_invocations: full per-job
timeline). For explicit per-collection filters write a small custom
subscribe client against src/protocol.ts.
`;

/**
 * Re-export `projectRows` from the helper so `test/board.test.ts` (and any
 * external consumers) can keep importing `projectRows` from the board entry.
 * The helper module is the canonical home; this re-export is a stability
 * shim. New code should import from `src/readiness-client` directly.
 */
export { projectRows } from "../src/readiness-client";

/** Approval enum vocabulary, mirrored from `src/plan-worker.ts:Approval`. */
const APPROVAL_VALUES = new Set(["approved", "rejected", "pending"]);

function approvalPill(v: unknown): string {
  if (typeof v === "string" && APPROVAL_VALUES.has(v)) {
    return v;
  }
  return "pending";
}

/**
 * Map the epic's `last_validated_at` to a `[validated]` / `[unvalidated]`
 * pill — mirrors `approvalPill`'s shape. The producer-side `asString`
 * (`src/plan-worker.ts`) already collapses empty-string / non-string values
 * to `null`, so the predicate is simply `v != null`. The pill string is
 * fixed (not the raw timestamp); a future task may add a sortable mode if
 * a use case appears.
 */
function validatedPill(v: unknown): "validated" | "unvalidated" {
  return v != null ? "validated" : "unvalidated";
}

/**
 * Map a plan_verb to its noun-form role label for the `[{role}]` pill.
 * Returns `null` when the input is null (the caller drops the pill).
 */
const PLAN_VERB_LABELS: Record<string, string> = {
  plan: "planner",
  work: "worker",
  close: "closer",
};

function planVerbLabel(v: unknown): string | null {
  if (v == null) {
    return null;
  }
  const s = typeof v === "string" ? v : "";
  return PLAN_VERB_LABELS[s] ?? s;
}

/**
 * Render the optional `[limited]` pill segment from a `jobs.rate_limited_at`
 * cell. The reducer stamps the column to a unix-seconds REAL on a synthetic
 * `RateLimited` fold and clears it to NULL on the next `UserPromptSubmit`
 * revival (see `src/reducer.ts`), so any non-null value means "this stoppage
 * was rate-limit-caused, the human hasn't picked up since the quota reset."
 * Returns the leading `' '` so the caller can append unconditionally — empty
 * string when the field is null, ` [limited]` otherwise. The underlying
 * lifecycle pill (`[stopped]`) is rendered separately from `jobs.state` and
 * always shows first; this annotation stacks after it.
 */
function rateLimitedPillSeg(v: unknown): string {
  return v == null ? "" : " [limited]";
}

function epicNumFromId(id: string): number | null {
  const m = /^[a-z]+-(\d+)-/.exec(id);
  return m ? Number.parseInt(m[1], 10) : null;
}

function taskNumFromId(id: string): number | null {
  const m = /\.(\d+)$/.exec(id);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Per-epic creator/refiner link lines, indented one level under the epic
 * header. Each {@link JobLinkEntry} carries five embedded fields
 * `{kind, job_id, title, state, rate_limited_at}` denormalized off the
 * linked `jobs` row at the reducer's write boundary (schema v21), so
 * the render reads every field straight off the projection — no
 * live-jobs join, no off-page fallback branch.
 *
 * The line shape is the same regardless of whether the linked session
 * is live, terminal, or off-page:
 *
 *     {title ?? job_id} [{kind}] [{state}]{rateLimitedPillSeg}
 *
 * Title falls back to `job_id` when the embedded `title` is null —
 * preserves the line shape when title is genuinely unknown (e.g. a
 * shell-inserted epic whose linked session has no captured title yet)
 * without dropping the readable label entirely.
 *
 * Iteration order is the projection's own `(kind, job_id)` ASC sort
 * (set by `sortJobLinks` in `src/reducer.ts`).
 *
 * Module-level + exported so `test/board.test.ts` can assert the line
 * shape directly without standing up the full subscribe loop.
 */
export function renderJobLinkLines(jobLinks: unknown): string[] {
  if (!Array.isArray(jobLinks) || jobLinks.length === 0) {
    return [];
  }
  const out: string[] = [];
  for (const link of jobLinks as JobLinkEntry[]) {
    const label = link.title ?? link.job_id;
    const state = link.state == null ? "" : String(link.state);
    out.push(
      `   ${label} [${link.kind}] [${state}]${rateLimitedPillSeg(link.rate_limited_at)}`,
    );
  }
  return out;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      live: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  const sockPath = values.sock ?? resolveSockPath();
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const liveMode = values.live;
  const liveShell = createLiveShell({ enabled: liveMode });
  let frameCount = 0;

  // `lastBody` byte-compares the COMBINED body — internal row churn that
  // doesn't surface in the render is invisible by design.
  let lastBody: string | null = null;

  const seg = (v: unknown) => (v == null ? "" : String(v));

  // --- epic rendering ---

  /**
   * Per-job sub-agent lines. Reads from the per-frame `subagentIndex` built
   * by `emitFrame` and closed-over via the render context. Each line
   * carries `{subagent_type}: {description} [pill]` — `description` is
   * dropped when null/empty so the pill stays anchored next to the type.
   * `indent` is supplied per caller: embedded jobs (already three-space
   * indented inside an epic block) get six spaces; bottom-section jobs
   * (flush left) get three. Returns `[]` for jobs with no recorded
   * invocations so callers can spread unconditionally.
   */
  function subagentLinesFor(
    subagentIndex: Map<string, SubagentInvocation[]>,
    jobId: string,
    indent: string,
  ): string[] {
    const hits = subagentIndex.get(jobId);
    if (hits === undefined || hits.length === 0) {
      return [];
    }
    return hits.map((inv) => {
      const type = inv.subagent_type ?? "subagent";
      const desc = inv.description ?? "";
      const label = desc === "" ? type : `${type}: ${desc}`;
      return `${indent}${label} [${seg(inv.status)}]`;
    });
  }

  // `renderJobLinkLines` lives at module scope (exported) — see above —
  // so `test/board.test.ts` can assert the line shape without standing
  // up the full subscribe loop.

  function renderJobLines(
    subagentIndex: Map<string, SubagentInvocation[]>,
    jobsArr: unknown,
  ): string[] {
    if (!Array.isArray(jobsArr) || jobsArr.length === 0) {
      return [];
    }
    const out: string[] = [];
    for (const j of jobsArr) {
      const job = j as Record<string, unknown>;
      out.push(
        `   ${seg(job.title)} [${planVerbLabel(job.plan_verb) ?? ""}] [${seg(job.state)}]${rateLimitedPillSeg(job.rate_limited_at)}`,
      );
      out.push(
        ...subagentLinesFor(subagentIndex, String(job.job_id), "      "),
      );
    }
    return out;
  }

  /**
   * Look up a verdict by id from the readiness map. A renderer-side lookup
   * miss (verdict map doesn't have the id) yields the defensive
   * `[blocked:unknown]` pill — visible bug indicator, inert for autopilot
   * dispatch.
   */
  function verdictFromMap(
    map: Map<string, Verdict> | undefined,
    id: string,
  ): Verdict {
    if (map === undefined) {
      return { tag: "blocked", reason: { kind: "unknown" } };
    }
    return map.get(id) ?? { tag: "blocked", reason: { kind: "unknown" } };
  }

  function renderEpicBlock(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
    epicIds: Set<string>,
    row: Record<string, unknown>,
  ): string {
    const dir =
      row.project_dir == null ? "" : basename(String(row.project_dir));
    const dirSeg = dir === "" ? "" : `(${dir}) `;
    const epicDeps = Array.isArray(row.depends_on_epics)
      ? row.depends_on_epics
      : [];
    const epicDepsForRender = epicDeps.filter((d) => epicIds.has(String(d)));
    const epicDepNums = epicDepsForRender
      .map((d) => epicNumFromId(String(d)))
      .filter((n): n is number => n != null);
    const epicDepsSeg =
      epicDepNums.length === 0
        ? ""
        : ` [${epicDepNums.map((n) => `#${n}`).join(",")}]`;
    const epicId = seg(row.epic_id);
    const epicApproval = approvalPill(row.approval);
    const lines: string[] = [];
    const epicVerdict = verdictFromMap(snap.readiness.perEpic, epicId);
    lines.push(
      `${dirSeg}${seg(row.epic_number)} ${seg(row.title)}${epicDepsSeg} [${validatedPill(row.last_validated_at)}] ${formatPill(epicVerdict)}`,
      ...renderJobLinkLines(row.job_links),
    );
    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    for (const task of tasks) {
      const t = task as Record<string, unknown>;
      const tdeps = Array.isArray(t.depends_on) ? t.depends_on : [];
      const tnums = tdeps
        .map((d) => taskNumFromId(String(d)))
        .filter((n): n is number => n != null);
      const taskDepsSeg =
        tnums.length === 0 ? "" : ` [${tnums.map((n) => `#${n}`).join(",")}]`;
      const taskApproval = approvalPill(t.approval);
      const taskId = seg(t.task_id);
      const taskVerdict = verdictFromMap(snap.readiness.perTask, taskId);
      lines.push(
        // Schema v19: task elements now carry both `runtime_status` (the
        // planctl-native enum `todo|in_progress|done|blocked`) and
        // `worker_phase` (the derived worker-phase binary `open|done`).
        // Render both pills side-by-side with `[approval]` so the row
        // surfaces the full native vocabulary — no client-side collapse.
        `${seg(t.task_number)}. ${seg(t.title)}${taskDepsSeg} [${seg(t.runtime_status)}] [${seg(t.worker_phase)}] [${taskApproval}]`,
        `   [${taskId}] ${formatPill(taskVerdict)}`,
        ...renderJobLines(subagentIndex, t.jobs),
      );
    }
    const closeVerdict = verdictFromMap(snap.readiness.perCloseRow, epicId);
    lines.push(
      `X. Quality audit and close [${seg(row.status)}] [${epicApproval}]`,
      `   [${epicId}] ${formatPill(closeVerdict)}`,
      ...renderJobLines(subagentIndex, row.jobs),
    );
    return lines.join("\n");
  }

  function renderEpicsBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string {
    if (snap.epics.length === 0) {
      return "";
    }
    const epicIds = new Set(snap.epics.map((e) => String(e.epic_id)));
    return snap.epics
      .map((e) =>
        renderEpicBlock(
          snap,
          subagentIndex,
          epicIds,
          e as unknown as Record<string, unknown>,
        ),
      )
      .join("\n+++\n");
  }

  // --- job rendering ---

  function projectJobRow(row: Record<string, unknown>): string {
    const title = seg(row.title);
    const cwd = row.cwd == null ? "" : basename(String(row.cwd));
    const cwdSeg = cwd === "" ? "" : `(${cwd}) `;
    const role = planVerbLabel(row.plan_verb);
    const roleSeg = role == null ? "" : ` [${role}]`;
    return `${cwdSeg}${title}${roleSeg} [${seg(row.state)}]${rateLimitedPillSeg(row.rate_limited_at)}`;
  }

  /**
   * Jobs body is split into two stacked sub-lists by `plan_verb` presence:
   * no-role (ambient sessions) on top, with-role (planner/worker/closer —
   * epic-bound work) on the bottom, joined by a `~~~` line. Within each
   * partition we preserve server order, and each job row is followed by
   * its `subagentLinesFor` block (three-space indent — one level under
   * the flush-left job line). Same empty-side drop rule as the outer
   * `renderBody`: a partition with zero rows yields just the other one,
   * no divider; both empty yields `""`.
   *
   * The helper delivers `jobs` as a `Map<job_id, Job>` (no ordered slice),
   * so we iterate via `jobs.values()` — the Map preserves insertion order
   * and the helper's `result`-handler inserts in wire order, so server
   * order is preserved.
   */
  function renderJobsBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string {
    if (snap.jobs.size === 0) {
      return "";
    }
    const noRole: string[] = [];
    const withRole: string[] = [];
    for (const [id, row] of snap.jobs) {
      const block = [
        projectJobRow(row as unknown as Record<string, unknown>),
        ...subagentLinesFor(subagentIndex, id, "   "),
      ].join("\n");
      if ((row as unknown as Record<string, unknown>).plan_verb == null) {
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

  /**
   * Combined frame body: epics on top, jobs on the bottom, a `~~~` divider
   * on its own line between them (no blank-line padding — the divider IS
   * the visual break). The divider is dropped when either side is empty,
   * so a single populated section reads as a clean block; both empty
   * yields an empty body (the frame is just the `---` lead). Same `---`
   * lead as the sibling scripts — there's still one frame per change.
   *
   * Returns one element per output line so the live-shell can consume
   * lines (per-line ANSI diff). The caller joins with `\n` for stdout /
   * sidecar / byte-compare.
   */
  function renderBody(
    snap: ReadinessClientSnapshot,
    subagentIndex: Map<string, SubagentInvocation[]>,
  ): string[] {
    const e = renderEpicsBody(snap, subagentIndex);
    const j = renderJobsBody(snap, subagentIndex);
    let body: string;
    if (e === "") {
      body = j;
    } else if (j === "") {
      body = e;
    } else {
      body = `${e}\n~~~\n${j}`;
    }
    return body === "" ? [] : body.split("\n");
  }

  const stateSidecar = `/tmp/keeper-board.${process.pid}.state.json`;
  const frameSidecar = `/tmp/keeper-board.${process.pid}.frame.txt`;
  const diffSidecar = `/tmp/keeper-board.${process.pid}.diff.txt`;
  // Internal scratch path for the previous frame text — fed to `diff -u` as
  // its "before" file. Overwritten each tick; not surfaced in the meta note.
  const prevFrameTmp = `/tmp/keeper-board.${process.pid}.prev.frame.txt`;
  // Session-level meta file: one tab-separated line per frame (index +
  // per-frame sidecar paths). Only written in `--live` mode; accumulates
  // across the session so every past frame remains inspectable.
  const metaSidecar = `/tmp/keeper-board.${process.pid}.meta.txt`;
  // `--live` mode owns the alt-screen, so per-frame / per-event chatter
  // can't go to stdout (raw newline writes scroll the alt-screen and
  // desync the per-line differ — every row not updated next frame shows
  // stale content). Lifecycle events and warn lines append here instead;
  // tail -f from another pane to watch.
  const lifecycleSidecar = `/tmp/keeper-board.${process.pid}.lifecycle.txt`;
  // Route warn/lifecycle output: stdout in default mode, sidecar in --live.
  const noteLine = (s: string): void => {
    if (liveMode) {
      try {
        appendFileSync(lifecycleSidecar, `${s}\n`);
      } catch {
        // best-effort — the sidecar is observational
      }
    } else {
      log(s);
    }
  };
  // In-memory copy of the last emitted frame's body+lead, used as the
  // "before" side of the per-frame unified diff. `null` until the first
  // frame lands (sentinel written instead).
  let lastFrameText: string | null = null;

  function writeSidecars(
    snap: ReadinessClientSnapshot,
    frameText: string,
  ): void {
    // In --live mode each frame's sidecars are indexed so past frames persist;
    // in default mode the three static paths are overwritten each frame.
    const sState = liveMode
      ? `/tmp/keeper-board.${process.pid}.state.${frameCount}.json`
      : stateSidecar;
    const sFrame = liveMode
      ? `/tmp/keeper-board.${process.pid}.frame.${frameCount}.txt`
      : frameSidecar;
    const sDiff = liveMode
      ? `/tmp/keeper-board.${process.pid}.diff.${frameCount}.txt`
      : diffSidecar;
    const stateJson = {
      epics: snap.epics,
      jobs: Array.from(snap.jobs.values()),
    };
    try {
      writeFileSync(sState, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      noteLine(`# warn: sidecar write failed: ${(err as Error).message}`);
    }
    // Per-frame unified diff against the previous emit. Uses system `diff -u`
    // so the output is the universally-readable unified-diff format. `diff -u`
    // exits 1 when files differ — that's expected here (we only get here when
    // the body changed), so we ignore the exit code and take stdout. First
    // frame has no prior, so we write a sentinel.
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
    if (liveMode) {
      try {
        appendFileSync(
          metaSidecar,
          `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
        );
      } catch (err) {
        noteLine(`# warn: meta write failed: ${(err as Error).message}`);
      }
    }
    lastFrameText = frameText;
    // In --live mode the alt-screen is the canvas — chatter to stdout would
    // scroll it and desync the per-line differ. The meta sidecar already
    // records every frame's indexed paths; the dispose summary surfaces
    // them on exit.
    if (!liveMode) {
      log("...");
      log(`state: ${sState}`);
      log(`frame: ${sFrame}`);
      log(`diff: ${sDiff}`);
      log("...");
    }
  }

  /**
   * Helper-driven snapshot callback. Builds the per-frame `job_id →
   * invocations` index, renders the combined body, byte-compares against
   * the last emit, and writes sidecars + stdout when the render changes.
   * The helper handles the all-three-strict first-paint gate AND the
   * `computeReadiness` call — `snap.readiness` is fully populated when
   * we get here.
   */
  function emitFrame(snap: ReadinessClientSnapshot): void {
    // Per-frame `job_id → invocations` index — re-entrant sub-agents within
    // one session sit on the same `job_id` bucket, ordered by `turn_seq asc`
    // so the nested list reads in invocation order. The projection now
    // promotes `superseded` natively (task fn-605.2), so no client-side
    // marking pass is required — `subagentLinesFor` stamps the raw
    // `[${status}]` enum verbatim.
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
    const lines = ["---", ...bodyLines];
    const frameText = lines.join("\n");
    liveShell.pushFrame(lines);
    writeSidecars(snap, frameText);
  }

  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    // Single multi-line block — one write call, one append — so the
    // alt-screen sees nothing in --live mode and the default-mode stdout
    // emits in one shot like the sidecar block.
    const lines: string[] = ["...", `event: ${event}`];
    for (const [k, v] of Object.entries(detail)) {
      lines.push(`${k}: ${String(v)}`);
    }
    lines.push("...");
    if (liveMode) {
      try {
        appendFileSync(lifecycleSidecar, `${lines.join("\n")}\n`);
      } catch {
        // best-effort
      }
    } else {
      for (const line of lines) {
        log(line);
      }
    }
    // On disconnect, clear `lastBody` so the next first-paint emits even
    // if the post-reconnect snapshot happens to match the last pre-
    // disconnect body byte-for-byte. (The helper resets its own collection
    // state and re-gates first-paint behind all three `result`s.)
    if (event === "disconnected") {
      lastBody = null;
    }
  }

  const handle = subscribeReadiness({
    sockPath,
    idPrefix: "board",
    onSnapshot: emitFrame,
    onLifecycle: emitLifecycle,
  });

  process.on("SIGINT", () => {
    // Terminal restoration before subscription teardown.
    liveShell.dispose();
    handle.dispose();
    // In --live mode chatter is suppressed during the session — surface
    // the session sidecar paths to the user's restored terminal now so
    // they can inspect the indexed history.
    if (liveMode) {
      log("...");
      log(`meta: ${metaSidecar}`);
      log(`lifecycle: ${lifecycleSidecar}`);
      log("...");
    }
    process.exit(0);
  });
}

// Entry-point guard — only run when invoked as a script, not when imported
// (the test suite re-imports `projectRows` from this module).
if (import.meta.main) {
  await main();
}
