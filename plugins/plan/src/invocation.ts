// Invocation payload builders — the port of planctl/invocation.py.
//
// Field order is the wire contract and must match Python exactly:
//   files, op, target, subject, touched_path_files, repo_root, state_repo
//   (mutating adds session_id after state_repo).
//
// buildPlanInvocationReadonly: read-only verbs touch nothing, so files/subject
// are null and touched_path_files is empty; repo_root === state_repo.
//
// buildPlanInvocation (mutating): session id fail-CLOSED (throws when no
// supported harness identity is present); files = the sorted intersection of the
// session's touched-paths log with git's dirty data-dir set; subject from
// buildSubject; session_id rides after state_repo.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSubject } from "./commit.ts";
import { resolvePlanSessionId } from "./session_id.ts";
import { DATA_DIR_NAMES, resolveDataDirOrDefault } from "./state_path.ts";
import { getVcs } from "./vcs.ts";

export interface ReadonlyInvocation {
  files: null;
  op: string;
  target: string | null;
  subject: null;
  touched_path_files: never[];
  repo_root: string;
  state_repo: string;
}

export function buildPlanInvocationReadonly(
  verb: string,
  repoRoot: string,
  target: string | null = null,
): ReadonlyInvocation {
  return {
    files: null,
    op: verb,
    target,
    subject: null,
    touched_path_files: [],
    repo_root: repoRoot,
    state_repo: repoRoot,
  };
}

export interface MutatingInvocation {
  files: string[];
  op: string;
  target: string;
  subject: string;
  touched_path_files: string[];
  repo_root: string;
  state_repo: string;
  session_id: string;
}

/** Build the mutating plan_invocation payload. Mirrors
 * planctl.invocation.build_planctl_invocation:
 *  - session id from the neutral harness resolver, fail-CLOSED when absent,
 *  - touched_path_files = the session's recorded touched-log filenames,
 *  - files = sorted(touched-paths content ∩ dirty data-dir set),
 *  - state_repo = primaryRepo when given, else repoRoot.
 *
 * `target` is the epic/task/project id; `detail` is the optional em-dash
 * subject suffix. Throws RuntimeError-equivalent when the session id is absent
 * (Python raises RuntimeError; here a plain Error with the same message). */
export function buildPlanInvocation(
  verb: string,
  target: string,
  detail: string | null | undefined,
  opts: {
    repoRoot: string;
    primaryRepo?: string | null;
  },
): MutatingInvocation {
  const { repoRoot, primaryRepo = null } = opts;
  const dataDir = resolveDataDirOrDefault(repoRoot);

  const sessionId = resolvePlanSessionId();
  if (sessionId === null) {
    throw new Error(
      "planctl build_planctl_invocation requires a resolvable session_id; " +
        "set KEEPER_PLAN_SESSION_ID for an explicit invocation, or run inside " +
        "a tracked Claude or Keeper agent session.",
    );
  }

  const touchedPathFiles = readTouchedFiles(dataDir, sessionId);

  const touched = readTouchedPaths(repoRoot, sessionId);
  const dirty = dirtyDataDirPaths(repoRoot);
  const files = [...touched].filter((p) => dirty.has(p)).sort();

  const subject = buildSubject(verb, target, detail);

  // state_repo: primaryRepo (from epic.primary_repo) takes precedence; falls
  // back to repoRoot for verbs with no epic/task target.
  const stateRepo = primaryRepo !== null ? primaryRepo : repoRoot;

  return {
    files,
    op: verb,
    target,
    subject,
    touched_path_files: touchedPathFiles,
    repo_root: repoRoot,
    state_repo: stateRepo,
    session_id: sessionId,
  };
}

/** The touched-log record filenames for `sessionId` (for hook cleanup, G7) —
 * the basenames of `*.txt` under sessions/<sid>/touched/. Mirrors
 * store._read_touched_files. Empty list when the dir is absent. */
function readTouchedFiles(dataDir: string, sessionId: string): string[] {
  const touchedDir = join(dataDir, "state", "sessions", sessionId, "touched");
  if (!existsSync(touchedDir)) {
    return [];
  }
  return readdirSync(touchedDir)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => join(touchedDir, name))
    .sort();
}

/** Paths recorded for `sessionId` in the touched-paths log, each a POSIX string
 * relative to repoRoot starting with the `.keeper/` data-dir prefix. The
 * touched-log lives under the data dir; a `..` traversal is a bug upstream and
 * throws loud, while a prefix outside the data-dir set is benign migration
 * residue and is logged + skipped so one stale record can't wedge the op. */
function readTouchedPaths(repoRoot: string, sessionId: string): string[] {
  const dataDir = resolveDataDirOrDefault(repoRoot);
  const touchedDir = join(dataDir, "state", "sessions", sessionId, "touched");
  if (!existsSync(touchedDir)) {
    return [];
  }

  const dataDirPrefixes = DATA_DIR_NAMES.map((name) => `${name}/`);

  const paths: string[] = [];
  for (const name of readdirSync(touchedDir)) {
    if (!name.endsWith(".txt")) {
      continue;
    }
    const file = join(touchedDir, name);
    const raw = readFileSync(file, "utf-8").trim();
    if (!raw) {
      continue;
    }
    // Security: path traversal is a hard reject — that IS a bug signal.
    if (raw.split("/").includes("..")) {
      throw new Error(
        `Touched-paths record contains path traversal: '${raw}' ` +
          `(file: ${file}). This is a bug — report it.`,
      );
    }
    // A path outside the data-dir set is benign migration residue (e.g. a stale
    // legacy `.planctl/` record from before the `.keeper/` rename): skip it so
    // one stale record can't wedge the whole op.
    if (!dataDirPrefixes.some((pfx) => raw.startsWith(pfx))) {
      process.stderr.write(
        `Skipping stale touched-paths record (non-data-dir path): ` +
          `'${raw}' (file: ${file}).\n`,
      );
      continue;
    }
    paths.push(raw);
  }
  return paths;
}

/** The set of dirty (modified/untracked) data-dir paths from git, scoped to the
 * `.keeper/` data dir. Mirrors invocation._dirty_planctl_paths: `git status
 * --porcelain --untracked-files=all -- <data dirs>` (the flag is load-bearing —
 * without it new files show as a directory-level `?? .keeper/epics/` and the
 * intersection returns empty). The parse matches Python exactly: line[3:].strip(),
 * rename "a -> b" takes b. Routes through the PlanVcs facade — real git in
 * production, the snapshot-diffing fake in tests. */
function dirtyDataDirPaths(repoRoot: string): Set<string> {
  return getVcs().dirtyDataDirPaths(repoRoot, DATA_DIR_NAMES);
}
