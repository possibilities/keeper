/**
 * tmux window-reaper worker (epic fn-802). keeperd's twelfth Bun Worker
 * thread, joining the producer / consumer fleet. A PURE EXTERNAL ACTUATOR:
 * it opens its own read-only connection, watches the `jobs`/`epics`
 * projections (level-triggered on `PRAGMA data_version` via the shared
 * `watchLoop` primitive PLUS a coarse periodic tick), and on every cycle
 * kills the tmux WINDOW of any autopilot-dispatched job whose work is
 * VERIFIABLY complete — stopped past {@link REAP_STOPPED_AGE_SEC} with a
 * `{tag:"completed"}` readiness verdict.
 *
 * It reads the projections read-only and writes ONLY to tmux (`kill-window`);
 * it NEVER writes the DB and posts NOTHING to main beyond the lifecycle
 * close/error events the daemon already wires. The existing exit-watcher →
 * synthetic `Killed` mint (pid + start_time match) is the SOLE truth of the
 * row's death — the kill is fire-and-forget, never assumed to have sufficed
 * (a SIGHUP-absorbing process leaves the row stopped; the cooldown bounds the
 * retry churn and the existing backstops own the residual).
 *
 * The periodic tick is LOAD-BEARING, not telemetry: the age threshold
 * elapsing writes NOTHING to the DB, so no `data_version` pulse fires when a
 * candidate merely ages past the bar — time itself must wake the cycle. Both
 * feeders call the same single-flight `driveCycle`.
 *
 * Each cycle:
 *  1. `loadReconcileSnapshot(db)` — the same snapshot autopilot reconciles
 *     against (includes the merged recently-done epics read that makes
 *     close-row `completed` verdicts observable).
 *  2. `computeReadiness(...)` at unix-SECONDS now (never ms).
 *  3. {@link selectReapCandidates} — the FULL predicate, every clause.
 *  4. Per candidate, skip if inside the in-memory kill cooldown.
 *  5. Immediately before each kill, re-run steps 1-3 fresh and require the
 *     SAME job to pass the full predicate again — a resume that flipped the
 *     verdict aborts the kill (the CWE-367 TOCTOU mitigation).
 *  6. `backend.killWindow(paneId)`; stamp the cooldown; one stderr audit line
 *     per attempt. Failures are non-fatal skips.
 *
 * Worker contract (see CLAUDE.md "Worker contract"):
 *  - `isMainThread` guard — a plain import is inert.
 *  - Own read-only `openDb` connection (`prepareStmts:false`, `bootRetry:true`).
 *  - Typed message protocol: `{type:"shutdown"}` main→worker ONLY; NO
 *    worker→main message. Exit 0 clean / 1 crash.
 *  - Subsystem-style teardown: the read-only DB connection is closed and the
 *    periodic interval cleared in the shutdown path before `process.exit(0)`.
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { loadReconcileSnapshot } from "./autopilot-worker";
import { openDb } from "./db";
import {
  createTmuxPaneOps,
  MANAGED_AUTOCLOSE_SESSIONS,
  MANAGED_EXEC_SESSION,
  type TmuxPaneOps,
} from "./exec-backend";
import { computeReadiness, type ReadinessSnapshot } from "./readiness";
import { readOsStartTime } from "./seed-sweep";
import { isPidAlive, type runQuery } from "./server-worker";
import type { Job } from "./types";
import { watchLoop } from "./wake-worker";

/**
 * Data the parent passes via `new Worker(url, { workerData })`. Only the DB
 * path crosses the boundary — the read-only connection is opened on the
 * worker thread, not handed across (handles are thread-affine).
 */
export interface ReaperWorkerData {
  dbPath: string;
  /**
   * Poll cadence in ms for the underlying `data_version` watch. Optional;
   * defaults to {@link watchLoop}'s default. Threaded through workerData for
   * parity with the other consumer workers.
   */
  pollMs?: number;
  /**
   * Coarse periodic-tick cadence in ms. Optional; defaults to
   * {@link DEFAULT_REAP_TICK_MS}. The tick is LOAD-BEARING (the age threshold
   * elapsing writes nothing, so a pulse never fires on aging alone).
   */
  tickMs?: number;
  /**
   * Operator opt-out: keeper-managed session names whose stopped tracked windows
   * the managed-session arm leaves OPEN. Threaded from `resolveConfig().
   * disableAutoclose` at the single populate site. Default empty (every managed
   * session autocloses). NEVER includes {@link MANAGED_EXEC_SESSION} — the
   * autopilot session rides the verdict-gated arm.
   */
  disableAutoclose?: string[];
  /**
   * Operator opt-out for the ORPHAN-process arm (epic fn-934): a list of
   * exe-signature SUBSTRINGS to exempt from reaping. An entry that matches a
   * candidate's resolved exe-path vetoes its candidacy. Threaded from
   * `resolveConfig().disableOrphanReap`. Default empty (every allow-listed
   * runaway class is reapable). Mirrors {@link disableAutoclose}'s shape.
   */
  disableOrphanReap?: string[];
}

/** Message the parent sends to ask the worker to stop. */
export interface ShutdownMessage {
  type: "shutdown";
}

/**
 * The completed-and-stopped age threshold (unix SECONDS). A row must have been
 * `stopped` for longer than this before it's reapable. Deliberately tight —
 * the done-AND-idle `{tag:"completed"}` verdict and the immediate pre-kill
 * re-check carry the safety; this bar only debounces the stop-instant
 * `data_version` pulse so a window never dies the same instant its row lands.
 */
