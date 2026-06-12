// Multi-project discovery — the subset of planctl/discovery.py that claim needs.
//
// Pure filesystem scan: given the configured roots (parent directories), walk
// each root's IMMEDIATE children and return those holding a `.planctl/` dir.
// Immediate children only — nested `.planctl/` (agent worktrees) must not
// double-count. Fail-soft: a root that doesn't exist (or can't be listed) is
// skipped, not an error.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { loadRoots } from "./config.ts";

/** Whether `p` is a directory (following symlinks), false on any stat error. */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Planctl project directories under the given (or configured) roots. A project
 * is an IMMEDIATE child of a root containing a `.planctl/` directory. Nested
 * `.planctl/` dirs are NOT surfaced — one level of children per root. Roots are
 * deduplicated, missing / unlistable roots skipped silently. Returned paths are
 * absolute, deduplicated, and sorted. Mirrors discover_projects. */
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
      if (!isDir(join(child, ".planctl"))) {
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

/** Discovered project roots whose `.planctl/tasks/<task_id>.json` exists. Used
 * by claim to resolve a task's owning project cwd-agnostically. Empty list when
 * no project holds the task (caller maps that to TASK_NOT_FOUND). Mirrors
 * find_projects_with_task. */
export function findProjectsWithTask(
  taskId: string,
  roots?: string[],
): string[] {
  const matches: string[] = [];
  for (const project of discoverProjects(roots)) {
    if (existsSync(join(project, ".planctl", "tasks", `${taskId}.json`))) {
      matches.push(project);
    }
  }
  return matches;
}
