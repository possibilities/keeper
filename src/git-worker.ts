/**
 * Git status producer worker. Snapshots watched git worktrees and posts a
 * synthetic snapshot message when the rendered git view changes.
 *
 * **Watch gate (epic fn-690).** A worktree is watched iff it satisfies the
 * dynamic membership gate computed each reconcile:
 *   `.planctl present || working tree dirty || ahead of upstream > 0`.
 * Clean-and-pushed non-`.planctl` worktrees drop after a cooling dwell;
 * `.planctl`-backed worktrees stay watched even when clean (legacy
 * always-watched behavior) and incur no probe spawn (short-circuit). See
 * {@link discoverProjectRoots} for the gate, {@link shouldWatchRoot} for
 * the verdict helper, and {@link decideReconcileTransitions} for the
 * dwell-aware drop logic.
 *
 * EVENT-DRIVEN, not polled: a snapshot fires only when one of four signals
 * arrives — (1) a `@parcel/watcher` event on the worktree (file content
 * changed), (2) a `@parcel/watcher` event on the git common-dir (commit,
 * checkout, branch-switch, fetch — operations that mutate refs/HEAD/index
 * without touching any worktree file, which the worktree subscription
 * intentionally never sees because it ignores `**\/.git/**`), (3) a
 * `PRAGMA data_version` bump on keeper's own DB (new jobs row → root-membership
 * may have changed → re-reconcile worktree subscriptions; the attribution
 * join itself runs in the reducer, not here), or (4) a 60s heartbeat
 * safety-net. Signal (3) drives membership reconcile ONLY — it carries no root
 * attribution, so it never fans a per-root snapshot out (that O(roots) fan-out
 * was the CPU-flood source removed in this epic); the per-root snapshots come
 * from the FSEvents signals (1)+(2) feeding a per-root `RescanScheduler`
 * (trailing-debounce + single-flight, so a flurry collapses into one `git
 * status` shell-out), with (4) as the slow drop backstop. The per-root
 * `lastByRoot` JSON dedupe absorbs no-op snapshots.
 *
 * `PRAGMA data_version` polling is the only sanctioned DB change primitive
 * per the CLAUDE.md DO-NOT — it's a sub-ms autocommit counter read, not a
 * shell-out, and it's already foundational to `wake-worker.ts`.
 *
 * This worker is an event PRODUCER only: it owns no writable DB connection and
 * never mutates projections. Main inserts a `GitSnapshot` event, and the
 * reducer folds that persisted payload into `git_status`. When a watched root
 * stops satisfying the watch gate on reconcile (no `.planctl/` AND clean-and-
 * pushed for ≥ the cooling dwell), the worker also
 * posts a `GitRootDropped` tombstone message from `unsubscribeRoot` — main
 * lifts it into a synthetic `GitRootDropped` event whose reducer fold DELETEs
 * the projection row, keeping `git_status` in sync with the worktree.
 */

import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import {
  BackstopCounters,
  type BackstopMessage,
  buildMissedWakeRecord,
} from "./backstop-telemetry";
import { openDb } from "./db";
import {
  parsePlanRef,
  parseSessionIdTrailer,
  parseTaskTrailers,
} from "./derivers";
import { normalizePlanctlOp } from "./plan-classifier";
import { DEFAULT_DEBOUNCE_MS, isDropError, RescanScheduler } from "./rescan";
import type { ShutdownMessage } from "./wake-worker";

export interface GitWorkerData {
  dbPath: string;
  /**
   * fn-747 watcher seam. When `true`, the worker NEVER `import()`s
   * `@parcel/watcher` — it skips the live FSEvents subscribe + DB-poll/heartbeat
   * reconcile (which exist only to manage watcher subscriptions) and stays alive
   * only for the shutdown handshake. The in-process daemon harness sets this so
   * the parallel slow-test tier never dlopens the NAPI addon in a worker thread.
   * Git snapshots are not exercised by the in-process fold-pipeline tier.
   */
  disableNativeWatcher?: boolean;
}

/**
 * fn-705 discovery nudge (main → git-worker). The plan-worker observed a
 * `.planctl` tree in a repo keeper has never seen a session in; main forwards
 * the repo root so the git-worker adds it to its discovery candidate set
 * IMMEDIATELY (the `.planctl` short-circuit in {@link shouldWatchRoot} then
 * subscribes it on the next reconcile) instead of waiting for the next full
 * `SELECT DISTINCT cwd` sweep. Without this, a brand-new repo's `.git` stays
 * unwatched until a session runs there — no GitSnapshot / attribution flows.
 * Idempotent: a re-nudge of an already-watched root is a no-op (the candidate
 * set is a Set + the reconcile is convergent).
 */
export interface AddDiscoveryRootMessage {
  type: "add-discovery-root";
  /** Absolute repo root to fold into discovery candidates. */
  root: string;
}

/** Every shape main sends to the git-worker. */
export type GitWorkerInbound = ShutdownMessage | AddDiscoveryRootMessage;

export interface GitFileStatus {
  path: string;
  xy: string;
  index: string;
  worktree: string;
  kind: "ordinary" | "renamed" | "unmerged" | "untracked";
  orig_path?: string;
  /**
   * Schema v44 / fn-664: the porcelain-v2 `hI` (index blob oid) and `mW`
   * (worktree mode) fields, lifted straight off the `1`/`2` record at parse
   * time. `untracked` (`?`) and `unmerged` (`u`) records have no `hI`/`mW`
   * fields in porcelain output and parse as `null`. The producer's
   * {@link buildGitSnapshot} threads these into the {@link GitDirtyFile}
   * payload alongside the (separately-computed) `worktree_oid`.
   */
  index_oid: string | null;
  worktree_mode: string | null;
}

/**
 * One dirty-file entry on the file-centric {@link GitSnapshotPayload} (schema
 * v31 / task fn-633.5). Field-for-field a {@link GitFileStatus} plus a
 * frozen-in-payload `mtime_ms` (filesystem modification time in unix-epoch
 * milliseconds, lifted via `fs.lstatSync(path).mtimeMs` so symlinks report
 * the link's own mtime — not the target's). `mtime_ms` is `null` when the
 * `lstat` failed (the file moved between `git status` enumeration and the
 * per-file `lstat`, the producer-side stat race documented in the task
 * spec's "Risks" section); the reducer reads `null` as "no inferred-
 * attribution possible for this file" and rolls forward without it.
 *
 * The producer no longer joins against the event log to compute per-job
 * touched-set / per-job dirty filter / project-wide orphan set — those
 * derivations move to the reducer (task fn-633.6) where they run inside
 * `BEGIN IMMEDIATE` against the persisted event log + `file_attributions`
 * table. The producer's contract narrows to "enumerate dirty files,
 * `lstat` each, embed mtime, post the payload".
 */
/**
 * Schema v44 / epic fn-664 additive content axes. All three are pulled at
 * producer time from one `git status --porcelain=v2` + one `git hash-object
 * --stdin-paths` shell-out per snapshot — frozen into the event payload so a
 * re-fold reproduces them byte-deterministically (no fold-time git probe).
 *
 * - `worktree_oid`: the filter-correct git blob oid of this file's WORKTREE
 *   bytes — `git hash-object --stdin-paths` (single batched spawn per
 *   snapshot, NOT per-file), critically WITHOUT `--no-filters` so
 *   clean/CRLF smudge filters match the stored blob. Task .2 of the epic
 *   gates content-aware discharge on `committed_oid == worktree_oid`; a
 *   `null` here falls back to today's timestamp discharge (the producer
 *   couldn't hash this file — staged-deleted, untracked-symlink-to-nowhere,
 *   submodule, the `hash-object` exit signaled a per-path failure, etc.).
 * - `index_oid`: the porcelain-v2 `hI` field (free — already parsed off the
 *   `1`/`2` record). Captures the staged blob; lets task .2 distinguish
 *   "staged but unwritten" vs "staged + re-edited" (the orphan case the
 *   epic exists to fix). `null` for `untracked` / `unmerged` records that
 *   don't carry `hI`.
 * - `worktree_mode`: the porcelain-v2 `mW` field (also free). Records the
 *   worktree's file mode (`100644` / `100755` / `120000` for symlinks /
 *   `160000` for submodules / `000000` for staged-deleted). Task .2 uses
 *   this only to recognize the modes where a blob-oid equality test is
 *   meaningful (regular files + symlinks); other modes fall back to
 *   timestamp discharge.
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
 * The file-centric `GitSnapshot` payload (schema v31 / task fn-633.5). Carries
 * the producer-observed `git status --porcelain=v2` parse — branch metadata,
 * HEAD oid, ahead/behind, and the dirty-file list with embedded `mtime_ms`
 * per file — and NOTHING else. Per-job rollup (`jobs[]`), per-file
 * attributions (`attributions[]`), and the project-wide orphan set
 * (`orphaned_files`) are derived by the reducer in `projectGitStatus`
 * (task fn-633.6) joining this payload against the persisted event log
 * and `file_attributions` table.
 *
 * Why the producer doesn't compute attribution: a touched-set join over
 * the event log would have to happen at producer time, and the producer
 * runs without the writer lock — so two concurrent producers (real + a
 * future replay) would see different mid-fold projections. Moving the
 * join to the reducer's `BEGIN IMMEDIATE` makes attribution a pure
 * function of the persisted event log, restoring re-fold determinism.
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
}

/**
 * Tombstone message: a watched root has stopped satisfying the watch gate
 * ({@link shouldWatchRoot}) on reconcile — no `.planctl/` present AND the
 * worktree has been clean-and-pushed for ≥ {@link WATCH_DROP_DWELL_MS} (the
 * cooling-hysteresis dwell, epic fn-690). The worker is unsubscribing; main
 * lifts this into a synthetic `GitRootDropped` event whose reducer fold
 * DELETEs the corresponding `git_status` row — without it the projection
 * would leak the final pre-drop snapshot forever (the reducer's
 * `projectGitStatus` is UPSERT-only).
 */
export interface GitRootDroppedMessage {
  kind: "git-root-dropped";
  project_dir: string;
}

