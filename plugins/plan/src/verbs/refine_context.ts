// refine-context verb — the port of planctl/run_refine_context.py. Read-only by
// default: returns one envelope carrying the epic metadata, raw epic spec
// markdown ("" when absent), and the child task list (each with its own spec_md)
// so /plan:plan's Phase R2 fires one verb instead of show + cat + tasks + per-
// task cat. Conditionally MUTATING under --invalidate: short-circuits to a
// readonly envelope when last_validated_at is already null, else writes the
// marker to null + bumps updated_at and rides the mutating emit seam so one
// chore(planctl): refine-context <epic> commit lands. Typed errors —
// BAD_EPIC_ID / EPIC_NOT_FOUND — emit {success:false, error:{code,message}}.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import { emitMutating, emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import { buildPlanctlInvocationReadonly } from "../invocation.ts";
import { resolveProject } from "../project.ts";
import { atomicWriteJson, loadJson, nowIso } from "../store.ts";

/** Emit a typed refine-context error envelope and exit 1. No invocation. */
function emitRefineError(
  code: string,
  message: string,
  format: OutputFormat | null,
): never {
  formatOutput({ success: false, error: { code, message } }, format);
  process.exit(1);
}

/** Raw spec markdown for an epic/task id; "" when the spec file is absent. */
function readSpecMd(dataDir: string, specId: string): string {
  const specPath = join(dataDir, "specs", `${specId}.md`);
  if (!existsSync(specPath)) {
    return "";
  }
  return readFileSync(specPath, "utf-8");
}

export function runRefineContext(opts: {
  epicId: string;
  invalidate: boolean;
  format: OutputFormat | null;
}): void {
  const { epicId, invalidate, format } = opts;

  if (!isEpicId(epicId)) {
    emitRefineError("BAD_EPIC_ID", `Invalid epic ID: ${epicId}`, format);
  }

  const ctx = resolveProject(format);
  const dataDir = ctx.dataDir;

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitRefineError(
      "EPIC_NOT_FOUND",
      `Epic not found in ${ctx.projectPath}: ${epicId}`,
      format,
    );
  }

  const epicDef = loadEpic(ctx, epicId);
  const epicSpecMd = readSpecMd(dataDir, epicId);

  const mergedTasks = loadTasksForEpic(ctx, epicId).sort(
    (a, b) =>
      taskSortKey((a.id as string | undefined) ?? "") -
      taskSortKey((b.id as string | undefined) ?? ""),
  );
  const tasks = mergedTasks.map((t) => ({
    id: t.id ?? null,
    title: t.title ?? null,
    status: t.status ?? "todo",
    deps: t.depends_on ?? [],
    snippets: t.snippets ?? [],
    bundles: t.bundles ?? [],
    spec_md: readSpecMd(dataDir, (t.id as string | undefined) ?? ""),
  }));

  if (invalidate) {
    if (
      epicDef.last_validated_at === null ||
      epicDef.last_validated_at === undefined
    ) {
      // Short-circuit: marker already null -> readonly envelope, no write.
      const pc = buildPlanctlInvocationReadonly(
        "refine-context",
        ctx.projectPath,
        epicId,
      );
      emitReadonly(
        {
          epic_id: epicId,
          title: epicDef.title ?? null,
          branch: epicDef.branch_name ?? null,
          last_validated_at: null,
          epic_spec_md: epicSpecMd,
          tasks,
          invalidated: false,
        },
        pc,
      );
      return;
    }

    // Stamped -> None transition. Load raw epic JSON so the write round-trips
    // the persisted field set.
    const rawEpic = loadJson(epicPath);
    rawEpic.last_validated_at = null;
    rawEpic.updated_at = nowIso();
    atomicWriteJson(epicPath, rawEpic, dataDir);

    emitMutating(
      {
        epic_id: epicId,
        title: epicDef.title ?? null,
        branch: epicDef.branch_name ?? null,
        last_validated_at: null,
        epic_spec_md: epicSpecMd,
        tasks,
        invalidated: true,
      },
      {
        verb: "refine-context",
        target: epicId,
        repoRoot: ctx.projectPath,
        primaryRepo:
          (rawEpic.primary_repo as string | null | undefined) ?? null,
      },
    );
    return;
  }

  // Read-only path: no invocation embedded — the dispatcher fires the generic
  // readonly trailer afterward (sentinel left unset).
  formatOutput(
    {
      success: true,
      epic_id: epicId,
      title: epicDef.title ?? null,
      branch: epicDef.branch_name ?? null,
      last_validated_at: epicDef.last_validated_at ?? null,
      epic_spec_md: epicSpecMd,
      tasks,
    },
    format,
  );
}
