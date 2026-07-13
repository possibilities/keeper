/**
 * tmux control-mode focus worker (epic fn-952, the task-.3 keystone). keeperd's
 * persistent `tmux -C` control client: ONE long-lived child attached with `-N`
 * (never starts a server) that observes — server-wide — which session/window/pane
 * the current REAL (non-control) tmux client is focused on, and posts a
 * `tmux-client-focus-snapshot` to main on every observed change. Main (the SOLE
 * synthetic-event writer) mints a `TmuxClientFocusSnapshot` event; the reducer's
 * live-only fold (task .2) UPSERTs the `tmux_client_focus` singleton; `keeper jobs`
 * renders the `[focus …]` banner (task .4).
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import (the fast-tier pure-fn tests) is inert.
 *  - OWN read-only `openDb` connection (`prepareStmts:false`) — jobs reads feed
 *    the connect gate + ownership join, while `PRAGMA data_version` wakes a
 *    connected ownership refresh. A reader open does NOT migrate.
 *  - Typed messages: `{type:"shutdown"}` main→worker; `tmux-client-focus-snapshot`
 *    + `tmux-control-liveness` worker→main. The child + pipes are an EXTERNAL
 *    resource released in the shutdown handler (mirror `bus-worker`).
 *  - `fatalExit` (exit 1) is reserved for a BOOT failure (db-open) and a bounded
 *    reconnect-cap breach (a flapping server). A no-server condition is NOT fatal:
 *    `-N` fails when no server runs, so the worker degrades + retries forever.
 *
 * Control-mode hard invariants (host tmux is 3.6b — verified by the planning
 * scouts):
 *  - `no-output` is set ONCE at attach (`-f no-output,…`) and re-asserted via
 *    `refresh-client -f no-output`, NEVER toggled off→on (the ≤3.6 toggle hangs
 *    the client). `copy-mode -q` is sent defensively on connect (no `%config-error`
 *    on 3.6b → a config error would otherwise silently hang the client).
 *  - The reader is a dedicated async loop that drains stdout straight into the
 *    task-1 parser, NEVER blocking on a DB write or a command round-trip — a
 *    notification burst against a stalled reader fills the (small, on macOS) pipe
 *    and trips `%exit "too far behind"`.
 *  - The server generation is read FIRST on every connect; ALL cached ids are
 *    discarded on `%exit`/EOF (tmux reuses pane/window/session ids across
 *    restarts) and the surface is re-bootstrapped via a framed re-read.
 *
 * The PURE pieces below (`buildAttachArgs`, `pickAnchorSession`, `focusDedupKey`,
 * `decideReconnect`, `isStructuralNotification`) carry no I/O so the fast tier
 * drives them against golden inputs; the live `tmux -C` attach is exercised only
 * in `tmux-control-worker.slow.test.ts` (allowlisted).
 */

import type { Database } from "bun:sqlite";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { openDb } from "./db";
import { buildGenerationId, localeDefaultedEnv } from "./exec-backend";
import { LineBuffer, OversizedLineError } from "./protocol";
import { runQuery } from "./server-worker";
import { createControlStreamParser } from "./tmux-control-parser";
import {
  deriveFocusAndPanes,
  type FocusDerivation,
  hashTopology,
  parseClientLines,
  parsePaneLines,
  pickCurrentClient,
  type TmuxPaneRow,
  type TmuxTopologyPane,
} from "./tmux-focus-derive";
import type { Job } from "./types";
import { watchLoop } from "./wake-worker";

/** Data the parent passes via `new Worker(url, { workerData })`. Only the db path
 *  crosses the boundary — the connection (a thread-affine handle) is opened on
 *  the worker thread. `pollMs` tunes the connect-gate poll cadence in tests. */
