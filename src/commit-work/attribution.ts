/**
 * Session dirty-file attribution reader.
 *
 * Returns the files a Claude Code session is "on the hook" for: every file the
 * session has an UNDISCHARGED mutation row for in `file_attributions`
 * (`last_commit_at IS NULL OR last_commit_at < last_mutation_at`) that is ALSO
 * currently dirty per a LIVE `git status` in its repo. Dirtiness is verified
 * live — never from the cached `git_status` projection, which can lag behind a
 * just-landed edit — and FAILS OPEN per-repo: a repo whose `git status` can't
 * be read keeps ALL its on-hook files rather than silently dropping any (a
 * drop would produce an empty commit and lose attribution; the risk the epic
 * spec flags as fail-CLOSED).
 *
 * Reads keeper's DB directly via `openDb({ readonly: true })`. Board-dir
 * exclusion stays out of {@link getSessionDirtyFiles}; the client-side
 * partition lives in {@link discoverSessionFiles}, which selects the cwd's repo
 * and drops `.keeper/` board paths (they commit via the plan-commit hook, not
 * commit-work).
 */

import { openDb, resolveDbPath } from "../db";

/** Repo-relative paths grouped by absolute repo root, plus the cwd's repo. */
export interface SessionDirtyFiles {
  filesByRepo: Record<string, string[]>;
  cwdRepo: string | null;
}

/**
 * Repo-relative path prefixes excluded CLIENT-side from commit-work's view —
 * they route through the plan-commit hook, not commit-work. keeper's
 * attribution surface is exclusion-agnostic, so the partition lives here.
 *
 * `.keeper/` is the live keeper board dir.
 */
const PLAN_EXCLUDE_PREFIXES = [".keeper/"];

/** Inject a custom git runner / DB path / db-path resolver (tests). */
export interface AttributionDeps {
  /**
   * Resolve a cwd to its git toplevel, or `null` (not a repo / git missing).
   * Defaults to a live `git rev-parse --show-toplevel`.
   */
  gitRoot?: (cwd: string) => string | null;
  /**
   * Live dirty set for a repo, or `null` to signal FAIL-OPEN (git unreadable).
   * Defaults to a live `git status --porcelain=v2 -z --untracked-files=all`.
   */
  liveDirtyPaths?: (projectDir: string) => Set<string> | null;
  /** DB path override; defaults to {@link resolveDbPath}. */
  dbPath?: string;
}

/**
 * Live git toplevel for `cwd`, or `null`. Resolved at call time (not from a
 * cached projection) so a freshly-checked-out or never-snapshotted repo still
 * resolves. git returns the innermost worktree's toplevel, so nested checkouts
 * resolve to the inner repo without manual longest-prefix logic. NO
 * `--no-optional-locks` here is irrelevant (rev-parse takes no index lock);
 * we omit it uniformly for the commit-work family.
 */
