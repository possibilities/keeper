/**
 * Git status producer worker. Snapshots planctl-backed git worktrees and posts
 * a synthetic snapshot message when the rendered git view changes.
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
 * safety-net. Each signal feeds a per-root `RescanScheduler` (trailing-
 * debounce + single-flight) so a flurry collapses into one `git status`
 * shell-out. The per-root `lastByRoot` JSON dedupe absorbs no-op snapshots.
 *
 * `PRAGMA data_version` polling is the only sanctioned DB change primitive
 * per the CLAUDE.md DO-NOT — it's a sub-ms autocommit counter read, not a
 * shell-out, and it's already foundational to `wake-worker.ts`.
 *
 * This worker is an event PRODUCER only: it owns no writable DB connection and
 * never mutates projections. Main inserts a `GitSnapshot` event, and the
 * reducer folds that persisted payload into `git_status`. When a watched root
 * stops being planctl-backed (its `.planctl/` directory was removed), the
 * worker also posts a `GitRootDropped` tombstone message from `unsubscribeRoot`
 * — main lifts it into a synthetic `GitRootDropped` event whose reducer fold
 * DELETEs the projection row, keeping `git_status` in sync with the worktree.
 */

import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import type { AsyncSubscription } from "@parcel/watcher";
import { openDb } from "./db";
import { parseSessionIdTrailer } from "./derivers";
import { isDropError, RescanScheduler } from "./rescan";
import type { ShutdownMessage } from "./wake-worker";

export interface GitWorkerData {
  dbPath: string;
}

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
 * Tombstone message: a watched root has stopped being planctl-backed (its
 * `.planctl/` directory disappeared, so `gitRootFor()` now returns null) and
 * the worker is unsubscribing. Main lifts this into a synthetic
 * `GitRootDropped` event whose reducer fold DELETEs the corresponding
 * `git_status` row — without it the projection would leak the final pre-drop
 * snapshot forever (the reducer's `projectGitStatus` is UPSERT-only).
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
  committed_at_ms: number;
}

