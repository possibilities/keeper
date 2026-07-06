// epic set-primary-repo / set-touched-repos — the port of
// run_epic_set_primary_repo.py and run_epic_set_touched_repos.py. Warn-and-write
// repo setters: a non-`.git/` path produces a warning in the envelope's
// `warnings: [...]` field AND a `WARN:` line on stderr, but the write still lands
// and the exit code stays 0 (CWE-367 deferred-validation). Both ride the shared
// post-write integrity gate with check_filesystem_repos=false, so the gate does
// not reject the bad path; the marker is left untouched (arm-exclusive latch).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { validateRepoPath } from "../integrity.ts";
import { runSetter } from "../integrity_gate.ts";
import { resolveProject } from "../project.ts";
import {
  atomicWriteJson,
  loadJson,
  loadJsonSafe,
  nowIso,
  resolveUserPath,
} from "../store.ts";

/** Build the warn message + emit the WARN: stderr line for a bad repo path.
 * Mirrors the verb-side wrap of _validate_repo_path's error. */
function warnFor(err: string, epicId: string): string {
  const msg = `${err}; 'keeper plan validate --epic ${epicId}' will reject this until the path is fixed`;
  process.stderr.write(`WARN: ${msg}\n`);
  return msg;
}

interface SetPrimaryRepoArgs {
  epicId: string;
  path: string;
  format: OutputFormat | null;
}

export function runEpicSetPrimaryRepo(args: SetPrimaryRepoArgs): void {
  const { epicId, path: pathArg, format } = args;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const resolved = resolveUserPath(pathArg);

  const warnings: string[] = [];
  const err = validateRepoPath(resolved, "primary_repo");
  if (err !== null) {
    warnings.push(warnFor(err, epicId));
  }

  runSetter(epicId, dataDir, {
    verb: "set-primary-repo",
    hooks: {
      apply: () => {
        const epicDef = loadJson(epicPath);
        epicDef.primary_repo = resolved;
        epicDef.updated_at = nowIso();
        atomicWriteJson(epicPath, epicDef, dataDir);
      },
    },
    stampUpdatedAt: false,
  });

  emitMutating(
    { epic_id: epicId, primary_repo: resolved, warnings },
    {
      verb: "set-primary-repo",
      target: epicId,
      repoRoot: ctx.projectPath,
      primaryRepo: resolved,
    },
  );
}

interface SetTouchedReposArgs {
  epicId: string;
  paths: string;
  format: OutputFormat | null;
}

export function runEpicSetTouchedRepos(args: SetTouchedReposArgs): void {
  const { epicId, paths: pathsArg, format } = args;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const touchedRepos = pathsArg
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => resolveUserPath(p));

  const warnings: string[] = [];
  for (const repoPath of touchedRepos) {
    const err = validateRepoPath(repoPath, "touched_repos");
    if (err !== null) {
      warnings.push(warnFor(err, epicId));
    }
  }

  runSetter(epicId, dataDir, {
    verb: "set-touched-repos",
    hooks: {
      apply: () => {
        const epicDef = loadJson(epicPath);
        epicDef.touched_repos = touchedRepos;
        epicDef.updated_at = nowIso();
        atomicWriteJson(epicPath, epicDef, dataDir);
      },
    },
    stampUpdatedAt: false,
  });

  const primaryRepo =
    (loadJsonSafe(epicPath)?.primary_repo as string | null | undefined) ?? null;

  emitMutating(
    { epic_id: epicId, touched_repos: touchedRepos, warnings },
    {
      verb: "set-touched-repos",
      target: epicId,
      repoRoot: ctx.projectPath,
      primaryRepo,
    },
  );
}
