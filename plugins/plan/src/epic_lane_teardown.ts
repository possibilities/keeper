import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

export interface TornDownLane {
  repo: string;
  path: string;
  branch: string;
}

export interface SkippedLane extends TornDownLane {
  reason: string;
}

export interface EpicLaneTeardownResult {
  tornDownLanes: TornDownLane[];
  skippedLanes: SkippedLane[];
  warnings: string[];
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  bare: boolean;
  locked?: string | null;
}

interface GitResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

const KEEPER_EPIC_BRANCH_PREFIX = "keeper/epic/";
const LANE_DIRT_INDEX_MAX_BYTES = 4096;
const WORKTREE_ROUTING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
] as const;

export function teardownEpicLanes(
  epicId: string,
  repos: readonly (string | null | undefined)[],
  dryRun: boolean,
): EpicLaneTeardownResult {
  const result: EpicLaneTeardownResult = {
    tornDownLanes: [],
    skippedLanes: [],
    warnings: [],
  };
  for (const repo of resolveRepoSet(repos)) {
    const listed = listWorktrees(repo);
    if (listed === null) {
      continue;
    }
    for (const entry of listed.filter((e) => entryBelongsToEpic(e, epicId))) {
      const lane = lanePayload(repo, entry);
      const ownership = classifyLaneOwnership(repo, entry);
      if (ownership !== "owned") {
        result.skippedLanes.push({ ...lane, reason: ownership });
        continue;
      }
      if (dryRun) {
        result.tornDownLanes.push(lane);
        continue;
      }
      const removed = backupThenForceRemoveWorktree(repo, entry);
      if (removed.kind !== "removed") {
        result.skippedLanes.push({ ...lane, reason: removed.kind });
        continue;
      }
      result.tornDownLanes.push(lane);
      const branch = shortBranchName(entry.branch);
      if (branch !== null) {
        const deleted = runGit(["branch", "-D", branch], repo);
        if (deleted.exitCode !== 0) {
          result.warnings.push(
            `failed to delete lane branch ${branch} in ${repo}: ${gitOutput(deleted)}`,
          );
        }
      }
    }
  }
  return result;
}

function resolveRepoSet(
  repos: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of repos) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      continue;
    }
    let repo: string;
    try {
      repo = realpathSync(raw);
    } catch {
      continue;
    }
    if (!seen.has(repo)) {
      seen.add(repo);
      out.push(repo);
    }
  }
  return out;
}

function listWorktrees(repo: string): WorktreeEntry[] | null {
  const inside = runGit(["rev-parse", "--is-inside-work-tree"], repo);
  if (inside.exitCode !== 0 || inside.stdout.toString().trim() !== "true") {
    return null;
  }
  const listed = runGit(["worktree", "list", "--porcelain"], repo);
  if (listed.exitCode !== 0) {
    return null;
  }
  return parseWorktreeList(listed.stdout.toString());
}

function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: Partial<WorktreeEntry> | null = null;
  const flush = (): void => {
    if (cur?.path !== undefined) {
      out.push({
        path: cur.path,
        branch: cur.branch ?? null,
        head: cur.head ?? null,
        bare: cur.bare ?? false,
        ...(cur.locked !== undefined ? { locked: cur.locked } : {}),
      });
    }
    cur = null;
  };
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.length === 0) {
      flush();
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp >= 0 ? line.slice(0, sp) : line;
    const value = sp >= 0 ? line.slice(sp + 1) : "";
    if (key === "worktree") {
      flush();
      cur = { path: value };
    } else if (cur !== null) {
      if (key === "branch") {
        cur.branch = value;
      } else if (key === "HEAD") {
        cur.head = value;
      } else if (key === "bare") {
        cur.bare = true;
      } else if (key === "locked") {
        cur.locked = value.length > 0 ? value : "locked";
      }
    }
  }
  flush();
  return out;
}

