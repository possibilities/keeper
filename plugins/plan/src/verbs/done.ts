// done verb — the port of planctl/run_done.py.
//
// The wave's committing verb. Resolves the OWNING project cwd-then-global
// (resolveOwningProjectForId), so a cross-repo worker whose cwd is the task's
// target repo still stamps the task on the board that owns it (the stamp lands
// in the owning project's store + commits there). --project bypasses discovery.
// Then under lockTask: re-read runtime, gate (already-done error; non-force
// requires in_progress + assignee match), patch the spec's `## Done summary` and
// `## Evidence` sections byte-stably, atomicWrite the spec, saveRuntime(done).
// AFTER the lock: stamp updated_at + worker_done_at on the TRACKED task JSON
// (atomicWriteJson — the gitignored runtime file is NOT where the completion
// signal lives), clear the work marker, then emit through the mutating seam (one
// compact NDJSON envelope, commit BEFORE print).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import { mergeTaskState } from "../models.ts";
import { resolveOwningProjectForId } from "../project.ts";
import { clearWorkMarker } from "../session_markers.ts";
import { ensureValidTaskSpec, patchTaskSection } from "../specs.ts";
import {
  atomicWrite,
  atomicWriteJson,
  getActor,
  LocalFileStateStore,
  loadJsonSafe,
  nowIso,
} from "../store.ts";

interface DoneArgs {
  taskId: string;
  summary: string | null;
  evidence: string | null;
  force: boolean;
  project: string | null;
  format: OutputFormat | null;
}

interface Evidence {
  commits: unknown[];
  tests: unknown[];
  prs: unknown[];
}

export function runDone(args: DoneArgs): void {
  const {
    taskId,
    summary,
    evidence: evidenceInline,
    force,
    project,
    format,
  } = args;

  if (!isTaskId(taskId)) {
    emitError(`Invalid task ID: ${taskId}`, format);
  }

  // Cwd-then-global owning-project resolution: the stamp lands in the board that
  // owns the task, not the cwd project (the cross-repo self-complete fix).
  const ctx = resolveOwningProjectForId(taskId, project, format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    emitError(`Task not found: ${taskId}`, format);
  }

  const taskDef = loadJsonSafe(taskPath) ?? {};
  const actor = getActor();

  let evidence: Evidence = { commits: [], tests: [], prs: [] };

  stateStore.withTaskLock(taskId, () => {
    const runtime = stateStore.loadRuntime(taskId);
    const merged = mergeTaskState(taskDef, runtime);
    const status = (merged.status as string) ?? "todo";

    if (status === "done") {
      emitError(`Task ${taskId} is already done`, format);
    }

    if (!force) {
      if (status !== "in_progress") {
        emitError(
          `Task ${taskId} is not in_progress (status: ${status})`,
          format,
        );
      }
      const currentAssignee = merged.assignee as string | null | undefined;
      if (currentAssignee && currentAssignee !== actor) {
        emitError(
          `Task ${taskId} is assigned to ${currentAssignee}, not ${actor}`,
          format,
        );
      }
    }

    const summaryText = summary ? summary : "";

    // Parse + normalize evidence (default empty object when none given).
    let evidenceData: unknown = {};
    if (evidenceInline) {
      try {
        evidenceData = JSON.parse(evidenceInline);
      } catch (e) {
        emitError(`Invalid evidence JSON: ${(e as Error).message}`, format);
      }
    }
    if (
      evidenceData !== null &&
      typeof evidenceData === "object" &&
      !Array.isArray(evidenceData)
    ) {
      const ev = evidenceData as Record<string, unknown>;
      evidence = {
        commits: Array.isArray(ev.commits) ? [...ev.commits] : [],
        tests: Array.isArray(ev.tests) ? [...ev.tests] : [],
        prs: Array.isArray(ev.prs) ? [...ev.prs] : [],
      };
    } else {
      emitError("Evidence must be a JSON object", format);
    }

    // Patch the spec — `## Done summary` then `## Evidence`, validating before
    // and after. A malformed spec is a hard error (the four-H2 contract).
    const specPath = join(dataDir, "specs", `${taskId}.md`);
    if (!existsSync(specPath)) {
      emitError(`Spec file not found: ${specPath}`, format);
    }

    let specContent = readFileSync(specPath, "utf-8");
    try {
      ensureValidTaskSpec(specContent);
      specContent = patchTaskSection(
        specContent,
        "## Done summary",
        summaryText,
      );
    } catch (e) {
      emitError(
        `Task spec is malformed for ${taskId}: ${(e as Error).message}`,
        format,
      );
    }

    const evidenceLines: string[] = [];
    if (evidence.commits.length > 0) {
      evidenceLines.push(`- Commits: ${evidence.commits.join(", ")}`);
    }
    if (evidence.tests.length > 0) {
      evidenceLines.push(`- Tests: ${evidence.tests.join(", ")}`);
    }
    if (evidence.prs.length > 0) {
      evidenceLines.push(`- PRs: ${evidence.prs.join(", ")}`);
    }
    const evidenceText =
      evidenceLines.length > 0 ? evidenceLines.join("\n") : "";

    try {
      specContent = patchTaskSection(specContent, "## Evidence", evidenceText);
      ensureValidTaskSpec(specContent);
    } catch (e) {
      emitError(
        `Task spec is malformed for ${taskId}: ${(e as Error).message}`,
        format,
      );
    }

    atomicWrite(specPath, specContent, dataDir);

    // Runtime state -> done. Python dict.get(key, default): a present key keeps
    // its stored value (even null); only an absent key uses the default.
    const now = nowIso();
    const newState: Record<string, unknown> = {
      status: "done",
      updated_at: now,
      assignee: "assignee" in merged ? merged.assignee : actor,
      claimed_at: "claimed_at" in merged ? merged.claimed_at : null,
      claim_note: "claim_note" in merged ? merged.claim_note : "",
      evidence,
      blocked_reason: null,
    };
    stateStore.saveRuntime(taskId, newState);
  });

  // After the lock: stamp updated_at + worker_done_at on the TRACKED definition
  // (NOT the gitignored runtime sidecar). worker_done_at set = task complete.
  const now = nowIso();
  taskDef.updated_at = now;
  taskDef.worker_done_at = now;
  atomicWriteJson(taskPath, taskDef, dataDir);

  // Clear this session's work marker — only if it names this task. Success-path
  // only, fail-open.
  clearWorkMarker(taskId);

  // Route through the central seam: rewrite of pre-existing tracked files (rename-
  // atomic) → one commit, no unwind.
  emitMutating(
    { task_id: taskId, status: "done", evidence },
    { verb: "done", target: taskId, repoRoot: ctx.projectPath },
  );
}
