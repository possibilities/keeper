// mv-repo — metadata-only board rewrite for a renamed repo directory. It does
// NOT move any directory on disk: the operator renames the dir, then this verb
// rewrites every stored board path that pointed at the old location so the board
// reads the new one. Across the current project it rewrites each epic's
// primary_repo, each epic's touched_repos entries, and each task's target_repo
// matching <old> -> <new>, re-validates every touched epic through the shared
// post-write integrity gate (the marker is left untouched), and lands the whole
// rewrite in ONE auto-commit.
//
// Matching is by the resolveUserPath-canonicalized STORED STRING, never a stat
// of <old> (the old dir is gone by definition of a rename) and never lowercased
// (APFS is case-insensitive; lowercasing would over-match). <new> is validated
// to exist + carry a .git/ and the verb refuses loudly otherwise. Naturally
// idempotent: a re-run finds nothing matching <old> and is a no-op. old==new
// after canonicalization is also a no-op (no empty-commit churn).

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { validateRepoPath } from "../integrity.ts";
import { integrityGateOrFail } from "../integrity_gate.ts";
import { resolveProject } from "../project.ts";
import {
  atomicWriteJson,
  loadJsonSafe,
  nowIso,
  resolveUserPath,
} from "../store.ts";

interface MvRepoArgs {
  oldPath: string;
  newPath: string;
  format: OutputFormat | null;
}

/** List the JSON stems under `<dataDir>/<sub>` (epics or tasks), sorted. Empty
 * when the dir is absent. */
function jsonStems(dataDir: string, sub: string): string[] {
  const dir = join(dataDir, sub);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

export function runMvRepo(args: MvRepoArgs): number {
  const { oldPath, newPath, format } = args;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  // Canonicalize BOTH sides the same way the setters persist a repo path.
  // <old> is gone on disk, so resolveUserPath falls through to its absolute
  // form (no symlink resolution) — comparison is by that canonical string.
  const oldResolved = resolveUserPath(oldPath);
  const newResolved = resolveUserPath(newPath);

  // <new> must exist and be a git repo — refuse loudly otherwise. <old> is NOT
  // validated (a rename means it is already gone).
  const newErr = validateRepoPath(newResolved, "new_repo");
  if (newErr !== null) {
    emitError(newErr, format);
  }

  // old == new after canonicalize → nothing to do, no empty-commit churn.
  if (oldResolved === newResolved) {
    emitMutating(
      {
        old_repo: oldResolved,
        new_repo: newResolved,
        rewritten_epics: [],
        rewritten_tasks: [],
      },
      {
        verb: "mv-repo",
        target: newResolved,
        repoRoot: ctx.projectPath,
        primaryRepo: null,
      },
    );
    return 0;
  }

  // Pass 1: rewrite task target_repo == old → new (sorted, stable order).
  const rewrittenTasks: string[] = [];
  // Epics whose JSON we touch (primary_repo / touched_repos) — gate these.
  const touchedEpics = new Set<string>();

  for (const taskStem of jsonStems(dataDir, "tasks")) {
    const taskPath = join(dataDir, "tasks", `${taskStem}.json`);
    const taskDef = loadJsonSafe(taskPath);
    if (taskDef === null) {
      continue;
    }
    if (taskDef.target_repo === oldResolved) {
      taskDef.target_repo = newResolved;
      taskDef.updated_at = nowIso();
      atomicWriteJson(taskPath, taskDef, dataDir);
      rewrittenTasks.push(taskStem);
    }
  }

  // Pass 2: rewrite epic primary_repo + each touched_repos entry == old → new.
  const rewrittenEpics: string[] = [];
  for (const epicStem of jsonStems(dataDir, "epics")) {
    const epicPath = join(dataDir, "epics", `${epicStem}.json`);
    const epicDef = loadJsonSafe(epicPath);
    if (epicDef === null) {
      continue;
    }

    let changed = false;
    if (epicDef.primary_repo === oldResolved) {
      epicDef.primary_repo = newResolved;
      changed = true;
    }
    if (Array.isArray(epicDef.touched_repos)) {
      const original = epicDef.touched_repos as unknown[];
      const rewritten = original.map((entry) =>
        entry === oldResolved ? newResolved : entry,
      );
      // Only write when an entry actually flipped (avoid spurious churn).
      if (rewritten.some((entry, i) => entry !== original[i])) {
        epicDef.touched_repos = rewritten;
        changed = true;
      }
    }
    if (changed) {
      epicDef.updated_at = nowIso();
      atomicWriteJson(epicPath, epicDef, dataDir);
      rewrittenEpics.push(epicStem);
      touchedEpics.add(epicStem);
    }
  }

  // A task rewrite whose owning epic JSON did not itself change still needs its
  // epic re-validated (its child tree changed). Derive owning epics from rewritten
  // task ids (the epic id is the prefix before the first dot segment).
  for (const taskStem of rewrittenTasks) {
    const dot = taskStem.indexOf(".");
    if (dot > 0) {
      touchedEpics.add(taskStem.slice(0, dot));
    }
  }

  // Re-validate every touched epic through the shared post-write integrity gate,
  // then bump its updated_at (the marker is left untouched). A gate failure exits
  // 1 (fail-forward: the structural writes already landed), matching the setter
  // family. Stable order so a re-fold / re-run is deterministic.
  for (const epicStem of [...touchedEpics].sort()) {
    const epicPath = join(dataDir, "epics", `${epicStem}.json`);
    if (!existsSync(epicPath)) {
      // A rewritten task whose epic JSON is absent (orphan task) — nothing to
      // gate; its task write already landed and rides the commit.
      continue;
    }
    integrityGateOrFail(epicStem, dataDir, { verb: "mv-repo" });
    const epicDef = loadJsonSafe(epicPath) ?? {};
    epicDef.updated_at = nowIso();
    atomicWriteJson(epicPath, epicDef, dataDir);
  }

  // ONE commit staging every rewritten file (the auto-commit scopes to the
  // session touched-log ∩ dirty data-dir set, so an arbitrary-length pathspec
  // lands in a single commit).
  emitMutating(
    {
      old_repo: oldResolved,
      new_repo: newResolved,
      rewritten_epics: rewrittenEpics,
      rewritten_tasks: rewrittenTasks,
    },
    {
      verb: "mv-repo",
      target: newResolved,
      repoRoot: ctx.projectPath,
      primaryRepo: null,
    },
  );
  return 0;
}
