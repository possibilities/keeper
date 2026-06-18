// epic add-dep / rm-dep — the port of run_epic_add_dep.py and the rm side of the
// dep editors. add-dep resolves the dep id cwd-then-global (ambiguous -> hard
// error), normalizes a number-only fn-N to the full slug, appends the edge,
// bumps updated_at, then rides the shared restamp pipeline. The rollback hook
// restores the pre-write epic JSON when the post-write integrity gate rejects an
// introduced cycle, so a rejected dep leaves disk untouched. rm-dep is the
// idempotent remove + restamp; removing a non-present dep is still success.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveEpicGlobally } from "../discovery.ts";
import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { resolveProject } from "../project.ts";
import { atomicWriteJson, loadJson, nowIso } from "../store.ts";
import { runSetter } from "../validation_restamp.ts";

interface DepEditArgs {
  epicId: string;
  depId: string;
  format: OutputFormat | null;
}

export function runEpicAddDep(args: DepEditArgs): void {
  const { epicId, depId, format } = args;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }
  if (epicId === depId) {
    emitError(`Epic cannot depend on itself: ${epicId}`, format);
  }

  // Dep existence resolved globally so cross-project deps wire. Ambiguous (dup)
  // surfaces as a hard error — never a silent pick.
  const depResolution = resolveEpicGlobally(depId);
  if (depResolution.ambiguous) {
    const owners = depResolution.owners.join(", ");
    emitError(
      `Epic ${depId} exists in multiple projects (cannot wire dep): ${owners}`,
      format,
    );
  }
  if (!depResolution.resolved) {
    emitError(`Epic not found: ${depId}`, format);
  }

  // Normalize a number-only fn-N to the resolved FULL slug before persisting.
  const fullDepId = depResolution.resolvedId as string;

  const preWriteEpicDef = loadJson(epicPath);
  const deps = [
    ...((preWriteEpicDef.depends_on_epics as string[] | undefined) ?? []),
  ];

  if (deps.includes(fullDepId)) {
    emitError(`Dependency already exists: ${epicId} -> ${fullDepId}`, format);
  }

  deps.push(fullDepId);

  runSetter(epicId, dataDir, {
    verb: "add-dep",
    // add-dep stamps updated_at in its apply; the tail writes last_validated_at
    // only (no re-bump). Mirrors run_epic_add_dep.py's post-restamp write.
    stampUpdatedAt: false,
    hooks: {
      apply: () => {
        const epicDef = { ...preWriteEpicDef };
        epicDef.depends_on_epics = deps;
        epicDef.updated_at = nowIso();
        atomicWriteJson(epicPath, epicDef, dataDir);
      },
      // Roll the dep write back if the post-write integrity gate rejects it
      // (e.g. an introduced cycle), so a rejected dep leaves disk untouched.
      rollback: () => {
        atomicWriteJson(epicPath, preWriteEpicDef, dataDir);
      },
    },
  });

  emitMutating(
    { epic_id: epicId, depends_on_epics: deps },
    { verb: "add-dep", target: epicId, repoRoot: ctx.projectPath },
  );
}

export function runEpicRmDep(args: DepEditArgs): void {
  const { epicId, depId, format } = args;

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const epicDef = loadJson(epicPath);
  const deps = [...((epicDef.depends_on_epics as string[] | undefined) ?? [])];
  const remaining = deps.filter((d) => d !== depId);

  runSetter(epicId, dataDir, {
    verb: "rm-dep",
    stampUpdatedAt: false,
    hooks: {
      apply: () => {
        const ed = loadJson(epicPath);
        ed.depends_on_epics = remaining;
        ed.updated_at = nowIso();
        atomicWriteJson(epicPath, ed, dataDir);
      },
    },
  });

  emitMutating(
    { epic_id: epicId, depends_on_epics: remaining },
    { verb: "rm-dep", target: epicId, repoRoot: ctx.projectPath },
  );
}