export const REAP_STOPPED_AGE_SEC = 1;

/**
 * Idle grace (unix SECONDS) for the managed-session arm. Longer than
 * {@link REAP_STOPPED_AGE_SEC} because that arm carries NO readiness verdict —
 * the allow-list + this grace are its whole safety margin. The CLI captures the
 * partner's answer SYNCHRONOUSLY (`wait-for-stop`/`show-last-message`) the
 * instant the Stop lands, so the window is dead weight once stopped; this grace
 * only keeps a just-stopped window alive long enough that a human glancing at it
 * (or a slow capture read) isn't racing the reaper.
 */
export const REAP_MANAGED_SESSION_IDLE_SEC = 30;

/**
 * In-memory kill cooldown (unix SECONDS). After an attempt, the same job is
 * suppressed for this long so a SIGHUP-absorbing process or an already-gone
 * window doesn't re-spawn tmux every cycle. In-memory ONLY — a restart
 * re-derives and re-kills once (idempotent no-op against a closed window).
 */
export const REAP_KILL_COOLDOWN_SEC = 10 * 60;

/** Default periodic-tick cadence (ms). ~1s — matches the tight age bar so an
 *  aged candidate is reaped within a tick of crossing it (done window dies in
 *  ~1-2s). The cycle is a few read-only queries over small projections, so the
 *  1s idle cadence is cheap. */
export const DEFAULT_REAP_TICK_MS = 1000;

/**
 * One reap the decision emits: the job whose window to kill and the pane id
 * that targets it (the stable `%N` handle, rename-proof — a concurrent
 * renamer can't redirect it). The remaining fields ride along for the audit
 * line. The autopilot verdict arm sets `verb`/`plan_ref` (its discriminators);
 * the managed-session arm sets `session` instead (its jobs carry NULL
 * `plan_verb`/`plan_ref`). The two arms are disjoint, so exactly one shape fires
 * per job.
 */
export interface ReapCandidate {
  job_id: string;
  pane_id: string;
  /** Autopilot arm: the `plan_verb`. NULL for a managed-session candidate. */
  verb: string | null;
  /** Autopilot arm: the `plan_ref`. NULL for a managed-session candidate. */
  plan_ref: string | null;
  /**
   * Managed-session arm: the resolved birth/live session name driving the kill.
   * NULL for an autopilot candidate (its session is always
   * {@link MANAGED_EXEC_SESSION}).
   */
  session?: string | null;
}

/**
 * The FULL reap predicate over a snapshot + readiness pass at a fixed `now`
 * (unix seconds), honoring the in-memory cooldown map. Pure — tests drive it
 * with no DB and a fake `killWindow`. Returns candidates in ascending
 * `job_id` order for a deterministic fire order and stable assertions.
 *
 * A row is a candidate iff ALL hold:
 *  - `backend_exec_session_id === MANAGED_EXEC_SESSION` (autopilot's session;
 *    a human-created session is never touched),
 *  - `plan_verb ∈ {work, close}` with a non-null `plan_ref` (approve rows are
 *    excluded by the verb filter even though they get `perTask` verdicts),
 *  - `state === 'stopped'` AND `now - updated_at > REAP_STOPPED_AGE_SEC`,
 *  - non-null `backend_exec_pane_id` AND non-null `pid` (a NULL-pid row is
 *    degenerate bookkeeping the exit-watcher's pidless path terminalizes;
 *    killing on its evidence is risk without payoff),
 *  - the verdict looked up BY VERB is `{tag:"completed"}`: work →
 *    `perTask[plan_ref]`, close → `perCloseRow[plan_ref]`. NEVER "try both
 *    maps" — the verb filter is what excludes the approve rows that also carry
 *    a `perTask` verdict.
 *
 * `cooldown` (job_id → last-attempt unix-seconds) suppresses a candidate while
 * `now - lastAttempt < REAP_KILL_COOLDOWN_SEC`.
 */
export function selectReapCandidates(
  jobs: Iterable<Job>,
  readiness: ReadinessSnapshot,
  now: number,
  cooldown: Map<string, number>,
): ReapCandidate[] {
  const out: ReapCandidate[] = [];
  for (const job of jobs) {
    if (job.backend_exec_session_id !== MANAGED_EXEC_SESSION) {
      continue;
    }
    const verb = job.plan_verb;
    if (verb !== "work" && verb !== "close") {
      continue;
    }
    const planRef = job.plan_ref;
    if (planRef == null || planRef === "") {
      continue;
    }
    if (job.state !== "stopped") {
      continue;
    }
    if (now - job.updated_at <= REAP_STOPPED_AGE_SEC) {
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    if (paneId == null || paneId === "") {
      continue;
    }
    if (job.pid == null) {
      continue;
    }
    // Verdict looked up BY VERB — never both maps. Task ids and epic ids never
    // collide (`fn-N-slug.M` vs `fn-N-slug`), but the verb filter is what keeps
    // an approve row (which also gets a perTask verdict) out of the reap set.
    const verdict =
      verb === "work"
        ? readiness.perTask.get(planRef)
        : readiness.perCloseRow.get(planRef);
    if (verdict?.tag !== "completed") {
      continue;
    }
    // In-memory cooldown: a recent attempt suppresses this job (a
    // SIGHUP-absorbing process or already-gone window must not re-spawn tmux
    // every cycle). A close job whose epic aged out of the merged-done window
    // reads no verdict above and is simply never reaped — accepted aging bound.
    const last = cooldown.get(job.job_id);
    if (last !== undefined && now - last < REAP_KILL_COOLDOWN_SEC) {
      continue;
    }
    out.push({ job_id: job.job_id, pane_id: paneId, verb, plan_ref: planRef });
  }
  out.sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0));
  return out;
}