function entryBelongsToEpic(entry: WorktreeEntry, epicId: string): boolean {
  const short = shortBranchName(entry.branch);
  if (short === null) {
    return false;
  }
  return (
    short === `${KEEPER_EPIC_BRANCH_PREFIX}${epicId}` ||
    short.startsWith(`${KEEPER_EPIC_BRANCH_PREFIX}${epicId}--`)
  );
}

function shortBranchName(branch: string | null): string | null {
  if (branch === null) {
    return null;
  }
  return branch.startsWith("refs/heads/")
    ? branch.slice("refs/heads/".length)
    : branch;
}

function lanePayload(repo: string, entry: WorktreeEntry): TornDownLane {
  return {
    repo,
    path: entry.path,
    branch: entry.branch ?? "",
  };
}

function classifyLaneOwnership(
  repo: string,
  entry: WorktreeEntry,
): "owned" | "locked" | "foreign" | "ambiguous" {
  if (entry.locked != null) {
    return "locked";
  }
  if (epicIdFromKeeperLaneEntry(entry) === null) {
    return "ambiguous";
  }
  try {
    const repoCommon = runGit(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      repo,
    );
    const laneGit = runGit(
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      entry.path,
    );
    const laneCommon = runGit(
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      entry.path,
    );
    if (
      repoCommon.exitCode !== 0 ||
      laneGit.exitCode !== 0 ||
      laneCommon.exitCode !== 0 ||
      repoCommon.stdout.toString().trim() === "" ||
      laneGit.stdout.toString().trim() === "" ||
      laneCommon.stdout.toString().trim() === ""
    ) {
      return "ambiguous";
    }
    const repoCommonPath = resolve(repoCommon.stdout.toString().trim());
    const laneGitPath = resolve(laneGit.stdout.toString().trim());
    const laneCommonPath = resolve(laneCommon.stdout.toString().trim());
    if (laneGitPath === laneCommonPath) {
      return "foreign";
    }
    if (laneCommonPath !== repoCommonPath) {
      return "foreign";
    }
    return "owned";
  } catch {
    return "ambiguous";
  }
}

function epicIdFromKeeperLaneEntry(entry: WorktreeEntry): string | null {
  const short = shortBranchName(entry.branch);
  if (short === null || !short.startsWith(KEEPER_EPIC_BRANCH_PREFIX)) {
    return null;
  }
  const rest = short.slice(KEEPER_EPIC_BRANCH_PREFIX.length);
  if (rest.length === 0) {
    return null;
  }
  const sep = rest.indexOf("--");
  if (sep === 0) {
    return null;
  }
  return sep === -1 ? rest : rest.slice(0, sep);
}

type BackupForceRemoveResult =
  | { kind: "removed"; snapshotDir: string }
  | { kind: "backup-failed"; detail: string }
  | { kind: "remove-failed"; detail: string; snapshotDir: string };

