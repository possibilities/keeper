/**
 * Git status producer worker. Snapshots watched git worktrees and posts a
 * synthetic snapshot message when the rendered git view changes.
 *
 * Watch gate: a worktree is watched iff
 *   `.keeper present || working tree dirty || ahead of upstream > 0`,
 * recomputed each reconcile. Clean-and-pushed non-`.keeper` worktrees drop
 * after a cooling dwell; `.keeper`-backed worktrees stay watched even when
 * clean and incur no probe spawn (short-circuit).
 *
 * POLL-ONLY (fn-921): the git surface no longer holds an `@parcel/watcher`
 * subscription. A snapshot fires on (1) a two-tier metadata poll delta — every
 * ~{@link GIT_POLL_MS} the worker cheap-`stat()`s each watched root's `.git`
 * metadata + worktree-root mtime ({@link readGitMetaSignature}); a changed
 * signature ({@link decideGitPoll}) drives the per-root `RescanScheduler`
 * (trailing-debounce + single-flight) — (2) a `PRAGMA data_version` bump
 * (membership reconcile ONLY — it carries no root attribution, so it never fans a
 * per-root snapshot out; that O(roots) fan-out was a CPU-flood source), or (3) a
 * 60s heartbeat backstop (which ALSO clears a quiet-repo `seed_required`). The
 * per-root `lastByRoot` dedupe absorbs no-op snapshots.
 *
 * The poll producer is armed UNCONDITIONALLY at worker start, NOT inside a watcher
 * `import().then()` — a watcher-load hang or a mute FSEvents stream can therefore
 * never again leave the producer with no timers armed (the 2026-06-23 silent
 * freeze). The poll `lstat` sweep is the sanctioned external-tree carve-out;
 * keeper's OWN DB is observed only via `PRAGMA data_version` polling.
 *
 * PRODUCER only: owns no writable DB connection, never mutates projections. Main
 * mints every event; the reducer folds the persisted payload into `git_status`.
 * On a drop, the worker posts a `GitRootDropped` tombstone whose reducer fold
 * DELETEs the projection row, keeping `git_status` in sync.
 */

import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  BackstopCounters,
  type BackstopMessage,
  buildMissedWakeRecord,
  buildTimeoutRecord,
} from "./backstop-telemetry";
import {
  openDb,
  readGitProjectionFloor,
  readGitProjectionSeedRequired,
} from "./db";
import {
  parsePlanRef,
  parseSessionIdTrailer,
  parseTaskTrailers,
} from "./derivers";
import { unseededGatedRoots } from "./gated-roots";
import {
  memoizedGitToplevel,
  resolveGitToplevel as resolveGitToplevelImpl,
} from "./git-toplevel";
import { NotadbTolerance } from "./notadb-tolerance";
import { normalizePlanOp } from "./plan-classifier";
import { DEFAULT_DEBOUNCE_MS, RescanScheduler } from "./rescan";
import type { ShutdownMessage } from "./wake-worker";

export interface GitWorkerData {
  dbPath: string;
  /**
   * When `true`, the worker arms NO producer timers — it skips the two-tier git
   * poll + DB-poll + heartbeat and stays alive only for the shutdown handshake.
   * The in-process daemon harness sets this so the slow-test tier runs the fold
   * pipeline without the git producer. (Named for the legacy `@parcel/watcher`
   * disable; fn-921 made the git-worker poll-only, so the flag now gates the poll
   * producer, not a watcher import.)
   */
  disableNativeWatcher?: boolean;
}

/**
 * Discovery nudge (main → git-worker): the plan-worker observed a `.keeper`
 * tree in a repo keeper has never seen a session in. Main forwards the repo root
 * so the git-worker adds it to its discovery candidate set IMMEDIATELY (the
 * `.keeper` short-circuit in {@link shouldWatchRoot} subscribes it next
 * reconcile) instead of waiting for the next full `SELECT DISTINCT cwd` sweep.
 * Idempotent: a re-nudge of an already-watched root is a no-op.
 */
export interface AddDiscoveryRootMessage {
  type: "add-discovery-root";
  /** Absolute repo root to fold into discovery candidates. */
  root: string;
}

/**
 * Teardown nudge (main → git-worker): a lane worktree's removals COMPLETED
 * (autopilot-worker finalize / recover pass-3), so run an IMMEDIATE
 * vanished-worktree sweep instead of waiting for the next full sweep. Payload-free
 * — the sweep keys on the canonical `git_status.project_dir` rows, and the
 * ENOENT/ENOTDIR gate re-verifies each candidate at retire time, so no path
 * canonicalization can no-op the retire. Idempotent: coalesces into any in-flight
 * reconcile via the single-flight guard.
 */
export interface NudgeVanishedSweepMessage {
  type: "nudge-vanished-sweep";
}

/** Every shape main sends to the git-worker. */
export type GitWorkerInbound =
  | ShutdownMessage
  | AddDiscoveryRootMessage
  | NudgeVanishedSweepMessage;

export interface GitFileStatus {
  path: string;
  xy: string;
  index: string;
  worktree: string;
  kind: "ordinary" | "renamed" | "unmerged" | "untracked";
  orig_path?: string;
  /**
   * The porcelain-v2 `hI` (index blob oid) and `mW` (worktree mode) fields,
   * lifted off the `1`/`2` record. `untracked`/`unmerged` records carry neither
   * and parse as `null`.
   */
  index_oid: string | null;
  worktree_mode: string | null;
}

/**
 * One dirty-file entry on the file-centric {@link GitSnapshotPayload}. The three
 * content axes (`worktree_oid`, `index_oid`, `worktree_mode`) are pulled at
 * producer time from one `git status --porcelain=v2` + one `git hash-object
 * --stdin-paths` per snapshot — frozen into the payload so a re-fold reproduces
 * them byte-deterministically (no fold-time git probe).
 *
 * - `worktree_oid`: the filter-correct blob oid of this file's WORKTREE bytes
 *   (`git hash-object --stdin-paths`, batched per snapshot; critically WITHOUT
 *   `--no-filters` so clean/CRLF smudge filters match the stored blob). `null`
 *   when the producer couldn't hash the file — falls back to timestamp discharge.
 * - `index_oid` / `worktree_mode`: the porcelain `hI` / `mW` fields, used by the
 *   reducer's content-aware discharge. `null` for `untracked`/`unmerged`.
 *
 * `mtime_ms` is the file's lstat mtime in unix-epoch ms (lstat, so a symlink
 * reports its own mtime, not the target's); `null` on a stat race (the file
 * moved between enumeration and lstat). The producer does NOT join the event log
 * — per-job rollup, attribution, and orphan set are derived by the reducer.
 */
export interface GitDirtyFile {
  path: string;
  xy: string;
  kind: "ordinary" | "renamed" | "unmerged" | "untracked";
  orig_path?: string;
  mtime_ms: number | null;
  worktree_oid: string | null;
  index_oid: string | null;
  worktree_mode: string | null;
}

/**
 * The file-centric `GitSnapshot` payload: the producer-observed
 * `git status --porcelain=v2` parse — branch metadata, HEAD oid, ahead/behind,
 * and the dirty-file list with embedded `mtime_ms` per file — and NOTHING else.
 *
 * The producer must NOT compute attribution: a touched-set join over the event
 * log would run at producer time WITHOUT the writer lock, so two producers (real
 * + a future replay) would see different mid-fold projections. Attribution lives
 * in the reducer's `BEGIN IMMEDIATE`, a pure function of the persisted event log
 * — that's what keeps re-fold deterministic.
 */
export interface GitSnapshotPayload {
  project_dir: string;
  branch: string | null;
  head_oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty_files: GitDirtyFile[];
}

export interface GitSnapshotMessage extends GitSnapshotPayload {
  kind: "git-snapshot";
  /** Inclusive events.id watermark captured immediately before readStatus. */
  attribution_event_id: number;
}

/**
 * Tombstone message: a watched root stopped satisfying the watch gate on
 * reconcile (no `.keeper/` AND clean-and-pushed for ≥ {@link
 * WATCH_DROP_DWELL_MS}). The worker is unsubscribing; main lifts this into a
 * synthetic `GitRootDropped` event whose reducer fold DELETEs the `git_status`
 * row — without it the UPSERT-only projection would leak the final pre-drop
 * snapshot forever.
 */
export interface GitRootDroppedMessage {
  kind: "git-root-dropped";
  project_dir: string;
  /**
   * Inclusive events.id watermark captured before a confirming clean status
   * read. Null for a vanished root whose filesystem state cannot be observed.
   */
  attribution_event_id: number | null;
}

/**
 * Per-commit message: a single commit landed in the HEAD-oid delta the worker
 * just observed. One per commit (an N-commit push lands N `Commit` events). Main
 * lifts each into a synthetic `Commit` event whose reducer fold updates
 * `file_attributions.last_commit_at` for the named files — discharging the
 * committer session's claim, or globally clearing it when the trailer is
 * absent/malformed.
 *
 * `commit_oid` / `parent_oid` are full oids (`parent_oid` `null` on the initial
 * commit). `committed_at_ms` is git's `%ct` × 1000, frozen so a re-fold
 * reproduces the discharge timestamp (the reducer never re-shells git).
 * `committer_session_id` is the validated `Session-Id:` trailer (`null` →
 * global discharge).
 */
/**
 * One file entry on a {@link CommitMessage}. `blob_oid` is the new blob's oid
 * from the `diff-tree -r` parse; `null` for deletions / parse misses / producer
 * fall-backs (the reducer reads `null` as "cannot confirm content equality" and
 * falls back to timestamp discharge). `committed_mode` is the porcelain `mI`
 * field, paired by the reducer against the snapshot's `worktree_mode` so a
 * chmod-only dirty file is not wrongly discharged; `null` symmetrically with
 * `blob_oid`.
 */
export interface CommitMessageFile {
  path: string;
  blob_oid: string | null;
  committed_mode: string | null;
}

export interface CommitMessage {
  kind: "commit";
  project_dir: string;
  commit_oid: string;
  parent_oid: string | null;
  files: CommitMessageFile[];
  committer_session_id: string | null;
  /**
   * The validated, plan-shaped `Task:` trailer values for this commit.
   * Multi-valued (collect-all, unlike the take-last {@link
   * committer_session_id}) so one `keeper commit-work` closing two tasks lights
   * both. Empty `[]` when no valid `Task:` trailer is present. The reducer's link
   * fold defaults `[]` for pre-existing events (re-fold determinism).
   */
  task_ids: string[];
  /**
   * The normalized plan op + validated target ref lifted from this commit's
   * `Planctl-Op:` / `Planctl-Target:` trailers. Both `null` on a non-plan
   * commit. The reducer's edge fold defaults both to `null` for pre-existing
   * events (re-fold determinism).
   */
  plan_op: string | null;
  plan_target: string | null;
  committed_at_ms: number;
}

/**
 * Per-commit message announcing the `.keeper/**` paths that changed in the
 * just-observed commit. Drives the plan-worker's commit-triggered ingest channel
 * (not an `events`-row insert). Main forwards it verbatim to plan-worker; the
 * reducer never sees it (re-fold determinism — the plan files are re-read from
 * committed worktree state on every ingest, never from this payload).
 *
 * The producer filters to plan-shaped paths so the worker needs no
 * re-classification. One message per commit; {@link changes} is non-empty by
 * construction (emission is suppressed when no plan path moved).
 */
export interface PlanChangedFile {
  /** Repo-relative path (forward-slash on POSIX). */
  path: string;
  /** `"upsert"` (present in HEAD) or `"delete"` (`git rm`'d in this commit). */
  op: "upsert" | "delete";
}

export interface PlanCommitChangedMessage {
  /**
   * The git-worker observed a commit landing plan-shaped `.keeper/**` paths and
   * signals main to re-ingest them. A worker-IPC TRIGGER, not minted projection
   * data, so re-fold determinism is unaffected.
   */
  kind: "plan-commit-changed";
  project_dir: string;
  commit_oid: string;
  changes: PlanChangedFile[];
}

/**
 * fn-921 supervisor liveness pulse. The git-worker is POLL-ONLY now, so a mute
 * `@parcel/watcher` stream can no longer silently freeze it — but a worker that is
 * alive-yet-stuck (an unhandled hang inside a poll tick) is invisible to main's
 * `onerror`/`close` supervision, which only catches a crash. This pulse is the
 * additive signal: the worker posts one on every poll tick it completes, and the
 * supervisor's seed-liveness watchdog reads the time since the last pulse together
 * with `seed_required` to decide whether the surface is stuck. NOT folded into the
 * event log — a pure worker→main side channel, like {@link BackstopMessage}.
 */
export interface GitLivenessMessage {
  kind: "git-liveness";
  /** Monotonic-ish wall-clock (`Date.now()`) at which the poll tick completed. */
  at_ms: number;
}

export type GitWorkerMessage =
  | GitSnapshotMessage
  | GitRootDroppedMessage
  | CommitMessage
  | PlanCommitChangedMessage
  | GitLivenessMessage
  // A backstop rescue/rollup record posted up to main (the sole sidecar writer).
  // NOT folded into the event log — routed straight to `handleBackstopMessage`.
  | BackstopMessage;

export interface ParsedGitStatus {
  branch: string | null;
  head_oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFileStatus[];
}

/** `PRAGMA data_version` cadence (drives membership reconcile only). */
const DB_POLL_MS = 100;
/**
 * Two-tier git-metadata poll cadence (fn-921). The git surface is POLL-ONLY: the
 * git-worker no longer holds an `@parcel/watcher` subscription. Every ~300ms the
 * worker cheap-`stat()`s each watched root's `.git` metadata + a shallow worktree
 * mtime ({@link readGitMetaSignature}); a changed signature drives the existing
 * per-root `RescanScheduler` (debounce + dedupe), so the git scan + `emitSnapshot`
 * still runs only on a detected delta. Latency ~300ms (tunable); the stat sweep is
 * negligible. Decoupling the producer from `@parcel/watcher` removes the
 * watcher-load-hang / mute-stream silent-freeze class entirely.
 */
const GIT_POLL_MS = 300;
/** Slow backstop (also clears a quiet-repo `seed_required`). */
const HEARTBEAT_MS = 60_000;
/**
 * Cadence at which the worker flushes its backstop counters as rollup records —
 * the fires/rescues denominator for a true rate. A clean shutdown also flushes
 * one final rollup so a quiescent daemon records a complete denominator.
 */
const BACKSTOP_ROLLUP_FLUSH_MS = 5 * 60_000;
/**
 * Per-root GitSnapshot emission ceiling, passed as the {@link RescanScheduler}
 * `maxWaitMs` so a root under CONTINUOUS churn emits ≤1 GitSnapshot per window
 * — a trailing debounce alone re-arms forever under sustained edits and never
 * flushes. The trailing debounce ({@link DEFAULT_DEBOUNCE_MS}) still wins on a
 * bursty-then-quiet edit; this only bites when edits outpace the debounce.
 */
const GIT_SNAPSHOT_MAX_WAIT_MS = 1500;
const GIT_TIMEOUT_MS = 2000;
/**
 * Per-root TTL on the watch-membership verdict for CURRENTLY-WATCHED roots.
 * Short — a watched root is the one most likely to flip, and we want a recent
 * `git status` for the dwell timer and early clean+pushed drops.
 */
const WATCH_PROBE_TTL_HOT_MS = 5_000;
/**
 * Per-root TTL for cold (candidate-but-unwatched) roots. Longer — a still-clean
 * repo needn't be re-checked every cycle.
 */