/**
 * The managed-session reap arm (epic fn-920) — the SECOND, verdict-free arm.
 * Autocloses any stopped tracked NON-plan job launched into a keeper-managed
 * session (`pair`/`panels`/`agentbus`) past the idle grace. It reads ONLY the
 * `jobs` projection + an idle clock — NO readiness verdict (these jobs carry no
 * `plan_ref`, so there is no verdict to look up; the Stop hook landing `state =
 * 'stopped'` is the authoritative done signal). Pure: tests drive it with no DB.
 *
 * A row is a candidate iff ALL hold:
 *  - `plan_verb IS NULL` — a tracked NON-plan job (a pair/panel/agentbus
 *    partner). A plan-verb job is the autopilot arm's domain.
 *  - `(backend_exec_session_id ?? backend_exec_birth_session_id)` ∈
 *    {@link MANAGED_AUTOCLOSE_SESSIONS} — the COALESCE onto the FROZEN
 *    birth-session matters: a fresh pair job reads a NULL live session until the
 *    first `TmuxTopologySnapshot` resolves it, and the birth-session
 *    (`KEEPER_TMUX_SESSION` at spawn) is stamped ONLY on keeper's own launches.
 *    This allow-list — NOT `plan_verb IS NULL` alone — is what keeps the arm off
 *    a human's hand-started claude window (which also folds to NULL `plan_verb`).
 *  - that resolved session is NOT in `disableAutoclose` — the operator opt-out.
 *  - `state === 'stopped'` AND `now - updated_at > REAP_MANAGED_SESSION_IDLE_SEC`.
 *  - non-null `backend_exec_pane_id` AND non-null `pid` (same degeneracy guard as
 *    the autopilot arm).
 *  - not inside the shared in-memory kill cooldown.
 *
 * The autopilot session ({@link MANAGED_EXEC_SESSION}) is DELIBERATELY absent
 * from {@link MANAGED_AUTOCLOSE_SESSIONS}, so the two arms never overlap and no
 * job is double-handled. Returns candidates in ascending `job_id` order.
 */
export function selectManagedSessionReapCandidates(
  jobs: Iterable<Job>,
  now: number,
  cooldown: Map<string, number>,
  disableAutoclose: ReadonlySet<string>,
  idleSec: number = REAP_MANAGED_SESSION_IDLE_SEC,
): ReapCandidate[] {
  const out: ReapCandidate[] = [];
  for (const job of jobs) {
    // NON-plan jobs only — a plan-verb job belongs to the autopilot arm.
    if (job.plan_verb != null && job.plan_verb !== "") {
      continue;
    }
    // COALESCE the LIVE session onto the FROZEN birth-session: a fresh pair job
    // reads a NULL live session until TmuxTopologySnapshot resolves the pane.
    const session =
      job.backend_exec_session_id ?? job.backend_exec_birth_session_id;
    if (session == null || !MANAGED_AUTOCLOSE_SESSIONS.has(session)) {
      continue;
    }
    // The operator opt-out: a managed session a human is debugging stays open.
    if (disableAutoclose.has(session)) {
      continue;
    }
    if (job.state !== "stopped") {
      continue;
    }
    if (now - job.updated_at <= idleSec) {
      continue;
    }
    const paneId = job.backend_exec_pane_id;
    if (paneId == null || paneId === "") {
      continue;
    }
    if (job.pid == null) {
      continue;
    }
    const last = cooldown.get(job.job_id);
    if (last !== undefined && now - last < REAP_KILL_COOLDOWN_SEC) {
      continue;
    }
    out.push({
      job_id: job.job_id,
      pane_id: paneId,
      verb: null,
      plan_ref: null,
      session,
    });
  }
  out.sort((a, b) => (a.job_id < b.job_id ? -1 : a.job_id > b.job_id ? 1 : 0));
  return out;
}

// ---------------------------------------------------------------------------
// Orphan-process reap arm (epic fn-934) — the THIRD, raw-process arm
// ---------------------------------------------------------------------------
//
// Unlike the two tmux-window arms above (which read `jobs` rows and kill via
// `killWindow`), this arm reaps RAW OS PROCESSES that agent test activity left
// running on the shared host: orphaned `bun test` worker trees, infinite-loop
// shell harnesses, leaked `flock_peer` fixtures. The incident: ~28 orphaned
// `while :; do :; done` harnesses + 2 leaked fixtures pegged the host to load
// ~188 on 10 cores and starved keeperd to 0.9% CPU.
//
// Killing the WRONG process is catastrophic, so the kill GATE is a CLOSED
// CONJUNCTION (every clause load-bearing, none optional):
//   uid == self                     — never another user's process
//   AND proc-info read succeeded     — a partial/failed read is can't-confirm
//   AND ppid == 1                    — a reparented orphan (its parent is gone)
//   AND exe_path matches the CLOSED  — match the EXE PATH, never the spoofable,
//       allow-list (minus exemptions)  16-char-truncated process NAME
//   AND age > minAge                 — launch-race guard (several minutes)
//   AND pid ∉ keeper's live set      — never keeperd or a live plan worker
//
// It NEVER throws — every probe/kill failure is a logged non-fatal skip (a
// throw would crash the worker via onerror→fatalExit). Escalation is two-phase
// WITHOUT a blocking in-cycle sleep: a first match sends SIGTERM and stamps an
// in-memory `(pid,start_time)` cooldown; the NEXT tick that still sees the SAME
// `(pid,start_time)` alive escalates to SIGKILL.

