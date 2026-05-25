#!/usr/bin/env bun
/**
 * keeper-board — a combined "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`) that streams the epics + jobs +
 * subagent_invocations collections as one frame per change: each frame is
 * the epics body + a `~~~` divider line + the jobs body, both refreshed
 * under the same poll/connect lifecycle so they always show the same
 * wall-clock snapshot of the daemon. `subagent_invocations` rows feed the
 * readiness pill ONLY — they're not directly rendered in the body.
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
 * One connection carries THREE `query` frames (one per collection — epics,
 * jobs, subagent_invocations — each with a distinct subscription `id`).
 * `patch` / `meta` frames carry only `collection` (no `id`), so we route
 * refetches by collection: an epics patch refetches only epics, a jobs
 * patch only jobs, a subagent_invocations patch only that. Each collection
 * keeps its own page state (`order` / `byId` / `gotResult`) and its own
 * coalescing flags (`queryInFlight` / `refetchDirty`), so a refetch in one
 * never blocks a refetch in the others; the rendered body + the readiness
 * pill are recomputed from ALL THREE whenever any lands a fresh `result`.
 * The combined body is byte-compared against the last printed frame, so
 * internal row churn that doesn't surface in the render is invisible.
 *
 * First-paint policy: NO frame is emitted until ALL THREE collections have
 * received their first `result` (strict — accept an indefinite dark board
 * over a wrong-state render). Otherwise the first paint would briefly show
 * a real section below an empty one (or vice versa), or compute the
 * readiness pill against a partial snapshot — both read as momentary
 * lies. After the first combined frame, every subsequent `result` may
 * emit — the lastBody compare keeps the stream quiet when nothing visible
 * changed.
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
 * Connection / poll / sidecar / SIGINT semantics: capped-backoff
 * connect+retry, post-disconnect reconnect, one `...`-fenced lifecycle note
 * per transition, THREE combined sidecar files (state JSON + frame text +
 * per-frame unified diff against the previous emit) overwritten each frame.
 * The diff is `diff -u prev current` via the system tool — universally-
 * readable unified-diff format; the first frame writes a sentinel since
 * there's no prior to diff. SIGINT sends a bare `unsubscribe` (no id) which
 * drops both subscriptions in one frame, then exits.
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
import {
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type ServerFrame,
} from "../src/protocol";
import type { Epic, Job, SubagentInvocation } from "../src/types";
import {
  computeReadiness,
  formatPill,
  formatReasonLine,
  type ReadinessSnapshot,
} from "./readiness";

/**
 * Page sizing. Jobs paginates at 10 — a tight enough window that a single
 * frame stays readable while still covering the typical live-session set.
 * Epics fetches the whole default-scope set (`limit: 0`) because that scope
 * (open + not-yet-approved) is already tiny — well under any sensible page
 * limit, and the user wants the whole board, not a window into it.
 */
const JOBS_PAGE_LIMIT = 10;
const EPICS_PAGE_LIMIT = 0;

/**
 * Poll cadence (ms). Refetches BOTH collections each tick (coalesced per
 * collection, so a tick that arrives while a refetch is in flight just sets
 * that collection's `refetchDirty` and skips the second send).
 */
const POLL_MS = 500;

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