const WATCH_PROBE_TTL_COLD_MS = 90_000;
/**
 * Cadence at which the candidate set widens to ALL `DISTINCT cwd` rows (the slow
 * sweep) instead of just recent + watched (the fast sweep). Surfaces a stale
 * unpushed-but-clean repo after a keeper restart; throttled to keep steady-state
 * spawns ≈ 0.
 */
const FULL_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * Recent-job window for the fast-path candidate build: a `jobs` row is a
 * candidate if `state='working'` OR `updated_at` is within this window. Covers
 * human-paced multi-session days without dredging up week-old idle sessions.
 */
const RECENT_JOB_WINDOW_MS = 2 * 60 * 60 * 1000;
/**
 * Cooling dwell before a non-`.keeper` clean-and-pushed root is dropped. Must
 * be ≥ HEARTBEAT_MS + one snapshot/commit-enumeration cycle so a post-commit
 * `emitSnapshot` (HEAD-delta enumeration → `Task:` link + discharge) drains
 * BEFORE the tombstone wipes the file_attributions claim.
 */
const WATCH_DROP_DWELL_MS = 45_000;
/**
 * Cap on new subscribes per reconcile cycle: the first full sweep (or
 * post-restart re-discovery) must not subscribe hundreds of roots at once, which
 * would balloon FSEvents streams into `fseventsd` bad-state. Remaining joins land
 * on subsequent cycles.
 */
const MAX_SUBSCRIBES_PER_CYCLE = 16;
/**
 * How long the `git`-derived HEAD may CONTINUOUSLY disagree with the fs-derived
 * HEAD before the divergence watchdog escalates (`process.exit(1)` → LaunchAgent
 * restart). Divergent snapshots are SUPPRESSED during the window. Long enough to
 * ride out the sub-second window where a commit lands between `readStatus` and
 * the fs ref read, short enough to recover a genuine wedge before agents lose
 * trust. Measured on the monotonic clock, never wall-time.
 */
const HEAD_DIVERGENCE_GRACE_MS = 90_000;

/**
 * Retry cap for a failed `enumerateCommitsInDelta` in `emitSnapshot`. The commit
 * channel MUST NOT silently drop a commit on a transient enumeration throw — so
 * the per-root HEAD-oid cache is held back and the next observation re-enumerates
 * the same range. To bound the spin on a PERMANENTLY broken object, after this
 * many consecutive failures the cache advances anyway with a loud one-time alarm;
 * the heartbeat backstop still recovers the projection.
 */
export const COMMIT_ENUM_MAX_RETRIES = 5;

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function parseBranchAheadBehind(value: string): {
  ahead: number | null;
  behind: number | null;
} {
  const m = value.match(/^\+(\d+) -(\d+)$/);
  if (m == null) {
    return { ahead: null, behind: null };
  }
  return { ahead: Number(m[1]), behind: Number(m[2]) };
}

export function parsePorcelainV2(raw: string): ParsedGitStatus {
  const records = raw.split("\0");
  const files: GitFileStatus[] = [];
  let branch: string | null = null;
  let headOid: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.length === 0) {
      continue;
    }
    if (rec.startsWith("# branch.head ")) {
      const value = rec.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
      continue;
    }
    if (rec.startsWith("# branch.oid ")) {
      const value = rec.slice("# branch.oid ".length);
      headOid = value === "(initial)" ? null : value;
      continue;
    }
    if (rec.startsWith("# branch.upstream ")) {
      upstream = rec.slice("# branch.upstream ".length);
      continue;
    }
    if (rec.startsWith("# branch.ab ")) {
      const parsed = parseBranchAheadBehind(rec.slice("# branch.ab ".length));
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }

    const parts = rec.split(" ");
    if (parts[0] === "1") {
      // Ordinary record `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`:
      // `mW = parts[5]`, `hI = parts[7]`. `?? null` keeps a malformed short
      // record from throwing (consumer reads `null` as "no oid/mode").
      const xy = parts[1] ?? "??";
      const path = parts.slice(8).join(" ");
      if (path.length > 0) {
        files.push({
          path,
          xy,
          index: xy[0] ?? ".",
          worktree: xy[1] ?? ".",
          kind: "ordinary",
          index_oid: parts[7] ?? null,
          worktree_mode: parts[5] ?? null,
        });
      }
    } else if (parts[0] === "2") {
      // Renamed/copied record `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score>
      // <path>`: same `mW`/`hI` offsets as record `1`; score at parts[8], new
      // path at parts[9], orig path in the next NUL-separated record.
      const xy = parts[1] ?? "??";
      const path = parts.slice(9).join(" ");
      const orig = records[++i] ?? "";
      if (path.length > 0) {
        files.push({
          path,
          xy,
          index: xy[0] ?? ".",
          worktree: xy[1] ?? ".",
          kind: "renamed",
          ...(orig.length > 0 ? { orig_path: orig } : {}),
          index_oid: parts[7] ?? null,
          worktree_mode: parts[5] ?? null,
        });
      }
    } else if (parts[0] === "u") {
      // Unmerged records carry three oids/modes (stages 1/2/3), none of which
      // maps onto a single `index_oid` — leave both null (timestamp discharge).
      const xy = parts[1] ?? "UU";
      const path = parts.slice(10).join(" ");
      if (path.length > 0) {
        files.push({
          path,
          xy,
          index: xy[0] ?? "U",
          worktree: xy[1] ?? "U",
          kind: "unmerged",
          index_oid: null,
          worktree_mode: null,
        });
      }
    } else if (parts[0] === "?") {
      // Untracked records carry no oids and no mode — only the path.
      const path = rec.slice(2);
      if (path.length > 0) {
        files.push({
          path,
          xy: "??",
          index: "?",
          worktree: "?",
          kind: "untracked",
          index_oid: null,
          worktree_mode: null,
        });
      }
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { branch, head_oid: headOid, upstream, ahead, behind, files };
}

function gitOutput(args: string[]): string | null {
  try {
    // `--no-optional-locks`: the daemon is a pure OBSERVER and must never take
    // `.git/index.lock`. A plain `git status` opportunistically refreshes the
    // index stat-cache, grabbing the lock and racing the watched session's own
    // `git add` / commit (a "fatal: Unable to create index.lock" in the agent,
    // or a stale lock that wedges the repo when our timeout kills git mid-refresh).
    const res = Bun.spawnSync(["git", "--no-optional-locks", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    if (!res.success || res.exitCode !== 0) {
      return null;
    }
    return res.stdout.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve a candidate path (typically a `cwd`) to its containing git toplevel,
 * or `null` if the path isn't inside a git worktree. cwd→toplevel is stable for
 * a session's lifetime, so its cache is permanent; the separate membership
 * verdict ({@link shouldWatchRoot}) re-runs per reconcile against a fresh probe.
 *
 * fn-921: the implementation lives in the dep-light `git-toplevel.ts` so the
 * readiness read sites can normalize the gated key without importing this whole
 * module. Re-exported here to preserve the existing public API + call sites.
 */
export function resolveGitToplevel(path: string): string | null {
  return resolveGitToplevelImpl(path);
}

/**
 * The dynamic per-reconcile watch-membership probe. ONE combined
 * `git status --porcelain=v2 --branch` spawn yields both facts {@link
 * shouldWatchRoot} needs:
 *   - dirty = any non-`#` record present,
 *   - ahead = the `# branch.ab +N -M` count (`0` when absent).
 *
 * Uses `-unormal` (the default), NOT `-uall`: the full untracked descent is a
 * perf cliff, and `-unormal` is sufficient for an is-dirty verdict.
 *
 * Returns `null` on timeout/error; `shouldWatchRoot` fails OPEN for an
 * already-watched root, CLOSED for a cold candidate.
 */
export function probeWatchMembership(
  root: string,
): { dirty: boolean; ahead: number } | null {
  const out = gitOutput(["-C", root, "status", "--porcelain=v2", "--branch"]);
  if (out == null) return null;
  let dirty = false;
  let ahead = 0;
  for (const rec of out.split("\n")) {
    if (rec.length === 0) continue;
    if (rec.startsWith("#")) {
      if (rec.startsWith("# branch.ab ")) {
        const parsed = parseBranchAheadBehind(rec.slice("# branch.ab ".length));
        if (parsed.ahead !== null) ahead = parsed.ahead;
      }
      continue;
    }
    // Any non-`#` record = a dirty entry; one is enough to flip the verdict.
    dirty = true;
  }
  return { dirty, ahead };
}

/**
 * Pure decision: does keeper want to watch this resolved git `root`?
 *
 *   - `.keeper/` present → ALWAYS watch, short-circuit BEFORE the probe (a
 *     `.keeper` repo never incurs a probe spawn).
 *   - probe `null` (timeout/error) → fail-open if `currentlyWatched`, closed
 *     otherwise (don't join on a broken probe; don't drop on a stutter).
 *   - probe non-null → watch iff dirty OR ahead > 0.
 */
export function shouldWatchRoot(
  root: string,
  probe: { dirty: boolean; ahead: number } | null,
  options: { currentlyWatched: boolean },
): boolean {
  if (existsSync(join(root, ".keeper"))) return true;
  if (probe === null) return options.currentlyWatched;
  return probe.dirty || probe.ahead > 0;
}

/**
 * Absolute path to the git common-dir for `root`. Use `--git-common-dir`
 * rather than `--git-dir` so a linked worktree (where `<root>/.git` is a
 * gitfile pointing into `<main>/.git/worktrees/<name>/`) resolves to the
 * main repo's `.git/` — the place where shared refs (`refs/heads/*`,
 * `packed-refs`, `refs/remotes/*`) live. For a regular repo the two return
 * the same path. The worktree's own per-worktree `HEAD` and `index` sit
 * inside the common-dir at `worktrees/<name>/`, so this single subscription
 * covers both worktree-local and shared-ref mutations. Resolved to absolute so
 * `@parcel/watcher.subscribe` gets a stable canonical path.
 */
function gitCommonDirFor(root: string): string | null {
  const out = gitOutput(["-C", root, "rev-parse", "--git-common-dir"]);
  const value = out?.trim();
  if (!value) return null;
  const abs = isAbsolute(value) ? value : resolve(root, value);
  return existsSync(abs) ? abs : null;
}

/**
 * Resolve a worktree's current HEAD oid by reading the git ref files DIRECTLY
 * via `fs` — never shelling out to `git`. The {@link decideHeadDivergence} wedge
 * guard's independent ground truth.
 *
 * *Why fs and not `git rev-parse`:* the guarded failure mode is a long-running
 * worker whose `git` subprocess silently returns a STALE view (a frozen HEAD
 * while the repo advances, surfacing committed files as phantom `<orphan>`
 * entries). A divergence check that also shelled `git` would read the same stale
 * value and never fire; `fs` reads stay correct in that wedged state.
 *
 * Handles a regular repo, a linked worktree (`<root>/.git` is a `gitdir:` pointer
 * → per-worktree dir with a sibling `commondir`), a symbolic `ref:` HEAD resolved
 * against the loose ref then `packed-refs`, and a detached HEAD (inline oid).
 * Returns the 40/64-hex oid, or `null` on any shape it can't resolve cheaply —
 * the watchdog treats `null` as "can't determine truth" and never escalates.
 */
export function resolveHeadOidViaFs(root: string): string | null {
  const isOid = (s: string): boolean => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s);
  try {
    let gitDir = join(root, ".git");
    const dotGit = lstatSync(gitDir);
    if (dotGit.isFile()) {
      // Linked worktree: `.git` is a `gitdir: <abs-or-rel-path>` pointer file.
      const m = readFileSync(gitDir, "utf8")
        .trim()
        .match(/^gitdir:\s*(.+)$/);
      if (m == null) return null;
      gitDir = isAbsolute(m[1]) ? m[1] : resolve(root, m[1]);
    }
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) {
      // Detached HEAD — the oid is inline.
      return isOid(head) ? head : null;
    }
    const refName = head.slice("ref:".length).trim();
    // Shared refs live in the common-dir for a linked worktree; a regular repo
    // has no `commondir` file and refs sit under `gitDir` itself.
    let commonDir = gitDir;
    const commonDirFile = join(gitDir, "commondir");
    if (existsSync(commonDirFile)) {
      const c = readFileSync(commonDirFile, "utf8").trim();
      commonDir = isAbsolute(c) ? c : resolve(gitDir, c);
    }
    const loosePath = join(commonDir, refName);
    if (existsSync(loosePath)) {
      const oid = readFileSync(loosePath, "utf8").trim();
      return isOid(oid) ? oid : null;
    }
    // Loose ref absent → consult packed-refs.
    const packedPath = join(commonDir, "packed-refs");
    if (existsSync(packedPath)) {
      for (const line of readFileSync(packedPath, "utf8").split("\n")) {
        if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) {
          continue;
        }
        const sp = line.indexOf(" ");
        if (sp < 0) continue;
        const oid = line.slice(0, sp);
        const name = line.slice(sp + 1).trim();
        if (name === refName && isOid(oid)) return oid;
      }
    }
    return null;
  } catch {
    // Any fs/parse failure → "unknown", never escalate. Pure best-effort.
    return null;
  }
}

/**
 * Pure decision for the `emitSnapshot` HEAD-divergence gate (the wedge guard).
 * `gitHead` is what `readStatus` reported; `fsHead` is the trusted ground truth
 * ({@link resolveHeadOidViaFs}).
 *
 * - Agreement, `fsHead == null` (can't verify — fail OPEN, trust git), or null
 *   `gitHead`: not divergent. `suppress=false`, `sinceMs=null`, `trip=false`.
 * - Divergence: `suppress=true` — the caller must NOT emit, enumerate commits,
 *   or advance any head cache (a data-INTEGRITY failure, not mere staleness).
 *   `sinceMs` is the monotonic start of the run; `trip=true` once it persists ≥
 *   `graceMs`, when the caller exits for a LaunchAgent restart.
 */
export interface HeadDivergenceDecision {
  suppress: boolean;
  sinceMs: number | null;
  trip: boolean;
}

export function decideHeadDivergence(
  gitHead: string | null,
  fsHead: string | null,
  priorSinceMs: number | null,
  nowMs: number,
  graceMs: number,
): HeadDivergenceDecision {
  if (gitHead == null || fsHead == null || gitHead === fsHead) {
    return { suppress: false, sinceMs: null, trip: false };
  }
  const sinceMs = priorSinceMs ?? nowMs;
  return { suppress: true, sinceMs, trip: nowMs - sinceMs >= graceMs };
}

/**
 * Pure decision for whether `emitSnapshot` may advance the per-root HEAD-oid
 * cache after attempting `enumerateCommitsInDelta`. A transient enumeration
 * throw must NOT skip the failed range (that would permanently drop the commit's
 * `plan-commit-changed` + `Commit` discharge):
 *
 * - `enumOk === true`: advance, reset the failure counter.
 * - `enumOk === false` AND `priorFailures + 1 < maxRetries`: HOLD the cache so
 *   the next observation re-enumerates the range; carry the bumped count.
 * - `enumOk === false` AND retries exhausted: a persistently broken range —
 *   advance anyway (`loudBackstop=true`) to break the spin; the heartbeat
 *   recovers the projection.
 *
 * `advance` gates ONLY the head-cache write; the divergence gate is upstream and
 * returns first, so a suppressed snapshot never advances the cache.
 */
export interface HeadCacheAdvanceDecision {
  advance: boolean;
  nextFailures: number;
  loudBackstop: boolean;
}

export function decideHeadCacheAdvance(
  enumOk: boolean,
  priorFailures: number,
  maxRetries: number,
): HeadCacheAdvanceDecision {
  if (enumOk) {
    return { advance: true, nextFailures: 0, loudBackstop: false };
  }
  const failures = priorFailures + 1;
  if (failures < maxRetries) {
    // Hold the cache so the next observation re-enumerates the failed range.
    return { advance: false, nextFailures: failures, loudBackstop: false };
  }
  // Retry budget exhausted — advance anyway (loud) to avoid a hot spin on a
  // permanently poisoned range; the heartbeat covers the lost commit.
  return { advance: true, nextFailures: 0, loudBackstop: true };
}

/**
 * Full porcelain-v2 status read for one root — the producer-side input to {@link
 * buildGitSnapshot}. Time-bound + fail-safe via {@link gitOutput} (returns `null`
 * on timeout/error). Exported so the boot-seed producer (`git-boot-seed.ts`)
 * re-derives the live git surface through the SAME read the live worker uses,
 * rather than reimplementing the porcelain parse.
 */
export function readStatus(root: string): ParsedGitStatus | null {
  const out = gitOutput([
    "-C",
    root,
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--renames",
    "--untracked-files=all",
  ]);
  return out == null ? null : parsePorcelainV2(out);
}

/**
 * One file entry in an {@link EnumeratedCommit}. `blob_oid` is the new (committed)
 * blob's oid from `git diff-tree -r`; `committed_mode` the porcelain `mI` mode
 * from the same record. The reducer's content-aware discharge pairs both against
 * the snapshot's `worktree_oid`/`worktree_mode` so a chmod-only dirty file is not
 * wrongly discharged. Either folds to `null` on a parse miss (discharge gate
 * falls back to timestamp).
 */
export interface EnumeratedCommitFile {
  path: string;
  blob_oid: string | null;
  committed_mode: string | null;
}

/**
 * Per-commit shape produced by {@link enumerateCommitsInDelta}. Field-for-
 * field this is the {@link CommitMessage} payload minus the `kind` /
 * `project_dir` discriminators (those ride in at the message boundary so the
 * enumerator stays a pure git-output parser).
 */
export interface EnumeratedCommit {
  commit_oid: string;
  parent_oid: string | null;
  files: EnumeratedCommitFile[];
  committer_session_id: string | null;
  task_ids: string[];
  /**
   * The normalized plan op (`Planctl-Op:` trailer → {@link normalizePlanOp})
   * and validated target ref (`Planctl-Target:` → {@link parsePlanRef}). Both
   * `null` on a non-plan / malformed commit. Frozen at producer time, read
   * back unchanged by the reducer's edge fold (re-fold determinism).
   */
  plan_op: string | null;
  plan_target: string | null;
  committed_at_ms: number;
}

/** Anchored full-OID match — same shape as `derivers.ts` `GIT_OID_RE`. */
const PRODUCER_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Is this repo-relative path one the plan-worker projects? Matches the SAME
 * shapes plan-worker's `classifyPlanPath` recognizes, duplicated so the two
 * workers stay independent — if this set widens, BOTH classifiers must move in
 * lockstep. Recognised shapes (forward-slash split):
 * - `.keeper/epics/<id>.json` (3-segment)
 * - `.keeper/tasks/<id>.json` (3-segment)
 * - `.keeper/state/tasks/<id>.state.json` (4-segment)
 * - `.keeper/state/epics/<id>.state.json` (4-segment)
 *
 * The sole gate for {@link filterPlanChanges}: only a commit touching one of
 * these `.keeper/` shapes is forwarded to the plan-worker.
 */
export function isPlanChangedPath(path: string): boolean {
  if (!path.endsWith(".json")) return false;
  const segments = path.split("/");
  const n = segments.length;
  // 3-segment tail: `.keeper/<epics|tasks>/<file>.json`.
  if (n >= 3 && segments[n - 3] === ".keeper") {
    const dir = segments[n - 2];
    return dir === "epics" || dir === "tasks";
  }
  // 4-segment tail: `.keeper/state/<tasks|epics>/<id>.state.json`.
  if (
    n >= 4 &&
    segments[n - 4] === ".keeper" &&
    segments[n - 3] === "state" &&
    (segments[n - 2] === "tasks" || segments[n - 2] === "epics") &&
    segments[n - 1].endsWith(".state.json")
  ) {
    return true;
  }
  return false;
}

/**
 * Filter a commit's enumerated file list to plan-shaped paths, pairing each
 * with an upsert/delete tag. A null `blob_oid` (the producer's zero-oid
 * "removed" marker) is `"delete"`; everything else is `"upsert"`.
 */
export function filterPlanChanges(
  files: EnumeratedCommitFile[],
): PlanChangedFile[] {
  const out: PlanChangedFile[] = [];
  for (const f of files) {
    if (!isPlanChangedPath(f.path)) continue;
    out.push({ path: f.path, op: f.blob_oid === null ? "delete" : "upsert" });
  }
  return out;
}

/**
 * Shell-out + parse for one commit's file list via
 * `git -C <root> diff-tree -r --no-commit-id --no-renames -z <oid>`, so each
 * record carries the new BLOB OID alongside the path (the content-aware
 * discharge gate's `committed_oid == worktree_oid` input).
 *
 * Output (with `-z`): `:<mH> <mI> <hH> <hI> <STATUS>\0<path>\0` per file, where
 * `hI` is the new blob's oid. `--no-renames` is load-bearing — without it renames
 * emit two paths per record and the alignment math would have to special-case
 * them; it also keeps the discharge surface file-path-keyed (a rename = add+delete).
 *
 * A bad/missing oid → `null` for that entry without dropping the path (discharge
 * falls back to timestamp). Empty array on any non-zero exit / parse miss (a
 * failed shell-out can't wedge the worker; the next snapshot re-attempts).
 */
/**
 * PURE parse of a `git diff-tree -r --no-commit-id --no-renames -z` output
 * string into the per-file {@link EnumeratedCommitFile} list. Split out of
 * {@link commitFiles} (whose only impurity is the `gitOutput` spawn) so the
 * filter round-trips unit-test against a captured diff-tree golden.
 *
 * `:<mH> <mI> <hH> <hI> <STATUS>\0<path>\0` per file — split on NUL, consume in
 * pairs (the trailing NUL yields an empty tail element).
 */
export function parseCommitFiles(rawZ: string): EnumeratedCommitFile[] {
  const fields = rawZ.split("\0");
  const files: EnumeratedCommitFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    if (path.length === 0) continue;
    // After splitting the meta line on space, index 1 is `mI` (mode) and index 3
    // is `hI` (blob oid). Deletions emit all-zeros sentinels for both → fold to
    // `null` (no worktree bytes/mode to compare against). The mode accepts any
    // non-empty token (the reducer string-compares it against `mW`).
    if (!meta.startsWith(":")) {
      files.push({ path, blob_oid: null, committed_mode: null });
      continue;
    }
    const parts = meta.slice(1).split(" ");
    const rawOid = parts[3] ?? "";
    const blobOid =
      rawOid.length === 0 ||
      !PRODUCER_OID_RE.test(rawOid) ||
      /^0+$/.test(rawOid)
        ? null
        : rawOid;
    const rawMode = parts[1] ?? "";
    const committedMode =
      rawMode.length === 0 || /^0+$/.test(rawMode) ? null : rawMode;
    files.push({ path, blob_oid: blobOid, committed_mode: committedMode });
  }
  return files;
}