export interface TmuxControlWorkerData {
  /** keeper.db path (read-only jobs reads + data-version polling). */
  dbPath: string;
  /** Connect-gate poll cadence (ms); defaults to {@link CONNECT_GATE_POLL_MS}. */
  pollMs?: number;
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * Worker→main focus observation (epic fn-952). Carries the current real client's
 * focused location PLUS the connection `status` and the `generation_id` (the tmux
 * server pid plus server start time) the focus was read under. Main mints ONE
 * `TmuxClientFocusSnapshot` event carrying exactly `{status, generation_id,
 * session_name, window_index, pane_id}` (the fold's
 * `extractTmuxClientFocusSnapshot` shape). The location fields are NULL on a
 * `status:"none"` (0 real clients) observation; the worker NEVER posts a
 * wiping/empty snapshot on a mere disconnect.
 */
export interface TmuxClientFocusSnapshotMessage {
  kind: "tmux-client-focus-snapshot";
  status: "connected" | "none";
  generation_id: string | null;
  session_name: string | null;
  window_index: number | null;
  pane_id: string | null;
}

/**
 * Worker→main supervisor liveness pulse (mirror `GitLivenessMessage`). The worker
 * posts one on a steady cadence — even during long idle (no focus change ≠
 * unhealthy) — so the supervisor's watchdog can tell a silently-HUNG client
 * (alive but its reader/re-read wedged) from a hard crash (which `onerror`/`close`
 * already catches). NOT folded into the event log — a pure side channel.
 */
export interface TmuxControlLivenessMessage {
  kind: "tmux-control-liveness";
  /** `Date.now()` at which the worker last made forward progress (a reader turn,
   *  a reconnect step, or an idle gate poll). */
  at_ms: number;
}

/**
 * Worker→main whole-server tmux topology observation (epic fn-968). Carries the
 * server `generation_id` and the live pane map `{pane_id, session_name,
 * window_index}`, MAPPED from the SAME framed `list-panes -a` re-read that drives
 * focus — no new tmux command, no subprocess.
 * Main mints ONE `TmuxTopologySnapshot` event carrying `{generation_id, panes}`,
 * byte-identical to the restore-worker poll's payload, which the live-location
 * fold OVERWRITES each matching tmux job's `backend_exec_session_id` +
 * `window_index` from.
 *
 * NEVER posted on a wiping/degraded observation — the worker self-gates on a
 * resolvable generation, a non-empty pane set, and a successful (non-faulting)
 * read; only a successful non-empty read posts, so a blip never clobbers a live
 * location.
 */
export interface TmuxTopologySnapshotMessage {
  kind: "tmux-topology-snapshot";
  generation_id: string;
  panes: TmuxTopologyPane[];
}

export type TmuxControlWorkerMessage =
  | TmuxClientFocusSnapshotMessage
  | TmuxControlLivenessMessage
  | TmuxTopologySnapshotMessage;

// ---------------------------------------------------------------------------
// Pure seams (fast-tier testable — no I/O, no real tmux)
// ---------------------------------------------------------------------------

/**
 * The `-F` format the worker issues for the framed `list-clients` re-read — must
 * match `parseClientLines`'s expected column order exactly:
 *   `#{client_name}\t#{client_control_mode}\t#{client_activity}\t#{client_created}\t#{client_session}`
 */
export const LIST_CLIENTS_FORMAT =
  "#{client_name}\t#{client_control_mode}\t#{client_activity}\t#{client_created}\t#{client_session}";

/**
 * The `-F` format for the framed `list-panes -a` re-read — must match
 * `parsePaneLines`'s expected column order exactly:
 *   `#{window_active}\t#{pane_active}\t#{window_index}\t#{pane_id}\t#{session_name}`
 */
export const LIST_PANES_FORMAT =
  "#{window_active}\t#{pane_active}\t#{window_index}\t#{pane_id}\t#{session_name}";

/**
 * Build the `tmux -N -C attach-session …` argv for the persistent control client.
 * `-N` never starts a server (degrade-and-retry when none runs, never fatal);
 * `-C` is control mode; the `-f` client flags are set ONCE here
 * (`no-output,ignore-size,no-detach-on-destroy`) and never toggled. `-t <anchor>`
 * is the keepalive parking spot only — observation is global, the anchor does not
 * limit what is seen. Pure; the anchor is the caller's pick.
 */
export function buildAttachArgs(anchor: string): string[] {
  return [
    "tmux",
    "-N",
    "-C",
    "attach-session",
    "-f",
    "no-output,ignore-size,no-detach-on-destroy",
    "-t",
    anchor,
  ];
}

/** The structural notifications that mark the focus dirty → schedule a re-read.
 *  A non-structural `%`-verb (e.g. `%output`, `%layout-change`) is observed but
 *  does NOT dirty focus. Kept as a Set so `isStructuralNotification` is O(1). */
const STRUCTURAL_NOTIFICATION_VERBS: ReadonlySet<string> = new Set([
  "session-changed",
  "session-window-changed",
  "window-pane-changed",
  "client-session-changed",
  "sessions-changed",
  "window-add",
  "window-close",
  "client-detached",
]);

/** Whether a parsed notification verb is structural — i.e. it may have changed
 *  which client/session/window/pane is focused, so the worker re-reads. Pure. */
export function isStructuralNotification(verb: string): boolean {
  return STRUCTURAL_NOTIFICATION_VERBS.has(verb);
}

/**
 * The dedup key over a focus observation. DELIBERATELY excludes `client_activity`
 * (and every other informational/tiebreak field): a pure activity bump on the
 * same focused pane is NOT a focus change and must not re-post (mirrors
 * `restore-worker`'s `serializeForHash` field-stripping precedent). Keyed on
 * `(generation_id, status, session_name, window_index, pane_id)` so a server
 * restart (new generation) re-posts even at the same location. Pure.
 */
export function focusDedupKey(
  generationId: string | null,
  derivation: FocusDerivation,
): string {
  if (derivation.status === "none") {
    return JSON.stringify(["none", generationId]);
  }
  return JSON.stringify([
    "focused",
    generationId,
    derivation.session_name,
    derivation.window_index,
    derivation.pane_id,
  ]);
}

/** A live (working/stopped) tmux-backed job exists — the connect gate. Mirrors
 *  `restore-worker.hasLiveTmuxJob`: no live tmux job ⇒ nothing to observe, stay
 *  disconnected (and never hold the server alive). Pure. */
export function hasLiveTmuxJob(jobs: readonly Job[]): boolean {
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (job.backend_exec_type === "tmux") {
      return true;
    }
  }
  return false;
}

