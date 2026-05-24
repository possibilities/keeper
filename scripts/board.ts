#!/usr/bin/env bun
/**
 * keeper-board — a combined "UI" over the read-only NDJSON-over-UDS subscribe
 * server (`src/server-worker.ts`) that fuses `scripts/epics.ts` and
 * `scripts/jobs.ts` into a single stream: one frame per change, each frame is
 * the epics body + a `~~~` divider line + the jobs body, both refreshed
 * under the same poll/connect lifecycle so they always show the same
 * wall-clock snapshot of the daemon.
 *
 * Frame shape (one `---` lead per frame):
 *
 *   ---
 *   {epics body}     ← see scripts/epics.ts for the epic-block format
 *   ~~~
 *   {jobs body}      ← see scripts/jobs.ts for the job-line format
 *
 * The jobs body itself is split into two stacked sub-lists separated by a
 * `~~~` line: jobs with NO `plan_verb` (ambient / ad-hoc sessions) on top,
 * jobs WITH a `plan_verb` (planner/worker/closer — epic/task-bound work) on
 * the bottom. So a fully-populated frame can carry TWO `~~~` lines — one
 * between epics and jobs, one inside the jobs section. The empty-side drop
 * rule (below) applies at both levels.
 *
 * One connection carries TWO `query` frames (one per collection, distinct
 * subscription `id`s). `patch` / `meta` frames carry only `collection` (no
 * `id`), so we route refetches by collection: an epics patch refetches only
 * epics, a jobs patch only jobs. Each collection keeps its own page state
 * (`order` / `byId` / `gotResult`) and its own coalescing flags
 * (`queryInFlight` / `refetchDirty`), so a refetch in one never blocks a
 * refetch in the other; the rendered body is recomputed from BOTH whenever
 * either lands a fresh `result`. The combined body is byte-compared against
 * the last printed frame, so internal row churn that doesn't surface in the
 * render is invisible (same contract as the sibling scripts).
 *
 * First-paint policy: NO frame is emitted until BOTH collections have
 * received their first `result`. Otherwise the first paint would briefly
 * show a real section below an empty one (or vice versa) before the other
 * landed — which reads as a momentary lie. After the first combined frame,
 * every subsequent `result` may emit — the lastBody compare keeps the
 * stream quiet when nothing visible changed.
 *
 * Empty-section policy: an empty collection renders as NOTHING (no
 * placeholder text). The `~~~` divider is dropped when either side is
 * empty, so a single populated section reads as a clean block under the
 * `---` lead, and a frame with both sides empty is just the lead. The
 * same rule applies to the jobs section's internal split: if one of the
 * two job partitions is empty, the inner `~~~` is dropped and the
 * populated partition reads as a single flat list.
 *
 * Filters: this combined view uses the SERVER defaults for both
 * collections — epics: `status = 'open' AND approval != 'approved'`; jobs:
 * live only (`working + stopped`, terminal states hidden). That's the
 * common-case "board" view; for explicit filters keep using the sibling
 * scripts (they may go away once this view replaces them).
 *
 * Connection / poll / sidecar / SIGINT semantics mirror the sibling
 * scripts: capped-backoff connect+retry, post-disconnect reconnect, one
 * `...`-fenced lifecycle note per transition, THREE combined sidecar files
 * (state JSON + frame text + per-frame unified diff against the previous
 * emit) overwritten each frame. The diff is `diff -u prev current` via the
 * system tool — universally-readable unified-diff format; the first frame
 * writes a sentinel since there's no prior to diff. SIGINT sends a bare
 * `unsubscribe` (no id) which drops both subscriptions in one frame, then
 * exits.
 *
 * Usage:
 *   bun scripts/board.ts [--sock <path>]
 *
 *   --sock <path>    Socket path override (else $KEEPER_SOCK, else the
 *                    ~/.local/state/keeper/keeperd.sock default).
 *   --help           Show this help.
 */

import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import { resolveSockPath } from "../src/db";
import {
  encodeFrame,
  LineBuffer,
  type QueryFrame,
  type ServerFrame,
} from "../src/protocol";

/**
 * Jobs page size — same as `scripts/jobs.ts`. Epics fetches the whole
 * default-scope set (`limit: 0`) because `epics.ts` does (and that scope
 * is already tiny — see the rationale in `scripts/epics.ts`).
 */
const JOBS_PAGE_LIMIT = 10;
const EPICS_PAGE_LIMIT = 0;

/**
 * Poll cadence (ms) — same as the sibling scripts. Refetches BOTH
 * collections each tick (coalesced per collection, so a tick that arrives
 * while a refetch is in flight just sets that collection's `refetchDirty`
 * and skips the second send).
 */
const POLL_MS = 500;

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;