function commitFiles(root: string, oid: string): EnumeratedCommitFile[] {
  const out = gitOutput([
    "-C",
    root,
    "diff-tree",
    "-r",
    "--no-commit-id",
    "--no-renames",
    "-z",
    oid,
  ]);
  if (out == null) return [];
  return parseCommitFiles(out);
}

/**
 * The `git log -z --format=<COMMIT_LOG_FORMAT>` field format consumed by
 * {@link enumerateCommitsFromLog}. Exported so the golden-fixture capture script
 * uses the EXACT same format the parser keys on — a drift between the two would
 * make a captured golden validate against a different stride than production.
 *
 * Session-Id / Job-Id / Planctl-Op / Planctl-Target use `valueonly,only,unfold`
 * (take-last single value); Task uses `valueonly,unfold` with the DEFAULT `\n`
 * separator — a newline-separated block inside ONE field so the outer `%x00`
 * delimiter survives (a `%x00` Task separator would collide with the field
 * boundary and realign the parser).
 *
 * FIELD ORDER IS LOAD-BEARING: {@link enumerateCommitsFromLog}'s stride loop
 * consumes fields in groups of EIGHT in this exact order. Adding / reordering /
 * dropping a `%x00` MUST move the stride (`i += 8`) + every `fields[i+N]` offset
 * in lockstep, or every field realigns off-by-one for EVERY commit.
 */
export const COMMIT_LOG_FORMAT =
  "%H%x00%P%x00%ct%x00" +
  "%(trailers:key=Session-Id,valueonly,only,unfold)%x00" +
  "%(trailers:key=Job-Id,valueonly,only,unfold)%x00" +
  "%(trailers:key=Task,valueonly,unfold)%x00" +
  "%(trailers:key=Planctl-Op,valueonly,only,unfold)%x00" +
  "%(trailers:key=Planctl-Target,valueonly,only,unfold)";

/**
 * PURE parse of a `git log -z --format=<COMMIT_LOG_FORMAT>` output string into
 * the per-commit {@link EnumeratedCommit} array. Mirrors {@link parsePorcelainV2}:
 * no git, no fs, no clock — every input arrives as an argument so the function
 * is fully unit-testable against captured-from-real-git goldens.
 *
 * The per-commit file list is the ONE thing this parser cannot derive from the
 * log output (it comes from a sibling `git diff-tree`); the caller supplies it
 * via `resolveFiles(oid)`. Production passes `(oid) => commitFiles(root, oid)`
 * (the impure helper); a unit test passes a synthetic resolver.
 *
 * With `-z` plus the `%x00` format separators, N commits emit a flat sequence
 * of 8N NUL-delimited fields (OID, P, CT, Session, Job-Id, Task, Planctl-Op,
 * Planctl-Target per commit) with a trailing empty element. Consume in 8s.
 */
export function enumerateCommitsFromLog(
  rawZ: string,
  resolveFiles: (oid: string) => EnumeratedCommitFile[],
): EnumeratedCommit[] {
  const fields = rawZ.split("\0");
  const commits: EnumeratedCommit[] = [];
  for (let i = 0; i + 7 < fields.length; i += 8) {
    const oid = (fields[i] ?? "").trim();
    if (oid.length === 0) continue;
    const parentsRaw = (fields[i + 1] ?? "").trim();
    // `%P` is space-separated; attribute against the FIRST parent only.
    const parentOid: string | null =
      parentsRaw.length === 0 ? null : (parentsRaw.split(" ")[0] ?? null);
    const ctRaw = fields[i + 2] ?? "";
    const ctSeconds = Number(ctRaw);
    const committedAtMs =
      Number.isFinite(ctSeconds) && ctSeconds > 0
        ? Math.floor(ctSeconds * 1000)
        : 0;
    const sessionTrailers = fields[i + 3] ?? "";
    const jobIdTrailers = fields[i + 4] ?? "";
    const taskTrailers = fields[i + 5] ?? "";
    const opTrailers = fields[i + 6] ?? "";
    const targetTrailers = fields[i + 7] ?? "";
    const committerSessionId = coalesceCommitterSessionId(
      sessionTrailers,
      jobIdTrailers,
      oid,
    );
    const taskIds = parseTaskTrailers(taskTrailers);
    const planOp = parsePlanOpTrailer(opTrailers);
    const planTarget = parsePlanTargetTrailer(targetTrailers);
    const files = resolveFiles(oid);
    commits.push({
      commit_oid: oid,
      parent_oid: parentOid,
      files,
      committer_session_id: committerSessionId,
      task_ids: taskIds,
      plan_op: planOp,
      plan_target: planTarget,
      committed_at_ms: committedAtMs,
    });
  }
  return commits;
}

/**
 * Enumerate the commits in a `<prev>..<new>` HEAD-oid delta via `git log -z`,
 * parsing each via the pure {@link enumerateCommitsFromLog}. Falls back to a
 * single-commit log against `<new>` when the range is empty (force-push /
 * non-descendant) or `<prev>` is null (bootstrap / initial commit). The impure
 * `git log` spawn + the per-commit `diff-tree` resolver ({@link commitFiles})
 * live here; the parse is pure.
 *
 * Returns the per-commit array newest-first (git's default ordering); the
 * reducer fold on `last_commit_at` is commutative, so iteration order doesn't
 * affect the projection.
 */
export function enumerateCommitsInDelta(
  root: string,
  prev: string | null,
  next: string,
): EnumeratedCommit[] {
  let out: string | null = null;
  if (prev !== null) {
    out = gitOutput([
      "-C",
      root,
      "log",
      `${prev}..${next}`,
      `--format=${COMMIT_LOG_FORMAT}`,
      "--no-patch",
      "-z",
    ]);
  }
  if (out == null || out.length === 0) {
    // Fallback (force-push / non-descendant / bootstrap / initial commit): a
    // single-commit log against `<next>` gives at least the HEAD commit's
    // attribution; earlier non-descendant commits are an accepted loss.
    out = gitOutput([
      "-C",
      root,
      "log",
      "-1",
      next,
      `--format=${COMMIT_LOG_FORMAT}`,
      "--no-patch",
      "-z",
    ]);
  }
  if (out == null || out.length === 0) {
    return [];
  }
  // Production passes the impure per-commit `diff-tree` helper as the file
  // resolver; the pure parser does the rest.
  return enumerateCommitsFromLog(out, (oid) => commitFiles(root, oid));
}

/**
 * Canonicalize a commit's session attribution by merging the `Session-Id:` and
 * `Job-Id:` trailers (both parsed via {@link parseSessionIdTrailer} —
 * UUID-anchored take-last). Policy:
 *   - Session-Id WINS when both are valid (equal, or DIFFERING with a one-shot
 *     stderr warning — `job_id === session_id` is a keeper invariant, so a
 *     divergence is a non-fatal bug signal).
 *   - Job-Id wins when Session-Id is null (jobctl stamps `Job-Id` on every
 *     `commit-work` source commit).
 *   - Both null → null (global discharge).
 */
function coalesceCommitterSessionId(
  sessionTrailers: string,
  jobIdTrailers: string,
  commitOid: string,
): string | null {
  const session = parseSessionIdTrailer(sessionTrailers);
  const jobId = parseSessionIdTrailer(jobIdTrailers);
  if (session !== null && jobId !== null && session !== jobId) {
    // `job_id === session_id` is a keeper invariant — a divergence is a bug
    // signal. Stderr-only, never throws; include both values + OID for a grep.
    console.error(
      `[git-worker] commit ${commitOid}: Session-Id (${session}) and Job-Id (${jobId}) trailers DIFFER; Session-Id wins per take-last policy`,
    );
  }
  // Session-Id preferred; fall through to Job-Id when absent. Both pass the same
  // UUID gate, so the result is always a UUID-shaped string or null.
  if (session !== null) return session;
  return jobId;
}

/**
 * Lift the plan operation from a commit's `Planctl-Op:` trailer and
 * NORMALIZE it via {@link normalizePlanOp} (same vocabulary as the legacy
 * scrape path, so the reducer's `syncPlanLinks` union compares both on one
 * vocabulary). Take-last on the unfolded block. Returns `null` on empty /
 * non-string input (no such trailer).
 */
function parsePlanOpTrailer(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    return normalizePlanOp(line);
  }
  return null;
}

/**
 * Lift the plan target ref from a commit's `Planctl-Target:` trailer and
 * validate it against the SAME epic-ref shape gate the legacy scrape path uses
 * ({@link parsePlanRef}). Take-last on the unfolded block; returns the raw
 * validated ref (`fn-1-foo` or `fn-1-foo.3`). `null` on empty / non-string input
 * AND on a value `parsePlanRef` rejects (so a garbage trailer never poisons the
 * edge fold).
 */
