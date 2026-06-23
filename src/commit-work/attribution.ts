/**
 * Session dirty-file attribution reader — the native TypeScript port of
 * keeper-py's `get_session_dirty_files` (keeper/api.py:392).
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
 * Two deliberate differences from the Python:
 *  - Reads keeper's DB DIRECTLY via `openDb({ readonly: true })` instead of the
 *    keeper-py reader. keeper owns the schema in this same binary, so there is
 *    NO `SUPPORTED_SCHEMA_VERSIONS` re-assertion — a hardcoded TS whitelist
 *    would self-reject the instant `SCHEMA_VERSION` bumps.
 *  - Board-dir exclusion is NOT done in {@link getSessionDirtyFiles} (it
 *    matches the Python's exclusion-agnostic shape exactly, for parity tests);
 *    the client-side partition lives in {@link discoverSessionFiles}, which
 *    selects the cwd's repo and drops `.keeper/` board paths (they commit via
 *    the plan-commit hook, not commit-work).
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
