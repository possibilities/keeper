// Multi-project discovery — the subset of planctl/discovery.py that claim needs.
//
// Pure filesystem scan: given the configured roots (parent directories), walk
// each root's IMMEDIATE children and return those holding a `.keeper/` data dir.
// Immediate children only — nested data
// dirs (agent worktrees) must not double-count. Fail-soft: a root that doesn't
// exist (or can't be listed) is skipped, not an error.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadRoots } from "./config.ts";
import { parseId } from "./ids.ts";
import { classifyCwdVantage } from "./project.ts";
import {
  hasDataDir,
  resolveDataDir,
  resolveDataDirOrDefault,
} from "./state_path.ts";

/** Whether `p` is a directory (following symlinks), false on any stat error. */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Planctl project directories under the given (or configured) roots. A project
 * is an IMMEDIATE child of a root containing a `.keeper/` data dir. Nested data
 * dirs are NOT surfaced — one level
 * of children per root. Roots are deduplicated, missing / unlistable roots
 * skipped silently. Returned paths are absolute, deduplicated, and sorted.
 * Mirrors discover_projects. */
export function discoverProjects(roots?: string[]): string[] {
  const rootList = roots ?? loadRoots();

  const projects: string[] = [];
  const seen = new Set<string>();
  const seenRoots = new Set<string>();

  for (const root of rootList) {
    if (seenRoots.has(root)) {
      continue;
    }
    seenRoots.add(root);

    let children: string[];
    try {
      children = readdirSync(root)
        .map((name) => join(root, name))
        .sort();
    } catch {
      // Root doesn't exist or can't be listed — skip, not an error.
      continue;
    }

    for (const child of children) {
      if (!isDir(child)) {
        continue;
      }
      if (!hasDataDir(child)) {
        continue;
      }
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      projects.push(child);
    }
  }

  return projects.sort();
}

/** Discovered project roots whose data dir holds `tasks/<task_id>.json`. Used
 * by claim to resolve a task's owning project cwd-agnostically. Empty list when
 * no project holds the task (caller maps that to TASK_NOT_FOUND). Mirrors
 * find_projects_with_task. */
export function findProjectsWithTask(
  taskId: string,
  roots?: string[],
): string[] {
  const matches: string[] = [];
  for (const project of discoverProjects(roots)) {
    const dataDir = resolveDataDir(project);
    if (
      dataDir !== null &&
      existsSync(join(dataDir, "tasks", `${taskId}.json`))
    ) {
      matches.push(project);
    }
  }
  return matches;
}

/** Outcome of resolveEpicGlobally — the port of discovery.ResolveResult.
 *
 * Distinguishes the three observable outcomes callers branch on:
 *  - **resolved**: `projectPath` is the owning root, `epicPath` the resolved
 *    data dir's `epics/<id>.json` inside it, `resolvedId` the full slug id
 *    (canonical form for a number-only `fn-N` input). `owners` is empty.
 *  - **not found**: `projectPath`/`epicPath`/`resolvedId` null, `owners` empty.
 *  - **ambiguous**: the id lives in two-or-more projects; all null, `owners`
 *    lists every owner. Callers surface dep_ambiguous_id — never a silent pick.
 */
export class ResolveResult {
  readonly projectPath: string | null;
  readonly epicPath: string | null;
  readonly owners: string[];
  readonly resolvedId: string | null;

  constructor(opts: {
    projectPath?: string | null;
    epicPath?: string | null;
    owners?: string[];
    resolvedId?: string | null;
  }) {
    this.projectPath = opts.projectPath ?? null;
    this.epicPath = opts.epicPath ?? null;
    this.owners = opts.owners ?? [];
    this.resolvedId = opts.resolvedId ?? null;
  }

  /** True iff the id resolved to exactly one project. */
  get resolved(): boolean {
    return this.projectPath !== null;
  }

  /** True iff two-or-more projects carry the id. */
  get ambiguous(): boolean {
    return this.owners.length > 1;
  }
}