function parsePlanTargetTrailer(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    return parsePlanRef(line) !== null ? line : null;
  }
  return null;
}

/**
 * One TTL-memoized watch-membership verdict per root. Hot tier ({@link
 * WATCH_PROBE_TTL_HOT_MS}, currently watched) refreshes every fast reconcile;
 * cold tier ({@link WATCH_PROBE_TTL_COLD_MS}, unwatched) holds longer so a
 * quiescent repo doesn't re-probe every cycle. Pruned lazily inside {@link
 * discoverProjectRoots} (never on the hot 100ms tick); bounded by the candidate
 * set size.
 */
interface WatchProbeCacheEntry {
  /** The last probe verdict (or `null` if the probe failed at expiry time). */
  verdict: { dirty: boolean; ahead: number } | null;
  /** Wall-clock ms (`Date.now()`) after which the entry is considered stale. */
  expiry: number;
}

/**
 * State threaded into {@link discoverProjectRoots} by `reconcileRoots`. An
 * interface so discovery can be driven deterministically in tests with
 * injectable Maps + `now` + probe.
 *
 * - `cwdRootCache` — cwd→toplevel memo, permanent for the daemon lifetime.
 * - `watchProbeCache` — per-root verdict TTL memo, hot/cold tiered.
 * - `currentlyWatched` — live subscribed roots; both the tier selector and the
 *   monotonicity floor (the slow sweep only ADDS; the fast path always re-probes
 *   every already-watched root).
 * - `nowMs` — wall clock, injected for tests.
 * - `runFullSweep` — `true` to widen to ALL `DISTINCT cwd` rows.
 * - `probe` — the spawnSync-backed verdict probe, injectable.
 */
export interface DiscoveryContext {
  cwdRootCache: Map<string, string | null>;
  watchProbeCache: Map<string, WatchProbeCacheEntry>;
  currentlyWatched: Set<string>;
  nowMs: number;
  runFullSweep: boolean;
  probe: (root: string) => { dirty: boolean; ahead: number } | null;
  /**
   * Discovery-nudge roots forwarded from the plan-worker, folded into the
   * candidate set unconditionally. Optional; omitted by tests.
   */
  extraCandidates?: Set<string>;
}

/**
 * Build the candidate set for `discoverProjectRoots`. The fast path probes only
 * recent + watched cwds; the slow sweep widens to every `DISTINCT cwd`. Epic
 * `project_dir` and `task.target_repo` are always included (cheap, bounded).
 */
export function buildDiscoveryCandidates(
  db: Database,
  options: {
    nowMs: number;
    runFullSweep: boolean;
    watched: Set<string>;
    /**
     * Discovery-nudge roots (a `.keeper` tree in a repo with no seen-cwd job
     * history). Always included so the `.keeper` short-circuit in {@link
     * shouldWatchRoot} subscribes them without waiting for a session to populate
     * `jobs.cwd`. Optional — pure tests omit it.
     */
    extraCandidates?: Set<string>;
  },
): Set<string> {
  const candidates = new Set<string>();

  // Nudge roots are unconditional candidates (a never-seen repo has no job rows).
  if (options.extraCandidates !== undefined) {
    for (const root of options.extraCandidates) candidates.add(root);
  }

  // Always include plan-backed roots: epic.project_dir and every embedded
  // task.target_repo. Bounded (one row per epic) and stable.
  const epicRows = db.query("SELECT project_dir, tasks FROM epics").all() as {
    project_dir: string | null;
    tasks: string | null;
  }[];
  for (const row of epicRows) {
    if (row.project_dir != null) candidates.add(row.project_dir);
    if (row.tasks == null || row.tasks.length === 0) continue;
    try {
      const tasks = JSON.parse(row.tasks);
      if (!Array.isArray(tasks)) continue;
      for (const task of tasks) {
        const repo = (task as { target_repo?: unknown }).target_repo;
        if (typeof repo === "string" && repo.length > 0) {
          candidates.add(repo);
        }
      }
    } catch {
      // malformed embedded task array: ignore for discovery.
    }
  }

  if (options.runFullSweep) {
    // Slow path: every cwd a job has ever run from. Surfaces a stale unpushed-
    // but-clean repo after a keeper restart.
    const rows = db
      .query("SELECT DISTINCT cwd FROM jobs WHERE cwd IS NOT NULL")
      .all() as { cwd: string }[];
    for (const row of rows) candidates.add(row.cwd);
  } else {
    // Fast path: working + recently-updated jobs only. `updated_at` is REAL unix
    // seconds; the cutoff converts ms to s.
    const cutoffSec = (options.nowMs - RECENT_JOB_WINDOW_MS) / 1000;
    const rows = db
      .query(
        `SELECT DISTINCT cwd FROM jobs
         WHERE cwd IS NOT NULL
           AND (state = 'working' OR updated_at >= ?)`,
      )
      .all(cutoffSec) as { cwd: string }[];
    for (const row of rows) candidates.add(row.cwd);
  }

  // Monotonicity floor: every already-watched root is a candidate regardless of
  // sweep, or a fast-path skip would shrink `desired` below the watched set and
  // spuriously unsubscribe a live attribution claim.
  for (const root of options.watched) candidates.add(root);

  return candidates;
}

/**
 * Pure cooling-hysteresis decision. Given the currently-watched set, the
 * moment-in-time `desiredNow` verdict, the per-root first-clean timestamp memo
 * (`cleanSinceByRoot`, mutated in place), `nowMs`, and the dwell threshold:
 *
 * - `toAdd` — roots in `desiredNow` not yet watched.
 * - `toDrop` — watched roots clean-and-pushed for ≥ `dwellMs`. A still-desired
 *   root is never dropped.
 *
 * Also mutates `cleanSinceByRoot`: stamps the first-clean ts when a watched root
 * falls out of `desiredNow`, clears it on re-qualify or drop.
 */
export function decideReconcileTransitions(
  currentlyWatched: Set<string>,
  desiredNow: Set<string>,
  cleanSinceByRoot: Map<string, number>,
  nowMs: number,
  dwellMs: number,
): { toAdd: string[]; toDrop: string[] } {
  const toAdd: string[] = [];
  for (const root of desiredNow) {
    if (!currentlyWatched.has(root)) toAdd.push(root);
  }

  const toDrop: string[] = [];
  for (const root of currentlyWatched) {
    if (desiredNow.has(root)) {
      // Re-qualified — clear any dwell timer so a future drop starts a
      // fresh window.
      cleanSinceByRoot.delete(root);
      continue;
    }
    // Watched but no longer desired → start (or check) the dwell timer.
    const since = cleanSinceByRoot.get(root);
    if (since === undefined) {
      cleanSinceByRoot.set(root, nowMs);
      continue;
    }
    if (nowMs - since >= dwellMs) {
      toDrop.push(root);
      cleanSinceByRoot.delete(root);
    }
  }

  // Prune dwell entries for roots that aren't watched anymore (e.g. dropped
  // on a previous cycle, or never subscribed).
  for (const root of cleanSinceByRoot.keys()) {
    if (!currentlyWatched.has(root)) cleanSinceByRoot.delete(root);
  }

  return { toAdd, toDrop };
}

/**
 * Derive a missed-wake rescue's TRUE change-to-rescue latency (`now − oldest
 * committed_at_ms`) from the commit times the rescue discharged — the honest
 * freshness signal, vs the idle-inflating `now − last_fast_path_at`.
 *
 * - Anchor on the OLDEST commit (worst case — it bounds the longest any change
 *   waited unobserved).
 * - Empty array → `null`: a dirty-tree-only rescue has no commit to measure
 *   against. The caller pushes only POSITIVE `committed_at_ms`.
 * - Returns the raw signed difference; the negative-latency (clock-skew) clamp
 *   lives in {@link buildMissedWakeRecord}.
 */
export function deriveChangeToRescueMs(
  dischargedCommitAtMs: number[],
  now: number,
): number | null {
  if (dischargedCommitAtMs.length === 0) return null;
  const oldest = Math.min(...dischargedCommitAtMs);
  return now - oldest;
}

/**
 * The presence verdict for a `git_status` project_dir, from a stat probe (never
 * bare `existsSync`): `present` (stat succeeded — exactly `existsSync === true`),
 * `vanished` (ENOENT/ENOTDIR — the dir is PROVABLY gone), or `error` (any other
 * stat failure — inconclusive). A currently-watched lane retires ONLY on
 * `vanished`; `error` fails closed so a stat blip never retires a live lane.
 */
export type RootPresence = "present" | "vanished" | "error";

/**
 * Stat probe for {@link selectVanishedRoots}. Follows symlinks (matching the
 * prior `existsSync`) so a `present` verdict is exactly `existsSync === true`.
 * ONLY ENOENT/ENOTDIR count as `vanished`; every other errno is `error`
 * (fail-closed). Mirrors {@link normalizeLanePathState}'s absence discriminator.
 */
export function probeRootPresence(dir: string): RootPresence {
  try {
    statSync(dir);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "vanished" : "error";
  }
}

/**
 * Select `git_status` rows to tombstone because their worktree vanished from
 * disk. Such a row is unreachable by {@link decideReconcileTransitions} (a
 * missing dir fails cwd→toplevel resolution, so the root never re-enters the
 * watched set) AND, for an always-watched `.keeper` lane, by the dwell drop, so
 * it would strand forever as phantom whole-tree orphan dirt. The stat `probe`
 * runs in the producer (never inside a fold), allowed by the event-sourcing
 * invariants; the reducer's idempotent DELETE reconciles.
 *
 * The `probe` is injected so the caller owns the one fs read per row.
 * - An UNWATCHED root retires on any not-`present` verdict — today's single-pass
 *   behavior (byte-identical to the old `existsSync === false` drop). The boot
 *   path, where the watched set is empty, is exactly this branch.
 * - A currently-WATCHED lane retires ONLY on `vanished` (ENOENT/ENOTDIR), and
 *   only once that verdict holds across two consecutive passes (`vanishStreak`
 *   debounce) so a transient stat blip on a live lane never drops it. `immediate`
 *   (the teardown nudge's sweep) confirms with a second probe in THIS pass instead
 *   of waiting a second cadence — teardown declared the dir gone.
 * - Mutates `alreadyTombstoned`: adds each newly-dropped root (so it isn't
 *   re-emitted before its DELETE round-trips), clears a reappeared dir, and prunes
 *   round-tripped entries so the set stays bounded by the live row count.
 * - Mutates `vanishStreak`: the per-watched-root consecutive-vanished counter,
 *   reset on `present`/`error` and on retire, pruned on round-trip.
 */
export function selectVanishedRoots(
  projectDirs: string[],
  probe: (dir: string) => RootPresence,
  currentlyWatched: Set<string>,
  alreadyTombstoned: Set<string>,
  vanishStreak: Map<string, number>,
  immediate = false,
): string[] {
  const present = new Set(projectDirs);
  // Prune round-tripped bookkeeping: a dir absent from the live git_status
  // rows has had its tombstone DELETE land, so its dedupe + debounce entries are
  // stale. Dropping them keeps both structures bounded by the live row count
  // rather than by every root ever torn down.
  for (const dir of [...alreadyTombstoned]) {
    if (!present.has(dir)) alreadyTombstoned.delete(dir);
  }
  for (const dir of [...vanishStreak.keys()]) {
    if (!present.has(dir)) vanishStreak.delete(dir);
  }

  const drop: string[] = [];
  for (const dir of projectDirs) {
    const verdict = probe(dir);
    if (verdict === "present") {
      // Reappeared (or never gone): clear the dedupe + debounce so a future
      // vanish can re-drop it.
      alreadyTombstoned.delete(dir);
      vanishStreak.delete(dir);
      continue;
    }
    if (alreadyTombstoned.has(dir)) continue;

    if (currentlyWatched.has(dir)) {
      if (verdict !== "vanished") {
        // Fail closed: an inconclusive stat error keeps a live lane and breaks
        // the consecutive-vanished streak.
        vanishStreak.delete(dir);
        continue;
      }
      if (immediate) {
        // The teardown nudge's immediate sweep satisfies the two-consecutive-pass
        // debounce with a second confirming probe in this same pass; the ENOENT
        // gate re-verifies regardless, so a blip that healed between probes stays.
        if (probe(dir) !== "vanished") {
          vanishStreak.delete(dir);
          continue;
        }
      } else {
        const streak = (vanishStreak.get(dir) ?? 0) + 1;
        if (streak < 2) {
          vanishStreak.set(dir, streak);
          continue;
        }
      }
      vanishStreak.delete(dir);
      alreadyTombstoned.add(dir);
      drop.push(dir);
      continue;
    }

    alreadyTombstoned.add(dir);
    drop.push(dir);
  }
  return drop;
}

/**
 * The dynamic watch-membership discoverer: a probe-driven verdict tiered by
 * hot/cold TTL. Returns the sorted set of roots {@link reconcileRoots} should
 * keep subscribed.
 *
 *   1. Build candidate cwds via {@link buildDiscoveryCandidates}.
 *   2. Resolve each cwd → toplevel via the permanent `cwdRootCache`.
 *   3. Per resolved root, consult the TTL memo; on miss/expiry run {@link
 *      probeWatchMembership} ONCE and cache at the right tier. `.keeper`
 *      short-circuits in {@link shouldWatchRoot} BEFORE the probe runs.
 *   4. Compose the verdict via {@link shouldWatchRoot}.
 *
 * This is the moment-in-time verdict only; the dwell-aware drop is layered on by
 * `reconcileRoots` via `cleanSinceByRoot`.
 */
export function discoverProjectRoots(
  db: Database,
  ctx: DiscoveryContext,
): string[] {
  const candidates = buildDiscoveryCandidates(db, {
    nowMs: ctx.nowMs,
    runFullSweep: ctx.runFullSweep,
    watched: ctx.currentlyWatched,
    extraCandidates: ctx.extraCandidates,
  });

  // Resolve cwd → toplevel via the permanent cache; drop cwds not in a git
  // worktree. `.keeper` and dirty checks run against the resolved root.
  const resolvedRoots = new Set<string>();
  for (const candidate of candidates) {
    let root: string | null | undefined = ctx.cwdRootCache.get(candidate);
    if (root === undefined) {
      root = resolveGitToplevel(candidate);
      ctx.cwdRootCache.set(candidate, root);
    }
    if (root != null) resolvedRoots.add(root);
  }

  // Per-root verdict TTL memo + probe + decide.
  const desired = new Set<string>();
  for (const root of resolvedRoots) {
    const watched = ctx.currentlyWatched.has(root);
    const ttl = watched ? WATCH_PROBE_TTL_HOT_MS : WATCH_PROBE_TTL_COLD_MS;
    let probe: { dirty: boolean; ahead: number } | null;
    const cached = ctx.watchProbeCache.get(root);
    if (cached !== undefined && cached.expiry > ctx.nowMs) {
      probe = cached.verdict;
    } else {
      // Skip the probe for `.keeper` roots — shouldWatchRoot short-circuits
      // true on the `.keeper` check; cache a `null` verdict so a future
      // `.keeper` removal forces a re-probe via expiry.
      if (existsSync(join(root, ".keeper"))) {
        probe = null;
        ctx.watchProbeCache.set(root, {
          verdict: null,
          expiry: ctx.nowMs + ttl,
        });
      } else {
        probe = ctx.probe(root);
        ctx.watchProbeCache.set(root, {
          verdict: probe,
          expiry: ctx.nowMs + ttl,
        });
      }
    }
    if (shouldWatchRoot(root, probe, { currentlyWatched: watched })) {
      desired.add(root);
    }
  }

  // Lazy prune: drop expired entries no longer in the candidate set, bounding
  // the map against churn.
  for (const [root, entry] of ctx.watchProbeCache) {
    if (!resolvedRoots.has(root) && entry.expiry <= ctx.nowMs) {
      ctx.watchProbeCache.delete(root);
    }
  }

  return [...desired].sort();
}