/**
 * Pick the anchor session to attach `-t` to: a keepalive parking spot ONLY (the
 * observation is global). Prefer a keeper-managed tmux job's session by most
 * recent activity; fall back to ANY session name present. REJECTS minting a
 * dedicated hidden observer session — a keeper-owned session would hold the
 * server alive, so its pid never flips and the recycle guard never fires.
 *
 * `jobs` supplies the keeper-managed session candidates (a tmux job's
 * `backend_exec_session_id`, most-recent first by the caller's order); `present`
 * is the set of session names the server currently has (from a `list-panes`/
 * `list-clients` read), so a stale job session that no longer exists is skipped.
 * Returns `null` when no live session is available (the caller stays gated). Pure.
 */
export function pickAnchorSession(
  jobs: readonly Job[],
  present: ReadonlySet<string>,
): string | null {
  // Prefer a keeper-managed tmux job's session that still exists on the server.
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") {
      continue;
    }
    if (job.backend_exec_type !== "tmux") {
      continue;
    }
    const session = job.backend_exec_session_id;
    if (session != null && session !== "" && present.has(session)) {
      return session;
    }
  }
  // Fall back to ANY present session — a deterministic lexical-least pick so the
  // choice is stable across reads (the anchor does not affect what is observed).
  let best: string | null = null;
  for (const name of present) {
    if (best === null || name < best) {
      best = name;
    }
  }
  return best;
}

/**
 * The reconnect-backoff state machine — PURE clock/counter arithmetic (mirror
 * `decideGitSeedWatchdog`) so the recovery decision is unit-testable with plain
 * inputs. After a child exit/EOF the worker discards cached ids and reconnects
 * with exponential backoff; a bounded cap escalates to `fatalExit` (no in-process
 * respawn — the LaunchAgent is the single recovery path).
 *
 * Returns:
 *   - `{ action: "retry", delayMs }` — within the cap: wait `delayMs` then
 *     reconnect. `delayMs` doubles per consecutive failure (`base · 2^attempts`),
 *     clamped to `maxDelayMs`.
 *   - `{ action: "escalate" }` — the attempt count reached `maxAttempts`: a
 *     flapping server, crash for a LaunchAgent restart.
 *
 * `attempts` is the count of consecutive failures SO FAR (0 on the first
 * reconnect after a clean run). A clean connect that observes focus resets it to
 * 0 (the caller's job).
 */
export function decideReconnect(inputs: {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}): { action: "retry"; delayMs: number } | { action: "escalate" } {
  const { attempts, baseDelayMs, maxDelayMs, maxAttempts } = inputs;
  if (attempts >= maxAttempts) {
    return { action: "escalate" };
  }
  const raw = baseDelayMs * 2 ** attempts;
  const delayMs = Number.isFinite(raw) ? Math.min(raw, maxDelayMs) : maxDelayMs;
  return { action: "retry", delayMs };
}

/**
 * Derive a focus observation from the two framed reads' raw stdout. Pure glue
 * over the task-1 seams: parse the `list-clients` + `list-panes -a` bodies and
 * pick the current real client's focused pane. Drives both the worker (live) and
 * the fast-tier golden-string tests.
 */
export function deriveFocus(
  clientsBody: string,
  panesBody: string,
): FocusDerivation {
  return pickCurrentClient(
    parseClientLines(clientsBody),
    parsePaneLines(panesBody),
  );
}

/**
 * Map the focus re-read's 5-col `TmuxPaneRow[]` into the whole-server topology
 * pane shape (`paneId→pane_id`, `session→session_name`, `windowIndex→
 * window_index`), stamping an OPTIONAL `job_id` for the keeper job that owns each
 * pane (`pane_id → job.backend_exec_pane_id` over all live tmux jobs — a pane MOVE
 * happens to an already-resolved job, so resolved jobs are joined too). A pane
 * claimed by multiple live jobs is ambiguous and remains unattributed rather
 * than choosing an owner by projection row order. The focus parser's
 * `windowActive`/`paneActive` flags are dropped — topology is whole-server, not
 * the focused pane. Pure; reads only its args.
 */
export function mapPaneRowsToTopology(
  rows: readonly TmuxPaneRow[],
  jobs: readonly Job[],
): TmuxTopologyPane[] {
  const jobByPaneId = new Map<string, string | null>();
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") continue;
    if (job.backend_exec_type !== "tmux" || job.backend_exec_pane_id == null) {
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    if (jobByPaneId.has(paneId)) {
      // More than one live claim is unsafe regardless of query order. `null` is
      // an explicit ambiguous marker; the mapped pane remains unattributed.
      jobByPaneId.set(paneId, null);
    } else {
      jobByPaneId.set(paneId, job.job_id);
    }
  }
  return rows.map((r) => {
    const pane: TmuxTopologyPane = {
      pane_id: r.paneId,
      session_name: r.session,
      window_index: r.windowIndex,
    };
    const jobId = jobByPaneId.get(r.paneId);
    return jobId == null ? pane : { ...pane, job_id: jobId };
  });
}

// ---------------------------------------------------------------------------
// Worker runtime constants
// ---------------------------------------------------------------------------

/** Connect-gate poll cadence (ms): how often the worker re-checks `hasLiveTmuxJob`
 *  while disconnected (no live tmux job ⇒ nothing to observe). */