function backupThenForceRemoveWorktree(
  repo: string,
  entry: WorktreeEntry,
): BackupForceRemoveResult {
  const spoolDir = resolveLaneDirtSpoolDir();
  const nowMs = Date.now();
  const snapshotId = `${nowMs}-${randomUUID().replaceAll("-", "")}`;
  const snapshotDir = resolve(spoolDir, snapshotId);
  try {
    const staged = runGit(
      ["diff", "--cached", "--binary", "--no-ext-diff"],
      entry.path,
    );
    const unstaged = runGit(["diff", "--binary", "--no-ext-diff"], entry.path);
    const untracked = runGit(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      entry.path,
    );
    if (
      staged.exitCode !== 0 ||
      unstaged.exitCode !== 0 ||
      untracked.exitCode !== 0
    ) {
      return { kind: "backup-failed", detail: "git dirt probe failed" };
    }
    const untrackedPaths = untracked.stdout
      .toString()
      .split("\0")
      .filter((p) => p.length > 0);
    for (const relativePath of untrackedPaths) {
      if (!isSafeLaneRelativePath(relativePath)) {
        return {
          kind: "backup-failed",
          detail: `unsafe untracked path ${JSON.stringify(relativePath)}`,
        };
      }
    }
    mkdirSync(spoolDir, { recursive: true });
    mkdirSync(snapshotDir, { recursive: false });
    writeFileSync(resolve(snapshotDir, "staged.patch"), staged.stdout);
    writeFileSync(resolve(snapshotDir, "unstaged.patch"), unstaged.stdout);
    for (const relativePath of untrackedPaths) {
      snapshotUntrackedNode(
        resolve(entry.path, relativePath),
        resolve(snapshotDir, "untracked", relativePath),
      );
    }
    appendFileSync(
      resolve(spoolDir, "index.ndjson"),
      serializeLaneDirtIndex({
        snapshotId,
        createdAtMs: nowMs,
        repoCwd: repo,
        lanePath: entry.path,
        branch: entry.branch ?? "",
        untrackedPaths,
      }),
    );
  } catch (err) {
    try {
      rmSync(snapshotDir, { recursive: true, force: true });
    } catch {}
    return {
      kind: "backup-failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const removed = runGit(["worktree", "remove", "--force", entry.path], repo);
  if (removed.exitCode !== 0) {
    return {
      kind: "remove-failed",
      detail: gitOutput(removed),
      snapshotDir,
    };
  }
  runGit(["worktree", "prune", "--expire", "now"], repo);
  return { kind: "removed", snapshotDir };
}

function resolveLaneDirtSpoolDir(): string {
  const override = process.env.KEEPER_LANE_DIRT_SPOOL_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return resolve(homedir(), ".local", "state", "keeper", "lane-dirt-spool");
}

function isSafeLaneRelativePath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes("\0")) {
    return false;
  }
  const normalized = path.replaceAll("\\", "/");
  return !normalized.split("/").some((part) => part === "" || part === "..");
}

function snapshotUntrackedNode(source: string, target: string): void {
  const st = lstatSync(source);
  mkdirSync(dirname(target), { recursive: true });
  if (st.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), target);
    return;
  }
  if (!st.isFile()) {
    throw new Error(`unsupported untracked node: ${source}`);
  }
  copyFileSync(source, target);
}

function serializeLaneDirtIndex(input: {
  snapshotId: string;
  createdAtMs: number;
  repoCwd: string;
  lanePath: string;
  branch: string;
  untrackedPaths: string[];
}): string {
  const bounded = (s: string): string => s.slice(0, 128);
  const record = {
    schema_version: 1,
    snapshot_id: bounded(input.snapshotId),
    created_at_ms: input.createdAtMs,
    repo: bounded(input.repoCwd),
    lane: bounded(input.lanePath),
    branch: bounded(input.branch),
    staged_patch: "staged.patch",
    unstaged_patch: "unstaged.patch",
    untracked_root: "untracked",
    untracked_count: input.untrackedPaths.length,
    untracked_paths: [] as string[],
    truncated: false,
  };
  for (const path of input.untrackedPaths) {
    record.untracked_paths.push(bounded(path));
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > LANE_DIRT_INDEX_MAX_BYTES) {
      record.untracked_paths.pop();
      record.truncated = true;
      break;
    }
  }
  let line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > LANE_DIRT_INDEX_MAX_BYTES) {
    record.untracked_paths = [];
    record.truncated = true;
    line = `${JSON.stringify(record)}\n`;
  }
  if (Buffer.byteLength(line) > LANE_DIRT_INDEX_MAX_BYTES) {
    line = `${JSON.stringify({
      schema_version: 1,
      snapshot_id: input.snapshotId.slice(0, 32),
      truncated: true,
    })}\n`;
  }
  return line;
}

function runGit(args: string[], cwd: string): GitResult {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd,
      env: gitEnv(),
    });
    return {
      exitCode: proc.exitCode,
      stdout: Buffer.from(proc.stdout),
      stderr: Buffer.from(proc.stderr),
    };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
    };
  }
}

function gitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of WORKTREE_ROUTING_ENV) {
    delete env[key];
  }
  return env;
}

function gitOutput(result: GitResult): string {
  return `${result.stdout.toString()}${result.stderr.toString()}`.trim();
}