/**
 * Schema v44 / epic fn-664: batch-compute one filter-correct git blob oid
 * per dirty-file path via a single `git -C <projectDir> hash-object
 * --stdin-paths` spawn. CRITICAL — `--stdin-paths` (not per-file
 * shell-outs); a dirty-heavy tree with hundreds of paths would otherwise
 * pay the spawn cost N times and hold the worker for seconds. Equally
 * critical — NO `--no-filters` flag; we want the cleaned/CRLF-normalized
 * hash so the result equals what git stored in the index/HEAD, not the raw
 * worktree bytes.
 *
 * Per-file failure folds to `null` for that one file without wedging the
 * batch. Both failure shapes are handled:
 *
 *   1. `hash-object` itself exits non-zero (typically when ONE path in the
 *      batch is unreadable — a staged-deleted file, a permissions miss, a
 *      broken symlink to nowhere — git aborts the whole batch). We re-shell
 *      with `--ignore-missing` to recover oids for the survivors; in the
 *      worst case we accept `null` for every file in the batch (the next
 *      snapshot's mtime-debounce will retry).
 *   2. `hash-object` exits 0 but emits fewer oid lines than we sent paths
 *      (rare; the writer mid-flight could lose alignment). We pair lines
 *      with paths in input order; surplus paths fold to `null`.
 *
 * Producer-only contract: a throw here cannot wedge the worker. Every
 * failure mode is funneled to "the file reads `null`" and the snapshot
 * still emits.
 *
 * Returns a `Map<relPath, oid|null>` so the caller can join against the
 * porcelain parse without re-ordering. Empty input returns an empty map.
 */
function batchHashObjectOids(
  projectDir: string,
  relPaths: string[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (relPaths.length === 0) return out;
  // Pre-seed every requested path with `null`. Any path the hash-object
  // batch doesn't successfully emit an oid for stays at `null`.
  for (const p of relPaths) out.set(p, null);

  // Pre-filter to paths that actually exist on disk. `hash-object
  // --stdin-paths` aborts the WHOLE batch on the first unreadable path —
  // the producer-side stat race (`git status` enumerated a file that's
  // since been removed) would otherwise null-out every survivor. We pay
  // a per-path `existsSync` here (cheap fs metadata read) to keep the
  // single batched spawn cost intact for the common all-files-exist
  // path. Missing files keep their `null` seed; existing files line up
  // 1:1 with the spawn's stdout lines (git preserves --stdin-paths
  // order, the documented contract).
  const presentPaths: string[] = [];
  for (const p of relPaths) {
    const abs = isAbsolute(p) ? p : join(projectDir, p);
    if (existsSync(abs)) presentPaths.push(p);
  }
  if (presentPaths.length === 0) return out;

  // Strict `--stdin-paths`. WITHOUT `--no-filters` so the emitted oids
  // match what git would have stored (clean/CRLF filters applied) —
  // the whole point of this column.
  let stdout: string | null = null;
  try {
    // `--no-optional-locks` for the same observer invariant as `gitOutput`
    // (hash-object doesn't touch the index, but keep the daemon uniformly
    // lock-free so no future arg change can reintroduce index.lock contention).
    const res = Bun.spawnSync(
      ["git", "--no-optional-locks", "hash-object", "--stdin-paths"],
      {
        cwd: projectDir,
        stdin: new TextEncoder().encode(`${presentPaths.join("\n")}\n`),
        stdout: "pipe",
        stderr: "ignore",
        timeout: GIT_TIMEOUT_MS,
      },
    );
    if (res.success && res.exitCode === 0) {
      stdout = res.stdout.toString();
    }
  } catch {
    stdout = null;
  }
  if (stdout == null) return out;

  const lines = stdout.split("\n");
  // Pair output lines with the SAME index in the input path list. git's
  // `--stdin-paths` preserves order; this is the documented contract.
  // Surplus paths (fewer lines than paths) fold to `null` via the seed.
  for (let i = 0; i < presentPaths.length && i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    // Validate via the same OID shape the reducer accepts (40-hex SHA-1
    // or 64-hex SHA-256). A non-OID line is the rare "git emitted a
    // warning where an oid should be" case — fold to `null` for that
    // file rather than persist a garbage value the discharge gate would
    // misread.
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(line)) {
      out.set(presentPaths[i], line);
    }
  }
  return out;
}

/**
 * Best-effort `lstat` of one worktree-relative dirty-file path, anchored on
 * `projectDir`. Returns the file's mtime in unix-epoch milliseconds, or
 * `null` if `lstat` failed (the file was enumerated by `git status` but
 * gone by the time we stat it — the documented producer-side stat race).
 *
 * **`lstat`, not `stat`** — for a worktree-managed symlink we want the
 * symlink's own mtime, not the target's (the target may live outside the
 * worktree entirely, and `git status` already reported the symlink itself
 * as the dirty entry). Without `lstat`, a symlink to a frequently-touched
 * external file would get a misleading mtime that re-attributes its
 * inferred-claim every time the target moved.
 *
 * Producer-only contract: a throw here cannot wedge the worker, so we
 * collapse every failure mode to `null` and let the reducer roll forward.
 */