const CONNECT_GATE_POLL_MS = 1_000;
/** Connected jobs-projection poll cadence. The shared data-version watcher floors
 * this at 25ms; paired with the reread debounce this remains well below the
 * autoclose grace while collapsing write bursts. */
const OWNERSHIP_POLL_MS = 25;
/** Debounce window (ms) for the framed re-read: a notification burst coalesces
 *  into a single re-read rather than re-reading per notification. */
const REREAD_DEBOUNCE_MS = 50;
/** Liveness pulse cadence (ms) — posted even during long idle so a missing pulse
 *  means a STUCK worker, not just a quiet host. */
const LIVENESS_PULSE_MS = 15_000;
/** Reconnect backoff: base delay, ceiling, and the consecutive-failure cap before
 *  `fatalExit` (a flapping server → LaunchAgent restart). */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 8;
/** Worker-shutdown grace (ms) before the worker force-exits. */
const SHUTDOWN_DEADLINE_MS = 2_000;

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

/** Minimal shape of the `Bun.spawn` child the runtime drives — the injection
 *  seam (a test substitutes a synthetic-transcript child with no real fork).
 *  Exported so the fast-tier synthetic-child test can feed a scripted transcript
 *  through {@link runConnection} with no real `tmux -C` fork. */
export interface ControlChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stdin: { write(chunk: string): void; flush?(): void };
  readonly exited: Promise<number>;
  kill(): void;
}

/** Spawn a real `tmux -C` control client under a locale-defaulted env so a
 *  C-locale tmux does not mangle the `\t` `-F` delimiters to `_`. Returns the
 *  child as a `ControlChild`. May throw (ENOENT: no tmux binary; `-N` no server)
 *  — the caller treats a throw as "connect failed" and backs off, never fatal. */
function spawnControlChild(anchor: string): ControlChild {
  const proc = Bun.spawn(buildAttachArgs(anchor), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: localeDefaultedEnv(process.env as Record<string, string | undefined>),
  });
  const stdin = proc.stdin as unknown as {
    write(chunk: string): void;
    flush?(): void;
  };
  return {
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    stdin,
    exited: proc.exited,
    kill: () => {
      try {
        proc.kill();
      } catch {
        // best-effort — the child may already be gone
      }
    },
  };
}

/** Read the live jobs projection (read-only) for the connect gate + anchor pick.
 *  NEVER throws — a transient read failure folds to `[]` (the gate stays closed
 *  this turn; the next poll retries). */
function readJobs(db: Database): Job[] {
  try {
    const res = runQuery(db, 0, {
      type: "query",
      collection: "jobs",
      id: "tmux-control-jobs",
      limit: 0,
    });
    return res.type === "result" ? (res.rows as unknown as Job[]) : [];
  } catch {
    return [];
  }
}

/**
 * Worker entrypoint. Opens a read-only connection, then runs the persistent
 * control-client supervisor loop until told to stop. A BOOT failure (db-open)
 * exits non-zero so the daemon's onerror/close guard fatalExits; a runtime fault
 * (no server, child exit) is handled inline (degrade + backoff) and never escapes.
 */
function main(): void {
  if (!parentPort) {
    console.error(
      "[tmux-control-worker] no parentPort — not running as a Worker",
    );
    process.exit(1);
  }

  const data = workerData as TmuxControlWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[tmux-control-worker] missing dbPath in workerData");
    process.exit(1);
  }

  let db: Database;
  try {
    db = openDb(data.dbPath, {
      readonly: true,
      prepareStmts: false,
      bootRetry: true,
    }).db;
  } catch (err) {
    console.error("[tmux-control-worker] db open failed:", err);
    process.exit(1);
  }

  const port = parentPort;
  const gatePollMs = data.pollMs ?? CONNECT_GATE_POLL_MS;
  let stopping = false;

  const postFocus = (msg: TmuxClientFocusSnapshotMessage): void => {
    if (!stopping) port.postMessage(msg);
  };
  const postTopology = (msg: TmuxTopologySnapshotMessage): void => {
    if (!stopping) port.postMessage(msg);
  };
  const postLiveness = (): void => {
    if (!stopping) {
      port.postMessage({
        kind: "tmux-control-liveness",
        at_ms: Date.now(),
      } satisfies TmuxControlLivenessMessage);
    }
  };

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  // Steady liveness pulse — runs for the worker's whole life (gate-poll, connected,
  // or backing off) so a STUCK supervisor loop (not just a crash) is visible to the
  // watchdog. Cheap (one postMessage per tick); shutdown-gated inside `postLiveness`.
  const livenessTimer = setInterval(postLiveness, LIVENESS_PULSE_MS);
  livenessTimer.unref?.();
  // First pulse immediately so the watchdog has an anchor before the first tick.
  postLiveness();

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      stopping = true;
      const timer = setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS);
      timer.unref?.();
    }
  });

  supervise({
    db,
    gatePollMs,
    isStopping: () => stopping,
    postFocus,
    postTopology,
    postLiveness,
    readJobs: () => readJobs(db),
    spawn: spawnControlChild,
    watchDbChanges: (onChange, isDone) =>
      watchLoop(db, onChange, isDone, OWNERSHIP_POLL_MS),
  })
    .then(() => {
      clearInterval(livenessTimer);
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      // A bounded reconnect-cap breach (or an unexpected supervisor fault) lands
      // here — exit non-zero so the daemon's close guard fatalExits → LaunchAgent
      // restart (the single recovery path; no in-process respawn).
      console.error("[tmux-control-worker] supervisor exited:", err);
      clearInterval(livenessTimer);
      closeDb();
      process.exit(1);
    });
}

