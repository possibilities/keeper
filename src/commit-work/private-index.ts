import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GIT_LOCAL_TIMEOUT_MS, type GitRunner } from "./git-exec";

export type GitPathKind = "file" | "symlink" | "gitlink" | "absent";

export interface GitPathEntry {
  path: string;
  kind: GitPathKind;
  oid: string | null;
  mode: string | null;
  /** Deletions carry the expected parent entry as their positive identity. */
  expectedBase?: {
    kind: Exclude<GitPathKind, "absent">;
    oid: string;
    mode: string;
  } | null;
}

export interface FrozenPrivateIndex {
  dir: string;
  indexPath: string;
  expectedHead: string | null;
  branchRef: string;
  tree: string;
  entries: GitPathEntry[];
  paths: string[];
}

export type PrivateIndexErrorCode =
  | "detached_head"
  | "head_read_failed"
  | "index_seed_failed"
  | "stage_failed"
  | "directory_file_conflict"
  | "tree_write_failed"
  | "surface_changed"
  | "ref_conflict"
  | "operation_in_progress"
  | "initial_commit_unsupported"
  | "commit_failed"
  | "commit_signing_failed"
  | "commit_hook_mutated";

export class PrivateIndexError extends Error {
  readonly code: PrivateIndexErrorCode;
  readonly stderr: string;
  readonly commitSha?: string;
  readonly operation?: string;
  readonly committed: boolean;
  readonly indeterminate: boolean;
  readonly paths?: string[];

  constructor(
    code: PrivateIndexErrorCode,
    stderr = "",
    details: {
      commitSha?: string;
      operation?: string;
      committed?: boolean;
      indeterminate?: boolean;
      paths?: string[];
    } = {},
  ) {
    super(code);
    this.name = "PrivateIndexError";
    this.code = code;
    this.stderr = stderr;
    this.commitSha = details.commitSha;
    this.operation = details.operation;
    this.committed = details.committed ?? false;
    this.indeterminate = details.indeterminate ?? false;
    this.paths = details.paths;
  }
}

export interface PrivatePathInfo {
  kind: "file" | "symlink" | "directory" | "other" | "absent";
  executable?: boolean;
}

export interface PrivateIndexFs {
  makeTempDir?: () => string;
  removeTempDir?: (dir: string) => void;
  /** Deterministic internal commit marker seam for tests; production mints a UUID. */
  commitMarker?: () => string;
  /** Filesystem identity seam used by plumbing-only unit fixtures. */
  inspectPath?: (absolutePath: string) => PrivatePathInfo;
  /** Raw symlink-target seam; targets are blob bytes, never followed paths. */
  readLink?: (absolutePath: string) => Uint8Array;
  /** Complete index fingerprint seam for plumbing-only unit fixtures. */
  fingerprintIndex?: (indexPath: string) => string;
  /** Canonical target-worktree index path seam for plumbing-only fixtures. */
  targetIndexPath?: (worktree: string) => string;
}

export interface PrivateCommitGuards {
  /** Original-worktree operation probe, run both before and after commit hooks. */
  beforeCommit?: () => Promise<string | null>;
  /** Caller-owned evidence validation, run after every commit hook. */
  validateOwnership?: () => Promise<void>;
  /** Validated invocation UUID to add as the internal Job-Id trailer. */
  jobId?: string | null;
}

export interface PostCommitHookWarning {
  code: "post_commit_hook_failed";
  stderr: string;
}

export interface PrivateCommitResult {
  sha: string;
  tree: string;
  postCommitHookWarning?: PostCommitHookWarning;
}

export interface AmbientReconcileWarning {
  code: "checkout_changed" | "reconcile_failed";
  detail?: string;
}

export type AmbientReconcileResult =
  | { reconciled: true }
  | { reconciled: false; warning: AmbientReconcileWarning };

function kindForMode(mode: string): Exclude<GitPathKind, "absent"> {
  if (mode === "120000") return "symlink";
  if (mode === "160000") return "gitlink";
  return "file";
}

function privateRunner(
  git: GitRunner,
  indexPath: string,
  worktree: string,
): GitRunner {
  return (args, options = {}) =>
    git(args, {
      ...options,
      cwd: options.cwd ?? worktree,
      env: {
        ...(options.env ?? {}),
        GIT_INDEX_FILE: indexPath,
        GIT_NO_REPLACE_OBJECTS: "1",
      },
    });
}

function parseTreeEntries(raw: string): Map<string, GitPathEntry> {
  const entries = new Map<string, GitPathEntry>();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    // A tree is not an index entry. `ls-tree <tree> -- dir` reports the tree
    // object itself, so ignoring it is required for directory -> file changes.
    if (!mode || !oid || !path || type === "tree" || mode === "040000")
      continue;
    entries.set(path, { path, kind: kindForMode(mode), oid, mode });
  }
  return entries;
}

