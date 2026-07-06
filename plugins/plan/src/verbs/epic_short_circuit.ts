// epic invalidate — the short-circuit pattern: when the epic is already in the
// target state (last_validated_at already null), emit a readonly envelope and
// write NOTHING (zero commits). Otherwise null the marker + bump updated_at and
// route through the mutating seam so one chore(plan): <verb> <epic> commit
// lands. Not an integrity-gate member.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitMutating, emitReadonly } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { resolveProject } from "../project.ts";
import { atomicWriteJson, loadJson, nowIso } from "../store.ts";

interface ShortCircuitArgs {
  epicId: string;
  format: OutputFormat | null;
}

export function runEpicInvalidate(args: ShortCircuitArgs): void {
  const { epicId, format } = args;

  const ctx = resolveProject(format);
  const epicPath = join(ctx.dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const epicDef = loadJson(epicPath);
  const primaryRepo =
    (epicDef.primary_repo as string | null | undefined) ?? null;

  // Short-circuit: marker already null -> readonly envelope only, no write.
  if (
    epicDef.last_validated_at === null ||
    epicDef.last_validated_at === undefined
  ) {
    const pc = buildPlanInvocationReadonly(
      "invalidate",
      ctx.projectPath,
      epicId,
    );
    emitReadonly({ epic_id: epicId, short_circuited: true }, pc);
    return;
  }

  epicDef.last_validated_at = null;
  epicDef.updated_at = nowIso();
  atomicWriteJson(epicPath, epicDef, ctx.dataDir);

  emitMutating(
    { epic_id: epicId, short_circuited: false },
    {
      verb: "invalidate",
      target: epicId,
      repoRoot: ctx.projectPath,
      primaryRepo,
    },
  );
}