const HELP = `keeper-board — combined epics + jobs UI over the keeper subscribe server

Usage: bun scripts/board.ts [--sock <path>]

  --sock <path>    Socket path override ($KEEPER_SOCK / default otherwise)
  --help           Show this help

Renders both views as one frame per change, each frame led by '---':

  ---
  {epics body}      (see scripts/epics.ts for the epic-block format)
  ~~~
  {jobs body}       (see scripts/jobs.ts for the job-line format)

The jobs body is itself split into two stacked sub-lists separated by a '~~~'
line: jobs with NO plan_verb (ambient sessions) on top, jobs WITH a plan_verb
(planner/worker/closer — epic-bound work) on the bottom. A fully-populated
frame can therefore show two '~~~' lines (one between epics and jobs, one
inside the jobs section).

The first frame waits until BOTH collections have landed their first result,
so first paint is never half-empty. An empty section renders as NOTHING (no
placeholder text); the ~~~ divider is dropped when either side is empty (this
applies to the inner jobs split too). The page is refetched on every change
signal and on a steady poll; a new frame prints only when the combined
rendered output changes. Both subscriptions ride one connection; an
epics-only change refetches only epics (and vice versa). Every emitted
frame is mirrored to three /tmp sidecar files (combined JSON state,
combined frame text, unified diff vs. the previous emit), whose paths
print in a ...-fenced note.

The client waits for keeperd to come up and reconnects across restarts
instead of exiting; each connection-lifecycle change prints a ...-fenced
note (event: connecting|connected|waiting|disconnected). Ctrl-C exits
cleanly.

This view uses the SERVER defaults for both collections (epics: open +
not-yet-approved; jobs: live only). For explicit per-collection filters
use the sibling scripts/epics.ts and scripts/jobs.ts.
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
 * Map a plan_verb to its noun-form role label for the `[{role}]` pill —
 * mirrors the sibling helpers in `scripts/epics.ts` and `scripts/jobs.ts`.
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

  const epics = makeState("epics", "epics-frames", "epic_id", EPICS_PAGE_LIMIT);
  const jobs = makeState("jobs", "jobs-frames", "job_id", JOBS_PAGE_LIMIT);
  const states: CollectionState[] = [epics, jobs];
  const byCollection = new Map(states.map((s) => [s.collection, s]));

  // `lastBody` byte-compares the COMBINED body — internal row churn that
  // doesn't surface in the render is invisible by design (same contract as
  // the sibling scripts, just across two collections).
  let lastBody: string | null = null;

  type Sock = Awaited<ReturnType<typeof Bun.connect>>;
  let currentSock: Sock | null = null;
  let attempt = 0;
  let shuttingDown = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const seg = (v: unknown) => (v == null ? "" : String(v));

  // --- epic rendering (mirrors scripts/epics.ts:renderEpicBlock) ---

  /**
   * In the combined view we ALWAYS use the server's default epics scope (no
   * CLI filter flag), so the fetched set IS the on-board set — `epicDepsFor`
   * can drop any dep absent from the page (it's done-AND-approved and off
   * the board). Same logic as `scripts/epics.ts:renderEpicBlock`'s
   * default-mode branch; no `onBoardOnly` toggle is needed here.
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
    const lines: string[] = [
      `${dirSeg}${seg(row.epic_number)} ${seg(row.title)}${epicDepsSeg}`,
    ];
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
      lines.push(
        `${seg(t.task_number)}. ${seg(t.title)}${taskDepsSeg} [${seg(t.status)}] [${taskApproval}]`,
        `   [${taskId}]`,
        ...renderJobLines(t.jobs),
      );
    }
    lines.push(
      `${tasks.length + 1}. Quality audit and close [${seg(row.status)}] [${epicApproval}]`,
      `   [${epicId}]`,
      ...renderJobLines(row.jobs),
    );
    return lines.join("\n");
  }

  function renderEpicsBody(): string {
    if (epics.order.length === 0) {
      return "";
    }
    return epics.order
      .map((id) => renderEpicBlock(epics.byId.get(id) ?? { [epics.pk]: id }))
      .join("\n\n");
  }

  // --- job rendering (mirrors scripts/jobs.ts:projectRow) ---

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
  // In-memory copy of the last emitted frame's body+lead, used as the
  // "before" side of the per-frame unified diff. `null` until the first
  // frame lands (sentinel written instead).
  let lastFrameText: string | null = null;

  function writeSidecars(frameText: string): void {
    const stateJson = {
      epics: epics.order.map((id) => epics.byId.get(id) ?? { [epics.pk]: id }),
      jobs: jobs.order.map((id) => jobs.byId.get(id) ?? { [jobs.pk]: id }),
    };
    try {
      writeFileSync(stateSidecar, `${JSON.stringify(stateJson, null, 2)}\n`);
      writeFileSync(frameSidecar, `${frameText}\n`);
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
          cmd: ["diff", "-u", prevFrameTmp, frameSidecar],
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
      writeFileSync(diffSidecar, diffText);
    } catch (err) {
      log(`# warn: diff sidecar write failed: ${(err as Error).message}`);
    }
    lastFrameText = frameText;
    log("...");
    log(`state: ${stateSidecar}`);
    log(`frame: ${frameSidecar}`);
    log(`diff: ${diffSidecar}`);
    log("...");
  }

  /**
   * Emit a frame iff (a) both collections have landed their first result
   * (no half-empty first paint) and (b) the combined body changed since the
   * last emit. Same contract as the sibling scripts' `emitFrameIfChanged`,
   * just guarded on the cross-collection readiness.
   */
  function emitFrameIfChanged(): void {
    if (!epics.gotResult || !jobs.gotResult) {
      return;
    }
    const body = renderBody();
    if (body === lastBody) {
      return;
    }
    lastBody = body;
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
      // reconnect can't fix a malformed query. Terminal iff neither
      // collection has produced a first result; otherwise the error is
      // likely transient and the next refetch will recover.
      if (!epics.gotResult && !jobs.gotResult) {
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
    }
    lastBody = null;
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