/**
 * Per-commit message: a single commit landed in the HEAD-oid delta the worker
 * just observed. The worker enumerates the `<prev>..<new>` range and emits one
 * of these per commit (so an N-commit push lands N `Commit` events — each
 * carries its own trailer, file list, and parent oid). Main lifts every
 * message into a synthetic `Commit` event whose reducer fold
 * ({@link import("./reducer").foldCommit}) updates
 * `file_attributions.last_commit_at` for the named files — discharging the
 * attribution claim for the committer session, or globally clearing the
 * attribution for the named files when the trailer is absent / malformed
 * (the global-discharge fallback documented in the fn-633 epic spec).
 *
 * `commit_oid` is the full SHA-1 (or SHA-256 on a future repo) of the commit
 * being attributed. `parent_oid` is the first-parent's full oid, or `null`
 * for the initial commit (no parent). `committed_at_ms` is unix-epoch
 * milliseconds, derived from git's `%ct` (committer date in unix seconds)
 * multiplied by 1000 — stamped into `file_attributions.last_commit_at` by
 * the reducer, so a from-scratch re-fold reproduces the same discharge
 * timestamp byte-deterministically (the reducer never re-shells git).
 *
 * `committer_session_id` is the validated session id pulled from the commit's
 * `Session-Id:` trailer via {@link
 * import("./derivers").parseSessionIdTrailer} (UUID-ish, take-last on
 * cherry-pick stacks). `null` when the trailer is absent, malformed, or
 * doesn't parse as a UUID — the reducer fold reads `null` as "global
 * discharge for this file set" (a human / CI commit clears every session's
 * attribution).
 */
/**
 * One file entry on the wire/payload of a {@link CommitMessage}. Schema v44
 * / fn-664: the producer's `diff-tree -r` parse pairs each committed path
 * with the new blob's oid (the bytes that just landed in HEAD for that
 * path). `blob_oid` is `null` for deletions (no blob to compare against),
 * for parse misses, and on producer fall-backs — the reducer treats
 * `null` as "cannot confirm content equality" and falls back to the
 * timestamp discharge rule.
 *
 * Schema v45 / fn-664.2: `committed_mode` joins the entry — the porcelain
 * `mI` field (`100644` / `100755` / `120000` / `160000`) lifted off the
 * same `diff-tree -r` record at parse time. The reducer's content-aware
 * discharge pairs `committed_mode` against the snapshot's `worktree_mode`
 * so a chmod-only dirty file (`committed_oid == worktree_oid`, modes
 * differ) is not wrongly discharged. Folds to `null` for deletions
 * (zero-mode sentinel) and for parse misses — null modes pair the same
 * way as null oids on the discharge gate (timestamp fall-back).
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
   * Epic fn-670 (T1): the validated, planctl-shaped `Task:` trailer
   * values the producer collected from this commit's message via
   * `%(trailers:key=Task,valueonly,unfold,separator=%x00)`. Multi-
   * valued by design — `Task:` is collect-all, distinct from
   * {@link committer_session_id} which is take-last canonical — so
   * one `keeper commit-work` closing two tasks lights both entries.
   * Empty `[]` on the common path (no `Task:` trailer present, or
   * every collected value was malformed). Rides the {@link
   * daemon.ts:onmessage} spread-serialize into the synthetic `Commit`
   * event's `data` JSON; the reducer's T2 link fold reads it back
   * via {@link extractCommit} (which defaults `[]` for pre-fn-670
   * events — re-fold determinism).
   */
  task_ids: string[];
  /**
   * Epic fn-695: the normalized planctl op + validated target ref the
   * producer lifted from this commit's `Planctl-Op:` / `Planctl-Target:`
   * trailers (see {@link EnumeratedCommit}). Both `null` on a non-planctl
   * commit. Ride the {@link daemon.ts:onmessage} commit-arm spread-
   * serialize into the synthetic `Commit` event's `data` JSON; the
   * reducer's edge fold reads them back via {@link extractCommit} (which
   * defaults both to `null` for pre-fn-695 events — re-fold determinism).
   */
  planctl_op: string | null;
  planctl_target: string | null;
  committed_at_ms: number;
}

/**
 * Per-commit message announcing the `.planctl/**` paths that changed in
 * the just-observed commit (epic fn-681). Sibling to {@link CommitMessage}
 * — same trigger (a HEAD-oid delta), same `diff-tree -r` parse — but
 * dedicated to driving the plan-worker's commit-triggered ingest channel
 * instead of an `events`-row insert. Main forwards this verbatim to
 * plan-worker; the reducer never sees it (so re-fold determinism stays
 * intact — the planctl files are re-read from committed worktree state
 * on every ingest call, never from the message payload).
 *
 * The producer filters {@link EnumeratedCommitFile} to planctl-shaped
 * paths via {@link classifyPlanctlPath} so the worker receives a tight
 * list — no recipient-side re-classification. One message per commit
 * even when several arrive in a single push, so the worker can attribute
 * each path back to its commit if a future use case needs it; the common
 * path (one push, one commit) lands one message regardless.
 *
 * `project_dir` is the absolute committing-repo root the worker is
 * watching; plan-worker joins it with each {@link PlanctlChangedFile.path}
 * to recover the absolute path it stats + reads. {@link changes} is
 * non-empty by construction — the producer suppresses emission when no
 * planctl path moved in the delta.
 */
export interface PlanctlChangedFile {
  /** Repo-relative path (forward-slash on POSIX). */
  path: string;
  /** `"upsert"` (present in HEAD) or `"delete"` (`git rm`'d in this commit). */
  op: "upsert" | "delete";
}

export interface PlanctlCommitChangedMessage {
  kind: "planctl-commit-changed";
  project_dir: string;
  commit_oid: string;
  changes: PlanctlChangedFile[];
}

export type GitWorkerMessage =
  | GitSnapshotMessage
  | GitRootDroppedMessage
  | CommitMessage
  | PlanctlCommitChangedMessage
  // Epic fn-720: a backstop rescue/rollup record posted up to main (the SOLE
  // sidecar writer). NOT folded into the event log — a pure consumer-side
  // side-file. Routed straight to `handleBackstopMessage`.
  | BackstopMessage;

interface ParsedGitStatus {
  branch: string | null;
  head_oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitFileStatus[];
}

/** `PRAGMA data_version` cadence — same shape as `wake-worker.ts`. */
const DB_POLL_MS = 100;
/** Silent-watcher backstop, same shape as `transcript-worker.ts`. */
const HEARTBEAT_MS = 60_000;
/**
 * Cadence (ms) at which the worker flushes its backstop counters as
 * {@link BackstopRollup} records (epic fn-720) — the denominator
 * (fires_total / rescues_total) `scripts/backstop-stats.ts` divides into the
 * rescue records for a true RATE. Slow (5 min); a clean shutdown also flushes
 * one final rollup so a quiescent daemon still records a complete denominator.
 */
const BACKSTOP_ROLLUP_FLUSH_MS = 5 * 60_000;
/**
 * Per-root GitSnapshot emission ceiling (epic fn-716). Passed into every
 * {@link RescanScheduler} (the `maxWaitMs` ceiling added in task fn-716.1) so a
 * root under CONTINUOUS churn emits ≤1 GitSnapshot per this window — a trailing
 * debounce alone re-arms forever under sustained edits and never flushes, so
 * staleness is unbounded; the ceiling caps it. The trailing debounce
 * ({@link DEFAULT_DEBOUNCE_MS}, 500ms) still wins on a bursty-then-quiet edit
 * (the common case), this only bites when edits land faster than the debounce.
 * 1.5s sits inside the epic's "≤1 per ~1-2s" bar.
 */
const GIT_SNAPSHOT_MAX_WAIT_MS = 1500;
const GIT_TIMEOUT_MS = 2000;
/**
 * Per-root TTL on the watch-membership verdict ({@link probeWatchMembership})
 * for roots that ARE currently watched. Short, because a watched root is the
 * one most likely to flip — we want a recent `git status` for the dwell timer
 * and for early drops on a clean+pushed transition. Cheap to re-probe (the
 * candidate set is already tiny — the watched set is bounded).
 */
const WATCH_PROBE_TTL_HOT_MS = 5_000;
/**
 * Per-root TTL on the watch-membership verdict for roots that are NOT
 * currently watched (cold candidates). Longer — a still-clean repo doesn't
 * need re-checking every reconcile cycle. The full-history sweep also runs at
 * a lower cadence, so a cold root is naturally re-probed less often.
 */
const WATCH_PROBE_TTL_COLD_MS = 90_000;
/**
 * Cadence at which the candidate set widens to ALL `DISTINCT cwd` rows from
 * the jobs table (the slow sweep), instead of just the recent + watched set
 * (the fast sweep). Lets a stale unpushed-but-clean repo surface after a
 * keeper restart (empty watched-set memory). Throttled because the slow
 * sweep can probe N candidates synchronously and we want steady-state
 * spawns ≈ 0.
 */
const FULL_SWEEP_INTERVAL_MS = 5 * 60_000;
/**
 * Recent-job window for the fast-path candidate build: a `jobs` row is a
 * candidate if `state='working'` OR `updated_at` falls within this many
 * milliseconds of now. 2h covers human-paced multi-session days without
 * dredging up week-old idle sessions whose repos are long gone.
 */
const RECENT_JOB_WINDOW_MS = 2 * 60 * 60 * 1000;
/**
 * Cooling dwell before a non-`.planctl` root that becomes clean-and-pushed
 * is dropped. Must be ≥ HEARTBEAT_MS + one snapshot/commit-enumeration
 * cycle so a post-commit `emitSnapshot` (HEAD-delta commit enumeration,
 * fn-670 `Task:` link + discharge) drains BEFORE the tombstone wipes the
 * file_attributions claim. 45s is one heartbeat (60s) reduced by the
 * worst-case snapshot debounce; in practice the next heartbeat covers it.
 */
const WATCH_DROP_DWELL_MS = 45_000;
/**
 * Cap on new subscribes per reconcile cycle. Prevents the first full sweep
 * (or a re-discovery after a keeper restart) from instantly subscribing
 * hundreds of roots — which would balloon FSEvents streams into
 * `fseventsd` bad-state. Remaining joins land on subsequent cycles
 * (every DB-poll tick, every heartbeat).
 */
const MAX_SUBSCRIBES_PER_CYCLE = 16;
/**
 * How long the worker's `git`-derived HEAD may CONTINUOUSLY disagree with the
 * fs-derived HEAD before the divergence watchdog escalates (`process.exit(1)`
 * → LaunchAgent restart). During the window every divergent snapshot is
 * SUPPRESSED — see {@link decideHeadDivergence} and the gate in `emitSnapshot`.
 * 90s rides out the sub-second window where a commit lands between `readStatus`
 * and the fs ref read (a healthy commit reconciles within one debounce), while
 * recovering a genuine wedge before agents lose trust in the surface. Measured
 * on the monotonic clock (`performance.now()`), never wall-time.
 */
const HEAD_DIVERGENCE_GRACE_MS = 90_000;