/** realpath of `p`, or `p` itself when it can't be resolved (matches the
 * Python `try: p.resolve() except: p` fallback used to dedup the cwd path). */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolve `epicId` against one project, returning `[fullId, epicPath]` or null.
 * A full-slug input matches its own `<id>.json` exactly (the hot path); a
 * number-only `fn-N` matches the epic whose parsed epic-num equals N by INTEGER
 * equality (never string-prefix: `fn-1` never matches `fn-10`). Mirrors
 * discovery._match_epic_in_project. */
function matchEpicInProject(
  project: string,
  epicId: string,
): [string, string] | null {
  const dataDir = resolveDataDir(project);
  if (dataDir === null) {
    return null;
  }
  const epicsDir = join(dataDir, "epics");

  const exact = join(epicsDir, `${epicId}.json`);
  if (existsSync(exact)) {
    return [epicId, exact];
  }

  const [wantEpic, wantTask] = parseId(epicId);
  if (wantEpic === null || wantTask !== null) {
    return null;
  }
  // Only treat the input as number-only when it has NO slug tail — a slug input
  // that simply doesn't exist must not match a same-number epic.
  if (epicId !== `fn-${wantEpic}`) {
    return null;
  }
  let entries: string[];
  try {
    entries = readdirSync(epicsDir)
      .filter((n) => n.startsWith("fn-") && n.endsWith(".json"))
      .sort();
  } catch {
    return null;
  }
  for (const entry of entries) {
    const stem = entry.slice(0, -".json".length);
    const [candEpic, candTask] = parseId(stem);
    if (candTask !== null) {
      continue;
    }
    if (candEpic === wantEpic) {
      return [stem, join(epicsDir, entry)];
    }
  }
  return null;
}

/** `[projectRoot, fullEpicId]` for every project matching `epicId`. Sibling of
 * findProjectsWithEpic that carries the matched epic's FULL slug id, so a
 * number-only `fn-N` normalizes to canonical form on the write side. Mirrors
 * discovery._find_epic_matches. */
function findEpicMatches(epicId: string, roots?: string[]): [string, string][] {
  const matches: [string, string][] = [];
  for (const project of discoverProjects(roots)) {
    const hit = matchEpicInProject(project, epicId);
    if (hit !== null) {
      matches.push([project, hit[0]]);
    }
  }
  return matches;
}

/** Discovered project roots whose data dir holds `epics/<epicId>.json`.
 * Accepts a number-only `fn-N` (integer-equality) as well as a full slug.
 * Mirrors discovery.find_projects_with_epic. */
export function findProjectsWithEpic(
  epicId: string,
  roots?: string[],
): string[] {
  return findEpicMatches(epicId, roots).map(([project]) => project);
}

/** Resolve an epic id cwd-then-global, distinguishing not-found from ambiguous.
 *
 * Order: (1) cwd short-circuit — if cwd is a planctl project carrying the id, it
 * wins and never counts toward ambiguity; (2) roots discovery — exactly one
 * match resolves, zero is not-found, many is ambiguous (legacy dup state). The
 * roots step is FAIL-SOFT: a discovery that throws or yields nothing contributes
 * no candidates (caller sees not-found, never an exception), while the cwd
 * short-circuit still works without configured roots. Mirrors
 * discovery.resolve_epic_globally. */