function lstatMtimeMs(projectDir: string, relPath: string): number | null {
  try {
    const abs = isAbsolute(relPath) ? relPath : join(projectDir, relPath);
    const st = lstatSync(abs);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * PURE composition of the porcelain-v2 parse with per-file `worktree_oid` and
 * `mtime_ms` lookups — no git, no fs probe. Both impure inputs arrive as maps so
 * the builder is fully unit-testable with synthetic payloads:
 *   - `oidByPath`: the filter-correct worktree blob oid per dirty-file path
 *     (production: {@link batchHashObjectOids}). Missing key → `null`.
 *   - `mtimeByPath`: the file's lstat mtime in unix-epoch ms per path
 *     (production: per-file {@link lstatMtimeMs}). Missing key → `null` (the
 *     documented producer-side stat race).
 *
 * {@link buildGitSnapshot} calls the two impure helpers then delegates here, so
 * production behavior is byte-identical. The renamed-path case keeps the renamed
 * entry's `path` (the NEW path); `orig_path` rides along when set.
 */
export function buildGitSnapshotFrom(
  projectDir: string,
  status: ParsedGitStatus,
  oidByPath: Map<string, string | null>,
  mtimeByPath: Map<string, number | null>,
): GitSnapshotPayload {
  const dirty: GitDirtyFile[] = status.files.map((file) => {
    const entry: GitDirtyFile = {
      path: file.path,
      xy: file.xy,
      kind: file.kind,
      mtime_ms: mtimeByPath.get(file.path) ?? null,
      worktree_oid: oidByPath.get(file.path) ?? null,
      index_oid: file.index_oid,
      worktree_mode: file.worktree_mode,
    };
    if (file.orig_path != null) entry.orig_path = file.orig_path;
    return entry;
  });

  return {
    project_dir: projectDir,
    branch: status.branch,
    head_oid: status.head_oid,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    dirty_files: dirty,
  };
}

/**
 * Production entry point: the IMPURE wrapper around {@link buildGitSnapshotFrom}.
 * Runs the two impure helpers — one batched `git hash-object --stdin-paths`
 * ({@link batchHashObjectOids}) + a per-file `lstat` ({@link lstatMtimeMs}) — then
 * delegates to the pure builder. No event-log join, no `jobs` join: per-job
 * rollup, per-file attribution, and the orphan set are the reducer's job
 * (`projectGitStatus`, fn-633.6) so re-fold determinism holds.
 */
export function buildGitSnapshot(
  projectDir: string,
  status: ParsedGitStatus,
): GitSnapshotPayload {
  // v44 / fn-664: ONE batched `git hash-object --stdin-paths` call per
  // snapshot, covering every dirty file. Untracked/unmerged entries are
  // included — `hash-object` of an untracked file is a meaningful oid; the
  // discharge gate just won't have an `index_oid`/`worktree_mode` to pair
  // it with from the porcelain side, which is fine. The single spawn keeps
  // the producer latency budget tight (a dirty-heavy tree on a slow disk
  // would otherwise pay N spawn costs).
  const oidPaths = status.files.map((f) => f.path);
  const worktreeOidByPath = batchHashObjectOids(projectDir, oidPaths);

  // Per-file `lstat` for `mtime_ms`; a missed stat (the documented producer
  // stat race) leaves the path out of the map so the pure builder reads `null`.
  const mtimeByPath = new Map<string, number | null>();
  for (const file of status.files) {
    mtimeByPath.set(file.path, lstatMtimeMs(projectDir, file.path));
  }

  return buildGitSnapshotFrom(
    projectDir,
    status,
    worktreeOidByPath,
    mtimeByPath,
  );
}

/**
 * SEMANTIC dedupe key for a {@link GitSnapshotPayload} (epic fn-716). The
 * per-root no-op gate in `emitSnapshot` compares this key against the prior
 * emit; an unchanged key short-circuits the emit so the reducer never folds a
 * snapshot that says nothing new.
 *
 * Why a hand-built semantic key, NOT `JSON.stringify(snapshot)` (the pre-fn-716
 * gate): the payload embeds per-file `mtime_ms` (and `worktree_oid`, which
 * churns whenever the file's *bytes* change). Under continuous churn — exactly
 * when a worker session is editing — `mtime_ms` advances on every save, so a
 * payload-hash key is unique on every snapshot and the gate NEVER fires. The
 * result was the ~13-20/sec GitSnapshot flood this epic fixes.
 *
 * The key covers ONLY render-significant fields — what the board / autopilot
 * actually read off `git_status`: `project_dir`, `head_oid`, `upstream`,
 * `ahead`, `behind`, and per-dirty-file `{path, xy, kind, orig_path,
 * worktree_oid, index_oid, worktree_mode}`. It DELIBERATELY EXCLUDES `mtime_ms`
 * (a pure file-system timestamp that changes without changing what's dirty) so
 * a save that doesn't change the dirty SET / content does not re-emit.
 *
 * It KEEPS `worktree_oid` in the key on purpose: a content change to a dirty
 * file IS render-significant (the reducer's content-aware discharge gate keys
 * on `blob_oid === worktree_oid`, so the same path with new bytes must produce
 * a fresh snapshot). `mtime_ms` and `worktree_oid` BOTH remain in the EMITTED
 * payload regardless — the reducer's pass-2 inferred attribution
 * (`last_mutation_at = mtime_ms / 1000`) and content-aware discharge
 * (`worktree_oid`) read them off the folded event. Only `mtime_ms` is dropped
 * from the *key*, never from the payload.
 *
 * The dirty-file projection is order-sensitive but `git status --porcelain=v2`
 * (and thus `buildGitSnapshot`) yields a stable total order, so the key is a
 * deterministic function of the parse — no sort needed here.
 *
 * Re-fold safety: this is a PRODUCER-side gate only. It changes WHETHER a
 * snapshot event is appended, never the event's contents; a correct dedupe
 * would have dropped exactly the snapshots this drops (same render-significant
 * state). The event log a from-scratch re-fold replays is unchanged in shape,
 * so projections stay byte-identical.
 */
export function semanticSnapshotKey(snapshot: GitSnapshotPayload): string {
  const files = snapshot.dirty_files.map((f) => ({
    path: f.path,
    xy: f.xy,
    kind: f.kind,
    // `orig_path` is render-significant (a rename pair) — `??` to `null` so the
    // key is stable whether the field is absent or explicitly null.
    orig_path: f.orig_path ?? null,
    // worktree_oid IN (content change is render-significant); mtime_ms OUT.
    worktree_oid: f.worktree_oid,
    index_oid: f.index_oid,
    worktree_mode: f.worktree_mode,
  }));
  return JSON.stringify({
    project_dir: snapshot.project_dir,
    head_oid: snapshot.head_oid,
    upstream: snapshot.upstream,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    dirty_files: files,
  });
}

/**
 * Pure decision for the `data_version` poll wake. The `data_version` pragma
 * signals "SOMETHING committed to keeper.db" with no root attribution — a hook
 * tool event dirtying repo A bumps the same counter as one dirtying repo B — so
 * it must only drive an O(1) membership reconcile, NEVER an O(roots) per-root
 * snapshot fan-out (that fan-out was the CPU-flood source this epic removes).
 *
 * The wake is membership-only: `reconcile` is true on any advance — a foreign
 * write (a tool event dirtying a repo, a new job row) may have changed which
 * roots should be watched, and that reconcile is cheap + idempotent. NEVER
 * gated, so a real foreign change still re-evaluates membership. Per-root
 * snapshots come SOLELY from the worktree + git-common-dir FSEvents subs (with
 * the drop-triggered rescan) and the 60s heartbeat backstop — never from this
 * unattributed poll.
 *
 * Returns `{ reconcile }`: true on any version advance, false otherwise.
 */
export interface DataVersionWakeDecision {
  reconcile: boolean;
}

export function decideDataVersionWake(
  curVersion: number,
  lastVersion: number,
): DataVersionWakeDecision {
  return { reconcile: curVersion !== lastVersion };
}

/**
 * The `.git`-metadata files the two-tier poll cheap-`stat()`s per root (fn-921).
 * A change to any of these is the cheap proxy for "a commit / checkout / branch
 * switch / index update happened": `HEAD` (current ref / detached oid), `index`
 * (staging mutations), `logs/HEAD` (reflog — every ref move), `packed-refs` (gc /
 * fetch). Paired with a shallow worktree-root mtime so a save in the worktree
 * (which touches the worktree dir's mtime) is also caught. Resolved against the
 * git COMMON-dir so a linked worktree's shared refs are covered (mirrors
 * {@link gitCommonDirFor}). Missing files contribute `0` — the signature still
 * changes when one appears/disappears.
 */
const GIT_META_FILES = ["HEAD", "index", "logs/HEAD", "packed-refs"] as const;

/**
 * Read the two-tier poll signature for a root: the worktree-root mtime plus each
 * {@link GIT_META_FILES} mtime under the git common-dir, joined into one stable
 * string. A changed signature ⇒ "rescan this root". IMPURE (fs `lstat`) — this is
 * the producer's poll boundary, so it lives in the worker, never a fold. A stat
 * that throws (vanished file) contributes `0`, so a delete still flips the
 * signature. Returns `null` ONLY when the worktree root itself cannot be stat'd
 * (vanished root) — the caller treats `null` as "no usable signature, skip".
 *
 * The git common-dir is resolved once and cached by the caller; here it is passed
 * in so the per-tick cost is a handful of `lstat`s and no `git` spawn.
 */
export function readGitMetaSignature(
  root: string,
  gitCommonDir: string | null,
): string | null {
  let worktreeMtime: number;
  try {
    worktreeMtime = lstatSync(root).mtimeMs;
  } catch {
    return null;
  }
  const parts: string[] = [String(worktreeMtime)];
  if (gitCommonDir != null) {
    for (const rel of GIT_META_FILES) {
      let mtime = 0;
      try {
        mtime = lstatSync(join(gitCommonDir, rel)).mtimeMs;
      } catch {
        mtime = 0;
      }
      parts.push(`${rel}:${mtime}`);
    }
  }
  return parts.join("|");
}

/**
 * Pure decision for the two-tier git poll (fn-921). Given the previously-seen
 * metadata signature and the freshly-read one, decide whether to rescan:
 *
 *   - `prev == null` (first observation of this root) → rescan: we have no
 *     baseline, so emit once to establish the surface (the per-root semantic
 *     dedupe in `emitSnapshot` absorbs a no-op).
 *   - `cur == null` (worktree vanished) → skip: no usable signature; the
 *     vanished-root prune (full sweep) tombstones it separately.
 *   - `cur !== prev` → rescan (a delta).
 *   - else → skip (quiet — the negligible-cost steady state).
 *
 * PURE — string compare only, no I/O. Exported for unit reach (the
 * {@link decideDataVersionWake} sibling model).
 */
export function decideGitPoll(
  prev: string | null,
  cur: string | null,
): { rescan: boolean } {
  if (cur == null) return { rescan: false };
  if (prev == null) return { rescan: true };
  return { rescan: cur !== prev };
}

/** Read the inclusive event watermark that a subsequent Git observation covers. */
export function readGitAttributionWatermark(db: Database): number | null {
  try {
    const row = db.query("SELECT MAX(id) AS max_id FROM events").get() as {
      max_id: number | null;
    } | null;
    const value = row?.max_id ?? 0;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Pure decision for the quiet-repo `seed_required` clear (fn-921). The boot-seed
 * captures the floor at `max(events.id)` BEFORE its scan; if a gated root's last
 * live snapshot sits AT/BELOW that floor (or the boot-seed missed the root), the
 * root has no above-floor `git_status` row and `seed_required` stays set —
 * FOREVER on a quiet repo, because the change-driven poll never fires with no
 * file activity. The fix: while `seed_required` is set, FORCE-emit a snapshot for
 * the unseeded gated roots (bypassing the semantic dedupe) so main folds an
 * above-floor snapshot and clears the flag. This helper decides the per-root
 * force-emit set: the intersection of the currently-WATCHED roots with the
 * unseeded gated roots (a root the worker doesn't watch can't be force-emitted
 * here — the boot-seed / membership reconcile owns establishing it).
 *
 * Returns the roots to force-emit (a subset of `watched`), or `[]` when
 * `seedRequired` is false (the steady state — no work). PURE: set arithmetic
 * only, no I/O; the caller owns the `seed_required` read + the emit.
 */
export function decideSeedRequiredEmit(
  seedRequired: boolean,
  watched: Iterable<string>,
  unseededGated: ReadonlySet<string>,
): string[] {
  if (!seedRequired || unseededGated.size === 0) return [];
  const out: string[] = [];
  for (const root of watched) {
    if (unseededGated.has(root)) out.push(root);
  }
  return out;
}

function startWorker(): void {
  if (parentPort == null) {
    console.error("[git-worker] no parentPort — not running as a Worker");
    process.exit(1);
  }
  const data = workerData as GitWorkerData | undefined;
  if (data == null || typeof data.dbPath !== "string") {
    console.error("[git-worker] missing dbPath in workerData");
    process.exit(1);
  }

  const { db } = openDb(data.dbPath, {
    readonly: true,
    prepareStmts: false,
    bootRetry: true,
  });
  const port = parentPort;

  const lastByRoot = new Map<string, string>();
  /**
   * Per-root HEAD-oid bootstrap cache. On first observation of a root, we
   * seed this with the current `head_oid` from `git status --porcelain=v2
   * --branch` so the worker emits NOTHING on bootstrap — we don't know if
   * the existing HEAD landed during this keeperd run or before it, so the
   * honest move is "watch from here forward". On every subsequent
   * snapshot, a non-equal `head_oid` is the HEAD-delta signal that fires
   * commit enumeration. After a successful enumeration we update the
   * Map so the next snapshot's comparison is against the just-emitted
   * head.
   *
   * Not persisted across daemon restarts: the seed sweep + this Map's
   * lazy population on first snapshot mean a launchd restart sees the
   * post-restart HEAD as "current" and starts emitting only on
   * post-restart deltas. Misses the discharge for any commit that
   * landed while keeperd was down — accepted lossiness; the
   * file_attributions invariant is "best-effort discharge against
   * observed commits", not "exhaustive historical replay".
   */
  const lastHeadOidByRoot = new Map<string, string | null>();
  /**
   * Epic fn-705 (T2): per-root consecutive `enumerateCommitsInDelta` failure
   * count. Bumped on each throw while the HEAD-oid cache is held back (so the
   * failed range re-enumerates next observation), reset to 0 on the first
   * success, and reset when {@link COMMIT_ENUM_MAX_RETRIES} is hit and the
   * cache is force-advanced past a permanently-broken range. Drives
   * {@link decideHeadCacheAdvance}. Cleared with the other per-root caches on
   * unsubscribe.
   */
  const headEnumFailuresByRoot = new Map<string, number>();
  // fn-921 poll-only: each watched root holds a poll-watch entry instead of an
  // `@parcel/watcher` subscription. `gitCommonDir` is resolved once (a single
  // `git rev-parse --git-common-dir` spawn) and cached so each ~300ms poll tick
  // is a handful of `lstat`s, never a `git` spawn; `lastSignature` is the prior
  // {@link readGitMetaSignature} so {@link decideGitPoll} can flag a delta.
  // `null` gitCommonDir means the common-dir resolve failed — the worktree-root
  // mtime alone still flags worktree saves, and the heartbeat backstop covers
  // commit/checkout for that root within 60s.
  interface RootPollWatch {
    gitCommonDir: string | null;
    lastSignature: string | null;
  }
  const subscriptions = new Map<string, RootPollWatch>();
  const schedulers = new Map<string, RescanScheduler>();
  /**
   * Epic fn-716: count of GitSnapshot emits coalesced away by the semantic
   * dedupe gate ({@link semanticSnapshotKey}) — i.e. a re-snapshot whose
   * render-significant state matched the prior emit (typically pure mtime churn
   * under continuous editing). Logged on the heartbeat so the flood reduction is
   * observable without per-drop log spam. Reset to 0 after each log.
   */
  let coalescedDrops = 0;
  const cwdRootCache = new Map<string, string | null>();
  /**
   * Epic fn-690: per-root watch-membership verdict TTL memo. Distinct from
   * `cwdRootCache` (cwd→toplevel, permanent) — this map holds the
   * dirty/ahead probe verdict at hot ({@link WATCH_PROBE_TTL_HOT_MS}) or
   * cold ({@link WATCH_PROBE_TTL_COLD_MS}) TTL so steady-state
   * `git status` spawns are ≈ 0. Pruned lazily inside
   * {@link discoverProjectRoots}.
   */
  const watchProbeCache = new Map<string, WatchProbeCacheEntry>();
  /**
   * Epic fn-690: per-root "first observed clean-and-pushed" wall-clock
   * (`Date.now()`) timestamp. Drives the cooling-hysteresis dwell — see
   * {@link decideReconcileTransitions} and
   * {@link WATCH_DROP_DWELL_MS}. The entry is stamped the first reconcile
   * cycle a watched root falls out of the desired set, cleared the
   * moment it re-qualifies (re-dirty or new ahead commits), and
   * deleted once the root is actually dropped.
   */
  const cleanSinceByRoot = new Map<string, number>();
  /**
   * fn-705 discovery-nudge roots forwarded by main (an
   * {@link AddDiscoveryRootMessage} per repo the plan-worker first saw a
   * `.keeper` tree in). Folded into the candidate set on every reconcile via
   * {@link buildDiscoveryCandidates} so a repo with no seen-cwd job history is
   * still discovered. Grows monotonically across the worker's lifetime; bounded
   * by the number of distinct plan repos (small, and the membership floor it
   * provides is harmless — `shouldWatchRoot` still gates on `.keeper` presence
   * / dirty / ahead, so a nudge for a repo whose `.keeper` later vanishes
   * simply stops qualifying).
   */
  const extraCandidateRoots = new Set<string>();
  /**
   * Epic fn-690: wall-clock (`Date.now()`) timestamp of the last full-history sweep
   * (`runFullSweep: true`). `null` until the first reconcile fires.
   * Throttled to {@link FULL_SWEEP_INTERVAL_MS} so the heavy
   * `SELECT DISTINCT cwd FROM jobs` walk + cold-tier re-probes runs ~5min
   * apart; the fast path covers everything in between.
   */
  let lastFullSweepMs: number | null = null;
  /**
   * Per-root monotonic timestamp (`performance.now()` ms) at which the worker's
   * `git`-derived HEAD first diverged from the fs-derived HEAD and has stayed
   * divergent since. `undefined`/absent means "in agreement". Cleared the moment
   * git and fs agree (or fs can't be resolved). The `emitSnapshot` gate reads
   * this to suppress divergent snapshots and to escalate after
   * {@link HEAD_DIVERGENCE_GRACE_MS}. See {@link decideHeadDivergence}.
   */
  const headDivergentSinceByRoot = new Map<string, number>();

  /**
   * Roots already tombstoned by the vanished-worktree prune ({@link
   * selectVanishedRoots}). A `GitRootDropped` round-trips through main →
   * synthetic event → reducer DELETE, so the row lingers for a poll tick or
   * two after we emit; this Set suppresses re-emitting it every full sweep in
   * the interim. An entry is cleared the moment the dir reappears, so a
   * re-created worktree can be tombstoned again if it vanishes a second time.
   */
  const vanishedTombstoned = new Set<string>();

  /**
   * Per-currently-watched-root count of CONSECUTIVE vanished ({@link
   * probeRootPresence} → `vanished`) sweep passes. A live lane retires only
   * once this reaches two, so a transient stat blip on a watched `.keeper` lane
   * never drops it. Reset the moment a probe reports `present` or `error`, and on
   * retire; pruned once the row round-trips. Unwatched roots never touch it (their
   * single-pass retire is unchanged), so the boot path is byte-identical.
   */
  const vanishStreak = new Map<string, number>();

  /**
   * Set by a teardown nudge ({@link NudgeVanishedSweepMessage}); consumed at the
   * top of the next {@link reconcileRoots} to run an IMMEDIATE vanished sweep
   * (satisfying the debounce with a second confirming probe) even when the
   * throttled full sweep is not due. Cleared as it is consumed.
   */
  let vanishedSweepRequested = false;

  let dbPollTimer: ReturnType<typeof setInterval> | null = null;
  let gitPollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastDataVersion: number | null = null;
  let shuttingDown = false;

  // ── fn-720 backstop telemetry ──────────────────────────────────────────────
  // `lastFastPathAt` is stamped at every confirmed FAST-path fire (the FSEvents
  // scheduler debounced emit — the only fast-path snapshot source now that the
  // data_version poll drives membership reconcile only); the 60s heartbeat (the
  // slow backstop) reads it to compute staleness. `null` until
  // the first fast path fires — the cold-boot sentinel that keeps a giant false
  // staleness off the histogram (buildMissedWakeRecord nulls staleness then).
  // The counters accumulate fires/rescues per (backstop,class) for the
  // denominator; a periodic + on-shutdown rollup flushes them up to main.
  let lastFastPathAt: number | null = null;
  const backstopCounters = new BackstopCounters();
  let rollupTimer: ReturnType<typeof setInterval> | null = null;
  const markFastPath = (): void => {
    lastFastPathAt = Date.now();
  };
  const flushBackstopRollups = (): void => {
    for (const rollup of backstopCounters.snapshot(Date.now())) {
      port.postMessage({
        kind: "backstop",
        record: rollup,
      } satisfies BackstopMessage);
    }
  };

  // Single-flight reconciler — DB poll + heartbeat + boot all call this and
  // must not double-subscribe across an `await`.
  let reconciling = false;
  let reconcilePending = false;

  // Returns `true` iff this call emitted a fresh GitSnapshot through `port`
  // (fn-720) — the `rescued` boolean the heartbeat backstop folds into one
  // uniform `missed-wake` record. Every early-return / divergence-suppress /
  // semantic-dedupe coalesce path returns `false`.
  //
  // fn-771: the optional `dischargedCommitAtMs` collector lets the heartbeat
  // backstop derive the true change-to-rescue latency. When provided, every
  // commit this call discharges in the HEAD-oid delta pushes its `committed_at_ms`
  // (positive only — a 0/unparseable commit time is NOT a usable anchor). The
  // heartbeat then takes the worst-case (oldest) anchor across all rescued roots
  // for `now − committed_at_ms`. The fast-path callers (scheduler emit, initial
  // subscribe) pass nothing — only the slow backstop needs the latency.
  //
  // fn-921: `force` bypasses the per-root semantic dedupe so a quiet repo with
  // `seed_required` set re-emits an UNCHANGED snapshot — the boot-seed may have
  // captured a floor ABOVE this root's last live snapshot, leaving the surface
  // unseeded yet the dedupe key identical. A forced emit lands an above-floor
  // snapshot main folds to clear `seed_required`. Used ONLY by the seed-required
  // backstop; every other caller leaves it false so the dedupe still suppresses
  // no-op churn.
  function emitSnapshot(
    root: string,
    dischargedCommitAtMs?: number[],
    force = false,
  ): boolean {
    if (shuttingDown) return false;
    // Capture BEFORE reading Git. The eventual synthetic event id is not an
    // observation fence: a hook event can land after readStatus but before main
    // appends the snapshot. Such an event must remain above this watermark for
    // the next observation rather than being compacted away unseen.
    const attributionEventId = readGitAttributionWatermark(db);
    if (attributionEventId === null) {
      console.error(
        `[git-worker] attribution watermark unavailable for ${root}; snapshot suppressed`,
      );
      return false;
    }
    let status: ParsedGitStatus | null;
    try {
      status = readStatus(root);
    } catch (err) {
      console.error(
        `[git-worker] readStatus failed for ${root}: ${stringifyErr(err)}`,
      );
      return false;
    }
    if (status == null) return false;

    // Wedge guard (data-integrity gate). The long-lived git subprocess can
    // start returning a STALE view (frozen head + dirty set) while fs reads in
    // this same process stay fresh; emitting it surfaces committed-clean files
    // as phantom dirty <orphan> across every repo. Cross-check the just-read
    // git HEAD against the fs-derived truth BEFORE trusting the payload, and on
    // divergence suppress everything below (no emit, no commit enumeration, no
    // head-cache advance) — see snapshotSuppressedByDivergence. Runs here on the
    // live emit path because the 60s heartbeat proved unreliable during a real
    // wedge (it never fired).
    if (snapshotSuppressedByDivergence(root, status.head_oid)) {
      return false;
    }

    // HEAD-oid delta detection — runs BEFORE the snapshot emission so a
    // commit's discharge lands before the next observed dirty count. The
    // first time we see a root, seed the Map with the current head_oid
    // and emit no commits (bootstrap-from-null avoidance per the task
    // spec). Every subsequent observation compares against the seeded
    // prev and emits one CommitMessage per commit in the delta.
    const currentHeadOid = status.head_oid;
    const had = lastHeadOidByRoot.has(root);
    if (!had) {
      lastHeadOidByRoot.set(root, currentHeadOid);
    } else {
      const prev = lastHeadOidByRoot.get(root) ?? null;
      if (currentHeadOid !== null && currentHeadOid !== prev) {
        // Epic fn-705 (T2): track whether enumeration succeeded so the
        // head-cache advance below is gated on it — a transient throw must
        // NOT skip the failed range (which would permanently drop the
        // commit's `plan-commit-changed` + `Commit` discharge), so we hold
        // the cache and re-enumerate on the next HEAD-oid observation. Bounded
        // by COMMIT_ENUM_MAX_RETRIES so a permanently corrupt range doesn't
        // hot-spin. See decideHeadCacheAdvance.
        let enumOk = true;
        try {
          const commits = enumerateCommitsInDelta(root, prev, currentHeadOid);
          for (const c of commits) {
            port.postMessage({
              kind: "commit",
              project_dir: root,
              commit_oid: c.commit_oid,
              parent_oid: c.parent_oid,
              files: c.files,
              committer_session_id: c.committer_session_id,
              // Epic fn-670 (T1): the validated, plan-shaped `Task:`
              // trailer values the git-worker collected for this
              // commit. Empty `[]` on the common path (no Task trailer,
              // or all values malformed). The reducer's T2 link fold
              // reads this array together with `committer_session_id`
              // to stamp the per-task `last_commit_for_task_at` on the
              // embedded job element under each named task.
              task_ids: c.task_ids,
              // Epic fn-695: the normalized plan op + validated target
              // ref lifted from this commit's `Planctl-Op:` /
              // `Planctl-Target:` trailers. Both null on a non-plan
              // commit. The reducer's edge fold reads them (with
              // `committer_session_id`) to mint the commit-derived
              // creator/refiner edge, deduped against the legacy stdout
              // scrape in `syncPlanLinks`.
              plan_op: c.plan_op,
              plan_target: c.plan_target,
              committed_at_ms: c.committed_at_ms,
            } satisfies CommitMessage);
            // fn-771: collect this discharged commit's time so the heartbeat
            // backstop can derive the true change-to-rescue latency. Only a
            // POSITIVE committed_at_ms is a usable anchor — enumerateCommitsInDelta
            // clamps an unparseable/non-positive commit time to 0, which would
            // otherwise read as a ~epoch-sized false latency.
            if (dischargedCommitAtMs !== undefined && c.committed_at_ms > 0) {
              dischargedCommitAtMs.push(c.committed_at_ms);
            }
            // Epic fn-681: authoritative commit-driven plan ingest.
            // Filter the commit's enumerated file list to plan-shaped
            // paths (epics / tasks / state-tasks) and post one
            // {@link PlanCommitChangedMessage} per commit carrying any
            // such paths. Suppressed when the commit touched no plan
            // files — the common case for source commits. Main forwards
            // the message verbatim to plan-worker, which re-ingests each
            // path from the committed worktree via the existing
            // `onChange` / `onDelete` pipeline (drop-proof; no partial-
            // read race). The reducer never sees this message — it lives
            // entirely on the worker→main→worker side channel.
            const planChanges = filterPlanChanges(c.files);
            if (planChanges.length > 0) {
              port.postMessage({
                kind: "plan-commit-changed",
                project_dir: root,
                commit_oid: c.commit_oid,
                changes: planChanges,
              } satisfies PlanCommitChangedMessage);
            }
          }
        } catch (err) {
          // Producer-only contract: a failed enumeration cannot wedge the
          // worker; log to stderr and continue. Unlike the pre-fn-705 code we
          // do NOT advance the head cache past this range below — `enumOk`
          // gates the advance so the next HEAD-oid observation re-enumerates
          // and re-emits the dropped commit's `plan-commit-changed`.
          enumOk = false;
          console.error(
            `[git-worker] commit enumeration failed for ${root}: ${stringifyErr(err)}`,
          );
        }
        // Epic fn-705 (T2): advance the head cache ONLY when enumeration
        // succeeded, or when the retry budget is spent (force-advance with a
        // loud backstop alarm to break a hot re-enumeration spin on a
        // permanently corrupt range). Holding the cache on a transient throw
        // is the whole fix — the dropped commit re-enumerates next time.
        const advanceDecision = decideHeadCacheAdvance(
          enumOk,
          headEnumFailuresByRoot.get(root) ?? 0,
          COMMIT_ENUM_MAX_RETRIES,
        );
        if (advanceDecision.nextFailures === 0) {
          headEnumFailuresByRoot.delete(root);
        } else {
          headEnumFailuresByRoot.set(root, advanceDecision.nextFailures);
        }
        if (advanceDecision.loudBackstop) {
          console.error(
            `[git-worker] commit enumeration failed ${COMMIT_ENUM_MAX_RETRIES}x for ${root} (${(prev ?? "null").slice(0, 12)}..${currentHeadOid.slice(0, 12)}) — force-advancing head cache; the commit channel dropped this range, the heartbeat backstop must recover it`,
          );
        }
        if (advanceDecision.advance) {
          // NULL head_oid is unreachable here (guarded by the `!== null`
          // above), but the same-head no-op is still absorbed by the
          // `currentHeadOid !== prev` branch guard.
          lastHeadOidByRoot.set(root, currentHeadOid);
        }
        // When `advance` is false (transient throw, retries remain) the cache
        // stays at `prev`, so the next observation with the same or a newer
        // head re-enumerates the failed range — drop-proof.
      }
    }

    let snapshot: GitSnapshotPayload;
    try {
      snapshot = buildGitSnapshot(root, status);
    } catch (err) {
      console.error(
        `[git-worker] buildGitSnapshot failed for ${root}: ${stringifyErr(err)}`,
      );
      return false;
    }
    // Epic fn-716: SEMANTIC dedupe key — render-significant fields only,
    // EXCLUDING per-file mtime_ms (which churns on every save without changing
    // what's dirty). The pre-fn-716 `JSON.stringify(snapshot)` key embedded
    // mtime_ms, so it was unique on every snapshot under continuous editing and
    // the gate never fired (the GitSnapshot flood). mtime_ms + worktree_oid
    // stay in the EMITTED payload below — only the KEY drops mtime_ms.
    const key = semanticSnapshotKey(snapshot);
    if (!force && lastByRoot.get(root) === key) {
      coalescedDrops++;
      return false;
    }
    lastByRoot.set(root, key);
    port.postMessage({
      kind: "git-snapshot",
      ...snapshot,
      attribution_event_id: attributionEventId,
    } satisfies GitSnapshotMessage);
    return true;
  }

  function schedulerFor(root: string): RescanScheduler {
    let s = schedulers.get(root);
    if (s != null) return s;
    // Epic fn-716: pass the per-root max-wait ceiling (task fn-716.1's
    // RescanScheduler `maxWaitMs` arg) so a root under continuous churn emits
    // ≤1 GitSnapshot per GIT_SNAPSHOT_MAX_WAIT_MS, latest-wins — a trailing
    // debounce alone re-arms forever under sustained edits and never flushes.
    s = new RescanScheduler(
      () => {
        // fn-720/fn-921: a debounced scheduler fire IS the fast path (a two-tier
        // poll delta from `pollGitRoots`). `markFastPath` is stamped by the poll
        // tick at schedule time; the heartbeat calls `emitSnapshot` DIRECTLY (not
        // through the scheduler), so it never stamps — exactly the
        // fast-path/backstop distinction we want.
        emitSnapshot(root);
      },
      DEFAULT_DEBOUNCE_MS,
      (m) => console.error(m),
      undefined,
      GIT_SNAPSHOT_MAX_WAIT_MS,
    );
    schedulers.set(root, s);
    return s;
  }

  /**
   * fn-921 quiet-repo `seed_required` clear. While the flag is set, force-emit a
   * snapshot for each WATCHED + unseeded gated root (see {@link
   * decideSeedRequiredEmit}) so main folds an above-floor `GitSnapshot` and clears
   * the flag — even with zero file activity (the change-driven poll never fires on
   * a quiet repo). The gated read key is normalized to the toplevel write key
   * ({@link memoizedGitToplevel}) so a subdir/symlink `target_repo` is matched.
   * Read-only DB access; the FORCE bypasses the semantic dedupe so an UNCHANGED
   * snapshot still lands above the floor. Returns the count emitted (for the
   * heartbeat's logging). Cheap + idempotent: once the flag clears (main's fold),
   * the next call sees `seedRequired=false` and does nothing.
   */
  function emitForUnseededGatedRoots(): number {
    let seedRequired: boolean;
    try {
      seedRequired = readGitProjectionSeedRequired(db);
    } catch {
      return 0;
    }
    if (!seedRequired) return 0;
    let unseeded: ReadonlySet<string>;
    try {
      unseeded = unseededGatedRoots(
        db,
        readGitProjectionFloor(db),
        memoizedGitToplevel(),
      );
    } catch {
      return 0;
    }
    const toEmit = decideSeedRequiredEmit(
      seedRequired,
      subscriptions.keys(),
      unseeded,
    );
    let emitted = 0;
    for (const root of toEmit) {
      if (emitSnapshot(root, undefined, /* force */ true)) emitted++;
    }
    return emitted;
  }

  /**
   * Wedge guard, called by `emitSnapshot` on the LIVE emit path (the proven path
   * — it's the one producing snapshots; the 60s heartbeat alone proved
   * unreliable, it never fired during a real wedge). Returns `true` when this
   * snapshot must be SUPPRESSED: the just-read `gitHead` disagrees with the
   * fs-derived ground truth ({@link resolveHeadOidViaFs}), so the whole
   * `git status` payload is untrusted — a data-INTEGRITY failure, not mere
   * staleness. The caller must then NOT emit, NOT enumerate commits, and NOT
   * advance any head cache.
   *
   * Persistence is tracked on the monotonic clock in {@link
   * headDivergentSinceByRoot}. Once divergence has held ≥ {@link
   * HEAD_DIVERGENCE_GRACE_MS} the worker `process.exit(1)`s → `close` event in
   * main → `fatalExit` → LaunchAgent restart (a fresh process re-seeds HEAD
   * correctly; verified a bounce clears the wedge in ~30s). NEVER respawn
   * in-process — the no-self-heal invariant. Logs once at onset and once at trip
   * (rate-limited — not every suppressed emit). Agreement / unresolvable fs head
   * clears the timer; we never escalate on uncertainty.
   */
  function snapshotSuppressedByDivergence(
    root: string,
    gitHead: string | null,
  ): boolean {
    const fsHead = resolveHeadOidViaFs(root);
    const prior = headDivergentSinceByRoot.get(root) ?? null;
    const decision = decideHeadDivergence(
      gitHead,
      fsHead,
      prior,
      performance.now(),
      HEAD_DIVERGENCE_GRACE_MS,
    );
    if (!decision.suppress) {
      headDivergentSinceByRoot.delete(root);
      return false;
    }
    headDivergentSinceByRoot.set(root, decision.sinceMs as number);
    if (prior == null) {
      console.error(
        `[git-worker] HEAD divergence for ${root}: git=${(gitHead ?? "null").slice(0, 12)} fs=${(fsHead ?? "null").slice(0, 12)} — suppressing snapshots (grace ${HEAD_DIVERGENCE_GRACE_MS}ms)`,
      );
    }
    if (decision.trip) {
      console.error(
        `[git-worker] HEAD divergence watchdog tripped for ${root} after ${Math.round((performance.now() - (decision.sinceMs as number)) / 1000)}s — git subprocess view is wedged; exiting for LaunchAgent restart`,
      );
      try {
        db.close();
      } catch {
        // best-effort — process is exiting anyway
      }
      process.exit(1);
    }
    return true;
  }

  /**
   * fn-921 poll-only: begin POLLING a newly-desired root. Resolves the git
   * common-dir ONCE (one `git rev-parse` spawn; cached on the poll-watch entry so
   * the steady poll is `lstat`-only), seeds the poll-watch with no baseline
   * signature, and emits the initial snapshot. The next poll tick reads the first
   * signature; subsequent ticks flag deltas via {@link decideGitPoll}. No
   * `@parcel/watcher` subscription — there is nothing async to await and nothing
   * to tear down, so this is synchronous and cannot leave a half-armed watcher.
   */
  function startWatchingRoot(root: string): void {
    if (shuttingDown) return;
    if (subscriptions.has(root)) return;
    const commonDir = gitCommonDirFor(root);
    subscriptions.set(root, { gitCommonDir: commonDir, lastSignature: null });
    // Initial snapshot for the newly-watched root.
    emitSnapshot(root);
  }

  /**
   * fn-921: the two-tier poll tick. For each watched root, cheap-`stat()` its
   * metadata signature and schedule a debounced rescan on a delta. Negligible
   * steady-state cost (a handful of `lstat`s per root, no `git` spawn). The
   * per-root `RescanScheduler` + `lastByRoot` dedupe absorb over-firing. Posts a
   * liveness pulse to main AFTER the sweep so the supervisor's seed watchdog can
   * tell "alive and ticking" from "alive but stuck".
   */
  function pollGitRoots(): void {
    if (shuttingDown) return;
    for (const [root, watch] of subscriptions) {
      const cur = readGitMetaSignature(root, watch.gitCommonDir);
      const { rescan } = decideGitPoll(watch.lastSignature, cur);
      // Advance the baseline whenever we have a usable signature, so a delta is
      // detected exactly once. A `null` (vanished worktree) keeps the prior
      // signature so a re-appearing root re-flags on its next read.
      if (cur != null) watch.lastSignature = cur;
      if (rescan) {
        markFastPath();
        schedulerFor(root).schedule();
      }
    }
    // fn-921 liveness pulse — see GitLivenessMessage. Always posted (even on a
    // fully-quiet sweep) so a missing pulse means a STUCK tick, not just a quiet
    // repo. Shutdown-gated above. Cheap (a single postMessage per tick).
    if (!shuttingDown) {
      port.postMessage({
        kind: "git-liveness",
        at_ms: Date.now(),
      } satisfies GitLivenessMessage);
    }
  }

  // Post the retract tombstone — main lifts this into a synthetic GitRootDropped
  // event whose reducer fold DELETEs the projection row. `attribution_event_id`
  // is a clean-read watermark for a dwell drop, or `null` for a vanished root
  // whose fs state cannot be observed. Skip during shutdown — main has already
  // cleared its onmessage handler and a post would just race the worker's exit
  // path. Split from {@link cleanupRootState} so the vanished-sweep retire path
  // fires EXACTLY ONE tombstone per retire (the double-post hazard).
  function postRootDropped(
    root: string,
    attributionEventId: number | null,
  ): void {
    if (shuttingDown) return;
    port.postMessage({
      kind: "git-root-dropped",
      project_dir: root,
      attribution_event_id: attributionEventId,
    } satisfies GitRootDroppedMessage);
  }

  // Clean a root's subscription + scheduler + per-root caches so no poller leaks
  // against a dropped/vanished dir. NO tombstone — the caller posts exactly one
  // via {@link postRootDropped}.
  function cleanupRootState(root: string): void {
    // fn-921 poll-only: a watched root is just a map entry now — no async
    // FSEvents teardown, only the delete.
    subscriptions.delete(root);
    const sched = schedulers.get(root);
    if (sched != null) {
      sched.cancel();
      schedulers.delete(root);
    }
    lastByRoot.delete(root);
    // Clear the HEAD-oid bootstrap cache too so a re-watch of the same root
    // (`.keeper` dir re-created) re-seeds from the current head and doesn't emit
    // a phantom delta against the pre-drop state. The fn-705 enumeration-failure
    // counter is per-root and meaningless across a re-watch, so drop it in
    // lockstep.
    lastHeadOidByRoot.delete(root);
    headEnumFailuresByRoot.delete(root);
  }

  async function unsubscribeRoot(
    root: string,
    attributionEventId: number,
  ): Promise<void> {
    // Tombstone FIRST (posting before teardown keeps the producer-only contract:
    // the event log is the sole driver of git_status changes, so re-fold
    // determinism extends to retractions), then clean the root state. The
    // vanished-sweep retire path calls the same two primitives with a null
    // attribution, so exactly one tombstone posts per retire on both paths.
    postRootDropped(root, attributionEventId);
    cleanupRootState(root);
  }

  async function reconcileRoots(): Promise<void> {
    if (shuttingDown) return;
    if (reconciling) {
      reconcilePending = true;
      return;
    }
    reconciling = true;
    try {
      // Date.now() — not performance.now(). nowMs flows into
      // buildDiscoveryCandidates where it derives `cutoffSec` for a
      // SQL comparison against `jobs.updated_at` (REAL unix seconds);
      // mixing performance.now()'s ms-since-process-start domain there
      // produces a near-zero or negative cutoff and silently disables
      // the recent-window filter. The downstream elapsed-time uses
      // (dwell timer, FULL_SWEEP_INTERVAL_MS throttle) stay correct
      // because they compare nowMs against a same-source stamp.
      const nowMs = Date.now();
      // Throttle the full-history sweep — fast path otherwise. The fast
      // path's bounded candidate set + the TTL memo together keep
      // steady-state spawns ≈ 0. The slow sweep widens to all
      // `DISTINCT cwd` to surface a stale unpushed-but-clean repo after
      // a keeper restart.
      const runFullSweep =
        lastFullSweepMs === null ||
        nowMs - lastFullSweepMs >= FULL_SWEEP_INTERVAL_MS;
      if (runFullSweep) lastFullSweepMs = nowMs;

      // fn-921 poll-only: there is no mute-stream re-arm anymore — a poll never
      // goes silent, so the fn-771 `pendingResubscribe` drain is gone. The
      // membership reconcile below is the sole add/drop driver.

      const currentlyWatched = new Set(subscriptions.keys());

      // Vanished-worktree prune. Runs on the full-sweep cadence (at boot —
      // lastFullSweepMs === null — and every FULL_SWEEP_INTERVAL_MS) AND on a
      // teardown nudge's immediate pass, so a git_status row whose directory was
      // deleted/moved sheds its ghost instead of lingering forever
      // (decideReconcileTransitions can't reach an unwatched root, and the dwell
      // path skips an always-watched `.keeper` lane). See selectVanishedRoots.
      const immediateVanishedSweep = vanishedSweepRequested;
      vanishedSweepRequested = false;
      if (runFullSweep || immediateVanishedSweep) {
        const rows = db.query("SELECT project_dir FROM git_status").all() as {
          project_dir: string;
        }[];
        for (const dir of selectVanishedRoots(
          rows.map((r) => r.project_dir),
          probeRootPresence,
          currentlyWatched,
          vanishedTombstoned,
          vanishStreak,
          immediateVanishedSweep,
        )) {
          // Retiring a currently-WATCHED lane also cleans its subscription +
          // scheduler state so no poller leaks against the dead dir; keep
          // `currentlyWatched` in lockstep so the reconcile below never re-drops
          // (double-tombstones) an already-swept root. An unwatched root has no
          // such state — just post the single tombstone. A vanished root has no
          // status observation to bind a newer watermark, so `null` attribution:
          // the reducer preserves its prior per-root floor.
          if (currentlyWatched.has(dir)) {
            cleanupRootState(dir);
            currentlyWatched.delete(dir);
          }
          postRootDropped(dir, null);
        }
      }

      const desired = new Set(
        discoverProjectRoots(db, {
          cwdRootCache,
          watchProbeCache,
          currentlyWatched,
          nowMs,
          runFullSweep,
          probe: probeWatchMembership,
          extraCandidates: extraCandidateRoots,
        }),
      );

      const { toAdd, toDrop } = decideReconcileTransitions(
        currentlyWatched,
        desired,
        cleanSinceByRoot,
        nowMs,
        WATCH_DROP_DWELL_MS,
      );

      // Cap new watches per cycle so the first full sweep can't fire hundreds of
      // `git rev-parse --git-common-dir` spawns at once. Remaining joins land on
      // subsequent reconciles (every DB-poll tick + heartbeat). Poll-only: each
      // watch is a synchronous `gitCommonDirFor` + map insert, no FSEvents stream.
      const capped = toAdd.slice(0, MAX_SUBSCRIBES_PER_CYCLE);
      for (const root of capped) {
        startWatchingRoot(root);
      }
      // If we capped, request another reconcile cycle so the rest land
      // promptly without waiting for the next data_version bump.
      if (toAdd.length > MAX_SUBSCRIBES_PER_CYCLE) {
        reconcilePending = true;
      }

      for (const root of toDrop) {
        // Re-confirm clean state with a watermark captured BEFORE the read. The
        // membership verdict can be TTL-cached; using the tombstone's eventual
        // event id would consume a concurrent mutation that this read never saw.
        const attributionEventId = readGitAttributionWatermark(db);
        let clean = false;
        if (attributionEventId !== null) {
          try {
            const status = readStatus(root);
            clean =
              status !== null &&
              status.files.length === 0 &&
              (status.ahead ?? 0) === 0 &&
              !snapshotSuppressedByDivergence(root, status.head_oid);
          } catch {
            clean = false;
          }
        }
        if (!clean || attributionEventId === null) {
          // Force a fresh membership decision and a new dwell rather than
          // dropping from stale or unavailable evidence.
          watchProbeCache.delete(root);
          cleanSinceByRoot.delete(root);
          continue;
        }
        await unsubscribeRoot(root, attributionEventId);
      }
    } finally {
      reconciling = false;
      if (reconcilePending) {
        reconcilePending = false;
        void reconcileRoots();
      }
    }
  }

  port.on("message", (msg: GitWorkerInbound | undefined) => {
    if (msg == null) return;
    if (msg.type === "add-discovery-root") {
      // fn-705 discovery nudge: fold the plan-worker's repo root into the
      // candidate set and request an immediate reconcile so the `.keeper`
      // short-circuit in `shouldWatchRoot` starts watching it now, not on the
      // next full sweep. Idempotent (Set add) + convergent (reconcile is
      // single-flighted). A nudge during shutdown is a tolerated no-op.
      if (shuttingDown) return;
      extraCandidateRoots.add(msg.root);
      void reconcileRoots();
      return;
    }
    if (msg.type === "nudge-vanished-sweep") {
      // Teardown nudge: a lane worktree's removals completed, so run an IMMEDIATE
      // vanished sweep instead of waiting for the next full sweep. The flag is
      // consumed at the top of reconcileRoots; the single-flight guard coalesces a
      // nudge landing mid-reconcile (it sets reconcilePending, never re-enters
      // concurrently). A nudge during shutdown is a tolerated no-op.
      if (shuttingDown) return;
      vanishedSweepRequested = true;
      void reconcileRoots();
      return;
    }
    if (msg.type !== "shutdown") return;
    shuttingDown = true;
    if (dbPollTimer != null) clearInterval(dbPollTimer);
    if (gitPollTimer != null) clearInterval(gitPollTimer);
    if (heartbeatTimer != null) clearInterval(heartbeatTimer);
    // fn-720: cancel the periodic rollup flush, then flush ONE final rollup so
    // the denominator survives a clean stop. postMessage is synchronous; main
    // is still reading (it sends `shutdown` and awaits `close`).
    if (rollupTimer != null) {
      clearInterval(rollupTimer);
      rollupTimer = null;
    }
    flushBackstopRollups();
    // Cancel every armed scheduler BEFORE db.close so a queued re-scan can't fire
    // against a closing connection. Mirrors plan-worker.
    for (const sched of schedulers.values()) sched.cancel();
    schedulers.clear();
    // fn-921 poll-only: no FSEvents subscriptions to await — clearing the timers
    // above stops the producer. Close the DB and exit synchronously.
    subscriptions.clear();
    try {
      db.close();
    } catch {
      // best-effort
    }
    process.exit(0);
  });

  // fn-747 seam: the in-process fold-pipeline tier arms NO producer timers — git
  // snapshots are not exercised there. The worker stays alive (the parentPort
  // listener keeps the event loop running) for the shutdown handshake.
  if (data.disableNativeWatcher) {
    return;
  }

  // fn-921 POLL-ONLY producer, armed UNCONDITIONALLY at worker start — NOT inside
  // a watcher `import().then()`. A watcher-load hang or a mute FSEvents stream can
  // therefore never again leave the producer with zero timers armed (the
  // 2026-06-23 silent freeze). No `@parcel/watcher` subscription is taken; every
  // per-root snapshot comes from the two-tier metadata poll, the db-poll
  // membership reconcile, or the heartbeat backstop.

  // Boot membership reconcile — derive the initial watched set + emit the first
  // snapshot per root. Then the two-tier poll keeps each root current.
  void reconcileRoots();

  // Two-tier git-metadata poll (fast path). Every GIT_POLL_MS, cheap-`stat()`
  // each watched root's `.git` metadata + worktree mtime and schedule a debounced
  // rescan on a delta. Posts a liveness pulse per tick so the supervisor's seed
  // watchdog can tell "alive + ticking" from "alive but stuck". See pollGitRoots.
  gitPollTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      pollGitRoots();
    } catch (err) {
      // Never let a poll tick throw out of the interval — log + continue so the
      // producer stays armed (the whole point of decoupling from the watcher).
      console.error(`[git-worker] poll tick failed: ${stringifyErr(err)}`);
    }
  }, GIT_POLL_MS);

  // DB-wake trigger. Per CLAUDE.md DO-NOT, `PRAGMA data_version` is the ONLY
  // sanctioned DB change primitive — `wake-worker.ts` uses the same pattern. A
  // bump means SOMETHING committed (new tool event, new job row, new epic/task
  // snapshot) and root membership may have changed. `data_version` carries NO
  // root attribution, so it drives membership reconcile ONLY (cheap, O(1),
  // idempotent) — it does NOT fan a per-root snapshot out (that O(roots) fan-out
  // was a CPU-flood source). See {@link decideDataVersionWake}.
  //
  // fn-1096.3: a transient SQLITE_NOTADB on this poll's PRAGMA data_version
  // read is a boot-checkpoint view race, not corruption — tolerate via the
  // shared helper (skip the tick, bounded consecutive-miss rethrow) rather
  // than letting it crash the worker. ONE instance for this poll site.
  const dataVersionTolerance = new NotadbTolerance();
  const emitDataVersionNotadbSkip = (consecutiveMisses: number): void => {
    console.error(
      `[git-worker] transient SQLITE_NOTADB on data_version poll — skipped tick (consecutive=${consecutiveMisses})`,
    );
    port.postMessage({
      kind: "backstop",
      record: buildTimeoutRecord({
        backstop: "notadb-skip",
        worker: "git-worker",
        rescued: true,
        now: Date.now(),
        stalenessMs: null,
        detail: { consecutive_misses: String(consecutiveMisses) },
      }),
    } satisfies BackstopMessage);
  };
  const dataVersionQuery = db.query("PRAGMA data_version");
  // A tolerated NOTADB on this VERY FIRST read (the boot-checkpoint race is
  // most likely right here) leaves `lastDataVersion` at its `null` init —
  // `decideDataVersionWake(cur, lastDataVersion ?? cur)` already treats a
  // `null` baseline as "no decision yet", so this is a harmless no-op, never
  // a false suppression.
  const dataVersionSeed = dataVersionTolerance.poll(
    () => (dataVersionQuery.get() as { data_version: number }).data_version,
  );
  if (dataVersionSeed.skipped) {
    emitDataVersionNotadbSkip(dataVersionSeed.consecutiveMisses);
  } else {
    lastDataVersion = dataVersionSeed.value;
  }
  dbPollTimer = setInterval(() => {
    if (shuttingDown) return;
    const outcome = dataVersionTolerance.poll(
      () => (dataVersionQuery.get() as { data_version: number }).data_version,
    );
    if (outcome.skipped) {
      emitDataVersionNotadbSkip(outcome.consecutiveMisses);
      return;
    }
    const cur = outcome.value;
    const decision = decideDataVersionWake(cur, lastDataVersion ?? cur);
    if (!decision.reconcile) return;
    lastDataVersion = cur;
    void reconcileRoots();
  }, DB_POLL_MS);

  // Heartbeat backstop (slow path). Re-reconciles membership, re-emits every
  // watched root (the per-root dedupe makes a healthy run free), and clears a
  // QUIET-repo `seed_required` via emitForUnseededGatedRoots — the change-driven
  // poll never fires with no file activity, so this is the path that un-darks an
  // idle gated root whose boot-seed missed the floor. emitSnapshot self-gates via
  // snapshotSuppressedByDivergence, so the heartbeat doubles as the quiet-repo
  // wedge-guard re-check.
  heartbeatTimer = setInterval(() => {
    if (shuttingDown) return;
    void reconcileRoots();
    // fn-720: OR the per-root emitted-booleans into one `rescued` flag. A `true`
    // means the heartbeat re-delivered a snapshot the poll fast path missed.
    let rescued = false;
    // fn-771: collect every discharged commit's time across the rescued roots so
    // the record carries the TRUE change-to-rescue latency.
    const dischargedCommitAtMs: number[] = [];
    for (const root of subscriptions.keys()) {
      if (emitSnapshot(root, dischargedCommitAtMs)) {
        rescued = true;
      }
    }
    backstopCounters.bump("git-heartbeat", "missed-wake", rescued);
    if (rescued) {
      const now = Date.now();
      // Worst-case (oldest) commit anchor across all roots rescued this tick →
      // `now − oldest`. No commit anchor (dirty-tree-only rescue) → null. A
      // negative latency (clock skew) is clamped to null by buildMissedWakeRecord.
      const changeToRescueMs = deriveChangeToRescueMs(
        dischargedCommitAtMs,
        now,
      );
      port.postMessage({
        kind: "backstop",
        record: buildMissedWakeRecord({
          backstop: "git-heartbeat",
          worker: "git-worker",
          // fn-925: the git surface is POLL-ONLY since fn-921 — the fast path
          // this rescue is measured against is the two-tier .git metadata stat
          // poll, not the retired @parcel/watcher/FSEvents subscription.
          fastPath: "metadata-poll",
          rescued: true,
          now,
          lastFastPathAt,
          changeToRescueMs,
        }),
      } satisfies BackstopMessage);
    }
    // fn-921 quiet-repo seed_required clear. Independent of `rescued` — a quiet
    // repo emits nothing above, yet a stuck `seed_required` must still clear. The
    // FORCE in emitForUnseededGatedRoots bypasses the dedupe so an UNCHANGED
    // snapshot lands above the floor; main's fold then clears the flag.
    const seedEmits = emitForUnseededGatedRoots();
    if (seedEmits > 0) {
      console.error(
        `[git-worker] force-emitted ${seedEmits} snapshot(s) to clear a quiet-repo seed_required`,
      );
    }
    // Epic fn-716: surface the flood reduction. Log + reset the count of
    // snapshots the semantic dedupe gate coalesced away this window.
    if (coalescedDrops > 0) {
      console.error(
        `[git-worker] coalesced ${coalescedDrops} no-op GitSnapshot emit(s) in the last ${HEARTBEAT_MS}ms (semantic dedupe)`,
      );
      coalescedDrops = 0;
    }
  }, HEARTBEAT_MS);

  // fn-720: periodic backstop-rollup flush — checkpoint the denominator
  // (fires_total / rescues_total) so the metric survives a crash without a line
  // per no-op heartbeat. Cleared + final-flushed in the shutdown handler.
  rollupTimer = setInterval(() => {
    if (shuttingDown) return;
    try {
      flushBackstopRollups();
    } catch (err) {
      console.error(
        `[git-worker] backstop rollup flush failed: ${stringifyErr(err)}`,
      );
    }
  }, BACKSTOP_ROLLUP_FLUSH_MS);

  // fn-921: clear a QUIET-repo seed_required promptly after boot too — the boot
  // membership reconcile above emitted per-root, but a root whose live snapshot
  // sat at/below the captured floor still has no above-floor row. Do one
  // force-emit pass now so the un-dark doesn't wait a full heartbeat. Idempotent
  // (no-op once main's fold clears the flag); wrapped so it never throws at boot.
  try {
    emitForUnseededGatedRoots();
  } catch (err) {
    console.error(
      `[git-worker] initial seed_required clear failed: ${stringifyErr(err)}`,
    );
  }
}

if (!isMainThread) {
  startWorker();
}