function defaultGitRoot(cwd: string): string | null {
  if (!cwd) return null;
  try {
    const res = Bun.spawnSync(
      ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
      {
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    if (!res.success || res.exitCode !== 0) return null;
    const root = res.stdout.toString().trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Live dirty repo-relative path set for `projectDir`, or `null` (fail-open).
 *
 * Uses porcelain **v2** `-z` (the Python uses v1; v2 carries the same path
 * facts and is what keeper's git-worker already parses elsewhere). v2 `-z`
 * record framing:
 *   - `1 <XY> ... <path>`            — ordinary changed entry
 *   - `2 <XY> ... <origPath?> NUL <path>` — rename/copy: the new `<path>` ends
 *     this record's first NUL-field; the ORIGINAL path is the NEXT NUL field.
 *   - `u <XY> ... <path>`            — unmerged
 *   - `? <path>`                      — untracked
 *   - `! <path>`                      — ignored (we don't request these)
 * Both the new AND original paths of a rename join the dirty set so a moved
 * on-hook file is never dropped.
 */
function defaultLiveDirtyPaths(projectDir: string): Set<string> | null {
  let out: string;
  try {
    const res = Bun.spawnSync(
      [
        "git",
        "-C",
        projectDir,
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    if (!res.success || res.exitCode !== 0) return null;
    out = res.stdout.toString();
  } catch {
    return null;
  }

  const dirty = new Set<string>();
  const fields = out.split("\0");
  let i = 0;
  while (i < fields.length) {
    const rec = fields[i];
    if (rec.length === 0) {
      i += 1;
      continue;
    }
    const kind = rec[0];
    if (kind === "1" || kind === "u") {
      // Ordinary / unmerged: path is the last space-separated token.
      const path = pathAfterPrefixTokens(rec, kind);
      if (path) dirty.add(path);
      i += 1;
    } else if (kind === "2") {
      // Rename/copy: `<path>` is the tail of THIS field; the ORIGINAL path is
      // the next NUL-separated field.
      const path = pathAfterPrefixTokens(rec, kind);
      if (path) dirty.add(path);
      i += 1;
      if (i < fields.length && fields[i].length > 0) {
        dirty.add(fields[i]);
        i += 1;
      }
    } else if (kind === "?" || kind === "!") {
      // Untracked / ignored: `? <path>`.
      const path = rec.slice(2);
      if (path) dirty.add(path);
      i += 1;
    } else {
      // `# branch.*` headers and anything unexpected — skip.
      i += 1;
    }
  }
  return dirty;
}

/**
 * Extract the `<path>` tail of a porcelain-v2 `1`/`2`/`u` record. These records
 * are a fixed run of space-separated header tokens followed by the path (which
 * may itself contain spaces — v2 deliberately puts it LAST and `-z` removes the
 * quoting/escaping ambiguity). The header token counts are documented in
 * git-status(1): `1` = 8 tokens before the path, `2` = 9, `u` = 10.
 */
function pathAfterPrefixTokens(rec: string, kind: string): string | null {
  const headerTokens = kind === "1" ? 8 : kind === "2" ? 9 : 10;
  let idx = 0;
  let seen = 0;
  while (seen < headerTokens && idx < rec.length) {
    if (rec[idx] === " ") {
      seen += 1;
      // Skip any run of spaces (defensive; v2 uses single spaces).
      while (idx < rec.length && rec[idx] === " ") idx += 1;
    } else {
      idx += 1;
    }
  }
  const path = rec.slice(idx);
  return path.length > 0 ? path : null;
}

/**
 * Faithful port of `get_session_dirty_files(session_id, cwd)` — the
 * exclusion-AGNOSTIC shape, byte-identical output to the Python (sorted paths
 * per repo, repos with no surviving file omitted). Board-dir filtering is the
 * caller's job — see {@link discoverSessionFiles}.
 */
export function getSessionDirtyFiles(
  sessionId: string,
  cwd: string,
  deps: AttributionDeps = {},
): SessionDirtyFiles {
  const gitRoot = deps.gitRoot ?? defaultGitRoot;
  const liveDirtyPaths = deps.liveDirtyPaths ?? defaultLiveDirtyPaths;
  const dbPath = deps.dbPath ?? resolveDbPath();

  // Read the undischarged on-hook rows, then close the read-only handle BEFORE
  // shelling out to git so the connection window stays narrow (git probes run
  // lock-free). NO schema-version re-assertion — keeper owns the schema here.
  const { db } = openDb(dbPath, { readonly: true });
  let onHook: Array<{ project_dir: string; file_path: string }>;
  try {
    onHook = db
      .query(
        "SELECT project_dir, file_path FROM file_attributions " +
          "WHERE session_id = ? " +
          "AND (last_commit_at IS NULL OR last_commit_at < last_mutation_at)",
      )
      .all(sessionId) as Array<{ project_dir: string; file_path: string }>;
  } finally {
    db.close();
  }

  const onHookByRepo: Record<string, string[]> = {};
  for (const { project_dir, file_path } of onHook) {
    const bucket = onHookByRepo[project_dir] ?? [];
    bucket.push(file_path);
    onHookByRepo[project_dir] = bucket;
  }

  const filesByRepo: Record<string, string[]> = {};
  for (const [projectDir, candidates] of Object.entries(onHookByRepo)) {
    const dirty = liveDirtyPaths(projectDir);
    // dirty === null → git status unreadable → FAIL OPEN (keep all).
    const kept =
      dirty === null ? candidates : candidates.filter((p) => dirty.has(p));
    if (kept.length > 0) {
      // Stable order for deterministic output (callers may diff the list).
      filesByRepo[projectDir] = [...kept].sort();
    }
  }

  // cwd_repo resolved LIVE so it is correct even when the cwd's repo has
  // nothing on the hook and was never snapshotted by keeper's git-worker.
  const cwdRepo = defaultGitRootOrInjected(cwd, gitRoot);

  return { filesByRepo, cwdRepo };
}

function defaultGitRootOrInjected(
  cwd: string,
  gitRoot: (cwd: string) => string | null,
): string | null {
  return gitRoot(cwd);
}

/**
 * The commit-work consumer view: the cwd repo's on-hook dirty files with
 * board-dir paths removed (order-preserving over the sorted parity output).
 * Mirrors jobctl's `discover_files` — only the cwd's own repo is returned;
 * cross-repo files stay in their own repos.
 */
export function discoverSessionFiles(
  sessionId: string,
  cwd: string,
  deps: AttributionDeps = {},
): string[] {
  const { filesByRepo, cwdRepo } = getSessionDirtyFiles(sessionId, cwd, deps);
  if (!cwdRepo || !(cwdRepo in filesByRepo)) {
    return [];
  }
  return filesByRepo[cwdRepo].filter(
    (p) => !PLAN_EXCLUDE_PREFIXES.some((pfx) => p.startsWith(pfx)),
  );
}

export { PLAN_EXCLUDE_PREFIXES };

// ---------------------------------------------------------------------------
// Read-side wait: close the poll-lag window the `.1` poll-only git producer
// leaves (fn-921.4).
// ---------------------------------------------------------------------------

/**
 * `file_attributions` is charged ONLY in pass 1 of the GitSnapshot fold — by
 * intersecting promoted `mutation_path` events with a GitSnapshot's live-dirty
 * set. Since `.1` made the git producer POLL-ONLY (scanning every ~300ms), a
 * file edited immediately before `commit-work` runs is live-dirty but NOT yet
 * charged (no GitSnapshot has folded since the edit), so the on-hook ∩ live read
 * would miss staging it. This module lets `commit-work` WAIT — bounded and
 * fail-open — for the producer to catch up before it reads.
 *
 * The "is my session caught up?" predicate keys off the LIVE-DIRTY set, NOT the
 * raw mutation stream, so it can never false-wait forever: a mutation to a file
 * that is no longer dirty (edited then reverted) or to an excluded/`.keeper`
 * path simply isn't in the live-dirty set, so it never demands a charged row.
 * The session is caught up iff every file that is BOTH (a) the target of one of
 * the session's `mutation_path` events AND (b) currently live-dirty in the cwd
 * repo AND (c) not a board-excluded path has a charged `file_attributions` row.
 */

/** Default bounded-wait ceiling — rides `.1`'s ~300ms scan cadence with margin. */
export const DEFAULT_ATTRIBUTION_WAIT_MS = 1500;
/** Default poll interval while waiting (a fraction of the scan cadence). */
export const DEFAULT_ATTRIBUTION_POLL_MS = 75;

/** Tuning + injectable clock/sleep for {@link waitForAttributionCaughtUp} (tests). */
export interface AttributionWaitOpts {
  /** Hard ceiling on the wait; on expiry we fail open to the current read. */
  ceilingMs?: number;
  /** Poll interval between caught-up checks. */
  pollMs?: number;
  /** Monotonic clock (ms); defaults to {@link Date.now}. */
  now?: () => number;
  /** Async sleep; defaults to a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The session's repo-relative live-dirty mutation targets in `cwdRepo` that lack
 * a charged (undischarged) `file_attributions` row — the "not yet folded" set.
 * Empty ⇒ the session's attribution is caught up with its latest edits.
 *
 * Reads keeper.db read-only (the session's `mutation_path` events + its
 * undischarged attribution rows for `cwdRepo`) and takes ONE live `git status`
 * read (the same source {@link getSessionDirtyFiles} already trusts). The DB
 * handle is closed before the git read so the connection window stays narrow.
 *
 * Path canonicalization mirrors the fold: `mutation_path` is the absolute
 * `tool_input.file_path`, so it is mapped to repo-relative by stripping the
 * `cwdRepo + "/"` prefix (lexical only — no symlink walk), exactly inverting the
 * fold's `projectDir + "/" + file.path` join. A mutation outside `cwdRepo` (no
 * prefix match) is dropped — it cannot be a cwd-repo dirty file.
 */
export function pendingAttributionFiles(
  sessionId: string,
  cwdRepo: string,
  deps: AttributionDeps = {},
): string[] {
  const liveDirtyPaths = deps.liveDirtyPaths ?? defaultLiveDirtyPaths;
  const dbPath = deps.dbPath ?? resolveDbPath();

  const { db } = openDb(dbPath, { readonly: true });
  let mutationPaths: string[];
  let charged: Set<string>;
  try {
    mutationPaths = (
      db
        .query(
          "SELECT DISTINCT mutation_path FROM events " +
            "WHERE session_id = ? AND mutation_path IS NOT NULL",
        )
        .all(sessionId) as Array<{ mutation_path: string }>
    ).map((r) => r.mutation_path);
    charged = new Set(
      (
        db
          .query(
            "SELECT file_path FROM file_attributions " +
              "WHERE session_id = ? AND project_dir = ? " +
              "AND (last_commit_at IS NULL OR last_commit_at < last_mutation_at)",
          )
          .all(sessionId, cwdRepo) as Array<{ file_path: string }>
      ).map((r) => r.file_path),
    );
  } finally {
    db.close();
  }

  // No session edits → nothing can be lagging.
  if (mutationPaths.length === 0) return [];

  // Map the absolute mutation targets to cwd-repo-relative, keeping only those
  // under `cwdRepo` and not board-excluded.
  const root = cwdRepo.endsWith("/") ? cwdRepo.slice(0, -1) : cwdRepo;
  const prefix = `${root}/`;
  const sessionRel = new Set<string>();
  for (const abs of mutationPaths) {
    if (!abs.startsWith(prefix)) continue;
    const rel = abs.slice(prefix.length);
    if (rel.length === 0) continue;
    if (PLAN_EXCLUDE_PREFIXES.some((pfx) => rel.startsWith(pfx))) continue;
    sessionRel.add(rel);
  }
  if (sessionRel.size === 0) return [];

  // Intersect with the LIVE dirty set. A `null` (git unreadable) means we can't
  // tell what is dirty — fail open: report nothing pending so the caller does
  // not block on an unreadable repo.
  const dirty = liveDirtyPaths(cwdRepo);
  if (dirty === null) return [];

  const pending: string[] = [];
  for (const rel of sessionRel) {
    if (dirty.has(rel) && !charged.has(rel)) pending.push(rel);
  }
  return pending.sort();
}

/**
 * Resolve `cwd` to its git toplevel for the read-side wait — the cwd-repo key
 * the wait + predicate compare against. Honors an injected `gitRoot` (tests);
 * defaults to the live `git rev-parse --show-toplevel`. `null` ⇒ not a repo, so
 * there is nothing to wait on.
 */
export function resolveCwdRepo(
  cwd: string,
  deps: AttributionDeps = {},
): string | null {
  return (deps.gitRoot ?? defaultGitRoot)(cwd);
}

/** Is the session's attribution caught up with its latest cwd-repo edits? */
export function isSessionAttributionCaughtUp(
  sessionId: string,
  cwdRepo: string,
  deps: AttributionDeps = {},
): boolean {
  return pendingAttributionFiles(sessionId, cwdRepo, deps).length === 0;
}

/**
 * Block until the session's attribution is caught up with its latest cwd-repo
 * edits, or the bounded ceiling elapses — whichever comes first. BOUNDED and
 * FAIL-OPEN by construction: a wedged/slow git producer can never hang
 * commit-work; on ceiling expiry this simply returns and the caller falls back
 * to its existing on-hook ∩ live read (the pre-`.1` behavior). Returns `true`
 * if the session converged within the ceiling, `false` on a fail-open timeout.
 *
 * The first check happens immediately (no initial sleep), so the steady-state
 * common case — already caught up — pays zero wait. Only a genuinely-lagging
 * session polls keeper.db read-only every `pollMs` until the `.1` poll producer
 * scans + folds a GitSnapshot covering the edit.
 */
export async function waitForAttributionCaughtUp(
  sessionId: string,
  cwdRepo: string,
  deps: AttributionDeps = {},
  opts: AttributionWaitOpts = {},
): Promise<boolean> {
  const ceilingMs = opts.ceilingMs ?? DEFAULT_ATTRIBUTION_WAIT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_ATTRIBUTION_POLL_MS;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const deadline = now() + ceilingMs;
  for (;;) {
    if (isSessionAttributionCaughtUp(sessionId, cwdRepo, deps)) return true;
    if (now() >= deadline) return false;
    // Don't sleep past the deadline.
    const remaining = deadline - now();
    await sleep(Math.min(pollMs, Math.max(0, remaining)));
    if (now() >= deadline) {
      // One final check after the last sleep so a fold that landed during the
      // sleep is observed rather than reported as a timeout.
      return isSessionAttributionCaughtUp(sessionId, cwdRepo, deps);
    }
  }
}