/**
 * Epic fn-705 (T2): retry cap for a failed `enumerateCommitsInDelta` in
 * `emitSnapshot`. The commit channel (fn-681 `planctl-commit-changed` + the
 * `Commit` discharge) MUST NOT silently drop a commit when enumeration throws
 * transiently — so on a throw the per-root HEAD-oid cache is held back, and
 * the next HEAD-oid observation re-enumerates the same range. To bound the
 * spin on a PERMANENTLY broken object (a corrupt pack, a missing loose
 * object), after this many consecutive failures the cache advances anyway
 * with a loud one-time alarm, accepting the lost commit rather than
 * re-enumerating the same poisoned range on every observation forever. The
 * 60s heartbeat backstop still recovers the projection in that pathological
 * case. See {@link decideHeadCacheAdvance}.
 */
export const COMMIT_ENUM_MAX_RETRIES = 5;

/**
 * Positive ignore globs for `@parcel/watcher`. Mirrors `plan-worker.ts`'s
 * `IGNORE_GLOBS` — the same noise (build outputs, vendored deps, package
 * caches) that floods FSEvents under a broad watch root. Duplicated rather
 * than shared because the two workers may diverge over time.
 */
const GIT_IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/.cache/**",
  "**/target/**",
  "**/.venv/**",
  "**/*.tmp",
];

/**
 * Positive ignore globs for the sibling `@parcel/watcher` subscription on each
 * worktree's git common-dir. The point of that subscription is to fire on
 * commit/checkout/branch-switch/fetch — operations that mutate `HEAD`,
 * `index`, `refs/heads/**`, `refs/remotes/**`, or `packed-refs` without
 * touching any worktree file. Everything below is high-churn noise that
 * doesn't affect `git status` output: object packs (a single `git gc` emits
 * thousands of events under `objects/`), reflogs (every ref move appends to
 * `logs/`), user-installed hooks and git-lfs storage that we never read, and
 * transient `*.lock` files (`index.lock`, `HEAD.lock`, `refs/heads/foo.lock`)
 * created and removed on every git write. The 500ms scheduler debounce plus
 * the per-root JSON dedupe in `emitSnapshot` would absorb these as no-ops,
 * but pruning them at the watcher reduces the FSEvents pressure that itself
 * causes drop-recovery storms.
 */
const GIT_DIR_IGNORE_GLOBS = [
  "**/objects/**",
  "**/logs/**",
  "**/hooks/**",
  "**/lfs/**",
  "**/info/**",
  "**/*.lock",
];

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
      // Porcelain v2 ordinary record:
      //   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      // So `mW = parts[5]` and `hI = parts[7]` are the v44 / fn-664 free
      // adds. Defensive `?? null` keeps a malformed shorter record from
      // throwing; the consumer reads `null` as "no oid/mode available"
      // and falls back to the timestamp discharge.
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
      // Porcelain v2 renamed/copied record:
      //   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>`
      // Same offsets as record `1` for `mW` (parts[5]) and `hI` (parts[7]);
      // the rename score sits at parts[8] and the new path starts at
      // parts[9]. The orig path follows in the next NUL-separated record.
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
      // Porcelain v2 unmerged records carry three oids and three modes
      // (stages 1/2/3) — none of which map onto a single `index_oid`
      // semantically. Leave both fields null; task .2 falls back to
      // timestamp discharge for any unmerged path.
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
    // index stat-cache, which grabs the lock and races the watched session's
    // own `git add` / commit — surfacing as a `fatal: Unable to create
    // index.lock` "tooling error" in the agent, and (when our 2s timeout kills
    // git mid-refresh) leaving a stale lock that wedges the repo until cleared.
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
 * Resolve a candidate path (typically a `cwd`) to its containing git
 * toplevel, or `null` if the path isn't inside a git worktree.
 *
 * Split out from the legacy `gitRootFor` (epic fn-690): cwd→toplevel
 * resolution is stable for a session's lifetime and is the dominant cost in
 * `discoverProjectRoots` (one `git rev-parse` shell-out per cwd, every
 * reconcile). The membership verdict — whether keeper should ACTUALLY watch
 * a resolved root — moves into {@link shouldWatchRoot}, which re-runs
 * dynamically per reconcile against a fresh probe. The cwd→toplevel cache
 * (in `discoverProjectRoots`) is permanent for the daemon's lifetime; the
 * membership verdict's cache (`watchProbeCache`) has a short TTL.
 */
function resolveGitToplevel(path: string): string | null {
  const out = gitOutput(["-C", path, "rev-parse", "--show-toplevel"]);
  const root = out?.trim();
  if (!root) return null;
  return root;
}

/**
 * The dynamic per-reconcile watch-membership probe (epic fn-690). Returns
 * the just-observed (dirty, ahead) verdict for `root` so {@link
 * shouldWatchRoot} can decide whether the root qualifies for the watched
 * set. ONE combined `git status --porcelain=v2 --branch` spawn yields both
 * facts:
 *   - dirty = any non-`#` record present in the parse,
 *   - ahead = the `# branch.ab +N -M` count of local-commits-ahead-of-
 *     upstream (`0` when no `# branch.ab` line is present, e.g. no upstream
 *     configured / detached HEAD).
 *
 * Critically uses `-unormal` (the default), NOT `-uall`: the full untracked
 * descent is the perf cliff that motivated the dynamic gate's bounded
 * candidate set. `-unormal` is sufficient for an is-dirty verdict.
 *
 * Returns `null` on timeout/error so the caller can decide what to do:
 * `shouldWatchRoot` fails OPEN for an already-watched root (retain it, the
 * caller should re-probe next cycle), but CLOSED for a cold candidate
 * (don't join on a broken probe).
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
    // Any non-`#` record = a dirty entry (`1`/`2`/`u`/`?`). We don't need to
    // count them; one is enough to flip the verdict.
    dirty = true;
  }
  return { dirty, ahead };
}

/**
 * Pure decision (epic fn-690): given a resolved git `root` and an optional
 * just-observed probe verdict, does keeper want to watch this root?
 *
 *   - `.planctl/` present → ALWAYS watch. Short-circuit BEFORE looking at
 *     the probe, so a `.planctl` repo never incurs a probe spawn (this
 *     keeps the historical zero-cost cycle for plan-backed roots).
 *   - probe is `null` (timeout / error) → fail-open if `currentlyWatched`,
 *     fail-closed otherwise. Don't join on a broken probe; don't drop a
 *     watched root just because one probe stuttered.
 *   - probe is non-null → watch iff dirty OR ahead > 0.
 *
 * Pure & exported for unit-testable verdict-only fixture coverage. The
 * caller supplies the probe via {@link probeWatchMembership} so the test
 * surface stays decoupled from the spawnSync side-effect.
 */