export function resolveEpicGlobally(
  epicId: string,
  roots?: string[],
): ResolveResult {
  // 1. Cwd short-circuit — lane-aware. A redirect-eligible worktree lane resolves
  // to its authoritative main STATE repo (the same `classifyCwdVantage` seam the
  // id-less resolver uses), so an id-addressed verb reads/serves the state repo's
  // definition, never the lane's lagging committed snapshot.
  let cwdRoot: string | null;
  try {
    cwdRoot = classifyCwdVantage().effectiveRoot;
  } catch {
    cwdRoot = null;
  }
  if (cwdRoot !== null && hasDataDir(cwdRoot)) {
    const cwdHit = matchEpicInProject(cwdRoot, epicId);
    if (cwdHit !== null) {
      const [resolvedId, epicPath] = cwdHit;
      return new ResolveResult({
        projectPath: cwdRoot,
        epicPath,
        resolvedId,
      });
    }
  }

  // 2. Roots discovery — fail-soft.
  let matches: [string, string][];
  try {
    matches = findEpicMatches(epicId, roots);
  } catch {
    matches = [];
  }

  // Filter the cwd path out so cwd never double-counts as ambiguous.
  if (cwdRoot !== null) {
    const cwdReal = realpathOr(cwdRoot);
    matches = matches.filter(([m]) => realpathOr(m) !== cwdReal);
  }

  if (matches.length === 0) {
    return new ResolveResult({ projectPath: null, epicPath: null });
  }
  if (matches.length === 1) {
    const [owner, resolvedId] = matches[0] as [string, string];
    return new ResolveResult({
      projectPath: owner,
      epicPath: join(
        resolveDataDirOrDefault(owner),
        "epics",
        `${resolvedId}.json`,
      ),
      resolvedId,
    });
  }
  return new ResolveResult({
    projectPath: null,
    epicPath: null,
    owners: matches.map(([m]) => m),
  });
}

// Filename shape for scanEpicIdsGlobal: capture the bare epic id (no ext) of a
// `<id>.json` / `<id>.md` under epics/ or specs/. Mirrors the Python pattern.
const EPIC_FILE_REGEX =
  /^(fn-\d+(?:-[a-z0-9][a-z0-9-]*[a-z0-9]|-[a-z0-9]{1,3})?)\.(json|md)$/;

/** Map every existing bare epic id across `projectPaths` to its owning project.
 * Walks each project's data dir `epics/*` and `specs/fn-*`; a project with no
 * data dir contributes nothing (fail-soft). When the same id appears in multiple
 * projects the LAST-WALKED owner wins — the value feeds human-readable
 * dup-detection messages only, NEVER resolver semantics (use resolveEpicGlobally
 * for that). Mirrors ids.scan_epic_ids_global; listings are sorted at the call
 * site so the last-walked winner is deterministic. */
export function scanEpicIdsGlobal(
  projectPaths: string[],
): Record<string, string> {
  const owners: Record<string, string> = {};
  for (const projectPath of projectPaths) {
    const dataDir = resolveDataDir(projectPath);
    if (dataDir === null) {
      continue;
    }
    for (const sub of ["epics", "specs"]) {
      const subDir = join(dataDir, sub);
      let entries: string[];
      try {
        entries = readdirSync(subDir).sort();
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith("fn-")) {
          continue;
        }
        const match = EPIC_FILE_REGEX.exec(entry);
        if (match) {
          owners[match[1] as string] = projectPath;
        }
      }
    }
  }
  return owners;
}

/** The owning project path if ``epicId`` already exists in a DIFFERENT
 * discovered project, else null — the global-name uniqueness check at epic
 * allocation time, so two projects can never mint the same full ``fn-N-slug``
 * even though per-project numbering is independent.
 *
 * Excludes ``localProjectPath`` (a same-project collision is the caller's own
 * epic-path-exists backstop). FAIL-SOFT: if discovery raises or yields no
 * foreign projects, returns null so a fresh / foreign system never hard-breaks
 * creation. Mirrors run_epic_create._check_global_name_unique. */
export function checkGlobalNameUnique(
  epicId: string,
  localProjectPath: string,
): string | null {
  let projects: string[];
  try {
    projects = discoverProjects();
  } catch {
    return null;
  }

  let local: string;
  try {
    local = realpathSync(localProjectPath);
  } catch {
    local = localProjectPath;
  }
  const foreign = projects.filter((p) => {
    let resolved: string;
    try {
      resolved = realpathSync(p);
    } catch {
      resolved = p;
    }
    return resolved !== local;
  });
  if (foreign.length === 0) {
    return null;
  }

  const owners = scanEpicIdsGlobal(foreign);
  return owners[epicId] ?? null;
}