export type GitWorkerMessage =
  | GitSnapshotMessage
  | GitRootDroppedMessage
  | CommitMessage;

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
const GIT_TIMEOUT_MS = 2000;
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
    const res = Bun.spawnSync(["git", ...args], {
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

function gitRootFor(path: string): string | null {
  const out = gitOutput(["-C", path, "rev-parse", "--show-toplevel"]);
  const root = out?.trim();
  if (!root) {
    return null;
  }
  return existsSync(join(root, ".planctl")) ? root : null;
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
interface EnumeratedCommit {
  commit_oid: string;
  parent_oid: string | null;
  files: EnumeratedCommitFile[];
  committer_session_id: string | null;
  committed_at_ms: number;
}

/**
 * Anchored full-OID match — same shape as `derivers.ts` `GIT_OID_RE`.
 * Module-scope literal so V8/JSC tier up once at process start.
 */
const PRODUCER_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

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
function enumerateCommitsInDelta(
  root: string,
  prev: string | null,
  next: string,
): EnumeratedCommit[] {
  const format =
    "%H%x00%P%x00%ct%x00%(trailers:key=Session-Id,valueonly,only,unfold)";
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
  // — but the `%x00` separators inside the format string also emit literal
  // NULs in-stream. So the wire format for N commits is:
  //   OID1\0PARENTS1\0CT1\0TRAILERS1\0OID2\0PARENTS2\0CT2\0TRAILERS2\0...
  // — i.e. a flat sequence of 4N NUL-delimited fields with a trailing
  // empty element after the final NUL. Split on `\0` and consume in
  // groups of 4.
  const fields = out.split("\0");
  const commits: EnumeratedCommit[] = [];
  for (let i = 0; i + 3 < fields.length; i += 4) {
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
    const trailers = fields[i + 3] ?? "";
    const committerSessionId = parseSessionIdTrailer(trailers);
    const files = commitFiles(root, oid);
    commits.push({
      commit_oid: oid,
      parent_oid: parentOid,
      files,
      committer_session_id: committerSessionId,
      committed_at_ms: committedAtMs,
    });
  }
  return commits;
}

function discoverProjectRoots(
  db: Database,
  cwdRootCache?: Map<string, string | null>,
): string[] {
  const candidates = new Set<string>();
  const jobRows = db
    .query("SELECT DISTINCT cwd FROM jobs WHERE cwd IS NOT NULL")
    .all() as { cwd: string }[];
  for (const row of jobRows) candidates.add(row.cwd);

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

  const roots = new Set<string>();
  for (const candidate of candidates) {
    // cwd → root is stable for a session's lifetime, and a shell-out per cwd
    // per reconcile is the dominant cost. Memoize across reconciles (cleared
    // only by daemon restart).
    let root: string | null | undefined = cwdRootCache?.get(candidate);
    if (root === undefined) {
      root = gitRootFor(candidate);
      cwdRootCache?.set(candidate, root);
    }
    if (root != null) roots.add(root);
  }
  return [...roots].sort();
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
    const res = Bun.spawnSync(["git", "hash-object", "--stdin-paths"], {
      cwd: projectDir,
      stdin: new TextEncoder().encode(`${presentPaths.join("\n")}\n`),
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
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
  const cwdRootCache = new Map<string, string | null>();
  /**
   * Per-root monotonic timestamp (`performance.now()` ms) at which the worker's
   * `git`-derived HEAD first diverged from the fs-derived HEAD and has stayed
   * divergent since. `undefined`/absent means "in agreement". Cleared the moment
   * git and fs agree (or fs can't be resolved). The `emitSnapshot` gate reads
   * this to suppress divergent snapshots and to escalate after
   * {@link HEAD_DIVERGENCE_GRACE_MS}. See {@link decideHeadDivergence}.
   */
  const headDivergentSinceByRoot = new Map<string, number>();

  let watcherModule: typeof import("@parcel/watcher") | null = null;
  let dbPollTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastDataVersion: number | null = null;
  let shuttingDown = false;

  // Single-flight reconciler — DB poll + heartbeat + boot all call this and
  // must not double-subscribe across an `await`.
  let reconciling = false;
  let reconcilePending = false;

  function emitSnapshot(root: string): void {
    if (shuttingDown) return;
    let status: ParsedGitStatus | null;
    try {
      status = readStatus(root);
    } catch (err) {
      console.error(
        `[git-worker] readStatus failed for ${root}: ${stringifyErr(err)}`,
      );
      return;
    }
    if (status == null) return;

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
      return;
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
              committed_at_ms: c.committed_at_ms,
            } satisfies CommitMessage);
          }
        } catch (err) {
          // Producer-only contract: a failed enumeration cannot wedge the
          // worker; log to stderr and continue. The next HEAD-oid change
          // will re-attempt (with `prev` updated below to the current
          // head, so we don't perpetually re-enumerate the same range).
          console.error(
            `[git-worker] commit enumeration failed for ${root}: ${stringifyErr(err)}`,
          );
        }
      }
      // Update prev unconditionally so a snapshot with the same head_oid
      // doesn't re-enumerate, AND a one-off failed enumeration doesn't
      // get stuck retrying the same range forever. NULL head_oid (e.g.
      // a worktree with no commits) also stores as null.
      lastHeadOidByRoot.set(root, currentHeadOid);
    }

    let snapshot: GitSnapshotPayload;
    try {
      snapshot = buildGitSnapshot(root, status);
    } catch (err) {
      console.error(
        `[git-worker] buildGitSnapshot failed for ${root}: ${stringifyErr(err)}`,
      );
      return;
    }
    const key = JSON.stringify(snapshot);
    if (lastByRoot.get(root) === key) return;
    lastByRoot.set(root, key);
    port.postMessage({
      kind: "git-snapshot",
      ...snapshot,
    } satisfies GitSnapshotMessage);
  }

  function schedulerFor(root: string): RescanScheduler {
    let s = schedulers.get(root);
    if (s != null) return s;
    s = new RescanScheduler(() => emitSnapshot(root));
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
    // doesn't emit a phantom delta against the pre-drop state.
    lastHeadOidByRoot.delete(root);
  }

  async function reconcileRoots(): Promise<void> {
    if (shuttingDown || watcherModule == null) return;
    if (reconciling) {
      reconcilePending = true;
      return;
    }
    reconciling = true;
    try {
      const desired = new Set(discoverProjectRoots(db, cwdRootCache));
      const current = new Set(subscriptions.keys());
      for (const root of desired) {
        if (!current.has(root)) await subscribeRoot(root);
      }
      for (const root of current) {
        if (!desired.has(root)) await unsubscribeRoot(root);
      }
    } finally {
      reconciling = false;
      if (reconcilePending) {
        reconcilePending = false;
        void reconcileRoots();
      }
    }
  }

  port.on("message", (msg: ShutdownMessage | undefined) => {
    if (msg?.type !== "shutdown") return;
    shuttingDown = true;
    if (dbPollTimer != null) clearInterval(dbPollTimer);
    if (heartbeatTimer != null) clearInterval(heartbeatTimer);
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

  void import("@parcel/watcher")
    .then(async (mod) => {
      watcherModule = mod;
      await reconcileRoots();

      // DB-wake trigger. Per CLAUDE.md DO-NOT, `PRAGMA data_version` is the
      // ONLY sanctioned DB change primitive — `wake-worker.ts` uses the same
      // pattern. A bump means SOMETHING committed (new tool event, new job
      // row, new epic/task snapshot) and the touched-set or root membership
      // may have changed. Re-reconcile + schedule snapshots for every root;
      // the per-root JSON dedupe absorbs no-ops (including our own
      // GitSnapshot round-trips).
      const dataVersionQuery = db.query("PRAGMA data_version");
      lastDataVersion = (dataVersionQuery.get() as { data_version: number })
        .data_version;
      dbPollTimer = setInterval(() => {
        if (shuttingDown) return;
        const cur = (dataVersionQuery.get() as { data_version: number })
          .data_version;
        if (cur === lastDataVersion) return;
        lastDataVersion = cur;
        void reconcileRoots();
        for (const root of subscriptions.keys()) {
          schedulerFor(root).schedule();
        }
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
        for (const root of subscriptions.keys()) emitSnapshot(root);
      }, HEARTBEAT_MS);
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