/** Sleep that resolves early when shutdown is requested (polled), so teardown is
 *  not blocked behind a long backoff. */
async function interruptibleSleep(
  ms: number,
  isStopping: () => boolean,
): Promise<void> {
  const STEP = 100;
  let remaining = ms;
  while (remaining > 0 && !isStopping()) {
    const slice = Math.min(STEP, remaining);
    await Bun.sleep(slice);
    remaining -= slice;
  }
}

/** Thrown by `runConnection` to signal the child went away (exit / EOF / SIGPIPE)
 *  so the supervisor discards cached ids and backs off. NOT an error condition —
 *  a control-flow signal. */
class ChildGoneError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ChildGoneError";
  }
}

/**
 * The persistent control-client supervisor. Loops forever: gate on a live tmux
 * job, pick an anchor, spawn the `tmux -C` child, run one connection to exhaustion,
 * then — on the child going away — discard cached ids, back off (bounded), and
 * reconnect. Resolves only when `isStopping()` becomes true; rejects only on a
 * reconnect-cap breach (escalate to a process restart).
 */
async function supervise(ctx: {
  db: Database;
  gatePollMs: number;
  isStopping: () => boolean;
  postFocus: (msg: TmuxClientFocusSnapshotMessage) => void;
  postTopology: (msg: TmuxTopologySnapshotMessage) => void;
  postLiveness: () => void;
  readJobs: () => Job[];
  spawn: (anchor: string) => ControlChild;
  watchDbChanges: (
    onChange: () => void,
    isDone: () => boolean,
  ) => Promise<void>;
}): Promise<void> {
  let attempts = 0;
  while (!ctx.isStopping()) {
    // Connect gate — no live tmux job ⇒ nothing to observe (and never hold the
    // server alive). Poll until one appears.
    const jobs = readJobs(ctx.db);
    if (!hasLiveTmuxJob(jobs)) {
      ctx.postLiveness();
      await interruptibleSleep(ctx.gatePollMs, ctx.isStopping);
      continue;
    }

    let child: ControlChild | null = null;
    let madeProgress = false;
    try {
      // Anchor must be a session that actually exists on the server. We do not
      // have a topology read yet, so accept any live tmux job's session; an attach
      // to a vanished session simply fails and we back off. (The first framed read
      // after attach corrects the picture.)
      const anchor = pickAnchorForConnect(jobs);
      if (anchor === null) {
        // A live tmux job with no resolvable session name yet — wait a beat.
        await interruptibleSleep(ctx.gatePollMs, ctx.isStopping);
        continue;
      }
      child = ctx.spawn(anchor);
      // `runConnection` resolves with whether it made forward progress (read +
      // posted at least one focus observation) so a healthy long-lived connection
      // that finally drops resets the backoff.
      madeProgress = await runConnection(child, ctx);
    } catch {
      // An unexpected fault (spawn ENOENT, no server, parser bug) — treat as a
      // failed connect and back off, never escalate on a no-server condition.
    } finally {
      if (child) child.kill();
    }

    if (ctx.isStopping()) break;

    // The child went away. tmux reuses ids across restarts, so the next connection
    // re-reads everything from scratch (all cached ids lived inside the connection
    // scope and are gone with it). A connection that made progress resets the
    // consecutive-failure counter; a connect that never read keeps counting toward
    // the cap. Back off, bounded.
    if (madeProgress) attempts = 0;
    attempts++;
    const decision = decideReconnect({
      attempts,
      baseDelayMs: RECONNECT_BASE_DELAY_MS,
      maxDelayMs: RECONNECT_MAX_DELAY_MS,
      maxAttempts: RECONNECT_MAX_ATTEMPTS,
    });
    if (decision.action === "escalate") {
      // Degrade focus observation in place rather than escalating a daemon
      // restart: a restart cannot recover a persistent control-mode
      // incompatibility, so escalating would crash-loop the whole daemon over a
      // non-critical feature. Stay gated at the max backoff and keep retrying —
      // a connect that later makes progress resets the counter and restores
      // observation.
      if (attempts === RECONNECT_MAX_ATTEMPTS) {
        console.error(
          "[tmux-control-worker] focus observation degraded — control client could not sustain a connection; retrying at max backoff, daemon stays up",
        );
      }
      attempts = RECONNECT_MAX_ATTEMPTS;
      ctx.postLiveness();
      await interruptibleSleep(RECONNECT_MAX_DELAY_MS, ctx.isStopping);
      continue;
    }
    ctx.postLiveness();
    await interruptibleSleep(decision.delayMs, ctx.isStopping);
  }
}

/** Pre-attach anchor pick. Without a fresh topology read the worker cannot know
 *  which session names the server currently has, so it treats every live tmux
 *  job's own session as a candidate (`present` = the job sessions). A vanished
 *  session just fails the attach → backoff; the framed read after attach corrects
 *  the picture. Delegates to the {@link pickAnchorSession} seam. */