/**
 * Minimum age (unix SECONDS) before an orphan is reapable. A launch-race guard:
 * a just-spawned test worker can momentarily read `ppid == 1` during the parent
 * handoff, and a legitimate short-lived process must be allowed to finish on its
 * own. Several minutes — orphaned runaways live indefinitely, so the bar costs
 * nothing against a true runaway while excluding every transient.
 */
export const ORPHAN_MIN_AGE_SEC = 5 * 60;

/**
 * Two-phase escalation grace (unix SECONDS): after a SIGTERM the SAME
 * `(pid,start_time)` must still be alive on a LATER tick before SIGKILL. The
 * tick re-derives the census every cycle, so this is simply "seen alive on a
 * subsequent tick" — no in-cycle blocking sleep. Tighter than the kill cooldown
 * because a runaway ignoring SIGTERM should escalate within a couple of ticks.
 */
export const ORPHAN_TERM_GRACE_SEC = 5;

/**
 * The CLOSED allow-list of exe-path signatures a process must match to be an
 * orphan-reap candidate. Matched as a SUBSTRING of the resolved exe path (and
 * its argv when the runtime is a generic interpreter), never the truncated
 * process name. Deliberately narrow — only the known agent-test runaway classes
 * the fn-934 incident identified. A signature is an EXE-PATH fragment, so a
 * human's editor/shell/long build never matches.
 *
 *  - `bun test`-spawned worker trees orphaned when their parent `bun test` died
 *    (`--test-worker` / the bun test runner exe).
 *  - the leak-prone `flock_peer.ts` test fixture (fn-934 T3 self-terminates it,
 *    but a pre-fix leaked instance still needs reaping).
 *  - infinite-loop shell harnesses (`while :; do :; done`) — matched on the
 *    busy-loop argv signature, the de-flake-work runaway class.
 */
export const ORPHAN_EXE_SIGNATURES: readonly string[] = [
  "bun test",
  "--test-worker",
  "flock_peer",
  "while :; do :; done",
  "while true; do :; done",
];

/**
 * One process row of a synthetic-or-real census. The selector reads ONLY these
 * fields; tests build them directly (no real `ps`). `exe` is the resolved
 * executable path PLUS argv (joined) so an argv-only runaway signature (the
 * busy-loop shell) is matchable — we match a SUBSTRING, never the name.
 */
export interface ProcCensusEntry {
  pid: number;
  /** Opaque platform-tagged start instant, same shape as `jobs.start_time`. */
  startTime: string | null;
  ppid: number;
  uid: number;
  /** Resolved exe path + argv, joined. Matched as a substring of the allow-list. */
  exe: string | null;
  /** Process age in seconds at census time. */
  ageSec: number;
}

/**
 * One orphan reap the selector emits. Carries the re-fingerprint identity
 * (`pid` + `startTime`) and the escalation `phase` the actuator acts on. `exe`
 * rides along for the audit line.
 */
export interface OrphanCandidate {
  pid: number;
  startTime: string | null;
  exe: string | null;
  /** `term` → SIGTERM (first sighting); `kill` → SIGKILL (still alive next tick). */
  phase: "term" | "kill";
}

/**
 * Per-pid escalation state: the `(pid,start_time)` we sent SIGTERM to and when.
 * In-memory only — a daemon restart re-derives and re-sends SIGTERM once
 * (idempotent: ESRCH on an already-gone pid is a non-fatal skip).
 */
export interface OrphanTermState {
  startTime: string | null;
  termAt: number;
}

/**
 * Does `entry.exe` match the closed allow-list (minus operator exemptions)?
 * Substring match on the resolved exe-path-plus-argv — NEVER the spoofable,
 * 16-char-truncated process name. An exemption in `exempt` (a
 * `disableOrphanReap` signature) that the entry matches vetoes the candidacy.
 */
function matchesOrphanSignature(
  exe: string | null,
  exempt: ReadonlySet<string>,
): boolean {
  if (exe == null || exe === "") {
    return false;
  }
  for (const sig of exempt) {
    if (sig !== "" && exe.includes(sig)) {
      return false;
    }
  }
  return ORPHAN_EXE_SIGNATURES.some((sig) => exe.includes(sig));
}

