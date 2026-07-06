// epic set-branch / set-title — the port of run_epic_set_branch.py and
// run_epic_set_title.py. Plain metadata writes: set the field, bump updated_at,
// route straight through the mutating seam. NEITHER is an integrity-gate member, so
// last_validated_at is left untouched (the test pins set-branch leaving the
// marker null).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { resolveProject } from "../project.ts";
import { atomicWriteJson, loadJson, nowIso } from "../store.ts";

interface SetBranchArgs {
  epicId: string;
  branch: string;
  format: OutputFormat | null;
}

export function runEpicSetBranch(args: SetBranchArgs): void {
  const { epicId, branch, format } = args;

  const ctx = resolveProject(format);
  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const epicDef = loadJson(epicPath);
  epicDef.branch_name = branch;
  epicDef.updated_at = nowIso();
  atomicWriteJson(epicPath, epicDef, ctx.dataDir);

  emitMutating(
    { epic_id: epicId, branch_name: branch },
    { verb: "set-branch", target: epicId, repoRoot: ctx.projectPath },
  );
}

interface SetTitleArgs {
  epicId: string;
  title: string;
  format: OutputFormat | null;
}

export function runEpicSetTitle(args: SetTitleArgs): void {
  const { epicId, title, format } = args;

  const ctx = resolveProject(format);
  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const epicDef = loadJson(epicPath);
  epicDef.title = title;
  epicDef.updated_at = nowIso();
  atomicWriteJson(epicPath, epicDef, ctx.dataDir);

  emitMutating(
    { epic_id: epicId, title },
    { verb: "set-title", target: epicId, repoRoot: ctx.projectPath },
  );
}
