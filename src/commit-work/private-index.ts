import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  GIT_LOCAL_TIMEOUT_MS,
  GIT_OUTPUT_LIMIT_CODE,
  GIT_SPAWN_TIMEOUT_CODE,
  type GitRunner,
} from "./git-exec";
import { EXCLUDED_PREFIX } from "./surface";

export const MAX_COMMIT_MESSAGE_BYTES = 65_536;
const MAX_RENDERED_COMMIT_MESSAGE_BYTES = MAX_COMMIT_MESSAGE_BYTES + 4_096;
export const MAX_INDEX_FINGERPRINT_BYTES = 256 * 1_048_576;
const FINGERPRINT_CHUNK_BYTES = 64 * 1_024;
const MAX_WORKTREE_SNAPSHOT_PATHS = 100_000;
const MAX_WORKTREE_SNAPSHOT_BYTES = 1_024 * 1_048_576;
const MAX_WORKTREE_SNAPSHOT_PATH_BYTES = 4_096;
// Node omits O_CLOEXEC; establish it atomically on every fingerprint descriptor.
const O_CLOEXEC = process.platform === "darwin" ? 0x1000000 : 0o2000000;

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
  /** All-zero object id in this repository's hash format for create-only CAS. */
  zeroOid: string;
  branchRef: string;
  tree: string;
  entries: GitPathEntry[];
  paths: string[];
  /** Selection-scoped pre-lint context; Excluded-prefix runtime churn is omitted. */
  worktreeBaseline: string;
  /** Whole-tree context captured immediately before executable publication hooks. */
  worktreeHookBaseline: string;
  targetIndexPath: string;
  targetIndexBaseline: string;
  gitConfigBaseline: string;
  hookSetBaseline: string;
  signing: {
    args: string[];
    enabled: boolean;
    /** Command-scope overrides freezing signer selection/program policy. */
    config?: Record<string, string>;
  };
  /** update-ref hooks cannot be made atomic with Keeper's own CAS protocol. */
  referenceTransactionHookPresent?: boolean;
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
  | "commit_state_indeterminate"
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
  readonly attempts?: number;

  constructor(
    code: PrivateIndexErrorCode,
    stderr = "",
    details: {
      commitSha?: string;
      operation?: string;
      committed?: boolean;
      indeterminate?: boolean;
      paths?: string[];
      attempts?: number;
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
    this.attempts = details.attempts;
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
  /** Complete primary + split-companion fingerprint seam for unit fixtures. */
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
        // A private index must never reuse or rewrite the target worktree's
        // split-index companion during construction.
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.splitIndex",
        GIT_CONFIG_VALUE_0: "false",
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
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
  } else {
    result = await git(["hash-object", "-w", `--path=${path}`, "--", path], {
      cwd: worktree,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
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
      env: {
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_VALUE_0: "false",
      },
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
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
    if (!/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(baseTree)) {
      throw new PrivateIndexError("tree_write_failed", "invalid base tree id");
    }
    const selectedPaths = [...new Set(paths)].sort();
    const frozen: FrozenPrivateIndex = {
      dir,
      indexPath,
      expectedHead,
      zeroOid: "0".repeat(baseTree.length),
      branchRef,
      tree: "",
      entries: [],
      paths: selectedPaths,
      worktreeBaseline: "",
      worktreeHookBaseline: "",
      targetIndexPath: "",
      targetIndexBaseline: "",
      gitConfigBaseline: "",
      hookSetBaseline: "",
      signing: { args: [], enabled: false },
    };
    // Capture every caller-owned surface before `hash-object --path` can invoke
    // a configured clean filter. Construction may write only the private index
    // and object database; any worktree/ambient-index/config/hook side effect is
    // therefore a refusal, not a new accepted baseline.
    await refreshFrozenPublicationBaseline(frozen, worktree, git, fs);

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
    frozen.tree = tree;
    frozen.entries = entries;
    await requireFrozenPublicationBaseline(
      frozen,
      worktree,
      git,
      fs,
      "surface_changed",
    );
    return frozen;
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

async function verifyFrozenSelectedSurface(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
): Promise<void> {
  const base = await baseEntriesByPath(
    frozen.paths,
    frozen.expectedHead,
    worktree,
    git,
  );
  const entries = await buildLiveEntries(frozen.paths, base, worktree, git, fs);
  if (!sameEntries(entries, frozen.entries)) {
    throw new PrivateIndexError("surface_changed");
  }
}

/** Re-hash live exact paths and require byte/mode/tree/index identity stability. */
export async function verifyFrozenSurface(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs = {},
): Promise<void> {
  await verifyFrozenSelectedSurface(frozen, worktree, git, fs);
  const privateGit = privateRunner(git, frozen.indexPath, worktree);
  const tree = await writeTree(worktree, privateGit);
  await requireExactStagedSet(
    frozen.paths,
    frozen.expectedHead,
    worktree,
    privateGit,
  );
  if (tree !== frozen.tree) {
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
): Promise<string | null> {
  return await capturedHead(frozen.branchRef, worktree, git);
}

export interface FrozenHeadAdvance {
  kind: "non_overlapping" | "overlapping" | "not_advance" | "unchanged";
  head: string | null;
}

export async function classifyFrozenHeadAdvance(
  frozen: Pick<FrozenPrivateIndex, "branchRef" | "expectedHead" | "paths">,
  worktree: string,
  git: GitRunner,
): Promise<FrozenHeadAdvance> {
  const head = await currentRef(frozen, worktree, git);
  if (head === frozen.expectedHead) return { kind: "unchanged", head };
  if (head === null || frozen.expectedHead === null) {
    return { kind: "not_advance", head };
  }
  const ancestor = await git(
    ["merge-base", "--is-ancestor", frozen.expectedHead, head],
    { cwd: worktree, env: { GIT_NO_REPLACE_OBJECTS: "1" } },
  );
  if (ancestor.code !== 0) return { kind: "not_advance", head };
  const delta = await git(
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--diff-filter=ACDMRT",
      frozen.expectedHead,
      head,
      "--",
      ...frozen.paths,
    ],
    {
      cwd: worktree,
      env: { GIT_LITERAL_PATHSPECS: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    },
  );
  if (delta.code !== 0) return { kind: "not_advance", head };
  return {
    kind: delta.stdout.split("\0").some(Boolean)
      ? "overlapping"
      : "non_overlapping",
    head,
  };
}

export function sameFrozenSelectedIdentity(
  left: Pick<FrozenPrivateIndex, "entries">,
  right: Pick<FrozenPrivateIndex, "entries">,
): boolean {
  const identity = (entry: GitPathEntry) => [
    entry.path,
    entry.kind,
    entry.oid,
    entry.mode,
  ];
  return (
    JSON.stringify(left.entries.map(identity)) ===
    JSON.stringify(right.entries.map(identity))
  );
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

const AUTHORITY_TRAILER_RE =
  /^(?:Job-Id|Keeper-Commit-Id|Session-Id|Signed-off-by|Planctl-[A-Za-z]+):/im;

async function completeCommitMessage(
  message: string,
  marker: string,
  jobId: string | null | undefined,
  worktree: string,
  git: GitRunner,
): Promise<string> {
  if (
    message.includes("\0") ||
    Buffer.byteLength(message, "utf8") > MAX_COMMIT_MESSAGE_BYTES
  ) {
    throw new PrivateIndexError(
      "commit_failed",
      `commit message exceeds ${MAX_COMMIT_MESSAGE_BYTES} bytes or contains NUL`,
    );
  }
  if (AUTHORITY_TRAILER_RE.test(message)) {
    throw new PrivateIndexError(
      "commit_failed",
      "commit message forges a protected authority trailer",
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
  if (
    rendered.stdout.includes("\0") ||
    Buffer.byteLength(rendered.stdout, "utf8") >
      MAX_RENDERED_COMMIT_MESSAGE_BYTES
  ) {
    throw new PrivateIndexError(
      "commit_failed",
      `rendered commit message exceeds ${MAX_RENDERED_COMMIT_MESSAGE_BYTES} bytes or contains NUL`,
    );
  }
  return rendered.stdout;
}

function readBoundedHookMessage(messagePath: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(messagePath, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("commit message is not a regular file");
    if (stat.size > MAX_RENDERED_COMMIT_MESSAGE_BYTES) {
      throw new Error(
        `commit message exceeds ${MAX_RENDERED_COMMIT_MESSAGE_BYTES} bytes`,
      );
    }
    const bytes = Buffer.alloc(MAX_RENDERED_COMMIT_MESSAGE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_RENDERED_COMMIT_MESSAGE_BYTES) {
      throw new Error(
        `commit message exceeds ${MAX_RENDERED_COMMIT_MESSAGE_BYTES} bytes`,
      );
    }
    const message = bytes.subarray(0, offset).toString("utf8");
    if (message.includes("\0")) throw new Error("commit message contains NUL");
    return message;
  } catch (error) {
    throw new PrivateIndexError(
      "commit_hook_mutated",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The bounded bytes are already copied; preserve the typed outcome.
      }
    }
  }
}

interface MessageTrailers {
  jobIds: string[];
  keeperIds: string[];
  tasks: string[];
  /** Canonical multiset of every attribution/plan authority trailer. */
  protected: string[];
}

function isProtectedTrailerKey(key: string): boolean {
  return (
    key === "job-id" ||
    key === "keeper-commit-id" ||
    key === "task" ||
    key === "session-id" ||
    key === "signed-off-by" ||
    key.startsWith("planctl-")
  );
}

function messageTrailers(message: string): MessageTrailers {
  const result: MessageTrailers = {
    jobIds: [],
    keeperIds: [],
    tasks: [],
    protected: [],
  };
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

  const entries: Array<{ key: string; value: string }> = [];
  let current: { key: string; value: string } | null = null;
  for (const line of lines.slice(start)) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (match) {
      current = {
        key: (match[1] ?? "").toLowerCase(),
        value: match[2]?.trim() ?? "",
      };
      entries.push(current);
      continue;
    }
    if (/^[ \t]+/.test(line) && current !== null) {
      // Git unfolds continuation lines into their owning trailer value.
      const continuation = line.trim();
      if (continuation.length > 0) {
        current.value = `${current.value} ${continuation}`.trim();
      }
    }
  }

  for (const entry of entries) {
    if (entry.key === "job-id") result.jobIds.push(entry.value);
    else if (entry.key === "keeper-commit-id") {
      result.keeperIds.push(entry.value);
    } else if (entry.key === "task") result.tasks.push(entry.value);
    if (isProtectedTrailerKey(entry.key)) {
      result.protected.push(`${entry.key}\0${entry.value}`);
    }
  }
  result.protected.sort();
  return result;
}

function assertMessageIntegrity(
  message: string,
  marker: string,
  jobId: string | null | undefined,
  expectedTasks: string[],
  expectedProtected: string[],
): void {
  const trailers = messageTrailers(message);
  const jobOk = jobId
    ? trailers.jobIds.length === 1 && trailers.jobIds[0] === jobId
    : trailers.jobIds.length === 0;
  const keeperOk =
    trailers.keeperIds.length === 1 && trailers.keeperIds[0] === marker;
  const remainingTasks = [...trailers.tasks];
  const tasksOk =
    expectedTasks.every((task) => {
      const index = remainingTasks.indexOf(task);
      if (index < 0) return false;
      remainingTasks.splice(index, 1);
      return true;
    }) && remainingTasks.length === 0;
  const protectedOk =
    trailers.protected.length === expectedProtected.length &&
    trailers.protected.every(
      (signature, index) => signature === expectedProtected[index],
    );
  if (!jobOk || !keeperOk || !tasksOk || !protectedOk) {
    throw new PrivateIndexError(
      "commit_hook_mutated",
      "commit message hook removed, changed, or injected a protected trailer",
    );
  }
}

function assertWorktreeRelativePath(worktree: string, path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    Buffer.byteLength(path, "utf8") > MAX_WORKTREE_SNAPSHOT_PATH_BYTES ||
    isAbsolute(path)
  ) {
    throw new Error("invalid worktree snapshot path");
  }
  const absolute = resolve(worktree, path);
  const rel = relative(resolve(worktree), absolute);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    throw new Error("worktree snapshot path escaped the repository");
  }
  return absolute;
}

function rawPathSetFingerprint(
  worktree: string,
  inputPaths: string[],
  fs: PrivateIndexFs,
): string {
  const paths = [...new Set(inputPaths)].sort();
  if (paths.length > MAX_WORKTREE_SNAPSHOT_PATHS) {
    throw new Error(
      `worktree snapshot exceeds ${MAX_WORKTREE_SNAPSHOT_PATHS} paths`,
    );
  }
  // Plumbing-only fixtures have no real worktree. Their injected complete
  // fingerprint seam still binds the deterministic path set.
  if (fs.fingerprintIndex) return `fixture:${paths.join("\0")}`;

  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(FINGERPRINT_CHUNK_BYTES);
  let totalBytes = 0;
  for (const path of paths) {
    const absolute = assertWorktreeRelativePath(worktree, path);
    let lexicalBefore: BigIntStats;
    try {
      lexicalBefore = lstatSync(absolute, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      hash.update(path);
      hash.update("\0absent\0");
      continue;
    }
    hash.update(path);
    hash.update("\0");
    hash.update(stableIndexMetadata(lexicalBefore));
    hash.update("\0");
    if (lexicalBefore.isSymbolicLink()) {
      const target = readlinkSync(absolute, { encoding: "buffer" });
      totalBytes += target.byteLength;
      if (totalBytes > MAX_WORKTREE_SNAPSHOT_BYTES) {
        throw new Error(
          `worktree snapshot exceeds ${MAX_WORKTREE_SNAPSHOT_BYTES} bytes`,
        );
      }
      hash.update(target);
    } else if (lexicalBefore.isFile()) {
      const fd = openSync(
        absolute,
        constants.O_RDONLY | constants.O_NONBLOCK | O_CLOEXEC,
      );
      try {
        const before = fstatSync(fd, { bigint: true });
        if (
          !before.isFile() ||
          stableIndexMetadata(before) !== stableIndexMetadata(lexicalBefore)
        ) {
          throw new Error("worktree snapshot path changed before read");
        }
        if (before.size > BigInt(MAX_WORKTREE_SNAPSHOT_BYTES - totalBytes)) {
          throw new Error(
            `worktree snapshot exceeds ${MAX_WORKTREE_SNAPSHOT_BYTES} bytes`,
          );
        }
        for (;;) {
          const count = readSync(fd, chunk, 0, chunk.length, null);
          if (count === 0) break;
          totalBytes += count;
          if (totalBytes > MAX_WORKTREE_SNAPSHOT_BYTES) {
            throw new Error(
              `worktree snapshot exceeds ${MAX_WORKTREE_SNAPSHOT_BYTES} bytes`,
            );
          }
          hash.update(chunk.subarray(0, count));
        }
        const after = fstatSync(fd, { bigint: true });
        const lexicalAfter = lstatSync(absolute, { bigint: true });
        if (
          stableIndexMetadata(before) !== stableIndexMetadata(after) ||
          stableIndexMetadata(after) !== stableIndexMetadata(lexicalAfter)
        ) {
          throw new Error("worktree snapshot path changed while read");
        }
      } finally {
        closeSync(fd);
      }
    }
    hash.update("\0");
  }
  return `paths:${paths.length}:bytes:${totalBytes}:sha256:${hash.digest("hex")}`;
}

function isExcludedRuntimePath(path: string): boolean {
  return (
    path === EXCLUDED_PREFIX.slice(0, -1) || path.startsWith(EXCLUDED_PREFIX)
  );
}

function worktreeStatusSnapshot(
  raw: string,
  excludeRuntimePaths: boolean,
): {
  identity: string[];
  paths: string[];
} {
  const identity: string[] = [];
  const paths = new Set<string>();
  const records = raw.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record === "") continue;
    const tag = record[0];
    if (tag === "1") {
      const path = pathAfterTokens(record, 8);
      const worktreeCode = record[3];
      if (path && worktreeCode && worktreeCode !== ".") {
        paths.add(path);
        identity.push(`1\0${worktreeCode}\0${path}`);
      }
    } else if (tag === "2") {
      const path = pathAfterTokens(record, 9);
      const original = records[index + 1];
      const worktreeCode = record[3];
      if (path && worktreeCode && worktreeCode !== ".") {
        paths.add(path);
        identity.push(`2\0${worktreeCode}\0${path}\0${original ?? ""}`);
        if (original) paths.add(original);
      }
      if (original) index += 1;
    } else if (tag === "u") {
      const path = pathAfterTokens(record, 10);
      if (path) {
        paths.add(path);
        identity.push(`u\0${path}`);
      }
    } else if (tag === "?" || tag === "!") {
      const path = record.slice(2);
      if (path && !(excludeRuntimePaths && isExcludedRuntimePath(path))) {
        paths.add(path);
        identity.push(`${tag}\0${path}`);
      }
    }
  }
  return { identity: identity.sort(), paths: [...paths].sort() };
}

async function worktreeSnapshot(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
  excludeRuntimePaths: boolean,
  captureWhole?: (snapshot: string) => void,
): Promise<string> {
  const readStatus = () =>
    git(
      [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignored=traditional",
      ],
      {
        cwd: worktree,
        env: {
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.fsmonitor",
          GIT_CONFIG_VALUE_0: "false",
        },
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      },
    );
  const before = await readStatus();
  if (before.code !== 0) {
    throw new PrivateIndexError("commit_failed", before.stderr);
  }
  // Porcelain `!` records enumerate ignored files individually under
  // --untracked-files=all. Normalize away the index-vs-HEAD X column: the raw
  // target-index fingerprint already owns staged identity, and a competing ref
  // advance must reach the CAS rather than masquerade as a worktree mutation.
  const status = worktreeStatusSnapshot(before.stdout, excludeRuntimePaths);
  const paths = [...new Set([...frozen.paths, ...status.paths])].sort();
  const raw = rawPathSetFingerprint(worktree, paths, fs);
  const wholeStatus = captureWhole
    ? worktreeStatusSnapshot(before.stdout, false)
    : null;
  const wholeRaw = wholeStatus
    ? JSON.stringify(wholeStatus) === JSON.stringify(status)
      ? raw
      : rawPathSetFingerprint(
          worktree,
          [...new Set([...frozen.paths, ...wholeStatus.paths])].sort(),
          fs,
        )
    : null;
  const after = await readStatus();
  if (after.code !== 0) {
    throw new PrivateIndexError("commit_failed", after.stderr);
  }
  const afterStatus = worktreeStatusSnapshot(after.stdout, excludeRuntimePaths);
  if (
    JSON.stringify(afterStatus.identity) !== JSON.stringify(status.identity) ||
    !samePathSet(afterStatus.paths, status.paths)
  ) {
    throw new Error("worktree status changed while fingerprinted");
  }
  if (captureWhole && wholeStatus && wholeRaw) {
    const afterWhole = worktreeStatusSnapshot(after.stdout, false);
    if (
      JSON.stringify(afterWhole.identity) !==
        JSON.stringify(wholeStatus.identity) ||
      !samePathSet(afterWhole.paths, wholeStatus.paths)
    ) {
      throw new Error("worktree status changed while fingerprinted");
    }
    captureWhole(
      JSON.stringify({ status: afterWhole.identity, raw: wholeRaw }),
    );
  }
  return JSON.stringify({ status: afterStatus.identity, raw });
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

function gitConfigOverlayEnvironment(
  base: Record<string, string>,
  config: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(config).sort(([a], [b]) => a.localeCompare(b));
  const env: Record<string, string> = {
    ...base,
    GIT_CONFIG_COUNT: String(entries.length),
  };
  entries.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function capturedHookEnvironment(
  frozen: FrozenPrivateIndex,
): Record<string, string> {
  return gitConfigOverlayEnvironment(targetGitEnvironment(frozen), {
    "core.hooksPath": join(frozen.dir, "captured-hooks"),
  });
}

function signingEnvironment(
  frozen: FrozenPrivateIndex,
): Record<string, string> {
  return gitConfigOverlayEnvironment(
    targetGitEnvironment(frozen),
    frozen.signing.config ?? {},
  );
}

function disabledHookEnvironment(
  frozen: FrozenPrivateIndex,
): Record<string, string> {
  return gitConfigOverlayEnvironment(targetGitEnvironment(frozen), {
    "core.hooksPath": join(frozen.dir, "no-hooks"),
  });
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

function stableIndexContentMetadata(stat: BigIntStats): string {
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
  ]
    .map(String)
    .join(":");
}

function fingerprintIndexFile(indexPath: string, fs: PrivateIndexFs): string {
  if (fs.fingerprintIndex) return fs.fingerprintIndex(indexPath);

  const fd = openSync(indexPath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error("private index is not a file");
    if (before.size > BigInt(MAX_INDEX_FINGERPRINT_BYTES)) {
      throw new Error(
        `index exceeds ${MAX_INDEX_FINGERPRINT_BYTES} fingerprint bytes`,
      );
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(FINGERPRINT_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_INDEX_FINGERPRINT_BYTES) {
        throw new Error(
          `index exceeds ${MAX_INDEX_FINGERPRINT_BYTES} fingerprint bytes`,
        );
      }
      hash.update(chunk.subarray(0, count));
    }
    const after = fstatSync(fd, { bigint: true });
    const pathStat = lstatSync(indexPath, { bigint: true });
    // Git legitimately freshens split-index companion timestamps during a
    // read. Bind semantic metadata + complete bytes, not mtime/ctime churn.
    const beforeMetadata = stableIndexContentMetadata(before);
    const afterMetadata = stableIndexContentMetadata(after);
    if (
      beforeMetadata !== afterMetadata ||
      afterMetadata !== stableIndexContentMetadata(pathStat)
    ) {
      throw new Error("private index changed while it was fingerprinted");
    }
    return `${afterMetadata}\0sha256:${hash.digest("hex")}`;
  } finally {
    closeSync(fd);
  }
}

/** Focused test seam for the production streaming size/hash implementation. */
export function fingerprintIndexFileForTest(indexPath: string): string {
  return fingerprintIndexFile(indexPath, {});
}

function fingerprintIndexFileOrMissing(
  indexPath: string,
  fs: PrivateIndexFs,
): string {
  try {
    return fingerprintIndexFile(indexPath, fs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function refingerprintKnownIndexState(
  indexPath: string,
  baseline: string,
  fs: PrivateIndexFs,
): string {
  if (fs.fingerprintIndex) return fs.fingerprintIndex(indexPath);
  const marker = "\0shared:";
  const markerAt = baseline.indexOf(marker);
  if (markerAt < 0) throw new Error("invalid index-state baseline");
  const pathStart = markerAt + marker.length;
  const pathEnd = baseline.indexOf("\0", pathStart);
  if (pathEnd < 0) throw new Error("invalid split-index baseline");
  const sharedPath = baseline.slice(pathStart, pathEnd);
  const previousShared = baseline.slice(pathEnd + 1);
  const primary = fingerprintIndexFileOrMissing(indexPath, fs);
  let shared = "none";
  if (sharedPath !== "") {
    try {
      shared = fingerprintIndexFile(sharedPath, fs);
    } catch (error) {
      if (
        previousShared === "zero-sentinel" &&
        /[/\\]sharedindex\.0+$/.test(sharedPath) &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        shared = "zero-sentinel";
      } else {
        throw error;
      }
    }
  }
  return `${primary}\0shared:${sharedPath}\0${shared}`;
}

async function fingerprintIndexState(
  indexPath: string,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
): Promise<string> {
  // Plumbing-only fixtures inject a complete state fingerprint. Production
  // fingerprints the primary index plus the exact split-index companion Git
  // resolves from that primary file.
  if (fs.fingerprintIndex) return fs.fingerprintIndex(indexPath);

  const primaryBefore = fingerprintIndexFileOrMissing(indexPath, fs);
  if (primaryBefore === "missing") return "missing\0shared:\0none";
  const shared = await git(
    ["rev-parse", "--path-format=absolute", "--shared-index-path"],
    {
      cwd: worktree,
      env: { GIT_INDEX_FILE: indexPath, GIT_NO_REPLACE_OBJECTS: "1" },
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    },
  );
  if (shared.code !== 0) {
    throw new Error(
      `cannot resolve split-index companion: ${shared.stderr || `git exited ${shared.code}`}`,
    );
  }

  const reported = shared.stdout.trim();
  let sharedPath = "";
  let sharedBefore = "none";
  if (reported !== "") {
    if (reported.includes("\0") || reported.includes("\n")) {
      throw new Error("invalid split-index companion path");
    }
    const absolute = resolve(worktree, reported);
    try {
      sharedPath = realpathSync(absolute);
      sharedBefore = fingerprintIndexFile(sharedPath, fs);
    } catch (error) {
      // Git can report the all-zero link sentinel while constructing a new
      // split index; it deliberately has no companion file yet.
      if (/[/\\]sharedindex\.0+$/.test(absolute)) {
        sharedPath = absolute;
        sharedBefore = "zero-sentinel";
      } else {
        throw error;
      }
    }
  }

  const primaryAfter = fingerprintIndexFile(indexPath, fs);
  let sharedAfter = sharedBefore;
  if (sharedPath !== "" && sharedBefore !== "zero-sentinel") {
    sharedAfter = fingerprintIndexFile(sharedPath, fs);
  }
  if (primaryAfter !== primaryBefore || sharedAfter !== sharedBefore) {
    throw new Error(
      "index or split-index companion changed while fingerprinted",
    );
  }
  return `${primaryAfter}\0shared:${sharedPath}\0${sharedAfter}`;
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
    const absolute = resolve(worktree, found.stdout.trim());
    try {
      return realpathSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return join(realpathSync(dirname(absolute)), basename(absolute));
      }
      throw error;
    }
  } catch (error) {
    throw new PrivateIndexError(
      "commit_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function configValue(
  key: string,
  worktree: string,
  git: GitRunner,
  targetEnv: Record<string, string>,
  type?: "bool",
): Promise<string | null> {
  const configured = await git(
    ["config", ...(type ? [`--${type}`] : []), "--get", key],
    {
      cwd: worktree,
      env: targetEnv,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      maxStdoutBytes: 64 * 1_024,
      maxStderrBytes: 64 * 1_024,
    },
  );
  if (configured.code === 1) return null;
  if (configured.code !== 0) {
    throw new PrivateIndexError("commit_failed", configured.stderr);
  }
  const value = configured.stdout.replace(/\r?\n$/, "");
  if (value.includes("\0") || value.includes("\n")) {
    throw new PrivateIndexError("commit_failed", `invalid Git config ${key}`);
  }
  return value === "" ? null : value;
}

async function signingArgs(
  worktree: string,
  git: GitRunner,
  targetEnv: Record<string, string>,
): Promise<{
  args: string[];
  enabled: boolean;
  config: Record<string, string>;
}> {
  const [enabledRaw, formatRaw, signingKey, generic, openpgp, x509, ssh] =
    await Promise.all([
      configValue("commit.gpgSign", worktree, git, targetEnv, "bool"),
      configValue("gpg.format", worktree, git, targetEnv),
      configValue("user.signingKey", worktree, git, targetEnv),
      configValue("gpg.program", worktree, git, targetEnv),
      configValue("gpg.openpgp.program", worktree, git, targetEnv),
      configValue("gpg.x509.program", worktree, git, targetEnv),
      configValue("gpg.ssh.program", worktree, git, targetEnv),
    ]);
  const enabled = enabledRaw === "true";
  const format = formatRaw ?? "openpgp";
  if (!new Set(["openpgp", "x509", "ssh"]).has(format)) {
    throw new PrivateIndexError("commit_failed", "unsupported gpg.format");
  }
  if (enabled && format === "ssh" && signingKey === null) {
    throw new PrivateIndexError(
      "commit_failed",
      "SSH commit signing requires an explicit user.signingKey",
    );
  }
  return {
    args: enabled ? [signingKey ? `-S${signingKey}` : "-S"] : [],
    enabled,
    config: {
      "gpg.format": format,
      "user.signingKey": signingKey ?? "",
      "gpg.program": generic ?? "gpg",
      "gpg.openpgp.program": openpgp ?? generic ?? "gpg",
      "gpg.x509.program": x509 ?? "gpgsm",
      "gpg.ssh.program": ssh ?? "ssh-keygen",
      "gpg.ssh.defaultKeyCommand": "",
    },
  };
}

const COMMIT_HOOK_NAMES = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "reference-transaction",
] as const;
const MAX_GIT_CONFIG_BYTES = 1_048_576;

async function gitConfigFingerprint(
  worktree: string,
  git: GitRunner,
  env: Record<string, string>,
): Promise<string> {
  const config = await git(
    ["config", "--null", "--list", "--show-origin", "--show-scope"],
    {
      cwd: worktree,
      env,
      maxStdoutBytes: MAX_GIT_CONFIG_BYTES,
      maxStderrBytes: 64 * 1024,
    },
  );
  if (config.code !== 0) {
    throw new PrivateIndexError("commit_failed", config.stderr);
  }
  return createHash("sha256").update(config.stdout).digest("hex");
}

function hookPathFingerprint(path: string, fs: PrivateIndexFs): string {
  if (path === "") return "missing";
  if (fs.fingerprintIndex) return fs.fingerprintIndex(path);
  try {
    const lexical = lstatSync(path, { bigint: true });
    const link = lexical.isSymbolicLink() ? readlinkSync(path) : "";
    if (!lexical.isFile() && !lexical.isSymbolicLink()) {
      return `other:${stableIndexMetadata(lexical)}:${link}`;
    }
    return `${stableIndexMetadata(lexical)}:${link}:${fingerprintIndexFile(path, fs)}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function resolveHookPaths(
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
  env: Record<string, string>,
): Promise<Record<(typeof COMMIT_HOOK_NAMES)[number], string>> {
  const paths: string[] = [];
  if (fs.fingerprintIndex) {
    for (const name of COMMIT_HOOK_NAMES) {
      const resolved = await git(
        ["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`],
        { cwd: worktree, env },
      );
      if (resolved.code !== 0) {
        throw new PrivateIndexError("commit_failed", resolved.stderr);
      }
      paths.push(resolved.stdout.trim());
    }
  } else {
    const resolved = await git(
      [
        "rev-parse",
        "--path-format=absolute",
        ...COMMIT_HOOK_NAMES.flatMap((name) => ["--git-path", `hooks/${name}`]),
      ],
      { cwd: worktree, env, timeoutMs: GIT_LOCAL_TIMEOUT_MS },
    );
    if (resolved.code !== 0) {
      throw new PrivateIndexError("commit_failed", resolved.stderr);
    }
    paths.push(...resolved.stdout.trimEnd().split("\n"));
  }
  if (paths.length !== COMMIT_HOOK_NAMES.length) {
    throw new PrivateIndexError("commit_failed", "incomplete hook path set");
  }
  return Object.fromEntries(
    COMMIT_HOOK_NAMES.map((name, index) => [name, paths[index] ?? ""]),
  ) as Record<(typeof COMMIT_HOOK_NAMES)[number], string>;
}

function resolvedHookSetFingerprint(
  paths: Record<(typeof COMMIT_HOOK_NAMES)[number], string>,
  fs: PrivateIndexFs,
): string {
  const entries = COMMIT_HOOK_NAMES.map((name) => {
    const path = paths[name];
    return `${name}\0${path}\0${hookPathFingerprint(path, fs)}`;
  });
  return createHash("sha256").update(entries.join("\0")).digest("hex");
}

async function hookSetFingerprint(
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
  env: Record<string, string>,
): Promise<string> {
  return resolvedHookSetFingerprint(
    await resolveHookPaths(worktree, git, fs, env),
    fs,
  );
}

function executableHook(path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`symbolic-link hook is unsupported: ${path}`);
    }
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readCapturedHook(path: string): Uint8Array {
  const fd = openSync(
    path,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW |
      O_CLOEXEC,
  );
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 1_048_576) {
      throw new Error(`hook is not a bounded regular file: ${path}`);
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (count <= 0) throw new Error(`hook changed while read: ${path}`);
      offset += count;
    }
    const after = fstatSync(fd);
    const lexical = lstatSync(path);
    if (
      !lexical.isFile() ||
      lexical.dev !== after.dev ||
      lexical.ino !== after.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`hook changed while read: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function captureHookSet(
  frozen: FrozenPrivateIndex,
  paths: Record<(typeof COMMIT_HOOK_NAMES)[number], string>,
  fs: PrivateIndexFs,
): {
  referenceTransactionPresent: boolean;
  capturedHashes: Map<string, string>;
} {
  if (fs.fingerprintIndex) {
    return {
      referenceTransactionPresent: false,
      capturedHashes: new Map(),
    };
  }
  const capturedDir = join(frozen.dir, "captured-hooks");
  const noHooksDir = join(frozen.dir, "no-hooks");
  rmSync(capturedDir, { recursive: true, force: true });
  rmSync(noHooksDir, { recursive: true, force: true });
  mkdirSync(capturedDir, { recursive: false, mode: 0o700 });
  mkdirSync(noHooksDir, { recursive: false, mode: 0o700 });
  const capturedHashes = new Map<string, string>();
  for (const name of COMMIT_HOOK_NAMES) {
    if (!executableHook(paths[name])) continue;
    if (name === "reference-transaction") continue;
    const bytes = readCapturedHook(paths[name]);
    capturedHashes.set(name, createHash("sha256").update(bytes).digest("hex"));
    writeFileSync(join(capturedDir, name), bytes, {
      flag: "wx",
      mode: 0o700,
    });
  }
  return {
    referenceTransactionPresent: executableHook(paths["reference-transaction"]),
    capturedHashes,
  };
}

/** Capture the complete context before lint; intentional ambient repair refreshes it. */
export async function refreshFrozenPublicationBaseline(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs = {},
): Promise<void> {
  const env = targetGitEnvironment(frozen);
  frozen.targetIndexPath = await targetWorktreeIndexPath(worktree, git, fs);
  frozen.targetIndexBaseline = await fingerprintIndexState(
    frozen.targetIndexPath,
    worktree,
    git,
    fs,
  );
  frozen.worktreeBaseline = await worktreeSnapshot(
    frozen,
    worktree,
    git,
    fs,
    true,
  );
  frozen.worktreeHookBaseline = "";
  const configBeforeSigning = await gitConfigFingerprint(worktree, git, env);
  frozen.signing = await signingArgs(worktree, git, env);
  const configAfterSigning = await gitConfigFingerprint(worktree, git, env);
  if (configAfterSigning !== configBeforeSigning) {
    throw new PrivateIndexError(
      "surface_changed",
      "Git configuration changed while signing policy was captured",
    );
  }
  frozen.gitConfigBaseline = configAfterSigning;
  const hookPaths = await resolveHookPaths(worktree, git, fs, env);
  const hookIdentities = new Map(
    COMMIT_HOOK_NAMES.map((name) => [
      name,
      hookPathFingerprint(hookPaths[name], fs),
    ]),
  );
  const hookBefore = resolvedHookSetFingerprint(hookPaths, fs);
  const executableBefore = new Map(
    COMMIT_HOOK_NAMES.map((name) => [
      name,
      fs.fingerprintIndex ? false : executableHook(hookPaths[name]),
    ]),
  );
  const capturedHooks = captureHookSet(frozen, hookPaths, fs);
  frozen.referenceTransactionHookPresent =
    capturedHooks.referenceTransactionPresent;
  const afterPaths = await resolveHookPaths(worktree, git, fs, env);
  const hookAfter = resolvedHookSetFingerprint(afterPaths, fs);
  let captureMismatch = false;
  for (const name of COMMIT_HOOK_NAMES) {
    const beforeIdentity = hookIdentities.get(name) ?? "";
    if (hookPathFingerprint(afterPaths[name], fs) !== beforeIdentity) {
      captureMismatch = true;
    }
    const capturedHash = capturedHooks.capturedHashes.get(name);
    if (
      capturedHash !== undefined &&
      !beforeIdentity.endsWith(`:${capturedHash}`)
    ) {
      captureMismatch = true;
    }
    if (
      name !== "reference-transaction" &&
      (executableBefore.get(name) === true) !== (capturedHash !== undefined)
    ) {
      captureMismatch = true;
    }
  }
  if (
    hookAfter !== hookBefore ||
    captureMismatch ||
    (!fs.fingerprintIndex &&
      (executableBefore.get("reference-transaction") !==
        capturedHooks.referenceTransactionPresent ||
        executableHook(afterPaths["reference-transaction"]) !==
          capturedHooks.referenceTransactionPresent))
  ) {
    throw new PrivateIndexError(
      "surface_changed",
      "hook set changed while immutable hook copies were captured",
    );
  }
  frozen.hookSetBaseline = hookAfter;
}

async function requireFrozenPublicationBaseline(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
  code: "surface_changed" | "commit_hook_mutated",
  commitSha?: string,
  excludeRuntimePaths = code === "surface_changed",
  captureWholeBaseline = false,
): Promise<void> {
  try {
    const env = targetGitEnvironment(frozen);
    const changed: string[] = [];
    const expectedWorktree = excludeRuntimePaths
      ? frozen.worktreeBaseline
      : frozen.worktreeHookBaseline;
    let wholeBaseline: string | undefined;
    if (
      (await worktreeSnapshot(
        frozen,
        worktree,
        git,
        fs,
        excludeRuntimePaths,
        captureWholeBaseline
          ? (snapshot) => {
              wholeBaseline = snapshot;
            }
          : undefined,
      )) !== expectedWorktree
    ) {
      changed.push("worktree");
    }
    const currentTargetIndex = refingerprintKnownIndexState(
      frozen.targetIndexPath,
      frozen.targetIndexBaseline,
      fs,
    );
    if (currentTargetIndex !== frozen.targetIndexBaseline) {
      changed.push(
        `target index ${createHash("sha256").update(frozen.targetIndexBaseline).digest("hex").slice(0, 12)}->${createHash("sha256").update(currentTargetIndex).digest("hex").slice(0, 12)}`,
      );
    }
    if (
      (await gitConfigFingerprint(worktree, git, env)) !==
      frozen.gitConfigBaseline
    ) {
      changed.push("Git config");
    }
    if (
      (await hookSetFingerprint(worktree, git, fs, env)) !==
      frozen.hookSetBaseline
    ) {
      changed.push("hook set");
    }
    if (changed.length > 0) {
      throw new Error(`${changed.join(", ")} changed`);
    }
    if (wholeBaseline !== undefined) {
      frozen.worktreeHookBaseline = wholeBaseline;
    }
  } catch (error) {
    if (error instanceof PrivateIndexError && error.code === code) throw error;
    throw new PrivateIndexError(
      code,
      error instanceof Error ? error.message : String(error),
      { commitSha },
    );
  }
}

export async function verifyFrozenPublicationBaseline(
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs = {},
): Promise<void> {
  await requireFrozenPublicationBaseline(
    frozen,
    worktree,
    git,
    fs,
    "surface_changed",
  );
}

async function runCommitHook(
  name: "pre-commit" | "prepare-commit-msg" | "commit-msg",
  args: string[],
  hookEnv: Record<string, string>,
  frozen: FrozenPrivateIndex,
  worktree: string,
  git: GitRunner,
  fs: PrivateIndexFs,
): Promise<void> {
  let indexBefore: string;
  try {
    indexBefore = await fingerprintIndexState(
      frozen.indexPath,
      worktree,
      git,
      fs,
    );
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
    indexAfter = refingerprintKnownIndexState(
      frozen.indexPath,
      indexBefore,
      fs,
    );
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
    if (
      refingerprintKnownIndexState(
        frozen.targetIndexPath,
        frozen.targetIndexBaseline,
        fs,
      ) !== frozen.targetIndexBaseline
    ) {
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
  try {
    await verifyFrozenSurface(frozen, worktree, git, fs);
  } catch (error) {
    const detail =
      error instanceof PrivateIndexError ? error.stderr : String(error);
    throw new PrivateIndexError("commit_hook_mutated", detail);
  }
  await requireFrozenPublicationBaseline(
    frozen,
    worktree,
    git,
    fs,
    "commit_hook_mutated",
  );
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
  const before = await currentRef(frozen, worktree, git);
  if (before !== frozen.expectedHead) {
    throw new PrivateIndexError("ref_conflict");
  }

  const operation = await guards.beforeCommit?.();
  if (operation) {
    throw new PrivateIndexError("operation_in_progress", "", { operation });
  }
  await verifyFrozenSurface(frozen, worktree, git, fs);
  await requireFrozenPublicationBaseline(
    frozen,
    worktree,
    git,
    fs,
    "commit_hook_mutated",
    undefined,
    true,
    true,
  );
  const marker = `keeper-commit-work:${(fs.commitMarker ?? randomUUID)()}`;
  const expectedTasks = messageTrailers(message).tasks;
  const completeMessage = await completeCommitMessage(
    message,
    marker,
    guards.jobId,
    worktree,
    git,
  );
  const expectedProtected = messageTrailers(completeMessage).protected;
  assertMessageIntegrity(
    completeMessage,
    marker,
    guards.jobId,
    expectedTasks,
    expectedProtected,
  );

  mkdirSync(frozen.dir, { recursive: true });
  const nonce = randomUUID();
  const messagePath = join(frozen.dir, `message-${nonce}`);
  writeFileSync(messagePath, completeMessage, { mode: 0o600 });

  try {
    const targetEnv = targetGitEnvironment(frozen);
    const hookEnv = capturedHookEnvironment(frozen);
    const signerEnv = signingEnvironment(frozen);
    if (frozen.referenceTransactionHookPresent !== false) {
      throw new PrivateIndexError(
        "commit_failed",
        "executable reference-transaction hooks are unsupported by atomic commit-work publication",
      );
    }
    await runCommitHook("pre-commit", [], hookEnv, frozen, worktree, git, fs);

    await runCommitHook(
      "prepare-commit-msg",
      [messagePath, "message"],
      hookEnv,
      frozen,
      worktree,
      git,
      fs,
    );
    let finalMessage = readBoundedHookMessage(messagePath);
    assertMessageIntegrity(
      finalMessage,
      marker,
      guards.jobId,
      expectedTasks,
      expectedProtected,
    );

    await runCommitHook(
      "commit-msg",
      [messagePath],
      hookEnv,
      frozen,
      worktree,
      git,
      fs,
    );
    finalMessage = readBoundedHookMessage(messagePath);
    assertMessageIntegrity(
      finalMessage,
      marker,
      guards.jobId,
      expectedTasks,
      expectedProtected,
    );

    const signing = frozen.signing;
    const finalOperation = await guards.beforeCommit?.();
    if (finalOperation) {
      throw new PrivateIndexError("operation_in_progress", "", {
        operation: finalOperation,
      });
    }
    await guards.validateOwnership?.();

    // Reject already-visible ownership drift before paying the remaining
    // surface/index verification cost. A second post-verification validation
    // below is the final non-local boundary immediately before CAS.
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
    finalMessage = readBoundedHookMessage(messagePath);
    assertMessageIntegrity(
      finalMessage,
      marker,
      guards.jobId,
      expectedTasks,
      expectedProtected,
    );
    let privateIndexBaseline: string;
    try {
      privateIndexBaseline = await fingerprintIndexState(
        frozen.indexPath,
        worktree,
        git,
        fs,
      );
    } catch (error) {
      throw new PrivateIndexError(
        "commit_failed",
        error instanceof Error ? error.message : String(error),
      );
    }

    const commit = await git(
      [
        "commit-tree",
        frozen.tree,
        ...(frozen.expectedHead === null ? [] : ["-p", frozen.expectedHead]),
        "-F",
        "-",
        ...signing.args,
      ],
      {
        cwd: worktree,
        env: signerEnv,
        stdin: new TextEncoder().encode(finalMessage),
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
      parsed.parents.length !== (frozen.expectedHead === null ? 0 : 1) ||
      (frozen.expectedHead !== null &&
        parsed.parents[0] !== frozen.expectedHead) ||
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
    // complete raw private/target-index checks after commit-tree. Ownership and
    // operation are sampled once more after those potentially-long checks.
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
    // The full private-index fingerprint below supersedes tree/index plumbing
    // here; avoid a post-signer write-tree that can refresh cache extensions.
    await verifyFrozenSelectedSurface(frozen, worktree, git, fs);
    await requireFrozenPublicationBaseline(
      frozen,
      worktree,
      git,
      fs,
      "commit_hook_mutated",
      sha,
    );
    try {
      if (
        refingerprintKnownIndexState(
          frozen.indexPath,
          privateIndexBaseline,
          fs,
        ) !== privateIndexBaseline
      ) {
        throw new Error("private index changed before publication");
      }
    } catch (error) {
      throw new PrivateIndexError(
        "commit_hook_mutated",
        error instanceof Error ? error.message : String(error),
        { commitSha: sha },
      );
    }
    try {
      if (
        refingerprintKnownIndexState(
          frozen.targetIndexPath,
          frozen.targetIndexBaseline,
          fs,
        ) !== frozen.targetIndexBaseline
      ) {
        throw new Error("target worktree index changed before publication");
      }
    } catch (error) {
      throw new PrivateIndexError(
        "commit_hook_mutated",
        error instanceof Error ? error.message : String(error),
        { commitSha: sha },
      );
    }

    // Linearize ownership/operation admission after every executable or
    // potentially-long validation boundary. Only the one CAS spawn remains;
    // work that becomes claimed after this point is concurrent with publication
    // rather than evidence skipped by Keeper's own pre-publication checks.
    const publishOperation = await guards.beforeCommit?.();
    if (publishOperation) {
      throw new PrivateIndexError("operation_in_progress", "", {
        operation: publishOperation,
        commitSha: sha,
      });
    }
    await requireFrozenPublicationBaseline(
      frozen,
      worktree,
      git,
      fs,
      "commit_hook_mutated",
      sha,
    );
    await guards.validateOwnership?.();

    const publish = await git(
      [
        "update-ref",
        "-m",
        "keeper commit-work: publish isolated commit",
        frozen.branchRef,
        sha,
        frozen.expectedHead ?? frozen.zeroOid,
      ],
      {
        cwd: worktree,
        env: disabledHookEnvironment(frozen),
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      },
    );
    if (publish.code !== 0) {
      if (
        publish.code === GIT_SPAWN_TIMEOUT_CODE ||
        publish.code === GIT_OUTPUT_LIMIT_CODE ||
        publish.signal != null
      ) {
        throw new PrivateIndexError(
          "commit_state_indeterminate",
          publish.stderr,
          {
            commitSha: sha,
            indeterminate: true,
          },
        );
      }
      throw new PrivateIndexError("ref_conflict", publish.stderr, {
        commitSha: sha,
      });
    }

    let postCommitHookWarning: PostCommitHookWarning | undefined;
    try {
      // `post-commit` is publication-adjacent executable authority. Re-resolve
      // both config and the complete hook set after CAS and skip execution if a
      // pre-hook or concurrent writer replaced it; the commit remains local and
      // the caller receives the existing committed-warning outcome.
      if (
        (await gitConfigFingerprint(worktree, git, targetEnv)) !==
          frozen.gitConfigBaseline ||
        (await hookSetFingerprint(worktree, git, fs, targetEnv)) !==
          frozen.hookSetBaseline
      ) {
        throw new Error("post-commit hook or Git configuration changed");
      }
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