/**
 * The PURE orphan-reap predicate over a process census at a fixed `now` (unix
 * seconds). Drivable in tests with a synthetic census + injected seams — no real
 * `ps`, no DB. Returns candidates in ascending pid order for a deterministic
 * fire order and stable assertions.
 *
 * A census entry is a candidate iff ALL hold (the closed conjunction):
 *  - `uid === selfUid` — only this user's processes (a recycled pid owned by
 *    another user is never killed — an LPE vector).
 *  - the proc-info read SUCCEEDED — a NULL `exe`/`startTime` signals a partial or
 *    failed `proc_pidinfo` (another user's process, or the pid vanished), which
 *    is can't-confirm → don't-kill.
 *  - `ppid === 1` — a reparented orphan (its real parent is gone). A live-parented
 *    test run keeps its parent and is excluded.
 *  - `exe` matches {@link ORPHAN_EXE_SIGNATURES} minus `exempt` (an exe-PATH
 *    substring, never the truncated NAME).
 *  - `ageSec > minAge` — the launch-race guard.
 *  - `pid ∉ keeperLivePids` — never keeperd's own pid nor a live plan worker
 *    (the read-only `jobs` live-pid set, plus keeperd's own pid).
 *
 * Phase: a pid NOT in `termState` (or whose stored `(pid,start_time)` differs —
 * a recycled pid) gets `phase: "term"`. A pid already SIGTERM'd as the SAME
 * `(pid,start_time)`, with `now - termAt >= ORPHAN_TERM_GRACE_SEC`, escalates to
 * `phase: "kill"`; still inside the grace, it is suppressed (no re-TERM churn).
 */
export function selectOrphanedProcessCandidates(
  census: Iterable<ProcCensusEntry>,
  opts: {
    now: number;
    selfUid: number;
    keeperLivePids: ReadonlySet<number>;
    exempt: ReadonlySet<string>;
    termState: Map<number, OrphanTermState>;
    minAge?: number;
    termGrace?: number;
  },
): OrphanCandidate[] {
  const minAge = opts.minAge ?? ORPHAN_MIN_AGE_SEC;
  const termGrace = opts.termGrace ?? ORPHAN_TERM_GRACE_SEC;
  const out: OrphanCandidate[] = [];
  for (const entry of census) {
    if (entry.uid !== opts.selfUid) {
      continue;
    }
    // A partial/failed proc-info read folds to NULL exe + NULL start_time. We
    // CANNOT confirm identity, so we never kill — `proc_pidinfo` 0/partial for
    // another user is can't-confirm-don't-kill (best-practice).
    if (entry.exe == null || entry.startTime == null) {
      continue;
    }
    if (entry.ppid !== 1) {
      continue;
    }
    if (!matchesOrphanSignature(entry.exe, opts.exempt)) {
      continue;
    }
    if (entry.ageSec <= minAge) {
      continue;
    }
    if (opts.keeperLivePids.has(entry.pid)) {
      continue;
    }
    // Two-phase escalation. A first sighting (or a recycled pid whose stored
    // start_time no longer matches) is a SIGTERM; the same `(pid,start_time)`
    // still alive a grace later escalates to SIGKILL.
    const prior = opts.termState.get(entry.pid);
    if (prior === undefined || prior.startTime !== entry.startTime) {
      out.push({
        pid: entry.pid,
        startTime: entry.startTime,
        exe: entry.exe,
        phase: "term",
      });
      continue;
    }
    if (opts.now - prior.termAt < termGrace) {
      // Inside the grace — suppress so we don't re-TERM every tick.
      continue;
    }
    out.push({
      pid: entry.pid,
      startTime: entry.startTime,
      exe: entry.exe,
      phase: "kill",
    });
  }
  out.sort((a, b) => a.pid - b.pid);
  return out;
}

/**
 * Enumerate the host's process census via one bounded `ps` spawn. macOS + Linux:
 * `ps -ax -o pid=,ppid=,uid=,lstart=,comm=,args=` — the same `ps` precedent the
 * bus-worker (`ps -o ppid=`) and seed-sweep (`ps -p … -o lstart=`) already use.
 * Returns `[]` on any failure (ps unavailable, timeout, parse miss) — an empty
 * census reaps nothing, the conservative default. NEVER throws.
 *
 * `startTime` is re-read per-candidate by {@link readOsStartTime} at the
 * actuator's TOCTOU re-check (the verbatim `darwin:`/`linux:` format the recycle
 * compare needs); the census `startTime` here is the same format via the shared
 * `lstart` column on darwin, and a coarse age proxy on linux — but the actuator's
 * re-fingerprint is the authoritative pid-reuse guard, not this census field.
 */
