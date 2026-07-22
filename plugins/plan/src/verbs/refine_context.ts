// refine-context verb — the port of planctl/run_refine_context.py. Read-only by
// default: returns one envelope carrying the epic metadata, raw epic spec
// markdown ("" when absent), and the child task list (each with its own spec_md)
// so /plan:plan's Phase R2 fires one verb instead of show + cat + tasks + per-
// task cat. Resolution is cwd-then-global (resolveOwningProjectForId), so a
// globally-unique epic id resolves to its owning board regardless of cwd;
// --project bypasses discovery for a legacy ambiguous id. Conditionally MUTATING
// under --invalidate: the null-marker write lands in that owning project's store.
// Short-circuits to a
// readonly envelope when last_validated_at is already null, else writes the
// marker to null + bumps updated_at and rides the mutating emit seam so one
// chore(plan): refine-context <epic> commit lands. Typed errors —
// BAD_EPIC_ID / NO_PROJECT / EPIC_NOT_FOUND — emit
// {success:false, error:{code,message}}.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEpic, loadTasksForEpic, taskSortKey } from "../api.ts";
import { emitMutating, emitReadonly } from "../emit.ts";
import { formatOutput, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import {
  annotateIdReadVantage,
  tryResolveOwningProjectForId,
} from "../project.ts";
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

export interface RefineContextResult {
  /** The OWNING project the epic resolved to (cwd-then-global). The read-only
   * path returns it so the dispatcher's generic trailer resolves through this
   * root, not the (possibly non-owning) cwd. The --invalidate path self-emits, so
   * the returned value is unused there. */
  projectPath: string;
}

export function runRefineContext(opts: {
  epicId: string;
  invalidate: boolean;
  project: string | null;
  format: OutputFormat | null;
}): RefineContextResult {
  const { epicId, invalidate, project, format } = opts;

  if (!isEpicId(epicId)) {
    emitRefineError("BAD_EPIC_ID", `Invalid epic ID: ${epicId}`, format);
  }

  // Surface the weaker-vantage note the id-bearing resolution would drop (a lane
  // cwd keeps cwd resolution for a lane_no_state / inconclusive vantage but never
  // annotates). No-op under --project or a non-lane cwd.
  annotateIdReadVantage(project);

  // Cwd-then-global owning-project resolution via the non-emitting resolver, so
  // not-found / ambiguous map to refine-context's OWN typed EPIC_NOT_FOUND
  // envelope (the resolver's plain string error would drop the {code,message}
  // contract). The resolved owning project is where any --invalidate write lands.
  const resolution = tryResolveOwningProjectForId(epicId, project);
  if (!resolution.ok) {
    if (resolution.reason === "no_project") {
      emitRefineError(
        "NO_PROJECT",
        `No plan project found at ${resolution.projectRoot}. ` +
          `Run 'keeper plan init' first.`,
        format,
      );
    }
    if (resolution.reason === "ambiguous") {
      emitRefineError(
        "EPIC_NOT_FOUND",
        `Epic ${epicId} exists in multiple projects; pass --project <path>. ` +
          `Candidates: ${resolution.owners.join(", ")}`,
        format,
      );
    }
    emitRefineError("EPIC_NOT_FOUND", `Epic not found: ${epicId}`, format);
  }
  const ctx = resolution.ctx;
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
      const pc = buildPlanInvocationReadonly(
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
      return { projectPath: ctx.projectPath };
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
    return { projectPath: ctx.projectPath };
  }

  // Read-only path: no invocation embedded — the dispatcher fires the generic
  // readonly trailer afterward (sentinel left unset), resolving through the
  // returned owning project root.
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
  return { projectPath: ctx.projectPath };
}
