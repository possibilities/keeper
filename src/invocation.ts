// Invocation payload builders — the port of planctl/invocation.py.
//
// Field order is the wire contract and must match Python exactly:
//   files, op, target, subject, touched_path_files, repo_root, state_repo
//   (mutating adds queue_jump, session_id after state_repo).
//
// buildPlanctlInvocationReadonly: read-only verbs touch nothing, so files/subject
// are null and touched_path_files is empty; repo_root === state_repo.
//
// buildPlanctlInvocation (mutating): session id fail-CLOSED (throws when
// CLAUDE_CODE_SESSION_ID is absent); files = the sorted intersection of the
// session's touched-paths log with git's dirty .planctl/ set; subject from
// buildSubject; queue_jump + session_id ride after state_repo.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSubject } from "./commit.ts";

export interface ReadonlyInvocation {
  files: null;
  op: string;
  target: string | null;
  subject: null;
  touched_path_files: never[];
  repo_root: string;
  state_repo: string;
}

export function buildPlanctlInvocationReadonly(
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
  queue_jump: boolean;
  session_id: string;
}

/** Build the mutating planctl_invocation payload. Mirrors
 * planctl.invocation.build_planctl_invocation:
 *  - session id from CLAUDE_CODE_SESSION_ID, fail-CLOSED (throw when absent),
 *  - touched_path_files = the session's recorded touched-log filenames,
 *  - files = sorted(touched-paths content ∩ dirty .planctl/ set),
 *  - state_repo = primaryRepo when given, else repoRoot.
 *
 * `target` is the epic/task/project id; `detail` is the optional em-dash
 * subject suffix. Throws RuntimeError-equivalent when the session id is absent
 * (Python raises RuntimeError; here a plain Error with the same message). */
export function buildPlanctlInvocation(
  verb: string,
  target: string,
  detail: string | null | undefined,
  opts: {
    repoRoot: string;
    primaryRepo?: string | null;
    queueJump?: boolean;
  },
): MutatingInvocation {
  const { repoRoot, primaryRepo = null, queueJump = false } = opts;
  const planctlDir = join(repoRoot, ".planctl");

  // Session id — CLAUDE_CODE_SESSION_ID is the sole source. Fail-closed on
  // absence: the claude binary ships it intrinsically on every session, so it is
  // always present for a mutating verb inside a Claude harness.
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || null;
  if (sessionId === null) {
    throw new Error(
      "planctl build_planctl_invocation requires a resolvable session_id; " +
        "CLAUDE_CODE_SESSION_ID must be set (the claude binary ships it " +
        "intrinsically inside a Claude harness; tests and manual invocations " +
        "must set it themselves).",
    );
  }

  const touchedPathFiles = readTouchedFiles(planctlDir, sessionId);

  const touched = readTouchedPaths(repoRoot, sessionId);
  const dirty = dirtyPlanctlPaths(repoRoot);
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
    queue_jump: queueJump,
    session_id: sessionId,
  };
}

/** The touched-log record filenames for `sessionId` (for hook cleanup, G7) —
 * the basenames of `*.txt` under sessions/<sid>/touched/. Mirrors
 * store._read_touched_files. Empty list when the dir is absent. */
function readTouchedFiles(planctlDir: string, sessionId: string): string[] {
  const touchedDir = join(
    planctlDir,
    "state",
    "sessions",
    sessionId,
    "touched",
  );
  if (!existsSync(touchedDir)) {
    return [];
  }
  return readdirSync(touchedDir)
    .filter((name) => name.endsWith(".txt"))
    .map((name) => join(touchedDir, name))
    .sort();
}

/** Paths recorded for `sessionId` in the touched-paths log, each a POSIX string
 * relative to repoRoot starting with `.planctl/`. Mirrors
 * invocation._read_touched_paths: a path with `..` or a non-`.planctl/` prefix
 * is a bug upstream and throws loud, never silently dropped. */
function readTouchedPaths(repoRoot: string, sessionId: string): string[] {
  const touchedDir = join(
    repoRoot,
    ".planctl",
    "state",
    "sessions",
    sessionId,
    "touched",
  );
  if (!existsSync(touchedDir)) {
    return [];
  }

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
    // Security: reject traversal and non-.planctl/ paths.
    if (raw.split("/").includes("..")) {
      throw new Error(
        `Touched-paths record contains path traversal: '${raw}' ` +
          `(file: ${file}). This is a bug — report it.`,
      );
    }
    if (!raw.startsWith(".planctl/")) {
      throw new Error(
        `Touched-paths record contains non-.planctl/ path: '${raw}' ` +
          `(file: ${file}). This is a bug — report it.`,
      );
    }
    paths.push(raw);
  }
  return paths;
}

/** The set of dirty (modified/untracked) .planctl/ paths from git. Mirrors
 * invocation._dirty_planctl_paths: `git status --porcelain --untracked-files=all
 * -- .planctl/` (the flag is load-bearing — without it new files show as a
 * directory-level `?? .planctl/epics/` and the intersection returns empty). The
 * parse matches Python exactly: line[3:].strip(), rename "a -> b" takes b. */
function dirtyPlanctlPaths(repoRoot: string): Set<string> {
  const proc = Bun.spawnSync(
    [
      "git",
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      ".planctl/",
    ],
    { cwd: repoRoot },
  );
  const paths = new Set<string>();
  for (const line of proc.stdout.toString().split("\n")) {
    if (line.length < 4) {
      continue;
    }
    // git status --porcelain: XY <path> (first 3 chars are status + space).
    let rel = line.slice(3).trim();
    // Handle renames: "old -> new" — take the new path.
    if (rel.includes(" -> ")) {
      rel = rel.split(" -> ", 2)[1] as string;
    }
    if (rel) {
      paths.add(rel);
    }
  }
  return paths;
}