function pickAnchorForConnect(jobs: readonly Job[]): string | null {
  const present = new Set<string>();
  for (const job of jobs) {
    if (job.state !== "working" && job.state !== "stopped") continue;
    if (job.backend_exec_type !== "tmux") continue;
    const session = job.backend_exec_session_id;
    if (session != null && session !== "") present.add(session);
  }
  return pickAnchorSession(jobs, present);
}

/**
 * Run ONE control connection to exhaustion. Owns the dedicated stdout reader (a
 * non-blocking drain into the parser), the debounced single-in-flight framed
 * re-read, generation read, and focus posting. Returns when the child goes away
 * (clean EOF) and throws {@link ChildGoneError} on a `%exit`. NEVER blocks the
 * reader on a DB write or a command round-trip.
 *
 * Bootstrap order on connect: re-assert `no-output` (never toggle), defensive
 * `copy-mode -q`, read the server generation FIRST, then the initial framed
 * focus read. A tmux notification or DB wake landing mid-re-read re-arms dirty
 * and re-reads once.
 */
export async function runConnection(
  child: ControlChild,
  ctx: {
    isStopping: () => boolean;
    postFocus: (msg: TmuxClientFocusSnapshotMessage) => void;
    postTopology: (msg: TmuxTopologySnapshotMessage) => void;
    postLiveness: () => void;
    readJobs: () => Job[];
    /** Connection-scoped jobs-projection change watcher. Production supplies the
     * shared read-only `PRAGMA data_version` loop; tests may inject a deterministic
     * trigger. It starts before bootstrap and resolves after `isDone()` flips. */
    watchDbChanges?: (
      onChange: () => void,
      isDone: () => boolean,
    ) => Promise<void> | void;
  },
): Promise<boolean> {
  const decoder = new TextDecoder();
  const lineBuf = new LineBuffer();

  // Framed-command correlation via a FIFO queue of pending replies. Commands are
  // issued STRICTLY SERIALLY (each `await sendCommand` resolves before the next is
  // sent), and tmux replies in command order, so the queue never holds more than
  // one waiter in practice — but the QUEUE (rather than a single slot) is what
  // makes the leading UNSOLICITED reply block deterministic to drop: on attach
  // tmux emits its own `%begin`/`%end` handshake block (plus a `%session-changed`)
  // BEFORE any command of ours. Because the first command is sent only AFTER the
  // reader has drained one COMPLETE reply event against the empty queue (that
  // handshake block — see `handshakeSettled` below), the handshake block is dropped
  // with an empty queue and a reply is never mis-matched to the wrong command's
  // resolver. The handshake's `%end` may split into a later read; a connection-
  // scoped stateful parser reassembles it, so the drop is deterministic regardless
  // of read boundaries. The reader NEVER awaits a DB write; it only buffers lines +
  // resolves queue heads.
  type ReplyResolver = (lines: readonly string[]) => void;
  const replyQueue: ReplyResolver[] = [];

  // Resolves once the reader has drained ONE complete reply event against an
  // EMPTY queue — i.e. tmux's unsolicited attach handshake `%begin`/`%end` block
  // has fully settled (its `%end` may arrive in a later read; the connection-
  // scoped parser reassembles it). The bootstrap awaits this before sending its
  // first command so that handshake reply can never FIFO-match one of our
  // resolvers. Gating on a settled reply — not on "processed a chunk with a
  // line" — makes the drop deterministic regardless of read boundaries.
  let resolveHandshake: () => void = () => {};
  const handshakeSettled = new Promise<void>((r) => {
    resolveHandshake = r;
  });

  /** Resolve the queue head (FIFO). A reply with an empty queue (the unsolicited
   *  attach handshake block) is dropped — and that empty-queue drop is exactly
   *  the signal that releases the bootstrap (`resolveHandshake`). */
  const settleHead = (lines: readonly string[]): void => {
    const waiter = replyQueue.shift();
    if (waiter) {
      waiter(lines);
      return;
    }
    // Empty queue: an unsolicited reply (the attach handshake block). Dropping it
    // here is the deterministic bootstrap-release signal.
    resolveHandshake();
  };
  /** Drain every still-pending waiter (child gone / teardown) so an in-flight
   *  `runReread` unblocks instead of hanging. */
  const drainPending = (): void => {
    while (replyQueue.length > 0) {
      const waiter = replyQueue.shift();
      if (waiter) waiter([]);
    }
  };
  let generationId: string | null = null;
  let lastPostedKey: string | null = null;
  // Per-connection topology dedup, scoped EXACTLY like `lastPostedKey`: a steady
  // topology never re-posts within a connection; a reconnect (a fresh scope) re-
  // reads + re-posts from scratch (ids are reused across server restarts).
  let lastPostedTopologyKey: string | null = null;
  let madeProgress = false;
  let exited = false;
  let exitReason: string | null = null;

  // Dirty/re-read coordination — a single-in-flight, debounced re-read. A tmux
  // notification OR a jobs-projection commit sets `dirty`; if a re-read is in
  // flight, `redirty` re-arms so the worker re-reads exactly once more after it
  // completes.
  let dirty = true; // bootstrap: read once on connect
  let rereadInFlight = false;
  let redirty = false;
  let rereadTimer: ReturnType<typeof setTimeout> | null = null;

  /** Send a framed command and resolve with its reply body lines (matched FIFO to
   *  the next reply). Rejects with {@link ChildGoneError} if the stdin write fails
   *  (child gone). Caller MUST await before sending the next command. */
  const sendCommand = (text: string): Promise<readonly string[]> =>
    new Promise<readonly string[]>((resolve, reject) => {
      replyQueue.push(resolve);
      try {
        child.stdin.write(`${text}\n`);
        child.stdin.flush?.();
      } catch (err) {
        // Roll back the just-pushed waiter and fail it.
        const idx = replyQueue.indexOf(resolve);
        if (idx >= 0) replyQueue.splice(idx, 1);
        reject(new ChildGoneError(`stdin write failed: ${String(err)}`));
      }
    });

  // The reader loop: drain stdout, frame into lines, parse, dispatch. Runs
  // concurrently with the bootstrap/re-read logic below. NEVER blocks on a DB
  // write — it resolves the in-flight command waiter and flags dirty on a
  // structural notification; the re-read + post happen on the awaiting side.
  const readerDone = (async (): Promise<void> => {
    const reader = child.stdout.getReader();
    // Connection-scoped, stateful parser: `%begin`/`%end` framing state survives
    // across reads, so a reply block (notably the unsolicited attach handshake)
    // whose `%end` lands in a LATER read reassembles into ONE reply event.
    const parser = createControlStreamParser();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        ctx.postLiveness();
        let lines: string[];
        try {
          lines = lineBuf.push(decoder.decode(value, { stream: true }));
        } catch (err) {
          if (err instanceof OversizedLineError) {
            // A pathological oversized line (should not happen with no-output) —
            // drop the buffer's tail by treating it as a fresh read; never crash.
            continue;
          }
          throw err;
        }
        if (lines.length === 0) continue;
        // Feed the accumulated complete lines into the stateful parser. An open
        // `%begin` block is carried forward; its `%end` in a later feed completes
        // the reply — so a split handshake never leaks an early bootstrap release.
        const events = parser.feed(`${lines.join("\n")}\n`);
        for (const ev of events) {
          if (ev.kind === "reply") {
            // Resolve the FIFO head; a reply with an empty queue (the unsolicited
            // attach handshake block) is dropped AND releases the bootstrap.
            settleHead(ev.lines);
          } else if (ev.kind === "exit") {
            exited = true;
            exitReason = ev.reason ?? null;
          } else if (ev.kind === "notification") {
            if (isStructuralNotification(ev.verb)) {
              dirty = true;
              scheduleReread();
            }
          }
        }
        if (exited) break;
      }
    } finally {
      reader.releaseLock();
      // Release a bootstrap still blocked on the handshake (a child that died
      // before emitting a complete reply block) so teardown does not hang.
      resolveHandshake();
      // The child's stream ended (EOF or `%exit`). Unblock every command awaiting
      // a reply that will now never arrive, so a `runReread` in flight settles
      // instead of hanging the connection teardown.
      drainPending();
    }
  })();

  /** Schedule the debounced re-read. Coalesces a tmux/DB burst into one re-read;
   *  a request arriving while a re-read is in flight sets `redirty` so exactly
   *  one more re-read runs after. */
  function scheduleReread(): void {
    if (rereadTimer !== null) return;
    rereadTimer = setTimeout(() => {
      rereadTimer = null;
      void runReread();
    }, REREAD_DEBOUNCE_MS);
    rereadTimer.unref?.();
  }

  /** The single-in-flight framed re-read: read the server generation if unknown,
   *  then `list-clients` + `list-panes -a`, derive focus AND topology (one parse),
   *  dedup each, post on change. Re-arms once if a notification landed mid-read. */
  async function runReread(): Promise<void> {
    if (rereadInFlight) {
      redirty = true;
      return;
    }
    if (!dirty) return;
    rereadInFlight = true;
    dirty = false;
    try {
      // Read the server generation FIRST if we do not have it yet — on a fresh
      // connection all cached ids are gone, so the generation is read before
      // anything is posted.
      if (generationId === null) {
        const generationLines = await sendCommand(
          "display-message -p '#{pid}:#{start_time}'",
        );
        // Mint through the SOLE builder — the topology stream and the
        // restore-worker boundary pulse share one format, so a probe-format
        // change can never fork one server boot into two generations.
        generationId = buildGenerationId(generationLines[0] ?? "");
      }
      const clientsBody = (
        await sendCommand(`list-clients -F '${LIST_CLIENTS_FORMAT}'`)
      ).join("\n");
      const panesBody = (
        await sendCommand(`list-panes -a -F '${LIST_PANES_FORMAT}'`)
      ).join("\n");
      // ONE parse of the two framed reads → BOTH the focus pick AND the full pane
      // set the topology emit maps. The focus half is byte-identical to the prior
      // `deriveFocus`.
      const { focus: derivation, panes: paneRows } = deriveFocusAndPanes(
        clientsBody,
        panesBody,
      );
      // A completed read (even a `none`) is forward progress — it resets the
      // supervisor's reconnect-backoff counter.
      madeProgress = true;
      const key = focusDedupKey(generationId, derivation);
      if (key !== lastPostedKey) {
        lastPostedKey = key;
        ctx.postFocus(
          derivation.status === "focused"
            ? {
                kind: "tmux-client-focus-snapshot",
                status: "connected",
                generation_id: generationId,
                session_name: derivation.session_name,
                window_index: derivation.window_index,
                pane_id: derivation.pane_id,
              }
            : {
                kind: "tmux-client-focus-snapshot",
                status: "none",
                generation_id: generationId,
                session_name: null,
                window_index: null,
                pane_id: null,
              },
        );
      }
      // Topology emit — relocated from the restore-worker poll, riding the SAME
      // framed re-read. Skip-gates (all NO-posts, never a wiping snapshot that
      // would clobber a live job location):
      //  1. null generation — no recycle key to stamp;
      //  2. emit-gate `hasLiveTmuxJob` — pointless with no jobs to locate;
      //  3. empty pane set — a wiping empty topology would clobber every location;
      //  4. read-fault — handled by the outer `catch` (no post).
      // Deduped via the SHARED `hashTopology` over physical coordinates PLUS
      // optional owner identity. A true duplicate stays silent, while a DB-only
      // ownership acquisition/removal/transfer re-posts steady physical rows.
      if (generationId !== null) {
        const jobs = ctx.readJobs();
        if (hasLiveTmuxJob(jobs)) {
          const panes = mapPaneRowsToTopology(paneRows, jobs);
          if (panes.length > 0) {
            const topoKey = hashTopology(generationId, panes);
            if (topoKey !== lastPostedTopologyKey) {
              lastPostedTopologyKey = topoKey;
              ctx.postTopology({
                kind: "tmux-topology-snapshot",
                generation_id: generationId,
                panes,
              });
            }
          }
        }
      }
    } catch {
      // A re-read fault (child went away mid-command) — let the reader's EOF/exit
      // path drive teardown; do not post a wiping snapshot here.
    } finally {
      rereadInFlight = false;
      // A notification landed mid-read (or the bootstrap dirty is still set) →
      // re-read exactly once more.
      if (redirty || dirty) {
        redirty = false;
        dirty = true;
        scheduleReread();
      }
    }
  }

  // Start the connection-scoped data-version watcher BEFORE bootstrap. Its
  // baseline read happens before the initial topology read: a commit before the
  // baseline is included by bootstrap, while one after it requests a reread. A
  // commit during an in-flight reread redirties the serialized loop, so no
  // initialization or refresh window can permanently lose ownership.
  let watchDone = false;
  let ownershipWatch: Promise<void> | null = null;
  if (ctx.watchDbChanges) {
    try {
      ownershipWatch = Promise.resolve(
        ctx.watchDbChanges(
          () => {
            dirty = true;
            scheduleReread();
          },
          () => watchDone || ctx.isStopping(),
        ),
      ).catch((err) => {
        // The shared watcher already tolerates transient SQLITE_NOTADB. Any other
        // failure is diagnostic; bootstrap/structural notifications remain live.
        console.error(
          `[tmux-control-worker] ownership watcher stopped: ${String(err)}`,
        );
      });
    } catch (err) {
      console.error(
        `[tmux-control-worker] ownership watcher failed to start: ${String(err)}`,
      );
    }
  }

  // Bootstrap the connection. WAIT for the unsolicited attach handshake to fully
  // settle first — tmux emits its own `%begin`/`%end` handshake block on attach,
  // which must be drained (and dropped, the reply queue being empty) BEFORE we
  // enqueue any command, or that block would FIFO-match our first command's
  // resolver. Gating on the handshake reply having SETTLED (not on "a chunk with a
  // line arrived") keeps the drop deterministic even when the handshake's `%end`
  // splits into a later read. Then re-assert no-output (NEVER toggle) and send the
  // defensive copy-mode, AWAITED in order so their reply blocks drain before the
  // first focus read. A child-gone mid-bootstrap settles via the reader's EOF/exit
  // path.
  void (async (): Promise<void> => {
    await handshakeSettled;
    try {
      await sendCommand("refresh-client -f no-output");
      await sendCommand("copy-mode -q");
    } catch {
      // Child already gone — the reader will EOF; fall through.
    }
    // Kick the initial framed read once the bootstrap replies have drained.
    scheduleReread();
  })();

  // Wait for the connection to end: either the reader finishes (EOF) or a `%exit`
  // was seen. BOTH are "child gone" — tmux reuses ids across restarts, so the next
  // connection re-bootstraps from scratch (the cached ids + generation lived in
  // THIS scope and are gone with it). The `%exit` reason string is version-
  // dependent and deliberately ignored. The supervisor backs off + reconnects;
  // neither path is an error.
  await readerDone;
  watchDone = true;
  if (ownershipWatch !== null) {
    await ownershipWatch;
  }
  if (rereadTimer !== null) {
    clearTimeout(rereadTimer);
    rereadTimer = null;
  }
  // Settle any in-flight commands so a `runReread` mid-flight unblocks.
  drainPending();
  if (exited) {
    console.error(
      `[tmux-control-worker] control client %exit${
        exitReason ? ` (${exitReason})` : ""
      } — reconnecting`,
    );
  }
  return madeProgress;
}

// Only run inside a real Worker; a plain import on the main thread (the fast-tier
// pure-fn tests) is inert.
if (!isMainThread) {
  main();
}