async function baseEntriesByPath(
  paths: string[],
  treeish: string | null,
  worktree: string,
  git: GitRunner,
): Promise<Map<string, GitPathEntry>> {
  if (treeish === null || paths.length === 0) return new Map();
  const result = await git(["ls-tree", "-z", treeish, "--", ...paths], {
    cwd: worktree,
    env: { GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (result.code !== 0) {
    throw new PrivateIndexError("head_read_failed", result.stderr);
  }
  const selected = new Set(paths);
  return new Map(
    [...parseTreeEntries(result.stdout)].filter(([path]) => selected.has(path)),
  );
}

async function allTrackedPaths(
  treeish: string | null,
  worktree: string,
  git: GitRunner,
): Promise<string[]> {
  if (treeish === null) return [];
  const result = await git(["ls-tree", "-r", "-z", "--full-tree", treeish], {
    cwd: worktree,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (result.code !== 0) {
    throw new PrivateIndexError("head_read_failed", result.stderr);
  }
  return [...parseTreeEntries(result.stdout).keys()].sort();
}

function absentEntry(
  path: string,
  base: GitPathEntry | undefined,
): GitPathEntry {
  return {
    path,
    kind: "absent",
    oid: null,
    mode: null,
    expectedBase:
      base?.oid && base.mode
        ? {
            kind: base.kind as Exclude<GitPathKind, "absent">,
            oid: base.oid,
            mode: base.mode,
          }
        : null,
  };
}

function inspectLivePath(
  absolutePath: string,
  fs: PrivateIndexFs,
): PrivatePathInfo {
  if (fs.inspectPath) return fs.inspectPath(absolutePath);
  try {
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return { kind: "symlink" };
    if (stat.isFile()) {
      return { kind: "file", executable: (stat.mode & 0o111) !== 0 };
    }
    if (stat.isDirectory()) return { kind: "directory" };
    return { kind: "other" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    throw new PrivateIndexError(
      "stage_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function honorsExecutableBit(
  worktree: string,
  git: GitRunner,
): Promise<boolean> {
  const result = await git(["config", "--bool", "core.filemode"], {
    cwd: worktree,
  });
  return result.code !== 0 || result.stdout.trim() !== "false";
}

async function hashLiveBlob(
  path: string,
  kind: "file" | "symlink",
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
): Promise<string> {
  // `hash-object` takes an exact file operand, not a pathspec. `--path` applies
  // Git's clean/eol attributes for ordinary files. A symlink operand would be
  // followed by hash-object, so feed its raw target bytes through stdin instead.
  let result: { code: number; stdout: string; stderr: string };
  if (kind === "symlink") {
    let target: Uint8Array;
    try {
      target =
        fs.readLink?.(resolve(worktree, path)) ??
        readlinkSync(resolve(worktree, path), { encoding: "buffer" });
    } catch (error) {
      throw new PrivateIndexError(
        "stage_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
    result = await git(["hash-object", "-w", "--stdin"], {
      cwd: worktree,
      stdin: target,
    });
  } else {
    result = await git(["hash-object", "-w", `--path=${path}`, "--", path], {
      cwd: worktree,
    });
  }
  const oid = result.stdout.trim();
  if (result.code !== 0 || !/^[0-9a-fA-F]{40,64}$/.test(oid)) {
    throw new PrivateIndexError("stage_failed", result.stderr);
  }
  return oid;
}

async function buildLiveEntries(
  paths: string[],
  base: Map<string, GitPathEntry>,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
): Promise<GitPathEntry[]> {
  let fileMode: boolean | null = null;
  const entries: GitPathEntry[] = [];
  for (const path of [...paths].sort()) {
    const old = base.get(path);
    const live = inspectLivePath(resolve(worktree, path), fs);
    if (live.kind === "absent") {
      entries.push(absentEntry(path, old));
      continue;
    }
    if (live.kind === "directory") {
      // Ordinary directories have no index identity. A selected path which was
      // a file is therefore its exact deletion; collision preflight separately
      // requires every dirty descendant to be selected before that conversion.
      if (old?.mode !== "160000") {
        entries.push(absentEntry(path, old));
        continue;
      }
      const nestedWorktree = resolve(worktree, path);
      const nestedDir = await git(
        ["rev-parse", "--resolve-git-dir", join(nestedWorktree, ".git")],
        { cwd: worktree },
      );
      const gitDir = nestedDir.stdout.trim();
      if (nestedDir.code !== 0 || gitDir.length === 0) {
        throw new PrivateIndexError("stage_failed", nestedDir.stderr);
      }
      const nested = await git(
        [`--git-dir=${gitDir}`, "rev-parse", "--verify", "HEAD^{commit}"],
        { cwd: nestedWorktree },
      );
      const oid = nested.stdout.trim();
      if (nested.code !== 0 || !/^[0-9a-fA-F]{40,64}$/.test(oid)) {
        throw new PrivateIndexError("stage_failed", nested.stderr);
      }
      entries.push({ path, kind: "gitlink", oid, mode: "160000" });
      continue;
    }
    if (live.kind === "other") {
      throw new PrivateIndexError(
        "stage_failed",
        `unsupported filesystem entry: ${path}`,
      );
    }

    const oid = await hashLiveBlob(path, live.kind, worktree, git, fs);
    if (live.kind === "symlink") {
      entries.push({ path, kind: "symlink", oid, mode: "120000" });
      continue;
    }
    if (fileMode === null) fileMode = await honorsExecutableBit(worktree, git);
    const mode =
      !fileMode && old?.kind === "file" && old.mode !== null
        ? old.mode
        : live.executable
          ? "100755"
          : "100644";
    entries.push({ path, kind: "file", oid, mode });
  }
  return entries;
}

function pathAfterTokens(record: string, count: number): string | null {
  let at = 0;
  let spaces = 0;
  while (at < record.length && spaces < count) {
    if (record[at] === " ") spaces += 1;
    at += 1;
  }
  const path = record.slice(at);
  return path.length > 0 ? path : null;
}

function dirtyPathsFromStatus(raw: string): string[] {
  const paths = new Set<string>();
  const records = raw.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record) continue;
    if (record[0] === "1") {
      const path = pathAfterTokens(record, 8);
      if (path) paths.add(path);
    } else if (record[0] === "2") {
      const path = pathAfterTokens(record, 9);
      const original = records[i + 1];
      if (path) paths.add(path);
      if (original) {
        paths.add(original);
        i += 1;
      }
    } else if (record[0] === "u") {
      const path = pathAfterTokens(record, 10);
      if (path) paths.add(path);
    } else if (record[0] === "?" || record[0] === "!") {
      const path = record.slice(2);
      if (path) paths.add(path);
    }
  }
  return [...paths].sort();
}

function hasDirectoryRelationship(a: string, b: string): boolean {
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Adding one side of a D/F conversion makes update-index evict the other side.
 * Require every dirty or parent-tracked path in that implicit expansion to be
 * named by selection, so no recursive path effect can silently enter the tree.
 */
async function preflightDirectoryFileCollisions(
  selectedPaths: string[],
  entries: GitPathEntry[],
  expectedHead: string | null,
  worktree: string,
  git: GitRunner,
): Promise<void> {
  const selected = new Set(selectedPaths);
  const [tracked, status] = await Promise.all([
    allTrackedPaths(expectedHead, worktree, git),
    git(["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
      cwd: worktree,
    }),
  ]);
  if (status.code !== 0) {
    throw new PrivateIndexError("stage_failed", status.stderr);
  }
  const dirty = dirtyPathsFromStatus(status.stdout);
  const missing = new Set<string>();

  // A non-absent entry cannot coexist in an index with a tracked ancestor or
  // descendant. update-index would remove those entries as an implicit side
  // effect, so each one must be explicitly selected.
  for (const entry of entries) {
    if (entry.kind === "absent") continue;
    for (const trackedPath of tracked) {
      if (
        trackedPath !== entry.path &&
        hasDirectoryRelationship(trackedPath, entry.path) &&
        !selected.has(trackedPath)
      ) {
        missing.add(trackedPath);
      }
    }
  }

  // Porcelain with `--untracked-files=all` exposes both sides of a live D/F
  // conversion. Prefix-related dirty paths form one atomic selection unit.
  for (const dirtyPath of dirty) {
    if (selected.has(dirtyPath)) continue;
    if (
      selectedPaths.some(
        (selectedPath) =>
          selectedPath !== dirtyPath &&
          hasDirectoryRelationship(selectedPath, dirtyPath),
      )
    ) {
      missing.add(dirtyPath);
    }
  }

  if (missing.size > 0) {
    const paths = [...missing].sort();
    throw new PrivateIndexError(
      "directory_file_conflict",
      `directory/file conversion requires explicit selection: ${paths.join(
        ", ",
      )}`,
      { paths },
    );
  }
}

async function zeroObjectId(
  entries: GitPathEntry[],
  expectedHead: string | null,
  worktree: string,
  git: GitRunner,
): Promise<string> {
  const example =
    entries.find((entry) => entry.oid !== null)?.oid ??
    entries.find((entry) => entry.expectedBase?.oid)?.expectedBase?.oid ??
    expectedHead;
  if (example && (example.length === 40 || example.length === 64)) {
    return "0".repeat(example.length);
  }
  const format = await git(["rev-parse", "--show-object-format"], {
    cwd: worktree,
  });
  return "0".repeat(
    format.code === 0 && format.stdout.trim() === "sha256" ? 64 : 40,
  );
}

async function updateExactEntries(
  entries: GitPathEntry[],
  expectedHead: string | null,
  worktree: string,
  git: GitRunner,
): Promise<void> {
  if (entries.length === 0) return;
  const zero = await zeroObjectId(entries, expectedHead, worktree, git);
  // Deletions precede additions so both directions of an explicitly complete
  // D/F conversion satisfy the index invariant without recursive path actions.
  const ordered = [...entries].sort((a, b) => {
    const absent = Number(b.kind === "absent") - Number(a.kind === "absent");
    return absent || a.path.localeCompare(b.path);
  });
  const input = ordered
    .map((entry) =>
      entry.kind === "absent"
        ? `0 ${zero} 0\t${entry.path}\0`
        : `${entry.mode} ${entry.oid} 0\t${entry.path}\0`,
    )
    .join("");
  const result = await git(["update-index", "-z", "--index-info"], {
    cwd: worktree,
    stdin: new TextEncoder().encode(input),
  });
  if (result.code !== 0) {
    throw new PrivateIndexError("stage_failed", result.stderr);
  }
}

async function writeTree(worktree: string, run: GitRunner): Promise<string> {
  const result = await run(["write-tree"], { cwd: worktree });
  const tree = result.stdout.trim();
  if (result.code !== 0 || tree.length === 0) {
    throw new PrivateIndexError("tree_write_failed", result.stderr);
  }
  return tree;
}

async function capturedHead(
  branchRef: string,
  worktree: string,
  git: GitRunner,
): Promise<string | null> {
  const head = await git(["rev-parse", "--verify", `${branchRef}^{commit}`], {
    cwd: worktree,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();

  // Distinguish an unborn symbolic branch from an ambiguous object/ref read.
  const exists = await git(["show-ref", "--verify", "--quiet", branchRef], {
    cwd: worktree,
  });
  if (exists.code === 1) return null;
  throw new PrivateIndexError("head_read_failed", head.stderr || exists.stderr);
}

async function stagedNamesAgainstExpected(
  expectedHead: string | null,
  worktree: string,
  run: GitRunner,
): Promise<string[]> {
  if (expectedHead === null) return [];
  const result = await run(
    [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=ACDMRT",
      expectedHead,
      "--",
    ],
    { cwd: worktree },
  );
  if (result.code !== 0) {
    throw new PrivateIndexError("stage_failed", result.stderr);
  }
  return result.stdout.split("\0").filter(Boolean).sort();
}

function samePathSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((path, index) => path === right[index]);
}

async function requireExactStagedSet(
  expectedPaths: string[],
  expectedHead: string | null,
  worktree: string,
  run: GitRunner,
): Promise<void> {
  if (expectedHead === null) return;
  const staged = await stagedNamesAgainstExpected(expectedHead, worktree, run);
  if (!samePathSet(staged, expectedPaths)) {
    const expected = new Set(expectedPaths);
    const actual = new Set(staged);
    const extras = staged.filter((path) => !expected.has(path));
    const missing = expectedPaths.filter((path) => !actual.has(path));
    throw new PrivateIndexError(
      "stage_failed",
      `frozen staged set differs from selection (extras: ${extras.join(
        ", ",
      )}; missing: ${missing.join(", ")})`,
      { paths: [...new Set([...extras, ...missing])].sort() },
    );
  }
}

/** Build an isolated index from the expected parent using exact index entries. */
export async function createFrozenPrivateIndex(
  worktree: string,
  paths: string[],
  git: GitRunner,
  fs: PrivateIndexFs = {},
): Promise<FrozenPrivateIndex> {
  const makeTempDir =
    fs.makeTempDir ??
    (() => mkdtempSync(join(tmpdir(), "keeper-commit-work-")));
  const removeTempDir =
    fs.removeTempDir ??
    ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  const dir = makeTempDir();
  const indexPath = join(dir, "index");
  const run = privateRunner(git, indexPath, worktree);
  try {
    const symbolic = await git(["symbolic-ref", "-q", "HEAD"], {
      cwd: worktree,
    });
    const branchRef = symbolic.stdout.trim();
    if (symbolic.code !== 0 || branchRef.length === 0) {
      throw new PrivateIndexError("detached_head", symbolic.stderr);
    }

    const expectedHead = await capturedHead(branchRef, worktree, git);
    const seed = await run(
      expectedHead === null
        ? ["read-tree", "--empty"]
        : ["read-tree", expectedHead],
      { cwd: worktree },
    );
    if (seed.code !== 0) {
      throw new PrivateIndexError("index_seed_failed", seed.stderr);
    }
    const baseTree = await writeTree(worktree, run);
    const selectedPaths = [...new Set(paths)].sort();
    const base = await baseEntriesByPath(
      selectedPaths,
      expectedHead,
      worktree,
      git,
    );
    const entries = await buildLiveEntries(
      selectedPaths,
      base,
      worktree,
      git,
      fs,
    );
    await preflightDirectoryFileCollisions(
      selectedPaths,
      entries,
      expectedHead,
      worktree,
      git,
    );
    await updateExactEntries(entries, expectedHead, worktree, run);
    await requireExactStagedSet(selectedPaths, expectedHead, worktree, run);
    const tree = await writeTree(worktree, run);
    if (tree === baseTree) throw new PrivateIndexError("surface_changed");

    return {
      dir,
      indexPath,
      expectedHead,
      branchRef,
      tree,
      entries,
      paths: selectedPaths,
    };
  } catch (error) {
    try {
      removeTempDir(dir);
    } catch {
      // Preserve the typed Git failure; cleanup is mandatory-best-effort.
    }
    throw error;
  }
}

function sameEntries(a: GitPathEntry[], b: GitPathEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Re-hash live exact paths and require byte/mode/tree/index identity stability. */
export async function verifyFrozenSurface(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs = {},
): Promise<void> {
  const base = await baseEntriesByPath(
    frozen.paths,
    frozen.expectedHead,
    worktree,
    git,
  );
  const entries = await buildLiveEntries(frozen.paths, base, worktree, git, fs);
  const privateGit = privateRunner(git, frozen.indexPath, worktree);
  const tree = await writeTree(worktree, privateGit);
  await requireExactStagedSet(
    frozen.paths,
    frozen.expectedHead,
    worktree,
    privateGit,
  );
  if (tree !== frozen.tree || !sameEntries(entries, frozen.entries)) {
    throw new PrivateIndexError("surface_changed");
  }
}

export function privateIndexGit(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
): GitRunner {
  return privateRunner(git, frozen.indexPath, worktree);
}

/** Read exact stage-0 entries from a frozen tree, never descendants. */
export async function exactEntriesFromTree(
  paths: string[],
  treeish: string | null,
  worktree: string,
  git: GitRunner,
): Promise<GitPathEntry[]> {
  const base = await baseEntriesByPath(paths, treeish, worktree, git);
  return [...paths]
    .sort()
    .map((path) => base.get(path) ?? absentEntry(path, undefined));
}

function indexPaths(raw: string): string[] {
  const paths: string[] = [];
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab >= 0) paths.push(record.slice(tab + 1));
  }
  return paths;
}

/** Replace/remove only the named ambient index entries via NUL-safe plumbing. */
export async function reconcileAmbientIndexEntries(
  entries: GitPathEntry[],
  expectedHead: string | null,
  worktree: string,
  git: GitRunner,
): Promise<void> {
  // Adding an exact file entry causes Git to evict an indexed ancestor or all
  // indexed descendants. Refuse when any such path is foreign to selection.
  const current = await git(["ls-files", "-s", "-z"], { cwd: worktree });
  if (current.code !== 0) {
    throw new PrivateIndexError("stage_failed", current.stderr);
  }
  const selected = new Set(entries.map((entry) => entry.path));
  const foreign = indexPaths(current.stdout).filter(
    (path) => !selected.has(path),
  );
  for (const entry of entries) {
    if (entry.kind === "absent") continue;
    if (
      foreign.some(
        (path) =>
          path.startsWith(`${entry.path}/`) ||
          entry.path.startsWith(`${path}/`),
      )
    ) {
      throw new PrivateIndexError(
        "directory_file_conflict",
        `ambient index directory/file conflict at ${entry.path}`,
        { paths: [entry.path] },
      );
    }
  }
  await updateExactEntries(entries, expectedHead, worktree, git);
}

/**
 * Reconcile only when the checkout still names the captured target at the
 * published commit. A branch/checkout race becomes a warning; it never triggers
 * a reset against an unrelated index.
 */
export async function reconcileAmbientAfterPublication(
  frozen: FrozenPrivateIndex,
  commitSha: string,
  worktree: string,
  git: GitRunner,
): Promise<AmbientReconcileResult> {
  const [symbolic, head] = await Promise.all([
    git(["symbolic-ref", "-q", "HEAD"], { cwd: worktree }),
    git(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: worktree,
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    }),
  ]);
  if (
    symbolic.code !== 0 ||
    symbolic.stdout.trim() !== frozen.branchRef ||
    head.code !== 0 ||
    head.stdout.trim() !== commitSha
  ) {
    return {
      reconciled: false,
      warning: {
        code: "checkout_changed",
        detail:
          "checkout changed after publication; ambient index was left untouched",
      },
    };
  }
  try {
    await reconcileAmbientIndexEntries(
      frozen.entries,
      frozen.expectedHead,
      worktree,
      git,
    );
    return { reconciled: true };
  } catch (error) {
    return {
      reconciled: false,
      warning: {
        code: "reconcile_failed",
        detail:
          error instanceof PrivateIndexError
            ? error.stderr || error.code
            : error instanceof Error
              ? error.message
              : String(error),
      },
    };
  }
}

async function currentRef(
  frozen: Pick<FrozenPrivateIndex, "branchRef">,
  worktree: string,
  git: GitRunner,
): Promise<string | undefined> {
  const result = await git(
    ["rev-parse", "--verify", `${frozen.branchRef}^{commit}`],
    { cwd: worktree, env: { GIT_NO_REPLACE_OBJECTS: "1" } },
  );
  return result.code === 0 && result.stdout.trim()
    ? result.stdout.trim()
    : undefined;
}

interface ParsedCommit {
  parents: string[];
  tree: string;
}

function parseCommitObject(raw: string): ParsedCommit | null {
  const separator = raw.indexOf("\n\n");
  if (separator < 0) return null;
  const headers = raw.slice(0, separator).split("\n");
  const trees = headers
    .filter((line) => line.startsWith("tree "))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (trees.length !== 1 || !trees[0]) return null;
  const parents = headers
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice(7).trim())
    .filter(Boolean);
  return { parents, tree: trees[0] };
}

const INTERNAL_TRAILER_RE = /^(?:Job-Id|Keeper-Commit-Id):/im;

async function completeCommitMessage(
  message: string,
  marker: string,
  jobId: string | null | undefined,
  worktree: string,
  git: GitRunner,
): Promise<string> {
  if (INTERNAL_TRAILER_RE.test(message)) {
    throw new PrivateIndexError(
      "commit_failed",
      "commit message forges an internal Keeper trailer",
    );
  }
  // Both internal trailers are prepared by this single invocation. Existing
  // Task trailers pass through interpret-trailers unchanged.
  const args = ["interpret-trailers"];
  if (jobId) args.push("--trailer", `Job-Id: ${jobId}`);
  args.push("--trailer", `Keeper-Commit-Id: ${marker}`);
  const rendered = await git(args, {
    cwd: worktree,
    stdin: new TextEncoder().encode(`${message.replace(/\n+$/, "")}\n`),
  });
  if (rendered.code !== 0 || rendered.stdout.length === 0) {
    throw new PrivateIndexError("commit_failed", rendered.stderr);
  }
  return rendered.stdout;
}

interface MessageTrailers {
  jobIds: string[];
  keeperIds: string[];
  tasks: string[];
}

function messageTrailers(message: string): MessageTrailers {
  const result: MessageTrailers = { jobIds: [], keeperIds: [], tasks: [] };
  const lines = message.split(/\r?\n/);
  while (lines.at(-1)?.trim() === "") lines.pop();

  // Parse only the final contiguous token/value block. An internal-looking line
  // moved into the message body is not a trailer and must fail integrity checks.
  let start = lines.length;
  while (start > 0) {
    const line = lines[start - 1] ?? "";
    if (/^[A-Za-z0-9-]+:[ \t]*/.test(line)) {
      start -= 1;
      continue;
    }
    if (/^[ \t]+/.test(line) && start < lines.length) {
      start -= 1;
      continue;
    }
    break;
  }
  if (start === lines.length) return result;
  if (start > 0 && lines[start - 1]?.trim() !== "") return result;

  for (const line of lines.slice(start)) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = match[2]?.trim() ?? "";
    if (key === "job-id") result.jobIds.push(value);
    else if (key === "keeper-commit-id") result.keeperIds.push(value);
    else if (key === "task") result.tasks.push(value);
  }
  return result;
}

function assertMessageIntegrity(
  message: string,
  marker: string,
  jobId: string | null | undefined,
  expectedTasks: string[],
): void {
  const trailers = messageTrailers(message);
  const jobOk = jobId
    ? trailers.jobIds.length === 1 && trailers.jobIds[0] === jobId
    : trailers.jobIds.length === 0;
  const keeperOk =
    trailers.keeperIds.length === 1 && trailers.keeperIds[0] === marker;
  const remainingTasks = [...trailers.tasks];
  const tasksOk = expectedTasks.every((task) => {
    const index = remainingTasks.indexOf(task);
    if (index < 0) return false;
    remainingTasks.splice(index, 1);
    return true;
  });
  if (!jobOk || !keeperOk || !tasksOk) {
    throw new PrivateIndexError(
      "commit_hook_mutated",
      "commit message hook removed or changed required trailers",
    );
  }
}

async function worktreeSnapshot(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
): Promise<string> {
  const run = privateRunner(git, frozen.indexPath, worktree);
  const [tracked, untracked, ambientIndex] = await Promise.all([
    run(["diff-files", "--name-only", "-z", "--"], { cwd: worktree }),
    run(["ls-files", "--others", "--exclude-standard", "-z", "--"], {
      cwd: worktree,
    }),
    git(["ls-files", "--stage", "-z"], { cwd: worktree }),
  ]);
  if (tracked.code !== 0 || untracked.code !== 0 || ambientIndex.code !== 0) {
    throw new PrivateIndexError(
      "commit_failed",
      tracked.stderr || untracked.stderr || ambientIndex.stderr,
    );
  }
  const paths = [
    ...new Set([
      ...frozen.paths,
      ...tracked.stdout.split("\0").filter(Boolean),
      ...untracked.stdout.split("\0").filter(Boolean),
    ]),
  ].sort();
  const base = await baseEntriesByPath(
    paths,
    frozen.expectedHead,
    worktree,
    git,
  );
  const entries = await buildLiveEntries(paths, base, worktree, git, fs);
  return JSON.stringify({
    tracked: tracked.stdout.split("\0").filter(Boolean).sort(),
    untracked: untracked.stdout.split("\0").filter(Boolean).sort(),
    ambientIndex: ambientIndex.stdout,
    entries,
  });
}

async function verifyHookBoundary(
  frozen: FrozenPrivateIndex,
  baseline: string,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
): Promise<void> {
  try {
    await verifyFrozenSurface(frozen, worktree, git, fs);
    if ((await worktreeSnapshot(frozen, worktree, git, fs)) !== baseline) {
      throw new PrivateIndexError("surface_changed");
    }
  } catch (error) {
    const detail =
      error instanceof PrivateIndexError ? error.stderr : String(error);
    throw new PrivateIndexError("commit_hook_mutated", detail);
  }
}

function targetGitEnvironment(
  frozen: FrozenPrivateIndex,
): Record<string, string> {
  // Keep cwd-based discovery in the original target worktree. In particular,
  // worktree-scoped config, hooks, identity, and signing must not be redirected
  // through a synthetic administrative directory.
  return {
    GIT_INDEX_FILE: frozen.indexPath,
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

function stableIndexMetadata(stat: BigIntStats): string {
  return [
    stat.dev,
    stat.ino,
    stat.mode,
    stat.nlink,
    stat.uid,
    stat.gid,
    stat.rdev,
    stat.size,
    stat.blksize,
    stat.blocks,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ]
    .map(String)
    .join(":");
}

function fingerprintIndexFile(indexPath: string, fs: PrivateIndexFs): string {
  if (fs.fingerprintIndex) return fs.fingerprintIndex(indexPath);

  const fd = openSync(indexPath, "r");
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("private index is not a file");
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const pathStat = lstatSync(indexPath, { bigint: true });
    const beforeMetadata = stableIndexMetadata(before);
    const afterMetadata = stableIndexMetadata(after);
    if (
      beforeMetadata !== afterMetadata ||
      afterMetadata !== stableIndexMetadata(pathStat)
    ) {
      throw new Error("private index changed while it was fingerprinted");
    }
    return `${afterMetadata}\0${bytes.toString("base64")}`;
  } finally {
    closeSync(fd);
  }
}

async function targetWorktreeIndexPath(
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
): Promise<string> {
  if (fs.targetIndexPath) return fs.targetIndexPath(worktree);
  const found = await git(["rev-parse", "--git-path", "index"], {
    cwd: worktree,
    env: { GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (found.code !== 0 || found.stdout.trim() === "") {
    throw new PrivateIndexError("commit_failed", found.stderr);
  }
  try {
    return realpathSync(resolve(worktree, found.stdout.trim()));
  } catch (error) {
    throw new PrivateIndexError(
      "commit_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function signingArgs(
  worktree: string,
  git: GitRunner,
  targetEnv: Record<string, string>,
): Promise<{ args: string[]; enabled: boolean }> {
  const configured = await git(
    ["config", "--bool", "--get", "commit.gpgSign"],
    { cwd: worktree, env: targetEnv },
  );
  if (configured.code === 1) return { args: [], enabled: false };
  if (configured.code !== 0) {
    throw new PrivateIndexError("commit_failed", configured.stderr);
  }
  const enabled = configured.stdout.trim() === "true";
  // `commit-tree -S` delegates key and format selection to user.signingKey,
  // gpg.format, gpg.ssh.* and the rest of Git's normal signing configuration.
  return { args: enabled ? ["-S"] : [], enabled };
}

async function runCommitHook(
  name: "pre-commit" | "prepare-commit-msg" | "commit-msg",
  args: string[],
  hookEnv: Record<string, string>,
  frozen: FrozenPrivateIndex,
  baseline: string,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
  targetIndexPath: string,
  targetIndexBaseline: string,
): Promise<void> {
  let indexBefore: string;
  try {
    indexBefore = fingerprintIndexFile(frozen.indexPath, fs);
  } catch (error) {
    throw new PrivateIndexError(
      "commit_failed",
      error instanceof Error ? error.message : String(error),
    );
  }

  const hook = await git(
    [
      "hook",
      "run",
      "--ignore-missing",
      name,
      ...(args.length ? ["--", ...args] : []),
    ],
    {
      cwd: worktree,
      env: hookEnv,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    },
  );
  // Inspect the exact file before any later Git command can normalize index
  // flags or extensions. Byte-identical trees do not cover skip-worktree,
  // assume-unchanged, split-index state, or arbitrary index extensions.
  let indexAfter: string;
  try {
    indexAfter = fingerprintIndexFile(frozen.indexPath, fs);
  } catch (error) {
    throw new PrivateIndexError(
      "commit_hook_mutated",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (indexAfter !== indexBefore) {
    throw new PrivateIndexError(
      "commit_hook_mutated",
      "commit hook changed the private index file",
    );
  }
  try {
    if (fingerprintIndexFile(targetIndexPath, fs) !== targetIndexBaseline) {
      throw new Error("commit hook changed the target worktree index file");
    }
  } catch (error) {
    throw new PrivateIndexError(
      "commit_hook_mutated",
      error instanceof Error ? error.message : String(error),
    );
  }

  // Mutation wins over a hook's exit code: publication must never happen when a
  // failing hook also changed the frozen index, live worktree, or target context.
  await verifyHookBoundary(frozen, baseline, worktree, git, fs);
  const target = await git(["symbolic-ref", "-q", "HEAD"], {
    cwd: worktree,
    env: hookEnv,
  });
  if (target.code !== 0 || target.stdout.trim() !== frozen.branchRef) {
    throw new PrivateIndexError(
      "commit_hook_mutated",
      "commit hook changed the captured branch context",
    );
  }
  if (hook.code !== 0) {
    throw new PrivateIndexError("commit_failed", hook.stderr);
  }
}

/**
 * Run commit hooks against the frozen index and captured branch context, create
 * one explicit commit object, then publish one compare-and-swap ref update.
 */
export async function commitFrozenPrivateIndex(
  frozen: FrozenPrivateIndex,
  message: string,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs = {},
  guards: PrivateCommitGuards = {},
): Promise<PrivateCommitResult> {
  if (frozen.expectedHead === null) {
    throw new PrivateIndexError("initial_commit_unsupported");
  }
  const before = await currentRef(frozen, worktree, git);
  if (before !== frozen.expectedHead) {
    throw new PrivateIndexError("ref_conflict");
  }

  const operation = await guards.beforeCommit?.();
  if (operation) {
    throw new PrivateIndexError("operation_in_progress", "", { operation });
  }

  await verifyFrozenSurface(frozen, worktree, git, fs);
  const marker = `keeper-commit-work:${(fs.commitMarker ?? randomUUID)()}`;
  const expectedTasks = messageTrailers(message).tasks;
  const completeMessage = await completeCommitMessage(
    message,
    marker,
    guards.jobId,
    worktree,
    git,
  );
  assertMessageIntegrity(completeMessage, marker, guards.jobId, expectedTasks);

  mkdirSync(frozen.dir, { recursive: true });
  const nonce = randomUUID();
  const messagePath = join(frozen.dir, `message-${nonce}`);
  writeFileSync(messagePath, completeMessage, { mode: 0o600 });

  try {
    const hookEnv = targetGitEnvironment(frozen);
    const baseline = await worktreeSnapshot(frozen, worktree, git, fs);
    const targetIndexPath = await targetWorktreeIndexPath(worktree, git, fs);
    let targetIndexBaseline: string;
    try {
      targetIndexBaseline = fingerprintIndexFile(targetIndexPath, fs);
    } catch (error) {
      throw new PrivateIndexError(
        "commit_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    await runCommitHook(
      "pre-commit",
      [],
      hookEnv,
      frozen,
      baseline,
      worktree,
      git,
      fs,
      targetIndexPath,
      targetIndexBaseline,
    );

    await runCommitHook(
      "prepare-commit-msg",
      [messagePath, "message"],
      hookEnv,
      frozen,
      baseline,
      worktree,
      git,
      fs,
      targetIndexPath,
      targetIndexBaseline,
    );
    let finalMessage = readFileSync(messagePath, "utf8");
    assertMessageIntegrity(finalMessage, marker, guards.jobId, expectedTasks);

    await runCommitHook(
      "commit-msg",
      [messagePath],
      hookEnv,
      frozen,
      baseline,
      worktree,
      git,
      fs,
      targetIndexPath,
      targetIndexBaseline,
    );
    finalMessage = readFileSync(messagePath, "utf8");
    assertMessageIntegrity(finalMessage, marker, guards.jobId, expectedTasks);

    const signing = await signingArgs(worktree, git, hookEnv);
    const finalOperation = await guards.beforeCommit?.();
    if (finalOperation) {
      throw new PrivateIndexError("operation_in_progress", "", {
        operation: finalOperation,
      });
    }
    await guards.validateOwnership?.();

    // Ownership validation is the final non-local boundary. From here through
    // compare-and-swap, perform only private filesystem reads and local Git
    // plumbing against the original target worktree context.
    const finalTarget = await git(["symbolic-ref", "-q", "HEAD"], {
      cwd: worktree,
      env: hookEnv,
    });
    if (
      finalTarget.code !== 0 ||
      finalTarget.stdout.trim() !== frozen.branchRef
    ) {
      throw new PrivateIndexError(
        "commit_hook_mutated",
        "target worktree changed the captured branch context",
      );
    }
    await verifyFrozenSurface(frozen, worktree, git, fs);
    finalMessage = readFileSync(messagePath, "utf8");
    assertMessageIntegrity(finalMessage, marker, guards.jobId, expectedTasks);

    const commit = await git(
      [
        "commit-tree",
        frozen.tree,
        "-p",
        frozen.expectedHead,
        "-F",
        messagePath,
        ...signing.args,
      ],
      {
        cwd: worktree,
        env: hookEnv,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      },
    );
    const sha = commit.stdout.trim().split(/\s+/)[0] ?? "";
    if (commit.code !== 0 || !/^[0-9a-fA-F]{40,64}$/.test(sha)) {
      throw new PrivateIndexError(
        signing.enabled ? "commit_signing_failed" : "commit_failed",
        commit.stderr,
      );
    }

    const object = await git(["cat-file", "commit", sha], {
      cwd: worktree,
      env: { GIT_NO_REPLACE_OBJECTS: "1" },
    });
    const parsed = object.code === 0 ? parseCommitObject(object.stdout) : null;
    if (parsed === null) {
      throw new PrivateIndexError("commit_failed", object.stderr, {
        commitSha: sha,
      });
    }
    if (
      parsed.parents.length !== 1 ||
      parsed.parents[0] !== frozen.expectedHead ||
      parsed.tree !== frozen.tree
    ) {
      throw new PrivateIndexError(
        "commit_failed",
        "unexpected commit identity",
        {
          commitSha: sha,
        },
      );
    }

    // A configured signer is executable and may mutate every caller-owned
    // surface. Re-run the operation, ownership, branch, selected-surface, and
    // raw target-index checks after commit-tree and immediately before CAS.
    const postCommitOperation = await guards.beforeCommit?.();
    if (postCommitOperation) {
      throw new PrivateIndexError("operation_in_progress", "", {
        operation: postCommitOperation,
        commitSha: sha,
      });
    }
    await guards.validateOwnership?.();
    const postCommitTarget = await git(["symbolic-ref", "-q", "HEAD"], {
      cwd: worktree,
      env: hookEnv,
    });
    if (
      postCommitTarget.code !== 0 ||
      postCommitTarget.stdout.trim() !== frozen.branchRef
    ) {
      throw new PrivateIndexError(
        "commit_hook_mutated",
        "target worktree changed the captured branch context",
        { commitSha: sha },
      );
    }
    await verifyFrozenSurface(frozen, worktree, git, fs);
    try {
      if (fingerprintIndexFile(targetIndexPath, fs) !== targetIndexBaseline) {
        throw new Error("target worktree index changed before publication");
      }
    } catch (error) {
      throw new PrivateIndexError(
        "commit_hook_mutated",
        error instanceof Error ? error.message : String(error),
        { commitSha: sha },
      );
    }

    const publish = await git(
      [
        "update-ref",
        "-m",
        "keeper commit-work: publish isolated commit",
        frozen.branchRef,
        sha,
        frozen.expectedHead,
      ],
      { cwd: worktree },
    );
    if (publish.code !== 0) {
      throw new PrivateIndexError("ref_conflict", publish.stderr, {
        commitSha: sha,
      });
    }

    let postCommitHookWarning: PostCommitHookWarning | undefined;
    try {
      const post = await git(
        ["hook", "run", "--ignore-missing", "post-commit"],
        {
          cwd: worktree,
          env: hookEnv,
          timeoutMs: GIT_LOCAL_TIMEOUT_MS,
        },
      );
      if (post.code !== 0) {
        postCommitHookWarning = {
          code: "post_commit_hook_failed",
          stderr: post.stderr,
        };
      }
    } catch (error) {
      postCommitHookWarning = {
        code: "post_commit_hook_failed",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      sha,
      tree: parsed.tree,
      ...(postCommitHookWarning ? { postCommitHookWarning } : {}),
    };
  } finally {
    // The message is private invocation state. The isolated index remains until
    // the caller's outer cleanup/reconciliation.
    try {
      rmSync(messagePath, { force: true });
    } catch {
      // Preserve the commit outcome.
    }
  }
}

export function cleanupPrivateIndex(
  frozen: Pick<FrozenPrivateIndex, "dir">,
  fs: PrivateIndexFs = {},
): void {
  const removeTempDir =
    fs.removeTempDir ??
    ((dir: string) => rmSync(dir, { recursive: true, force: true }));
  try {
    removeTempDir(frozen.dir);
  } catch {
    // Cleanup is mandatory-best-effort; retain the real commit outcome.
  }
}