export function shouldWatchRoot(
  root: string,
  probe: { dirty: boolean; ahead: number } | null,
  options: { currentlyWatched: boolean },
): boolean {
  if (existsSync(join(root, ".planctl"))) return true;
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
 * covers both worktree-local and shared-ref mutations.
 *
 * git's default output is relative to `root`; we resolve to absolute so
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
 * via `fs` — never shelling out to `git`. This is the {@link decideHeadDivergence}
 * wedge guard's independent ground truth (see `snapshotSuppressedByDivergence`).
 *
 * *Why fs and not `git rev-parse`:* the failure mode this guards against is a
 * long-running worker whose `git` subprocess invocations silently return a
 * STALE view (observed in the wild — `readStatus` froze on an old HEAD for ~50
 * min while the repo advanced three commits, surfacing committed files as
 * phantom `<orphan>` dirty entries across every watched repo). A divergence
 * check that also shells `git` would read the same stale value and never fire.
 * `fs` reads stay correct in that wedged state — the same worker was still
 * `lstat`ing live mtimes throughout — so a direct ref read is the one source we
 * can trust to catch the wedge.
 *
 * Handles the common cases: a regular repo (`<root>/.git/`), a linked worktree
 * (`<root>/.git` is a `gitdir:`-pointer file → per-worktree dir with a sibling
 * `commondir`), a symbolic `ref:` HEAD resolved against the loose ref then
 * `packed-refs`, and a detached HEAD (oid inline). Returns the 40/64-hex oid, or
 * `null` on any shape it can't resolve cheaply — the watchdog treats `null` as
 * "can't determine truth this cycle" and never escalates on it (fail-safe).
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
 * Split out from the worker closure so it is unit-testable and deterministic.
 *
 * The wedge: keeper's long-lived git-worker thread can start returning a STALE
 * `git status` view (frozen HEAD + dirty set) for many minutes while the same
 * process's `fs` reads stay fresh — a `Bun.spawnSync`/long-Worker boundary
 * defect we could not minimally reproduce, so we DETECT-AND-PREVENT rather than
 * cure. `gitHead` is what `readStatus` just reported; `fsHead` is
 * {@link resolveHeadOidViaFs} (the trusted ground truth).
 *
 * - Agreement, or `fsHead == null` (can't verify — fail OPEN, trust git), or a
 *   null `gitHead`: not divergent. `suppress=false`, `sinceMs=null` (reset the
 *   timer), `trip=false`.
 * - Divergence: `suppress=true` — the caller must NOT emit this snapshot,
 *   enumerate its commits, or advance any head cache (the payload is untrusted,
 *   a data-INTEGRITY failure, not just staleness). `sinceMs` is the monotonic
 *   start of the current divergence run (carried in from prior state, or
 *   `nowMs` on first divergence). `trip=true` once it has persisted ≥ `graceMs`
 *   — the caller then exits for a LaunchAgent restart, the only honest recovery.
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
 * cache (`lastHeadOidByRoot`) after attempting `enumerateCommitsInDelta` over
 * a HEAD-oid delta. Split out of the closure so the retry/backstop policy is
 * unit-testable (mirrors {@link decideHeadDivergence}).
 *
 * Epic fn-705 (T2). The old `emitSnapshot` advanced the cache UNCONDITIONALLY
 * (even when enumeration threw), so a single transient enumeration failure
 * skipped the failed range forever: the commit's `planctl-commit-changed`
 * (and `Commit` discharge) was never re-emitted and the projection fell back
 * to FSEvents + the 60s heartbeat. The fix:
 *
 * - `enumOk === true` (enumeration succeeded — including the no-commits and
 *   no-planctl-changes cases): advance, reset the failure counter to 0.
 * - `enumOk === false` (enumeration threw) AND `priorFailures + 1 < maxRetries`:
 *   HOLD the cache (`advance=false`) so the next HEAD-oid observation
 *   re-enumerates the same range. Carry the bumped failure count.
 * - `enumOk === false` AND `priorFailures + 1 >= maxRetries`: a persistently
 *   broken range (corrupt object). Advance anyway (`advance=true`,
 *   `loudBackstop=true`) to break the re-enumeration spin, reset the counter,
 *   and let the caller emit a one-time loud alarm. The 60s heartbeat still
 *   recovers the projection.
 *
 * Note `advance` only gates the head-cache write; the divergence wedge gate is
 * upstream and `return`s before this is ever consulted, so a suppressed
 * snapshot likewise never advances the cache (and re-enumerates on clear).
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
  // permanently poisoned range; the heartbeat backstop covers the lost commit.
  return { advance: true, nextFailures: 0, loudBackstop: true };
}

function readStatus(root: string): ParsedGitStatus | null {
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
 * One file entry in an {@link EnumeratedCommit}. Schema v44 / fn-664: the
 * commit-time blob oid joins the path so the reducer's content-aware
 * discharge (task .2) can compare `committed_oid` against the snapshot's
 * `worktree_oid` per-file. The producer derives `blob_oid` from
 * `git diff-tree -r --no-commit-id <commit>` (the "new" oid in each
 * record); a malformed/missing oid folds to `null` so a single bad record
 * never wedges the whole commit message.
 *
 * Schema v45 / fn-664.2: `committed_mode` joins the entry — the porcelain
 * mode `mI` from the same `diff-tree` record (`100644` / `100755` /
 * `120000` for symlinks / `160000` for submodules / `000000` for the
 * deletion side). The reducer's content-aware discharge gate pairs
 * `committed_mode` against the snapshot's `worktree_mode` so a chmod-only
 * dirty file — `committed_oid == worktree_oid` but mode differs — is NOT
 * wrongly discharged (the blob bytes are equal but the file is still on
 * the hook for its mode change). Folds to `null` symmetrically with
 * `blob_oid` on any parse miss; the discharge gate treats null modes the
 * same as null oids (fall back to today's timestamp discharge).
 */
interface EnumeratedCommitFile {
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
   * Epic fn-695: the normalized planctl op (`Planctl-Op:` trailer →
   * {@link normalizePlanctlOp}) and the validated target ref
   * (`Planctl-Target:` trailer → {@link parsePlanRef}). Both `null`
   * when the commit carried no such trailer (every non-`chore(planctl)`
   * commit) or the value was empty / malformed. Frozen here at producer
   * time and read back unchanged by the reducer's edge fold — re-fold
   * determinism (no fold-time git probe).
   */
  planctl_op: string | null;
  planctl_target: string | null;
  committed_at_ms: number;
}

/**
 * Anchored full-OID match — same shape as `derivers.ts` `GIT_OID_RE`.
 * Module-scope literal so V8/JSC tier up once at process start.
 */
const PRODUCER_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Is this repo-relative path one the plan-worker projects (epic fn-681)?
 * Matches the SAME shapes plan-worker's `classifyPlanPath` recognizes,
 * intentionally duplicated here so the two workers stay independent (no
 * cross-worker module import — the producer/consumer contract is the
 * message shape, not a shared classifier function). If this set ever
 * widens, BOTH classifiers must move in lockstep.
 *
 * Recognised shapes (forward-slash split — `git diff-tree` always emits
 * POSIX separators regardless of platform):
 * - `.planctl/epics/<id>.json` (3-segment)
 * - `.planctl/tasks/<id>.json` (3-segment)
 * - `.planctl/state/tasks/<id>.state.json` (4-segment)
 *
 * Pure — does no I/O. Exported for unit reach.
 */
export function isPlanctlChangedPath(path: string): boolean {
  if (!path.endsWith(".json")) return false;
  const segments = path.split("/");
  const n = segments.length;
  // 3-segment tail: `.planctl/<epics|tasks>/<file>.json`.
  if (n >= 3 && segments[n - 3] === ".planctl") {
    const dir = segments[n - 2];
    return dir === "epics" || dir === "tasks";
  }
  // 4-segment tail: `.planctl/state/tasks/<id>.state.json`.
  if (
    n >= 4 &&
    segments[n - 4] === ".planctl" &&
    segments[n - 3] === "state" &&
    segments[n - 2] === "tasks" &&
    segments[n - 1].endsWith(".state.json")
  ) {
    return true;
  }
  return false;
}

/**
 * Filter a commit's enumerated file list to planctl-shaped paths and
 * pair each with its add/update-vs-delete tag (epic fn-681). Delete is
 * signalled by the producer's null sentinels on the {@link
 * EnumeratedCommitFile} record — `commitFiles` lifts a zero-oid /
 * zero-mode `diff-tree` line to `{blob_oid: null, committed_mode: null}`,
 * which is the producer's honest "the file was removed" marker. We treat
 * a null `blob_oid` as `"delete"` and every other shape as `"upsert"` —
 * matching the plan-worker's `onChange` / `onDelete` dispatch.
 *
 * Pure — does no I/O. Exported for unit reach.
 */
export function filterPlanctlChanges(
  files: EnumeratedCommitFile[],
): PlanctlChangedFile[] {
  const out: PlanctlChangedFile[] = [];
  for (const f of files) {
    if (!isPlanctlChangedPath(f.path)) continue;
    out.push({ path: f.path, op: f.blob_oid === null ? "delete" : "upsert" });
  }
  return out;
}

/**
 * Shell-out + parse for one commit's file list via
 * `git -C <root> diff-tree -r --no-commit-id --no-renames -z <oid>`. Schema
 * v44 / epic fn-664: switched from `git log -1 <oid> --name-only` to
 * `diff-tree -r` so each record carries the new BLOB OID for the path
 * alongside the path itself — task .2 of the epic uses this to gate
 * content-aware discharge on `committed_oid == worktree_oid`.
 *
 * Output format (per the git docs, with `-z`):
 *   `:<mH> <mI> <hH> <hI> <STATUS>\0<path>\0` ... per file
 * — where `hI` here is the NEW blob's oid (the committed bytes for the
 * non-merge path). `-z` swaps the per-record `\n` terminator and the
 * intra-record TAB into NULs, keeping paths with spaces/newlines whole.
 * `--no-renames` is load-bearing — without it, renames emit two paths per
 * record and the alignment math here would have to special-case them; the
 * task spec also recommends `--no-renames` to keep the discharge surface
 * file-path-keyed (a rename is recorded as add+delete from the
 * attribution perspective, which is the honest semantic).
 *
 * Returns the file list with each path paired against its validated
 * `blob_oid` (40-hex / 64-hex). Bad/missing oid → `null` for that one
 * entry without dropping the path (the discharge gate falls back to the
 * timestamp rule on a `null` oid; that's safer than silently omitting the
 * file from the commit's discharge set). Empty array on any non-zero exit
 * / parse miss (the producer-only invariant means a failed shell-out can't
 * wedge the worker; the next snapshot or commit will re-attempt).
 */
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
  // With `-z`, diff-tree's output is `:<mH> <mI> <hH> <hI> <STATUS>\0<path>\0`
  // per file. Split on NUL and consume in pairs. Defensive: drop trailing
  // empties (the last \0 produces an empty tail element) and ignore any
  // record where the meta-line doesn't carry a recognizable shape.
  const fields = out.split("\0");
  const files: EnumeratedCommitFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i] ?? "";
    const path = fields[i + 1] ?? "";
    if (path.length === 0) continue;
    // diff-tree's `-r` meta line starts with `:` and uses single-space
    // separators: `:<mH> <mI> <hH> <hI> <STATUS>`. After splitting on space,
    // index 1 carries `mI` (the new/committed mode) and index 3 carries `hI`
    // (the new/committed blob oid). For deletions git emits
    // `hI = 0000...000` and `mI = 000000` — the all-zeros sentinels;
    // validate the oid via PRODUCER_OID_RE and additionally reject the
    // zero-oid (the file was deleted in this commit — there's nothing to
    // compare worktree bytes against, so `null` is the honest signal). The
    // mode side accepts any non-empty token shape (the reducer compares
    // string-equality against the snapshot's `mW`, so the exact byte
    // sequence matters more than a regex shape check); a leading
    // all-zeros mode for a deletion folds to `null` symmetrically with
    // the zero-oid sentinel — there is no honest worktree mode to
    // compare against a deleted-in-commit path.
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

/**
 * Enumerate the commits in a `<prev>..<new>` HEAD-oid delta. Shells out to
 * `git -C <root> log <prev>..<new> --format='%H%x00%P%x00%ct%x00%(trailers:
 * key=Session-Id,valueonly,only,unfold)' --no-patch -z` and parses each
 * commit's four-field record. Falls back to single-commit emission against
 * `<new>` when `<prev>..<new>` is empty (force-push, rebase to a non-
 * descendant) or when `<prev>` is null (bootstrap-from-null, initial
 * commit). For each enumerated commit, a sibling
 * `git log -1 <oid> --name-only --first-parent` populates the file list.
 *
 * Returns the per-commit array in REVERSE chronological order (newest
 * first — git's default `log` ordering). The caller emits one
 * {@link CommitMessage} per element in iteration order; the reducer fold is
 * commutative on `last_commit_at` (a later commit at higher ts wins via
 * `MAX(existing, incoming)` semantics — or simply "always stamp" since
 * commits are inherently ordered by chronology and the producer emits them
 * in batch per delta), so iteration order doesn't affect the final
 * projection.
 */
export function enumerateCommitsInDelta(
  root: string,
  prev: string | null,
  next: string,
): EnumeratedCommit[] {
  // Epic fn-670 (T1): widen from 4 fields (OID, P, ct, Session-Id) to
  // SIX (… + Job-Id + Task). Epic fn-695 widens to EIGHT (… + Planctl-Op
  // + Planctl-Target). Session-Id / Job-Id / Planctl-Op / Planctl-Target
  // all use `valueonly,only,unfold` (take-last single value per key);
  // Task is `valueonly,unfold` with the DEFAULT `\n` separator — we want
  // a human-newline-separated block of values inside that ONE field so
  // the outer `%x00` field delimiter survives. Switching the Task
  // separator to `%x00` would collide with the field boundary and
  // realign the stride parser off-by-one. The parser below splits the
  // Task field on `\n` (via {@link parseTaskTrailers}); `\0` is also
  // accepted by that helper as a defensive belt-and-suspenders, but is
  // not used on the live wire here.
  //
  // FIELD ORDER IS LOAD-BEARING: the stride loop below consumes fields in
  // groups of EIGHT, in this exact order. Adding / reordering / dropping a
  // `%x00` here MUST move the loop's stride (`i += 8`) + every `fields[i+N]`
  // offset in lockstep, or every field realigns off-by-one for EVERY commit.
  const format =
    "%H%x00%P%x00%ct%x00" +
    "%(trailers:key=Session-Id,valueonly,only,unfold)%x00" +
    "%(trailers:key=Job-Id,valueonly,only,unfold)%x00" +
    "%(trailers:key=Task,valueonly,unfold)%x00" +
    "%(trailers:key=Planctl-Op,valueonly,only,unfold)%x00" +
    "%(trailers:key=Planctl-Target,valueonly,only,unfold)";
  let out: string | null = null;
  if (prev !== null) {
    out = gitOutput([
      "-C",
      root,
      "log",
      `${prev}..${next}`,
      `--format=${format}`,
      "--no-patch",
      "-z",
    ]);
  }
  if (out == null || out.length === 0) {
    // Fallback: force-push / non-descendant / bootstrap-from-null / initial
    // commit. Emit a single-commit log against `<next>` only — this gives
    // us at least the attribution for the HEAD commit (the producer's
    // job is to be honest about what we observed; subsequent commits in
    // a non-descendant ancestry are lost, but that's an acceptable
    // edge per the task spec's "Risks" section).
    out = gitOutput([
      "-C",
      root,
      "log",
      "-1",
      next,
      `--format=${format}`,
      "--no-patch",
      "-z",
    ]);
  }
  if (out == null || out.length === 0) {
    return [];
  }
  // Parse: with `-z`, git replaces the per-record `\n` terminator with `\0`
  // — and the `%x00` separators inside the format string also emit literal
  // NULs in-stream. With the fn-695 widening to EIGHT format fields per
  // record (fn-670's six + Planctl-Op + Planctl-Target), the wire format
  // for N commits is:
  //   OID1\0P1\0CT1\0SESSION1\0JOBID1\0TASK1\0POP1\0PTARGET1\0OID2\0...
  // — i.e. a flat sequence of 8N NUL-delimited fields with a trailing
  // empty element after the final NUL. Split on `\0` and consume in
  // groups of 8.
  const fields = out.split("\0");
  const commits: EnumeratedCommit[] = [];
  for (let i = 0; i + 7 < fields.length; i += 8) {
    const oid = (fields[i] ?? "").trim();
    if (oid.length === 0) continue;
    const parentsRaw = (fields[i + 1] ?? "").trim();
    // `%P` emits parent oids space-separated. First-parent semantic:
    // attribute against the FIRST parent only (matches `--first-parent`
    // for the file-list call below).
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
    const planctlOp = parsePlanctlOpTrailer(opTrailers);
    const planctlTarget = parsePlanctlTargetTrailer(targetTrailers);
    const files = commitFiles(root, oid);
    commits.push({
      commit_oid: oid,
      parent_oid: parentOid,
      files,
      committer_session_id: committerSessionId,
      task_ids: taskIds,
      planctl_op: planctlOp,
      planctl_target: planctlTarget,
      committed_at_ms: committedAtMs,
    });
  }
  return commits;
}

/**
 * Epic fn-670 (T1): canonicalize a commit's session attribution by
 * merging the `Session-Id:` and `Job-Id:` trailer values. Both are
 * parsed via {@link parseSessionIdTrailer} (UUID-anchored take-last,
 * shared with the Session-Id-only path).
 *
 * Policy:
 *   - Session-Id WINS when both are valid and equal (canonical agreement).
 *   - Session-Id WINS when both are valid but DIFFER — and a one-shot
 *     stderr warning fires (a bug signal: `job_id === session_id` is a
 *     keeper invariant, see CLAUDE.md / planctl session-context). Never
 *     fatal; the producer-only liveness invariant + hook's exit-0
 *     contract forbid escalating from a trailer mismatch.
 *   - Job-Id wins when Session-Id is null (the path that REVIVES the
 *     dormant v45 per-session discharge arm — jobctl's `_append_job_id
 *     _trailer` stamps `Job-Id` on every `commit-work` source commit,
 *     so coalescing it into `committer_session_id` finally lets
 *     `foldCommit`'s per-session arm fire on those commits).
 *   - Both null → return null (global discharge, unchanged).
 *
 * Pure-ish: emits a single `console.error` warn line on the
 * both-differing branch. The whole producer side already writes
 * stderr on git failures, so this is the same surface. The reducer
 * NEVER reads/probes/computes here — the field is frozen in the
 * Commit event payload at producer time.
 */
function coalesceCommitterSessionId(
  sessionTrailers: string,
  jobIdTrailers: string,
  commitOid: string,
): string | null {
  const session = parseSessionIdTrailer(sessionTrailers);
  const jobId = parseSessionIdTrailer(jobIdTrailers);
  if (session !== null && jobId !== null && session !== jobId) {
    // `job_id === session_id` is a keeper invariant — a divergence here
    // is a bug signal worth surfacing. Stderr-only (LaunchAgent stdlog),
    // never throws, never blocks. Include both values + commit OID so a
    // forensic grep can locate the offending commit.
    console.error(
      `[git-worker] commit ${commitOid}: Session-Id (${session}) and Job-Id (${jobId}) trailers DIFFER; Session-Id wins per take-last policy`,
    );
  }
  // Session-Id preferred — its presence is the canonical signal
  // (jobctl stamps Job-Id too, but a hand-written Session-Id wins).
  // Fall through to Job-Id when Session-Id is absent / malformed —
  // both pass the same UUID gate in parseSessionIdTrailer, so the
  // coalesced value is always either a UUID-shaped string or null
  // (never a bare value that could poison the UUID gate on the
  // deriver side).
  if (session !== null) return session;
  return jobId;
}

/**
 * Epic fn-695: lift the planctl operation from a commit's `Planctl-Op:`
 * trailer block and NORMALIZE it the same way the legacy stdout-scrape
 * path does — via {@link normalizePlanctlOp} (`epic-scaffold` →
 * `scaffold`, etc.) — so the reducer's `syncPlanctlLinks` union compares
 * the commit-derived op against the scrape-derived op on one normalized
 * vocabulary. Take-last on the unfolded value block (mirrors
 * {@link parseSessionIdTrailer}): the producer requests
 * `valueonly,only,unfold`, so the common case is a single line, but a
 * hand-edited stacked block resolves to the last non-empty line. Returns
 * `null` on empty / whitespace-only / non-string input (no `Planctl-Op:`
 * trailer — every non-`chore(planctl)` commit). Pure function of its
 * argument so re-fold determinism holds (the reducer never re-derives —
 * the normalized op is frozen in the Commit payload at producer time).
 */
function parsePlanctlOpTrailer(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) continue;
    return normalizePlanctlOp(line);
  }
  return null;
}