export function enumerateProcessCensus(): ProcCensusEntry[] {
  try {
    // lstart is fixed-width 24 chars; comm trails before args so the columns are
    // parseable. We request args last (un-truncated by the implicit -ww on the
    // long format) so the busy-loop argv signature is matchable.
    const res = Bun.spawnSync(
      ["ps", "-axww", "-o", "pid=,ppid=,uid=,lstart=,args="],
      { stdout: "pipe", stderr: "ignore", timeout: 4000 },
    );
    if (!res.success) {
      return [];
    }
    const text = res.stdout.toString();
    const out: ProcCensusEntry[] = [];
    for (const line of text.split("\n")) {
      const parsed = parsePsCensusLine(line);
      if (parsed === null) {
        continue;
      }
      // Age proxy from the parsed lstart epoch; null start → unknown age (0, so
      // the min-age gate excludes it as can't-confirm). The authoritative
      // re-fingerprint at the actuator uses readOsStartTime, not this.
      out.push(parsed);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Parse one `ps -axww -o pid=,ppid=,uid=,lstart=,args=` line into a census entry.
 * `lstart` is a fixed-width 24-char date (`Wed Jun 24 10:11:12 2026`); the args
 * remainder is the full argv. Returns null on any malformed line so a parse miss
 * is a skipped row, never a throw. Exported for unit reach.
 */
export function parsePsCensusLine(line: string): ProcCensusEntry | null {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s(.*)$/);
  if (m === null) {
    return null;
  }
  const pid = Number.parseInt(m[1], 10);
  const ppid = Number.parseInt(m[2], 10);
  const uid = Number.parseInt(m[3], 10);
  const lstart = m[4].trim();
  const args = m[5];
  if (
    !Number.isInteger(pid) ||
    !Number.isInteger(ppid) ||
    !Number.isInteger(uid)
  ) {
    return null;
  }
  const startMs = Date.parse(lstart);
  const ageSec = Number.isNaN(startMs)
    ? 0
    : Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  return {
    pid,
    ppid,
    uid,
    startTime: Number.isNaN(startMs) ? null : `darwin:${lstart}`,
    exe: args,
    ageSec,
  };
}

/**
 * The NET-NEW raw-pid actuator — `process.kill`, distinct from the tmux
 * `killWindow` actuator the two job-arms use. Re-fingerprints `(pid,start_time)`
 * immediately BEFORE the signal (the CWE-367 TOCTOU pid-reuse guard): if the
 * live pid's OS start_time no longer matches the candidate's, the pid was
 * recycled into a DIFFERENT process between census and kill — abort. NEVER
 * throws: ESRCH (already gone) / EPERM (raced into another owner) are non-fatal
 * logged skips. Returns the outcome string for the audit line.
 *
 * Injected `isAlive` / `readStartTime` / `kill` seams mirror `reprobeLoop`'s
 * shape so the actuator is unit-testable without real signals.
 */
export function actuateOrphanKill(
  candidate: OrphanCandidate,
  seams: {
    isAlive: (pid: number) => boolean;
    readStartTime: (pid: number) => string | null;
    kill: (pid: number, signal: NodeJS.Signals) => void;
  },
): string {
  try {
    if (!seams.isAlive(candidate.pid)) {
      return "skip:gone";
    }
    // Re-fingerprint at the TOCTOU pre-kill re-check: a recycled pid carrying a
    // different process must NOT be signalled.
    const liveStart = seams.readStartTime(candidate.pid);
    if (liveStart == null) {
      return "skip:probe-failed";
    }
    if (liveStart !== candidate.startTime) {
      return "skip:recycled";
    }
    const signal: NodeJS.Signals =
      candidate.phase === "kill" ? "SIGKILL" : "SIGTERM";
    seams.kill(candidate.pid, signal);
    return candidate.phase === "kill" ? "killed" : "termed";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH (gone) / EPERM (raced into another owner) are expected — non-fatal.
    return `skip:${code ?? "error"}`;
  }
}

/**
 * Build keeper's LIVE pid set from a jobs snapshot — every non-null `pid` on a
 * non-terminal row, PLUS keeperd's own pid. The orphan arm subtracts this set so
 * it can never kill keeper's own tree (the daemon or a live plan worker). A
 * terminal row (killed/ended) is excluded so a stale row's recycled pid never
 * shields a true orphan.
 */
export function buildKeeperLivePids(
  jobs: Iterable<Job>,
  selfPid: number,
): Set<number> {
  const live = new Set<number>([selfPid]);
  for (const job of jobs) {
    if (job.pid == null) {
      continue;
    }
    if (job.state === "killed" || job.state === "ended") {
      continue;
    }
    live.add(job.pid);
  }
  return live;
}

/**
 * Run the orphan-reap arm for one cycle: enumerate the census, select candidates
 * against keeper's live-pid set + the closed conjunction, and actuate each via
 * the raw-pid two-phase actuator. Stamps the per-pid SIGTERM state on a `term`
 * attempt; clears it on a `kill` so a re-appeared (recycled) pid restarts the
 * two-phase ladder. NEVER throws — a census or actuator failure is a logged skip.
 *
 * Separated from {@link reaperCycle} (the tmux-window arms): this arm kills raw
 * pids, not tmux windows, and carries its own re-fingerprint TOCTOU + escalation
 * state. Both are driven from the same worker cycle.
 */
export function orphanReapCycle(
  jobs: Iterable<Job>,
  seams: {
    now: number;
    selfUid: number;
    selfPid: number;
    exempt: ReadonlySet<string>;
    termState: Map<number, OrphanTermState>;
    enumerate: (now: number) => ProcCensusEntry[];
    isAlive: (pid: number) => boolean;
    readStartTime: (pid: number) => string | null;
    kill: (pid: number, signal: NodeJS.Signals) => void;
  },
): void {
  let census: ProcCensusEntry[];
  try {
    census = seams.enumerate(seams.now);
  } catch (err) {
    console.error(
      `[reaper-worker] orphan census failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  const keeperLivePids = buildKeeperLivePids(jobs, seams.selfPid);
  const candidates = selectOrphanedProcessCandidates(census, {
    now: seams.now,
    selfUid: seams.selfUid,
    keeperLivePids,
    exempt: seams.exempt,
    termState: seams.termState,
  });
  for (const c of candidates) {
    const outcome = actuateOrphanKill(c, {
      isAlive: seams.isAlive,
      readStartTime: seams.readStartTime,
      kill: seams.kill,
    });
    // Stamp / clear the escalation state. A successful SIGTERM stamps the
    // `(pid,start_time)` so the next tick can escalate; a SIGKILL clears it so a
    // recycled pid (different start_time) restarts the ladder rather than
    // immediately re-killing.
    if (c.phase === "term" && outcome === "termed") {
      seams.termState.set(c.pid, {
        startTime: c.startTime,
        termAt: seams.now,
      });
    } else if (c.phase === "kill") {
      seams.termState.delete(c.pid);
    }
    // The one trace the orphan arm leaves: a single audit line per attempt.
    console.error(
      `[reaper-worker] reap arm=orphan pid=${c.pid} exe=${c.exe} phase=${c.phase} outcome=${outcome}`,
    );
  }
}

/**
 * Load a fresh snapshot, run readiness at `now` (unix seconds), and select the
 * reap candidates from BOTH arms (autopilot verdict + managed-session idle). The
 * single composed read the cycle and the immediate pre-kill re-check both call,
 * so the re-check sees the SAME pipeline (and thus a flipped verdict / resumed
 * partner provably aborts the kill). `now` is injected so the pre-kill re-check
 * uses the current instant. Config (`disableAutoclose`, idle grace) is bound at
 * the call site; the readiness pass is computed ONCE and reused for the
 * autopilot arm only (the managed-session arm reads no verdict).
 */
async function selectFromDb(
  db: Parameters<typeof runQuery>[0],
  now: number,
  cooldown: Map<string, number>,
  disableAutoclose: ReadonlySet<string>,
): Promise<ReapCandidate[]> {
  const snapshot = await loadReconcileSnapshot(db);
  const readiness = computeReadiness(
    snapshot.epics,
    snapshot.jobs,
    snapshot.subagentInvocations,
    snapshot.gitStatusByProjectDir,
    now,
    snapshot.pendingDispatches,
  );
  // Two disjoint arms over the SAME jobs snapshot — autopilot verdict-gated
  // (plan-verb jobs in the autopilot session) + managed-session idle-gated
  // (NON-plan jobs in pair/panels/agentbus). The allow-list excludes the
  // autopilot session, so no job appears in both lists.
  return [
    ...selectReapCandidates(snapshot.jobs.values(), readiness, now, cooldown),
    ...selectManagedSessionReapCandidates(
      snapshot.jobs.values(),
      now,
      cooldown,
      disableAutoclose,
    ),
  ];
}

/**
 * A reap-candidate selector at a fixed `now` (unix seconds) honoring the
 * cooldown map — {@link selectFromDb} bound to a connection, OR a fake in
 * tests. Injected into {@link reaperCycle} so the re-check / cooldown / audit
 * logic is drivable without a fully-folded DB.
 */
export type ReapSelector = (
  now: number,
  cooldown: Map<string, number>,
) => Promise<ReapCandidate[]>;

/**
 * Drive one reaper cycle. Calls `select` for the candidate set, and for EACH
 * candidate re-runs `select` against a FRESH snapshot immediately before the
 * kill — requiring the SAME job to still pass the full predicate (fresh verdict
 * included). A resume that flipped the verdict (or any other clause miss)
 * between selection and now aborts that kill (the CWE-367 TOCTOU mitigation).
 * Stamps the cooldown on every attempt and emits one stderr audit line per
 * attempt. NEVER throws for an expected degradation: a `killWindow` failure is
 * a logged non-fatal skip.
 *
 * Exported for unit reach: tests drive this directly with an injected selector
 * + fake backend and a controllable `now`.
 */
export async function reaperCycle(
  select: ReapSelector,
  backend: Pick<TmuxPaneOps, "killWindow">,
  cooldown: Map<string, number>,
  now: () => number,
): Promise<void> {
  const candidates = await select(now(), cooldown);
  for (const candidate of candidates) {
    // Re-run the full predicate against a FRESH snapshot immediately before the
    // kill and require the SAME job to still pass (fresh verdict included). A
    // resume that flipped the verdict between selection and now aborts the kill.
    const recheckNow = now();
    const fresh = await select(recheckNow, cooldown);
    const stillReapable = fresh.some(
      (c) => c.job_id === candidate.job_id && c.pane_id === candidate.pane_id,
    );
    // The arm-specific discriminators for the audit line: the autopilot arm
    // carries verb/ref, the managed-session arm carries session.
    const desc = describeCandidate(candidate);
    if (!stillReapable) {
      console.error(
        `[reaper-worker] reap aborted job=${candidate.job_id} ${desc} outcome=recheck-miss`,
      );
      continue;
    }
    // Stamp the cooldown on EVERY attempt (before the fire) so a SIGHUP-absorbed
    // kill that left the row stopped doesn't re-spawn tmux next cycle.
    cooldown.set(candidate.job_id, recheckNow);
    const res = await backend.killWindow(candidate.pane_id);
    const outcome = res.ok ? "killed" : `skip:${res.error}`;
    // The one trace the reaper leaves: a single audit line per attempt. The
    // exit-watcher's Killed mint — not this line — is the truth of the death.
    console.error(
      `[reaper-worker] reap job=${candidate.job_id} ${desc} pane=${candidate.pane_id} outcome=${outcome}`,
    );
  }
}

/** The arm-specific audit fragment: `verb=…/ref=…` for an autopilot candidate,
 *  `session=…` for a managed-session candidate. */
function describeCandidate(c: ReapCandidate): string {
  return c.session != null
    ? `arm=managed-session session=${c.session}`
    : `arm=autopilot verb=${c.verb} ref=${c.plan_ref}`;
}

/**
 * Worker entrypoint. Opens its own read-only connection, wires the shutdown
 * message, and drives the reaper cycle from BOTH `data_version` pulses and a
 * coarse periodic tick through one single-flight entry until told to stop.
 */
function main(): void {
  if (!parentPort) {
    console.error("[reaper-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }

  const data = workerData as ReaperWorkerData | undefined;
  if (!data || typeof data.dbPath !== "string") {
    console.error("[reaper-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  // Session-agnostic pane-ops seam: only killWindow is used. Direct tmux seam
  // (NOT routed through the removed exec-backend abstraction). Warnings route to
  // stderr.
  const backend = createTmuxPaneOps({
    noteLine: (line: string): void => {
      console.error(`[reaper-worker] ${line}`);
    },
  });
  // job_id → last kill-attempt unix-seconds. In-memory only.
  const cooldown = new Map<string, number>();
  const now = (): number => Math.floor(Date.now() / 1000);
  // The operator opt-out set, threaded from `resolveConfig().disableAutoclose`
  // at the daemon populate site. Frozen for the worker's lifetime — a config
  // change takes effect on the next daemon bounce, same as the other tunables.
  const disableAutoclose: ReadonlySet<string> = new Set(
    data.disableAutoclose ?? [],
  );
  // The production selector: the full pipeline bound to this read-only
  // connection. The cycle's pre-kill re-check re-runs it against a fresh read.
  const select: ReapSelector = (n, cd) =>
    selectFromDb(db, n, cd, disableAutoclose);

  // Orphan-arm state (epic fn-934). The exempt set is the operator opt-out
  // (frozen for the worker's lifetime, same as disableAutoclose). The termState
  // map holds the per-pid two-phase escalation (in-memory only). selfUid/selfPid
  // anchor the uid-self gate + keeper's own-pid exclusion.
  const orphanExempt: ReadonlySet<string> = new Set(
    data.disableOrphanReap ?? [],
  );
  const orphanTermState = new Map<number, OrphanTermState>();
  const selfUid = process.getuid?.() ?? -1;
  const selfPid = process.pid;
  // A cheap read-only jobs read for the orphan arm's keeper-live-pid exclusion —
  // just pid + state, not the full reconcile snapshot. A slightly-stale read is
  // safe: the live-pid set only grows the exclusion (more safety), and the
  // actuator's `(pid,start_time)` re-fingerprint is the authoritative guard.
  const liveJobsQuery = db.query(
    `SELECT pid, state FROM jobs WHERE pid IS NOT NULL`,
  );
  const loadLiveJobs = (): Job[] => {
    try {
      return liveJobsQuery.all() as Job[];
    } catch (err) {
      console.error("[reaper-worker] orphan live-jobs read failed:", err);
      return [];
    }
  };

  let shutdown = false;

  parentPort.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg && msg.type === "shutdown") {
      shutdown = true;
    }
  });

  const closeDb = (): void => {
    try {
      db.close();
    } catch {
      // best-effort; we're exiting either way
    }
  };

  // Single-flight cycle drive. Both feeders (data_version pulses + the periodic
  // tick) call this; a wake while a cycle runs sets `wakePending` and the
  // running cycle loops once more after it finishes — coalescing a burst into
  // one trailing re-run. The WHOLE cycle is wrapped so a snapshot or readiness
  // throw never wedges the loop (no self-heal — log and let the next wake
  // re-drive).
  let cycleRunning = false;
  let wakePending = false;
  const driveCycle = async (): Promise<void> => {
    if (cycleRunning) {
      wakePending = true;
      return;
    }
    cycleRunning = true;
    try {
      do {
        wakePending = false;
        if (shutdown) {
          return;
        }
        await reaperCycle(select, backend, cooldown, now);
        // The orphan-process arm (epic fn-934): raw-pid reaper, distinct from
        // the tmux-window arms above. It enumerates the host census, excludes
        // keeper's own live tree, and two-phase-escalates SIGTERM→SIGKILL. It
        // never throws — its own internal try/catch isolates census/actuator
        // failures as logged skips.
        orphanReapCycle(loadLiveJobs(), {
          now: now(),
          selfUid,
          selfPid,
          exempt: orphanExempt,
          termState: orphanTermState,
          enumerate: () => enumerateProcessCensus(),
          isAlive: isPidAlive,
          readStartTime: readOsStartTime,
          kill: (pid, signal) => process.kill(pid, signal),
        });
      } while (wakePending && !shutdown);
    } catch (err) {
      console.error(
        `[reaper-worker] reap cycle threw (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      cycleRunning = false;
    }
  };

  const drive = (): void => {
    void driveCycle();
  };

  // The LOAD-BEARING periodic tick: the age threshold elapsing writes nothing
  // to the DB, so no data_version pulse fires on aging alone — time itself must
  // wake the cycle. Cleared on shutdown.
  const tickMs = data.tickMs ?? DEFAULT_REAP_TICK_MS;
  const tick = setInterval(() => {
    if (shutdown) return;
    drive();
  }, tickMs);

  watchLoop(db, drive, () => shutdown, data.pollMs)
    .then(() => {
      clearInterval(tick);
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      clearInterval(tick);
      console.error("[reaper-worker] watch loop crashed:", err);
      closeDb();
      process.exit(1);
    });
}

// Only run inside a real Worker; a plain import on the main thread (tests
// driving the pure decision fns / cycle) is inert.
if (!isMainThread) {
  main();
}