const HELP = `keeper-board — combined epics + jobs UI over the keeper subscribe server

Usage: bun scripts/board.ts [--sock <path>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --clear          Clear the terminal before each frame (live-panel mode).
                   Each frame's sidecars are written to indexed paths
                   instead of overwriting, and a session meta file at
                   /tmp/keeper-board.<pid>.meta.txt accumulates the full
                   index (tab-separated: frame# state frame diff).
  --help           Show this help

Renders both views as one frame per change, each frame led by '---':

  ---
  {epics body}      (one block per epic, see epic-header format below)
  ~~~
  {jobs body}       (one row per job: {basename(cwd)} {title} [role] [state])

Each epic block opens with a header line of the form:

  ({dir}) {epic_number} {title} [#dep,#dep] [validated|unvalidated] [<readiness>]

followed by indented task lines (one per embedded task) and a final
"Quality audit and close" line for the epic itself. The [validated] /
[unvalidated] pill reflects planctl's last_validated_at timestamp on the
epic file — flipped by 'planctl validate --epic <id>'.

The [<readiness>] pill is one of [ready], [completed], or
[blocked:<reason>] — a pure-function verdict computed by scripts/readiness.ts
from the (epics, jobs, subagent_invocations) snapshot. A blocked row is
followed by a "   (reason: <reason>)" continuation line so the cause is
visible without scanning the upstream rows.

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

function epicNumFromId(id: string): number | null {
  const m = /^[a-z]+-(\d+)-/.exec(id);
  return m ? Number.parseInt(m[1], 10) : null;
}

function taskNumFromId(id: string): number | null {
  const m = /\.(\d+)$/.exec(id);
  return m ? Number.parseInt(m[1], 10) : null;
}

function die(message: string): never {
  process.stderr.write(`keeper-board: ${message}\n`);
  process.exit(2);
}

/**
 * Per-collection page + coalescing state. One instance per subscription
 * (epics, jobs); both ride one connection. `order` + `byId` are rebuilt
 * wholesale on every `result`; `gotResult` flips true on the first one
 * and stays true. `queryInFlight` / `refetchDirty` are the coalescing
 * pair — see `scheduleRefetchFor`.
 */
interface CollectionState {
  readonly collection: string;
  readonly subId: string;
  readonly pk: string;
  readonly query: QueryFrame;
  order: string[];
  byId: Map<string, Record<string, unknown>>;
  gotResult: boolean;
  queryInFlight: boolean;
  refetchDirty: boolean;
}

function makeState(
  collection: string,
  subId: string,
  pk: string,
  limit: number,
): CollectionState {
  return {
    collection,
    subId,
    pk,
    query: { type: "query", collection, id: subId, limit },
    order: [],
    byId: new Map(),
    gotResult: false,
    queryInFlight: false,
    refetchDirty: false,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      sock: { type: "string" },
      clear: { type: "boolean", default: false },
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
  const clearMode = values.clear;
  let frameCount = 0;

  const epics = makeState("epics", "epics-frames", "epic_id", EPICS_PAGE_LIMIT);
  const jobs = makeState("jobs", "jobs-frames", "job_id", JOBS_PAGE_LIMIT);
  // The `subagent_invocations` descriptor's pk is `job_id` (it's a composite
  // PK `(job_id, agent_id, turn_seq)` but the wire-facing index key is
  // `job_id` — see `src/collections.ts:SUBAGENT_INVOCATIONS_DESCRIPTOR`).
  // The readiness predicate 6 only ever asks "is there a running sub-agent
  // under this worker.session_id?" — keying by `job_id` is sufficient. We
  // store every row received under its `job_id` (multiple rows may collide;
  // the readiness pipeline iterates the array, not the map). Page limit 0
  // streams the full default scope — same scope-is-board reasoning as epics.
  const subagentInvocations = makeState(
    "subagent_invocations",
    "subagent-invocations-frames",
    "job_id",
    0,
  );
  const states: CollectionState[] = [epics, jobs, subagentInvocations];
  const byCollection = new Map(states.map((s) => [s.collection, s]));

  // `lastBody` byte-compares the COMBINED body — internal row churn that
  // doesn't surface in the render is invisible by design.
  let lastBody: string | null = null;

  // Latest readiness snapshot — computed once per frame inside
  // `emitFrameIfChanged` BEFORE `renderBody` runs, and read by the row
  // renderers (`renderEpicBlock` and friends) when stamping the pill.
  // `null` between frames (cleared on disconnect; replaced on next emit).
  let lastReadiness: ReadinessSnapshot | null = null;

  type Sock = Awaited<ReturnType<typeof Bun.connect>>;
  let currentSock: Sock | null = null;
  let attempt = 0;
  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const seg = (v: unknown) => (v == null ? "" : String(v));

  // --- epic rendering ---

  /**
   * We ALWAYS use the server's default epics scope (no CLI filter flag), so
   * the fetched set IS the on-board set — `epicDepsFor` can drop any dep
   * absent from the page (it's done-AND-approved and off the board). No
   * `onBoardOnly` toggle is needed here.
   */
  function renderJobLines(jobsArr: unknown): string[] {
    if (!Array.isArray(jobsArr) || jobsArr.length === 0) {
      return [];
    }
    return jobsArr.map((j) => {
      const job = j as Record<string, unknown>;
      return `   ${seg(job.title)} [${planVerbLabel(job.plan_verb) ?? ""}] [${seg(job.state)}]`;
    });
  }

  /**
   * Look up a verdict by id from `lastReadiness`. A renderer-side lookup
   * miss (verdict map doesn't have the id) yields the defensive
   * `[blocked:unknown]` pill — visible bug indicator, inert for autopilot
   * dispatch. `lastReadiness === null` shouldn't happen once the first
   * frame has emitted (the gate in `emitFrameIfChanged` runs
   * `computeReadiness` before `renderBody`), but the safety net stays:
   * the only way to get here without a readiness snapshot is a logic bug.
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

  /**
   * Render a row with the readiness pill appended after the existing
   * `[status] [approval]` segment, and — when the verdict is blocked —
   * a continuation line `   (reason: <reason text>)` underneath. The
   * `baseLine` carries everything before the pill so the caller composes
   * the pill in the same expression that already carries the row's pills.
   */
  function appendReadinessLines(
    out: string[],
    baseLine: string,
    verdict: Verdict,
  ): void {
    out.push(`${baseLine} ${formatPill(verdict)}`);
    const reason = formatReasonLine(verdict);
    if (reason !== null) {
      out.push(`   (reason: ${reason})`);
    }
  }

  function renderEpicBlock(row: Record<string, unknown>): string {
    const dir =
      row.project_dir == null ? "" : basename(String(row.project_dir));
    const dirSeg = dir === "" ? "" : `(${dir}) `;
    const epicDeps = Array.isArray(row.depends_on_epics)
      ? row.depends_on_epics
      : [];
    const epicDepsForRender = epicDeps.filter((d) => epics.byId.has(String(d)));
    const epicDepNums = epicDepsForRender
      .map((d) => epicNumFromId(String(d)))
      .filter((n): n is number => n != null);
    const epicDepsSeg =
      epicDepNums.length === 0
        ? ""
        : ` [${epicDepNums.map((n) => `#${n}`).join(",")}]`;
    const epicId = seg(row[epics.pk]);
    const epicApproval = approvalPill(row.approval);
    const lines: string[] = [];
    const epicHeaderBase = `${dirSeg}${seg(row.epic_number)} ${seg(row.title)}${epicDepsSeg} [${validatedPill(row.last_validated_at)}]`;
    appendReadinessLines(
      lines,
      epicHeaderBase,
      verdictFromMap(lastReadiness?.perEpic, epicId),
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
      const taskRowBase = `${seg(t.task_number)}. ${seg(t.title)}${taskDepsSeg} [${seg(t.status)}] [${taskApproval}]`;
      appendReadinessLines(
        lines,
        taskRowBase,
        verdictFromMap(lastReadiness?.perTask, taskId),
      );
      lines.push(`   [${taskId}]`, ...renderJobLines(t.jobs));
    }
    const closeRowBase = `${tasks.length + 1}. Quality audit and close [${seg(row.status)}] [${epicApproval}]`;
    appendReadinessLines(
      lines,
      closeRowBase,
      verdictFromMap(lastReadiness?.perCloseRow, epicId),
    );
    lines.push(`   [${epicId}]`, ...renderJobLines(row.jobs));
    return lines.join("\n");
  }

  function renderEpicsBody(): string {
    if (epics.order.length === 0) {
      return "";
    }
    return epics.order
      .map((id) => renderEpicBlock(epics.byId.get(id) ?? { [epics.pk]: id }))
      .join("\n+++\n");
  }

  // --- job rendering ---

  function projectJobRow(row: Record<string, unknown>): string {
    const title = seg(row.title);
    const cwd = row.cwd == null ? "" : basename(String(row.cwd));
    const cwdSeg = cwd === "" ? "" : `(${cwd}) `;
    const role = planVerbLabel(row.plan_verb);
    const roleSeg = role == null ? "" : ` [${role}]`;
    return `${cwdSeg}${title}${roleSeg} [${seg(row.state)}]`;
  }

  /**
   * Jobs body is split into two stacked sub-lists by `plan_verb` presence:
   * no-role (ambient sessions) on top, with-role (planner/worker/closer —
   * epic-bound work) on the bottom, joined by a `~~~` line. Within each
   * partition we preserve server order. Same empty-side drop rule as the
   * outer `renderBody`: a partition with zero rows yields just the other
   * one, no divider; both empty yields `""`.
   */
  function renderJobsBody(): string {
    if (jobs.order.length === 0) {
      return "";
    }
    const noRole: string[] = [];
    const withRole: string[] = [];
    for (const id of jobs.order) {
      const row = jobs.byId.get(id) ?? { [jobs.pk]: id };
      const line = projectJobRow(row);
      if (row.plan_verb == null) {
        noRole.push(line);
      } else {
        withRole.push(line);
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
   */
  function renderBody(): string {
    const e = renderEpicsBody();
    const j = renderJobsBody();
    if (e === "") {
      return j;
    }
    if (j === "") {
      return e;
    }
    return `${e}\n~~~\n${j}`;
  }

  const stateSidecar = `/tmp/keeper-board.${process.pid}.state.json`;
  const frameSidecar = `/tmp/keeper-board.${process.pid}.frame.txt`;
  const diffSidecar = `/tmp/keeper-board.${process.pid}.diff.txt`;
  // Internal scratch path for the previous frame text — fed to `diff -u` as
  // its "before" file. Overwritten each tick; not surfaced in the meta note.
  const prevFrameTmp = `/tmp/keeper-board.${process.pid}.prev.frame.txt`;
  // Session-level meta file: one tab-separated line per frame (index +
  // per-frame sidecar paths). Only written in `--clear` mode; accumulates
  // across the session so every past frame remains inspectable.
  const metaSidecar = `/tmp/keeper-board.${process.pid}.meta.txt`;
  // In-memory copy of the last emitted frame's body+lead, used as the
  // "before" side of the per-frame unified diff. `null` until the first
  // frame lands (sentinel written instead).
  let lastFrameText: string | null = null;

  function writeSidecars(frameText: string): void {
    // In --clear mode each frame's sidecars are indexed so past frames persist;
    // in default mode the three static paths are overwritten each frame.
    const sState = clearMode
      ? `/tmp/keeper-board.${process.pid}.state.${frameCount}.json`
      : stateSidecar;
    const sFrame = clearMode
      ? `/tmp/keeper-board.${process.pid}.frame.${frameCount}.txt`
      : frameSidecar;
    const sDiff = clearMode
      ? `/tmp/keeper-board.${process.pid}.diff.${frameCount}.txt`
      : diffSidecar;
    const stateJson = {
      epics: epics.order.map((id) => epics.byId.get(id) ?? { [epics.pk]: id }),
      jobs: jobs.order.map((id) => jobs.byId.get(id) ?? { [jobs.pk]: id }),
    };
    try {
      writeFileSync(sState, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(sFrame, `${frameText}\n`);
    } catch (err) {
      log(`# warn: sidecar write failed: ${(err as Error).message}`);
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
      log(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    if (clearMode) {
      try {
        appendFileSync(
          metaSidecar,
          `${frameCount}\t${sState}\t${sFrame}\t${sDiff}\n`,
        );
      } catch (err) {
        log(`# warn: meta write failed: ${(err as Error).message}`);
      }
    }
    lastFrameText = frameText;
    log("...");
    log(`state: ${sState}`);
    log(`frame: ${sFrame}`);
    log(`diff: ${sDiff}`);
    if (clearMode) {
      log(`meta: ${metaSidecar}`);
    }
    log("...");
  }

  /**
   * Emit a frame iff (a) all three collections have landed their first
   * result (no half-empty first paint — strict per spec: indefinite dark
   * board over a wrong-state render) and (b) the combined body changed
   * since the last emit. `computeReadiness` runs once per emit BEFORE
   * `renderBody` so the row renderers can stamp the pill from
   * `lastReadiness`.
   */
  function emitFrameIfChanged(): void {
    if (!epics.gotResult || !jobs.gotResult || !subagentInvocations.gotResult) {
      return;
    }
    // Cast: the wire delivers each row as `Record<string, unknown>`; the
    // descriptors guarantee the shape matches the typed projection (decoded
    // by `decodeRow` on the server side). The readiness pipeline only
    // touches typed fields it expects to exist.
    const epicsTyped = epics.order.map(
      (id) => (epics.byId.get(id) ?? { [epics.pk]: id }) as unknown as Epic,
    );
    const jobsTyped = new Map<string, Job>();
    for (const [id, row] of jobs.byId) {
      jobsTyped.set(id, row as unknown as Job);
    }
    const subsTyped: SubagentInvocation[] = [];
    for (const row of subagentInvocations.byId.values()) {
      subsTyped.push(row as unknown as SubagentInvocation);
    }
    lastReadiness = computeReadiness(epicsTyped, jobsTyped, subsTyped);
    const body = renderBody();
    if (body === lastBody) {
      return;
    }
    lastBody = body;
    frameCount += 1;
    if (clearMode) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    const frameText = `---\n${body}`;
    log(frameText);
    writeSidecars(frameText);
  }

  /**
   * Re-issue ONE collection's page query, coalesced. `state.queryInFlight`
   * is per-collection so an in-flight epics refetch never blocks a jobs
   * refetch (or vice versa). A change signal that arrives while a refetch
   * is in flight queues exactly one more.
   */
  function scheduleRefetchFor(state: CollectionState): void {
    if (!currentSock) {
      return;
    }
    if (state.queryInFlight) {
      state.refetchDirty = true;
      return;
    }
    state.queryInFlight = true;
    currentSock.write(encodeFrame(state.query));
  }

  /** Steady-poll backstop — both collections, every tick. */
  function pollAll(): void {
    for (const s of states) {
      scheduleRefetchFor(s);
    }
  }

  function emitLifecycle(
    event: string,
    detail: Record<string, unknown> = {},
  ): void {
    log("...");
    log(`event: ${event}`);
    for (const [k, v] of Object.entries(detail)) {
      log(`${k}: ${String(v)}`);
    }
    log("...");
  }

  function handleFrame(frame: ServerFrame): void {
    if (frame.type === "result") {
      const state = byCollection.get(frame.collection);
      if (!state) {
        // A `result` for a collection we don't track — defensive; should
        // never happen on a connection we opened ourselves.
        return;
      }
      state.queryInFlight = false;
      state.order.length = 0;
      state.byId.clear();
      for (const row of frame.rows) {
        const id = String(row[state.pk]);
        state.order.push(id);
        state.byId.set(id, row);
      }
      state.gotResult = true;
      emitFrameIfChanged();
      if (state.refetchDirty) {
        state.refetchDirty = false;
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "patch" || frame.type === "meta") {
      // Route by collection — patch/meta carry no `id`, only `collection`,
      // so we refetch the collection that moved.
      const state = byCollection.get(frame.collection);
      if (state) {
        scheduleRefetchFor(state);
      }
    } else if (frame.type === "error") {
      log(`# error ${frame.code} (rev ${frame.rev}): ${frame.message}`);
      // A bad_frame / unknown_collection on our own query is terminal — a
      // reconnect can't fix a malformed query. Terminal iff NO collection
      // has produced a first result (with three collections, that means
      // all three failed); otherwise the error is likely transient and
      // the next refetch will recover.
      if (
        !epics.gotResult &&
        !jobs.gotResult &&
        !subagentInvocations.gotResult
      ) {
        shuttingDown = true;
        currentSock?.end();
        process.exit(1);
      }
    }
  }

  function teardownConnection(): void {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    currentSock = null;
    for (const s of states) {
      s.order.length = 0;
      s.byId.clear();
      s.queryInFlight = false;
      s.refetchDirty = false;
      s.gotResult = false;
    }
    lastBody = null;
    lastReadiness = null;
  }

  async function connectOnce(): Promise<void> {
    const buffer = new LineBuffer();
    await Bun.connect({
      unix: sockPath,
      socket: {
        open(sock) {
          attempt = 0;
          currentSock = sock;
          emitLifecycle("connected", { sock: sockPath });
          // Send BOTH queries up front. Each collection's `queryInFlight`
          // tracks its own send so the poll/refetch coalescer stays sane.
          for (const s of states) {
            s.queryInFlight = true;
            sock.write(encodeFrame(s.query));
          }
          pollTimer = setInterval(pollAll, POLL_MS);
        },
        data(_sock, chunk) {
          let lines: string[];
          try {
            lines = buffer.push(chunk.toString("utf8"));
          } catch (err) {
            die(`protocol error: ${(err as Error).message}`);
          }
          for (const line of lines) {
            if (line.trim().length === 0) {
              continue;
            }
            handleFrame(JSON.parse(line) as ServerFrame);
          }
        },
        close() {
          if (shuttingDown) {
            return;
          }
          teardownConnection();
          emitLifecycle("disconnected", {});
          void connectWithRetry();
        },
        error(_sock, err) {
          emitLifecycle("error", { message: err.message });
        },
      },
    });
  }

  async function connectWithRetry(): Promise<void> {
    emitLifecycle("connecting", { sock: sockPath });
    while (!shuttingDown) {
      try {
        await connectOnce();
        return;
      } catch (err) {
        attempt += 1;
        const delay = Math.min(
          INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
          MAX_BACKOFF_MS,
        );
        emitLifecycle("waiting", {
          attempt,
          retry_in_ms: delay,
          reason: (err as Error).message,
        });
        await Bun.sleep(delay);
      }
    }
  }

  process.on("SIGINT", () => {
    shuttingDown = true;
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    try {
      // No `id` → drop every subscription on this connection in one frame.
      currentSock?.write(encodeFrame({ type: "unsubscribe" }));
      currentSock?.end();
    } catch {
      // socket already gone — nothing to release
    }
    process.exit(0);
  });

  await connectWithRetry();
}

await main();