/**
 * Epic fn-695: lift the planctl target ref from a commit's
 * `Planctl-Target:` trailer block and validate it against the SAME
 * epic-ref shape gate the legacy scrape path uses ({@link parsePlanRef}).
 * Take-last on the unfolded value block (mirrors
 * {@link parsePlanctlOpTrailer}); returns the raw validated ref string
 * (`fn-1-foo` or `fn-1-foo.3` — the edge fold folds a task-form ref up to
 * its parent epic downstream, exactly as `extractPlanctlInvocation` does).
 * Returns `null` on empty / whitespace-only / non-string input AND on a
 * value that {@link parsePlanRef} rejects (malformed ref) — so a garbage
 * trailer never poisons the edge fold. Pure function of its argument
 * (re-fold determinism — frozen in the Commit payload at producer time).
 */
function parsePlanctlTargetTrailer(raw: string): string | null {
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
 * One TTL-memoized watch-membership verdict per root (epic fn-690). Entries
 * live in the per-worker `watchProbeCache` Map; the hot tier
 * ({@link WATCH_PROBE_TTL_HOT_MS}, currently watched) refreshes on every
 * fast reconcile, the cold tier ({@link WATCH_PROBE_TTL_COLD_MS}, candidate
 * but unwatched) holds a longer-lived verdict so a quiescent untouched
 * repo doesn't re-probe every cycle. `expiry` is wall clock
 * (`Date.now()` ms).
 *
 * Pruning is lazy-on-read inside {@link discoverProjectRoots} so we never
 * walk the map on the hot 100ms tick. The map is bounded by the candidate
 * set size (one entry per resolved root in flight).
 */
interface WatchProbeCacheEntry {
  /** The last probe verdict (or `null` if the probe failed at expiry time). */
  verdict: { dirty: boolean; ahead: number } | null;
  /** Wall-clock ms (`Date.now()`) after which the entry is considered stale. */
  expiry: number;
}

/**
 * State threaded into {@link discoverProjectRoots} by `reconcileRoots`.
 * Separated as an interface so the discovery function can be exercised
 * deterministically in tests against injectable Maps + an injected `now`
 * + an injected probe function (the live caller passes
 * {@link probeWatchMembership}).
 *
 * - `cwdRootCache` — cwd→toplevel memo, permanent for the daemon lifetime
 *   (cwd→toplevel is stable for a session). One entry per distinct
 *   candidate path.
 * - `watchProbeCache` — per-root verdict TTL memo, hot/cold tiered.
 * - `currentlyWatched` — the live set of subscribed roots. Used both as a
 *   tier selector (hot vs cold TTL) AND as the monotonicity floor (the
 *   slow sweep only ADDS candidates; the fast path always re-probes every
 *   already-watched root).
 * - `nowMs` — wall clock (`Date.now()`). Injected for tests.
 * - `runFullSweep` — `true` when the candidate set should widen to ALL
 *   `DISTINCT cwd` rows (the slow sweep), `false` for the recent+watched
 *   fast path. The caller decides cadence via
 *   {@link FULL_SWEEP_INTERVAL_MS}.
 * - `probe` — the spawnSync-backed verdict probe. Injectable so tests can
 *   drive a fake.
 */
export interface DiscoveryContext {
  cwdRootCache: Map<string, string | null>;
  watchProbeCache: Map<string, WatchProbeCacheEntry>;
  currentlyWatched: Set<string>;
  nowMs: number;
  runFullSweep: boolean;
  probe: (root: string) => { dirty: boolean; ahead: number } | null;
  /**
   * fn-705 discovery-nudge roots forwarded from the plan-worker — folded into
   * the candidate set unconditionally (see {@link buildDiscoveryCandidates}).
   * Optional; omitted by tests that don't exercise the nudge.
   */
  extraCandidates?: Set<string>;
}

/**
 * Build the candidate set for `discoverProjectRoots`. Pure & exported for
 * unit reach. The fast path probes only the recent + watched cwds; the
 * slow sweep widens to every `DISTINCT cwd` in the jobs table. Epic
 * `project_dir` and `task.target_repo` are always in the set — they're
 * cheap, bounded, and tied to plan-backed work.
 */
export function buildDiscoveryCandidates(
  db: Database,
  options: {
    nowMs: number;
    runFullSweep: boolean;
    watched: Set<string>;
    /**
     * fn-705 discovery-nudge roots: repo roots the plan-worker handed over
     * (a `.planctl` tree in a repo with no seen-cwd job history). Always
     * included so the `.planctl` short-circuit in {@link shouldWatchRoot}
     * subscribes them on the next reconcile, without waiting for a session
     * to populate `jobs.cwd`. Optional — pure tests omit it.
     */
    extraCandidates?: Set<string>;
  },
): Set<string> {
  const candidates = new Set<string>();

  // fn-705: nudge roots are unconditional candidates (independent of the
  // recent/full-sweep job-cwd partition — a never-seen repo has no job rows).
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
    // Slow path: every cwd a job has ever run from. Lets a stale unpushed-
    // but-clean repo surface after a keeper restart (empty watched-set
    // memory + empty cold cache).
    const rows = db
      .query("SELECT DISTINCT cwd FROM jobs WHERE cwd IS NOT NULL")
      .all() as { cwd: string }[];
    for (const row of rows) candidates.add(row.cwd);
  } else {
    // Fast path: only working jobs + recently-updated jobs. The `state`
    // and `updated_at` columns are projection-derived (fold-time), so a
    // job that just touched a file at all is in this set. RECENT_JOB_
    // WINDOW_MS keeps the human-paced multi-session day on the fast
    // path without dredging up week-old idle sessions.
    //
    // `updated_at` is REAL unix seconds; the cutoff converts ms to s.
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

  // Monotonicity floor: every already-watched root is a candidate
  // regardless of which sweep ran. Without this a fast-path skip would
  // shrink `desired` below the watched set on the very next reconcile
  // (the cwd that bootstrapped a watched root might not be in the recent
  // window anymore) and spuriously unsubscribe a live attribution claim.
  for (const root of options.watched) candidates.add(root);

  return candidates;
}

/**
 * Pure cooling-hysteresis decision (epic fn-690). Given:
 *
 * - `currentlyWatched` — the set of roots that are subscribed right now;
 * - `desiredNow` — the moment-in-time verdict set from
 *   {@link discoverProjectRoots};
 * - `cleanSinceByRoot` — per-root wall clock (`Date.now()`) at which the root first
 *   became clean-and-pushed (i.e. NOT in `desiredNow` while it WAS in
 *   `currentlyWatched`); cleared the moment a root re-qualifies. The
 *   caller mutates this Map in place across reconciles;
 * - `nowMs` — wall clock (`Date.now()`) now;
 * - `dwellMs` — the dwell threshold ({@link WATCH_DROP_DWELL_MS}).
 *
 * Returns:
 * - `toAdd` — roots to subscribe this cycle (in `desiredNow` and not in
 *   `currentlyWatched`).
 * - `toDrop` — roots to unsubscribe this cycle (have been clean-and-pushed
 *   for ≥ `dwellMs`; satisfies the cooling-hysteresis invariant). A
 *   `.planctl` (or otherwise still-desired) root is never in `toDrop`.
 *
 * Also mutates `cleanSinceByRoot`: stamps the first-clean ts when a
 * watched root falls out of `desiredNow`, clears it when the root
 * re-qualifies or has been dropped.
 *
 * Pure & exported for unit-testable hysteresis verification.
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
 * fn-771: derive a missed-wake rescue's TRUE change-to-rescue latency from the
 * commit times the rescue discharged across all rescued roots. The honest
 * freshness signal — `now − committed_at_ms` — replaces the idle-inflating
 * `now − last_fast_path_at` staleness that paged a false critical (a 2s-old
 * commit caught after 27 quiet minutes reported staleness_ms ≈ 1.6M).
 *
 * - WORST CASE: when several commits discharge in one rescue tick, anchor on
 *   the OLDEST (smallest `committed_at_ms`) — it bounds the longest any
 *   delivered change waited unobserved.
 * - NO ANCHOR → `null`: a dirty-tree-only rescue (no commit discharged, so the
 *   array is empty) has no change to measure latency against. The caller only
 *   pushes POSITIVE `committed_at_ms` values (enumerateCommitsInDelta clamps an
 *   unparseable/non-positive commit time to 0, which would otherwise read as a
 *   ~epoch-sized false latency), so an empty array genuinely means no anchor.
 * - The negative-latency clamp (clock skew: `committed_at_ms > now`) is owned
 *   by {@link buildMissedWakeRecord}, which never emits a negative — this
 *   helper returns the raw signed difference so the clamp lives in one place.
 *
 * Pure & exported for unit reach (mirrors {@link decideReconcileTransitions}).
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
 * Select `git_status` projection rows to tombstone because their worktree
 * vanished from disk. Such a row is unreachable by {@link
 * decideReconcileTransitions} (whose `toDrop` loop only walks
 * `currentlyWatched`): a missing directory fails discovery's cwd→toplevel
 * resolution, so the root is never re-added to `desired` and never enters the
 * watched set — leaving the row strandable forever once a daemon restart drops
 * it out of `currentlyWatched`. The producer emitting `GitRootDropped` off a
 * live `existsSync` probe is allowed by the event-sourcing invariants (the
 * probe runs in a producer, never inside a fold); the reducer's idempotent
 * DELETE fold reconciles the projection.
 *
 * Pure & exported for unit reach (mirrors {@link buildDiscoveryCandidates} /
 * {@link decideReconcileTransitions}). The `exists` probe is injected so the
 * caller owns the one fs read per row.
 *
 * - Skips `currentlyWatched` roots — a live root whose dir vanishes is dropped
 *   by the normal dwell path (it falls out of `desired`, dwells, then
 *   `unsubscribeRoot` tombstones it); emitting here too would double-fire.
 * - Mutates `alreadyTombstoned`: adds each newly-dropped root (so a row pending
 *   its DELETE round-trip isn't re-emitted on the next sweep) and clears any
 *   root whose dir has reappeared (so it can be tombstoned again later).
 */
export function selectVanishedRoots(
  projectDirs: string[],
  exists: (dir: string) => boolean,
  currentlyWatched: Set<string>,
  alreadyTombstoned: Set<string>,
): string[] {
  const drop: string[] = [];
  for (const dir of projectDirs) {
    if (exists(dir)) {
      alreadyTombstoned.delete(dir);
      continue;
    }
    if (currentlyWatched.has(dir)) continue;
    if (alreadyTombstoned.has(dir)) continue;
    alreadyTombstoned.add(dir);
    drop.push(dir);
  }
  return drop;
}

/**
 * The dynamic watch-membership discoverer (epic fn-690). Replaces the
 * `.planctl`-only `gitRootFor`-filtered set with a probe-driven verdict
 * tiered by hot/cold TTL. Returns the sorted set of roots that
 * {@link reconcileRoots} should ensure are subscribed.
 *
 * Stages:
 *   1. Build the candidate cwds via {@link buildDiscoveryCandidates}
 *      (recent + watched fast path, or full-history slow sweep).
 *   2. Resolve each cwd → toplevel via the permanent
 *      `cwdRootCache`. Drops cwds that aren't inside a git worktree.
 *   3. For each resolved root, consult the per-root TTL memo
 *      (`watchProbeCache`). On miss / expiry, run {@link
 *      probeWatchMembership} ONCE and cache the verdict at the
 *      appropriate tier (hot if currently watched, cold otherwise).
 *      `.planctl` short-circuits in {@link shouldWatchRoot} BEFORE the
 *      probe even runs.
 *   4. Compose the verdict via {@link shouldWatchRoot} (which folds in
 *      `.planctl` short-circuit + fail-open-if-watched / fail-closed-
 *      otherwise on a null probe).
 *
 * Returns the sorted list of roots keeper should watch. Cooling
 * hysteresis ({@link WATCH_DROP_DWELL_MS}) is applied by `reconcileRoots`
 * on the drop side — `discoverProjectRoots` is the moment-in-time
 * verdict, NOT the dwell-aware drop list. The reconcile then layers
 * `cleanSinceByRoot` on top to convert a clean+pushed candidate into a
 * delayed drop.
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

  // Stage 2: resolve cwd → toplevel via the permanent cache. Drops cwds
  // that aren't inside a git worktree. `.planctl` and dirty checks happen
  // against the resolved root, NOT the candidate cwd.
  const resolvedRoots = new Set<string>();
  for (const candidate of candidates) {
    let root: string | null | undefined = ctx.cwdRootCache.get(candidate);
    if (root === undefined) {
      root = resolveGitToplevel(candidate);
      ctx.cwdRootCache.set(candidate, root);
    }
    if (root != null) resolvedRoots.add(root);
  }

  // Stage 3 + 4: per-root verdict TTL memo + probe + decide. Lazy-prune
  // expired entries that aren't in the current candidate set so the map
  // stays bounded by the live working set.
  const desired = new Set<string>();
  for (const root of resolvedRoots) {
    const watched = ctx.currentlyWatched.has(root);
    const ttl = watched ? WATCH_PROBE_TTL_HOT_MS : WATCH_PROBE_TTL_COLD_MS;
    let probe: { dirty: boolean; ahead: number } | null;
    const cached = ctx.watchProbeCache.get(root);
    if (cached !== undefined && cached.expiry > ctx.nowMs) {
      probe = cached.verdict;
    } else {
      // `.planctl` short-circuits inside shouldWatchRoot BEFORE the probe
      // runs — but we need the probe verdict cached anyway for any future
      // `.planctl` removal. Skip the probe for `.planctl` roots entirely;
      // the verdict is `null` (unknown), shouldWatchRoot returns true on
      // the `.planctl` check, and a future removal forces a re-probe via
      // expiry.
      if (existsSync(join(root, ".planctl"))) {
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

  // Lazy prune: drop expired entries that aren't even candidates anymore.
  // Bounds map size against churn (a stale cwd no longer in any candidate
  // set drops within one TTL window).
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
 * Build the file-centric `GitSnapshot` payload. Pure composition of the
 * `git status --porcelain=v2` parse with a per-file `lstat` for `mtime_ms` —
 * no event-log join, no `jobs` join, no per-(session, file) derivation.
 * Per-job rollup, per-file attribution, and the project-wide orphan set are
 * computed by the reducer in `projectGitStatus` (task fn-633.6) inside
 * `BEGIN IMMEDIATE` against the persisted event log + `file_attributions`
 * table — moving the join there restores re-fold determinism (a producer
 * runs without the writer lock, so an event-log join here would see a
 * different mid-fold projection on every re-fold).
 *
 * The renamed-path case keeps the renamed entry's `path` (the NEW path —
 * what's currently in the worktree); `orig_path` rides along when set so
 * the reducer can dereference both halves of the rename pair against the
 * event log. `lstat` always targets `path` (the new name); `orig_path`
 * doesn't exist on disk anymore.
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

  const dirty: GitDirtyFile[] = status.files.map((file) => {
    const entry: GitDirtyFile = {
      path: file.path,
      xy: file.xy,
      kind: file.kind,
      mtime_ms: lstatMtimeMs(projectDir, file.path),
      worktree_oid: worktreeOidByPath.get(file.path) ?? null,
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

  const { db } = openDb(data.dbPath, { readonly: true });
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
  // Each watched root holds a worktree subscription and (best-effort) a
  // git-common-dir subscription. The git-dir sub may be null if the
  // common-dir lookup failed or the subscribe itself rejected (logged,
  // non-fatal — the heartbeat backstop still covers commit/checkout for
  // that root within 60s). Co-locating the two so unsubscribe + shutdown
  // can release them as a unit.
  interface RootSubscriptions {
    worktree: AsyncSubscription;
    gitDir: AsyncSubscription | null;
  }
  const subscriptions = new Map<string, RootSubscriptions>();
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
   * `.planctl` tree in). Folded into the candidate set on every reconcile via
   * {@link buildDiscoveryCandidates} so a repo with no seen-cwd job history is
   * still discovered. Grows monotonically across the worker's lifetime; bounded
   * by the number of distinct planctl repos (small, and the membership floor it
   * provides is harmless — `shouldWatchRoot` still gates on `.planctl` presence
   * / dirty / ahead, so a nudge for a repo whose `.planctl` later vanishes
   * simply stops qualifying).
   */
  const extraCandidateRoots = new Set<string>();
  /**
   * fn-771 missed-wake re-arm. Roots whose FSEvents subscription went mute and
   * was rescued by the heartbeat backstop — flagged here so the NEXT
   * level-triggered reconcile re-derives a FRESH subscription for each (a mute
   * `@parcel/watcher` stream is replaced, not respawned). This is the existing
   * reconcile mechanism with ONE extra trigger: the heartbeat NEVER
   * unsubscribes/resubscribes directly (the no-self-heal invariant — no worker
   * respawn), it only sets the flag and kicks a reconcile. The reconcile drains
   * the set (bounded by {@link MAX_SUBSCRIBES_PER_CYCLE}), tears down each
   * flagged root's FSEvents subs WITHOUT a `git-root-dropped` tombstone (a
   * re-arm keeps the projection row + the HEAD-oid cache — it is not a drop),
   * then the normal `toAdd` re-derivation re-subscribes any still-desired root
   * exactly once. A subscribe failure follows the existing reconcile
   * error-handling (`subscribeRoot` swallows + logs); nothing throws out of the
   * heartbeat. No DB write, no synthetic event.
   */
  const pendingResubscribe = new Set<string>();
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

  let watcherModule: typeof import("@parcel/watcher") | null = null;
  let dbPollTimer: ReturnType<typeof setInterval> | null = null;
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
  function emitSnapshot(
    root: string,
    dischargedCommitAtMs?: number[],
  ): boolean {
    if (shuttingDown) return false;
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
        // commit's `planctl-commit-changed` + `Commit` discharge), so we hold
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
              // Epic fn-670 (T1): the validated, planctl-shaped `Task:`
              // trailer values the git-worker collected for this
              // commit. Empty `[]` on the common path (no Task trailer,
              // or all values malformed). The reducer's T2 link fold
              // reads this array together with `committer_session_id`
              // to stamp the per-task `last_commit_for_task_at` on the
              // embedded job element under each named task.
              task_ids: c.task_ids,
              // Epic fn-695: the normalized planctl op + validated target
              // ref lifted from this commit's `Planctl-Op:` /
              // `Planctl-Target:` trailers. Both null on a non-planctl
              // commit. The reducer's edge fold reads them (with
              // `committer_session_id`) to mint the commit-derived
              // creator/refiner edge, deduped against the legacy stdout
              // scrape in `syncPlanctlLinks`.
              planctl_op: c.planctl_op,
              planctl_target: c.planctl_target,
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
            // Epic fn-681: authoritative commit-driven planctl ingest.
            // Filter the commit's enumerated file list to planctl-shaped
            // paths (epics / tasks / state-tasks) and post one
            // {@link PlanctlCommitChangedMessage} per commit carrying any
            // such paths. Suppressed when the commit touched no planctl
            // files — the common case for source commits. Main forwards
            // the message verbatim to plan-worker, which re-ingests each
            // path from the committed worktree via the existing
            // `onChange` / `onDelete` pipeline (drop-proof; no partial-
            // read race). The reducer never sees this message — it lives
            // entirely on the worker→main→worker side channel.
            const planctlChanges = filterPlanctlChanges(c.files);
            if (planctlChanges.length > 0) {
              port.postMessage({
                kind: "planctl-commit-changed",
                project_dir: root,
                commit_oid: c.commit_oid,
                changes: planctlChanges,
              } satisfies PlanctlCommitChangedMessage);
            }
          }
        } catch (err) {
          // Producer-only contract: a failed enumeration cannot wedge the
          // worker; log to stderr and continue. Unlike the pre-fn-705 code we
          // do NOT advance the head cache past this range below — `enumOk`
          // gates the advance so the next HEAD-oid observation re-enumerates
          // and re-emits the dropped commit's `planctl-commit-changed`.
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
    if (lastByRoot.get(root) === key) {
      coalescedDrops++;
      return false;
    }
    lastByRoot.set(root, key);
    port.postMessage({
      kind: "git-snapshot",
      ...snapshot,
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
        // fn-720: a debounced scheduler fire IS the fast path (an FSEvents
        // worktree/git-dir change, or the drop-triggered rescan) — stamp
        // `last_fast_path_at` so a later heartbeat measures staleness against
        // it. The heartbeat calls
        // `emitSnapshot` DIRECTLY (not through the scheduler), so it never
        // stamps — exactly the fast-path/backstop distinction we want.
        markFastPath();
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

  async function subscribeRoot(root: string): Promise<void> {
    if (shuttingDown || watcherModule == null) return;
    if (subscriptions.has(root)) return;
    const sched = schedulerFor(root);
    const mod = watcherModule;
    let worktreeSub: AsyncSubscription | null = null;
    let gitDirSub: AsyncSubscription | null = null;
    try {
      worktreeSub = await mod.subscribe(
        root,
        (err) => {
          if (err) {
            console.error(
              `[git-worker] watcher error for ${root}: ${stringifyErr(err)}`,
            );
            // A recoverable FSEvents drop: schedule a re-snapshot so the missed
            // change isn't lost. Non-drop errors keep today's swallow-and-log.
            if (isDropError(err)) sched.schedule();
            return;
          }
          // Any worktree change → debounced re-snapshot. The per-root JSON
          // dedupe absorbs no-ops, so over-firing is cheap.
          sched.schedule();
        },
        { ignore: GIT_IGNORE_GLOBS },
      );
      if (shuttingDown) {
        void worktreeSub.unsubscribe();
        return;
      }

      // Sibling subscription on the git common-dir. The worktree sub ignores
      // `**/.git/**` (and even without that ignore, FSEvents wouldn't fire on
      // refs/HEAD/index churn because git uses rename-replace and lockfile
      // dance under the gitdir). Without this, a `git commit` (which only
      // mutates `.git/index`, `.git/HEAD`, `.git/refs/...`, `.git/objects/...`)
      // is invisible to the worker until the 60s heartbeat — the bug the
      // human hit. A failure here is logged and tolerated: the root stays
      // subscribed to its worktree, and the heartbeat still covers it.
      const commonDir = gitCommonDirFor(root);
      if (commonDir != null) {
        try {
          gitDirSub = await mod.subscribe(
            commonDir,
            (err) => {
              if (err) {
                console.error(
                  `[git-worker] git-dir watcher error for ${commonDir}: ${stringifyErr(err)}`,
                );
                if (isDropError(err)) sched.schedule();
                return;
              }
              sched.schedule();
            },
            { ignore: GIT_DIR_IGNORE_GLOBS },
          );
        } catch (err) {
          console.error(
            `[git-worker] failed to subscribe to git-dir ${commonDir}: ${stringifyErr(err)}`,
          );
        }
      }
      if (shuttingDown) {
        if (gitDirSub != null) void gitDirSub.unsubscribe();
        void worktreeSub.unsubscribe();
        return;
      }

      subscriptions.set(root, { worktree: worktreeSub, gitDir: gitDirSub });
      // Initial snapshot for the newly-watched root.
      emitSnapshot(root);
    } catch (err) {
      // Only the worktree `await` can reach this catch — the git-dir branch
      // has its own inner try/catch, and every subsequent step is sync &
      // non-throwing. So `gitDirSub` is still null here; only `worktreeSub`
      // needs best-effort teardown.
      if (worktreeSub != null) void worktreeSub.unsubscribe();
      console.error(
        `[git-worker] failed to subscribe to ${root}: ${stringifyErr(err)}`,
      );
    }
  }

  async function unsubscribeRoot(root: string): Promise<void> {
    // Tombstone first — main lifts this into a synthetic GitRootDropped event
    // whose reducer fold DELETEs the projection row. Posting before teardown
    // keeps the producer-only contract: the event log is the sole driver of
    // git_status changes, so re-fold determinism extends to retractions.
    // Skip during shutdown — main has already cleared its onmessage handler
    // and posting would be a no-op that just races the worker's exit path.
    if (!shuttingDown) {
      port.postMessage({
        kind: "git-root-dropped",
        project_dir: root,
      } satisfies GitRootDroppedMessage);
    }
    const sub = subscriptions.get(root);
    if (sub != null) {
      subscriptions.delete(root);
      try {
        await sub.worktree.unsubscribe();
      } catch {
        // best-effort
      }
      if (sub.gitDir != null) {
        try {
          await sub.gitDir.unsubscribe();
        } catch {
          // best-effort
        }
      }
    }
    const sched = schedulers.get(root);
    if (sched != null) {
      sched.cancel();
      schedulers.delete(root);
    }
    lastByRoot.delete(root);
    // Clear the HEAD-oid bootstrap cache too so a re-subscribe of the same
    // root (planctl dir re-created) re-seeds from the current head and
    // doesn't emit a phantom delta against the pre-drop state. The fn-705
    // enumeration-failure counter is per-root and meaningless across a
    // re-subscribe, so drop it in lockstep.
    lastHeadOidByRoot.delete(root);
    headEnumFailuresByRoot.delete(root);
  }

  /**
   * fn-771 missed-wake re-arm teardown. Unlike {@link unsubscribeRoot} this is
   * NOT a drop: it tears down ONLY the (possibly mute) FSEvents subscriptions
   * and removes the root from the `subscriptions` map so the reconcile's normal
   * `toAdd` re-derivation re-subscribes it with a fresh stream. It posts NO
   * `git-root-dropped` tombstone (the projection row stays — the root is still
   * desired) and PRESERVES `lastHeadOidByRoot` (so the re-subscribe does not
   * emit a phantom HEAD delta against the pre-rearm state). The debounce
   * scheduler is left in place — it is re-bound by `schedulerFor` inside the
   * re-subscribe and carries no stale pending fire that matters. Best-effort
   * teardown throughout; nothing throws.
   */
  async function tearDownForResubscribe(root: string): Promise<void> {
    const sub = subscriptions.get(root);
    if (sub == null) return;
    subscriptions.delete(root);
    try {
      await sub.worktree.unsubscribe();
    } catch {
      // best-effort
    }
    if (sub.gitDir != null) {
      try {
        await sub.gitDir.unsubscribe();
      } catch {
        // best-effort
      }
    }
  }

  async function reconcileRoots(): Promise<void> {
    if (shuttingDown || watcherModule == null) return;
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

      // fn-771 missed-wake re-arm. Drain the heartbeat-flagged roots BEFORE
      // computing `currentlyWatched` so a torn-down (re-armed) root falls into
      // the `toAdd` re-derivation below and re-subscribes exactly once with a
      // fresh FSEvents stream. Bounded by the same per-cycle cap as new
      // subscribes; any overflow stays flagged for the next reconcile. The
      // flag is cleared as it is drained (re-arm is one-shot per flag), so a
      // root that re-goes-mute simply gets re-flagged by a later heartbeat.
      if (pendingResubscribe.size > 0) {
        const toRearm = [...pendingResubscribe].slice(
          0,
          MAX_SUBSCRIBES_PER_CYCLE,
        );
        for (const root of toRearm) {
          pendingResubscribe.delete(root);
          await tearDownForResubscribe(root);
        }
        if (pendingResubscribe.size > 0) reconcilePending = true;
      }

      const currentlyWatched = new Set(subscriptions.keys());

      // Vanished-worktree prune. Gated to the full-sweep cadence (runs at boot
      // — lastFullSweepMs === null — and every FULL_SWEEP_INTERVAL_MS), so a
      // git_status row whose directory was deleted/moved sheds its ghost
      // instead of lingering forever (decideReconcileTransitions can't reach an
      // unwatched root). See selectVanishedRoots.
      if (runFullSweep) {
        const rows = db.query("SELECT project_dir FROM git_status").all() as {
          project_dir: string;
        }[];
        for (const dir of selectVanishedRoots(
          rows.map((r) => r.project_dir),
          existsSync,
          currentlyWatched,
          vanishedTombstoned,
        )) {
          port.postMessage({
            kind: "git-root-dropped",
            project_dir: dir,
          } satisfies GitRootDroppedMessage);
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

      // Cap new subscribes per cycle so the first full sweep can't balloon
      // FSEvents streams into `fseventsd` bad-state. Remaining joins land
      // on subsequent reconciles (every DB-poll tick + heartbeat).
      const capped = toAdd.slice(0, MAX_SUBSCRIBES_PER_CYCLE);
      for (const root of capped) {
        await subscribeRoot(root);
      }
      // If we capped, request another reconcile cycle so the rest land
      // promptly without waiting for the next data_version bump.
      if (toAdd.length > MAX_SUBSCRIBES_PER_CYCLE) {
        reconcilePending = true;
      }

      for (const root of toDrop) {
        await unsubscribeRoot(root);
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
      // candidate set and request an immediate reconcile so the `.planctl`
      // short-circuit in `shouldWatchRoot` subscribes it now, not on the next
      // full sweep. Idempotent (Set add) + convergent (reconcile is
      // single-flighted). Tolerated no-op during the boot window where
      // `watcherModule` is still null — `reconcileRoots` early-returns and the
      // root stays queued for the boot reconcile.
      if (shuttingDown) return;
      extraCandidateRoots.add(msg.root);
      void reconcileRoots();
      return;
    }
    if (msg.type !== "shutdown") return;
    shuttingDown = true;
    if (dbPollTimer != null) clearInterval(dbPollTimer);
    if (heartbeatTimer != null) clearInterval(heartbeatTimer);
    // fn-720: cancel the periodic rollup flush, then flush ONE final rollup so
    // the denominator survives a clean stop. postMessage is synchronous; main
    // is still reading (it sends `shutdown` and awaits `close`).
    if (rollupTimer != null) {
      clearInterval(rollupTimer);
      rollupTimer = null;
    }
    flushBackstopRollups();
    // Cancel every armed scheduler BEFORE unsubscribe + db.close so a queued
    // re-scan can't fire against a closing connection. Mirrors plan-worker.
    for (const sched of schedulers.values()) sched.cancel();
    schedulers.clear();
    void (async () => {
      const subs = [...subscriptions.values()];
      subscriptions.clear();
      for (const sub of subs) {
        try {
          await sub.worktree.unsubscribe();
        } catch {
          // best-effort
        }
        if (sub.gitDir != null) {
          try {
            await sub.gitDir.unsubscribe();
          } catch {
            // best-effort
          }
        }
      }
      try {
        db.close();
      } catch {
        // best-effort
      }
      process.exit(0);
    })();
  });

  // fn-747 watcher seam: skip the native addon dlopen entirely in the in-process
  // tier. `reconcileRoots`/`subscribeRoot` early-return while `watcherModule`
  // stays null, so the DB-poll + heartbeat timers (armed inside the `.then`
  // below) never arm and no GitSnapshot work runs — git snapshots are not
  // exercised by the in-process fold-pipeline tier. The worker stays alive (the
  // parentPort listener keeps the event loop running) for the shutdown
  // handshake.
  if (data.disableNativeWatcher) {
    return;
  }

  void import("@parcel/watcher")
    .then(async (mod) => {
      watcherModule = mod;
      await reconcileRoots();

      // DB-wake trigger. Per CLAUDE.md DO-NOT, `PRAGMA data_version` is the
      // ONLY sanctioned DB change primitive — `wake-worker.ts` uses the same
      // pattern. A bump means SOMETHING committed (new tool event, new job
      // row, new epic/task snapshot) and root membership may have changed.
      //
      // `data_version` carries NO root attribution, so it drives membership
      // reconcile ONLY (cheap, O(1), idempotent — a foreign write may have
      // changed which roots to watch). It does NOT fan a per-root snapshot out:
      // that O(roots) fan-out was the CPU-flood source this epic removed. Every
      // per-root snapshot now comes from the worktree + git-common-dir FSEvents
      // subs (plus the drop-triggered rescan) with the 60s heartbeat as the
      // single drop backstop. See {@link decideDataVersionWake}.
      const dataVersionQuery = db.query("PRAGMA data_version");
      lastDataVersion = (dataVersionQuery.get() as { data_version: number })
        .data_version;
      dbPollTimer = setInterval(() => {
        if (shuttingDown) return;
        const cur = (dataVersionQuery.get() as { data_version: number })
          .data_version;
        const decision = decideDataVersionWake(cur, lastDataVersion ?? cur);
        if (!decision.reconcile) return;
        lastDataVersion = cur;
        void reconcileRoots();
      }, DB_POLL_MS);

      // Silent-watcher backstop, mirroring transcript-worker. If a watcher
      // ever goes mute (observed parcel/watcher #174-style stalls under
      // sibling-worker crashes), the heartbeat catches the missed snapshot
      // within HEARTBEAT_MS. The per-root dedupe makes a healthy run free.
      heartbeatTimer = setInterval(() => {
        if (shuttingDown) return;
        void reconcileRoots();
        // emitSnapshot self-gates via snapshotSuppressedByDivergence, so the
        // heartbeat doubles as the quiet-repo backstop for the wedge guard —
        // even with no file/commit activity it re-checks divergence and drives
        // the eventual restart. (The primary trigger is the live watcher/
        // db-poll emit path, since this 60s timer proved unreliable mid-wedge.)
        // fn-720: this IS the slow backstop — OR the per-root emitted-booleans
        // into one `rescued` flag. A `true` means a watcher went mute and the
        // heartbeat re-delivered a snapshot the FSEvents/db-poll fast paths
        // missed. The shutdown guard above gates the telemetry emit too.
        let rescued = false;
        // fn-771: collect every discharged commit's time across the rescued
        // roots so the record carries the TRUE change-to-rescue latency, and
        // track WHICH roots rescued so each can be flagged for a watcher
        // re-arm (a rescue means that root's FSEvents stream missed a change).
        const dischargedCommitAtMs: number[] = [];
        const rescuedRoots: string[] = [];
        for (const root of subscriptions.keys()) {
          if (emitSnapshot(root, dischargedCommitAtMs)) {
            rescued = true;
            rescuedRoots.push(root);
          }
        }
        backstopCounters.bump("git-heartbeat", "missed-wake", rescued);
        if (rescued) {
          const now = Date.now();
          // Worst-case (oldest) commit anchor across all roots rescued this
          // tick → `now − oldest`. No commit anchor (dirty-tree-only rescue) →
          // null. A negative latency (clock skew: committed_at_ms > now) is
          // clamped to null by buildMissedWakeRecord, never emitted negative.
          const changeToRescueMs = deriveChangeToRescueMs(
            dischargedCommitAtMs,
            now,
          );
          port.postMessage({
            kind: "backstop",
            record: buildMissedWakeRecord({
              backstop: "git-heartbeat",
              worker: "git-worker",
              fastPath: "fsevents",
              rescued: true,
              now,
              lastFastPathAt,
              changeToRescueMs,
            }),
          } satisfies BackstopMessage);
          // fn-771 re-arm: flag each rescued root for a fresh subscription and
          // kick a reconcile to re-derive it. The heartbeat NEVER
          // unsubscribes/resubscribes directly (no-self-heal); reconcile owns
          // the teardown + re-subscribe, bounded by MAX_SUBSCRIBES_PER_CYCLE.
          for (const root of rescuedRoots) {
            pendingResubscribe.add(root);
          }
          void reconcileRoots();
        }
        // Epic fn-716: surface the flood reduction. Log + reset the count of
        // snapshots the semantic dedupe gate coalesced away this window (mostly
        // pure-mtime churn under continuous editing) so the throttle's effect is
        // observable in keeperd's stderr without per-drop spam.
        if (coalescedDrops > 0) {
          console.error(
            `[git-worker] coalesced ${coalescedDrops} no-op GitSnapshot emit(s) in the last ${HEARTBEAT_MS}ms (semantic dedupe)`,
          );
          coalescedDrops = 0;
        }
      }, HEARTBEAT_MS);

      // fn-720: periodic backstop-rollup flush — checkpoint the denominator
      // (fires_total / rescues_total) so the metric survives a crash without a
      // line per no-op heartbeat. Cleared + final-flushed in the shutdown
      // handler.
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
    })
    .catch((err) => {
      // Addon load failure is the sole unrecoverable surface. Exit non-zero →
      // daemon `fatalExit` → launchd restart, the single recovery path.
      console.error(
        `[git-worker] failed to load @parcel/watcher: ${stringifyErr(err)}`,
      );
      try {
        db.close();
      } catch {
        // best-effort
      }
      process.exit(1);
    });
}

if (!isMainThread) {
  startWorker();
}
