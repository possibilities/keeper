// done verb — the port of planctl/run_done.py.
//
// The wave's committing verb. Routes its STATE through the central
// resolvePlanStateContext seam, so a worker whose cwd is the task's target repo
// OR a worktree lane still stamps the task on the board that PHYSICALLY owns its
// state (the epic's primary_repo) — the stamp + gitignored runtime overlay land
// in the primary project's store and commit there, never a lane that only carries
// committed defs (and never the lane even when primary is OUTSIDE the configured
// roots). --project stays authoritative for locating.
// Then under lockTask: re-read runtime, gate (already-done error; non-force
// requires in_progress + assignee match), patch the spec's `## Done summary` and
// `## Evidence` sections byte-stably, atomicWrite the spec, saveRuntime(done).
// AFTER the lock: stamp updated_at + worker_done_at on the TRACKED task JSON
// (atomicWriteJson — the gitignored runtime file is NOT where the completion
// signal lives), clear the work marker, then emit through the mutating seam (one
// compact NDJSON envelope, commit BEFORE print).
//
// The stamp is durable-or-nothing. The runtime overlay, spec patch, and tracked
// worker_done_at all land BEFORE the commit, and the daemon reads a done overlay
// the moment it is written (FSEvents, ahead of any commit). So a failed commit —
// the mid-merge shared-checkout window, where git refuses a partial commit — is
// unwound: the three files are restored to their pre-done bytes, the daemon
// re-reads the restored overlay, and no half-stamped "done" the CLI cannot back
// out of survives. The symmetric recovery for an ALREADY-wedged task (runtime
// overlay done, HEAD:<task.json> missing worker_done_at) is a self-heal: a `done`
// re-run re-commits the missing backing instead of the flat "already done"
// refusal a durably-committed done still earns.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { emitMutating } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import { mergeTaskState } from "../models.ts";
import { resolvePlanStateContext } from "../project.ts";
import { clearWorkMarker } from "../session_markers.ts";
import {
  ensureValidTaskSpec,
  getTaskSection,
  patchTaskSection,
} from "../specs.ts";
import {
  atomicWrite,
  atomicWriteJson,
  atomicWriteRaw,
  getActor,
  LocalFileStateStore,
  loadJsonSafe,
  nowIso,
} from "../store.ts";
import { getVcs } from "../vcs.ts";
import { GitError, stateHeadVisible } from "./reconcile.ts";

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

/** True when the task's committed HEAD:<task.json> already carries the durable
 * done backing (worker_done_at). A wedged done — the runtime overlay reads done
 * but the state-file commit was lost to the mid-merge window — reads false,
 * distinguishing a recoverable half-stamp from a genuinely-committed done. Shares
 * reconcile.stateHeadVisible so the heal decision stays byte-consistent with the
 * reconcile STATE_UNCOMMITTED verdict. Fail-SAFE: an unreadable git (GitError)
 * reads true → refuse, never healing on an unverifiable commit state. */
function doneBackingCommitted(stateRepo: string, taskId: string): boolean {
  try {
    return stateHeadVisible(stateRepo, taskId);
  } catch (exc) {
    if (exc instanceof GitError) {
      return true;
    }
    throw exc;
  }
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

  // STATE resolution through the central seam: the stamp + runtime overlay land
  // in the repo that PHYSICALLY owns the task's state (the epic's primary_repo),
  // never a worktree lane whose committed defs would otherwise win cwd-first, and
  // never the lane even when primary is outside the configured roots. --project
  // stays authoritative for locating.
  const ctx = resolvePlanStateContext(taskId, project, format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    emitError(`Task not found: ${taskId}`, format);
  }

  const specPath = join(dataDir, "specs", `${taskId}.md`);
  const runtimeStatePath = join(ctx.stateDir, "tasks", `${taskId}.state.json`);

  const taskDef = loadJsonSafe(taskPath) ?? {};
  const actor = getActor();

  let evidence: Evidence = { commits: [], tests: [], prs: [] };

  // Pre-write bytes of the three state files this verb rewrites (spec, runtime
  // overlay, tracked def). Captured inside the lock before any write so the
  // commit-failure unwind restores exactly the pre-done state. A null runtime
  // snapshot means the overlay did not exist and the unwind must DELETE the one
  // saveRuntime created (never leave a stray done overlay behind).
  let specSnapshot: string | null = null;
  let runtimeSnapshot: string | null = null;
  let taskJsonSnapshot: string | null = null;

  stateStore.withTaskLock(taskId, () => {
    specSnapshot = existsSync(specPath)
      ? readFileSync(specPath, "utf-8")
      : null;
    runtimeSnapshot = existsSync(runtimeStatePath)
      ? readFileSync(runtimeStatePath, "utf-8")
      : null;
    taskJsonSnapshot = readFileSync(taskPath, "utf-8");

    const runtime = stateStore.loadRuntime(taskId);
    const merged = mergeTaskState(taskDef, runtime);
    const status = (merged.status as string) ?? "todo";

    // A done overlay with no durable backing is a wedge, not a completed task:
    // the state-file commit was lost (the mid-merge window) while the daemon's
    // runtime_status still reads done. Re-commit the backing instead of the flat
    // "already done" refusal, which is what a genuinely-committed done still
    // earns. Gates the in_progress/assignee check below off too — the task is
    // past in_progress, only its commit is missing.
    let healUncommittedDone = false;
    if (status === "done") {
      if (doneBackingCommitted(ctx.projectPath, taskId)) {
        emitError(`Task ${taskId} is already done`, format);
      }
      healUncommittedDone = true;
    }

    if (!force && !healUncommittedDone) {
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

    // Parse + normalize evidence (default empty object when none given). A heal
    // re-run with no --evidence carries the wedge's recorded evidence forward
    // from the runtime overlay rather than blanking it to the empty default —
    // the prior done wrote it there, so a self-heal must not lose it.
    let evidenceData: unknown = {};
    if (evidenceInline) {
      try {
        evidenceData = JSON.parse(evidenceInline);
      } catch (e) {
        emitError(`Invalid evidence JSON: ${(e as Error).message}`, format);
      }
    } else if (
      healUncommittedDone &&
      merged.evidence !== null &&
      typeof merged.evidence === "object" &&
      !Array.isArray(merged.evidence)
    ) {
      evidenceData = merged.evidence;
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
    if (!existsSync(specPath)) {
      emitError(`Spec file not found: ${specPath}`, format);
    }

    let specContent = readFileSync(specPath, "utf-8");
    // A heal re-run with no --summary preserves the existing Done summary rather
    // than blanking the operator's recovered text.
    const summaryText = summary
      ? summary
      : healUncommittedDone
        ? getTaskSection(specContent, "## Done summary")
        : "";
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

    // A heal re-run with no --evidence preserves the existing `## Evidence`
    // section verbatim rather than blanking the operator's recovered text —
    // mirrors the `## Done summary` preservation above.
    let evidenceText: string;
    if (!evidenceInline && healUncommittedDone) {
      evidenceText = getTaskSection(specContent, "## Evidence");
    } else {
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
      evidenceText = evidenceLines.length > 0 ? evidenceLines.join("\n") : "";
    }

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
  // atomic) → one commit. On a commit failure (the mid-merge window), unwind the
  // three state files to their pre-done bytes so no durable "done" survives the
  // failed commit — the daemon re-reads the restored overlay and the task stays
  // recoverable by a plain `done` re-run once the merge completes.
  emitMutating(
    { task_id: taskId, status: "done", evidence },
    {
      verb: "done",
      target: taskId,
      repoRoot: ctx.projectPath,
      onCommitFailure: () => {
        if (taskJsonSnapshot !== null) {
          atomicWriteRaw(taskPath, taskJsonSnapshot);
        }
        if (specSnapshot !== null) {
          atomicWriteRaw(specPath, specSnapshot);
        }
        if (runtimeSnapshot !== null) {
          atomicWriteRaw(runtimeStatePath, runtimeSnapshot);
        } else if (existsSync(runtimeStatePath)) {
          unlinkSync(runtimeStatePath);
        }
        // Restoring the working-tree bytes alone leaves the done bytes STAGED:
        // commit.ts's gitStage (`git add`) ran before the mid-merge-refused
        // pathspec commit, so a later full-index merge-completion would sweep
        // the half-stamp into its tree. Return the three state paths' index
        // entries to HEAD too (a gitignored / never-staged path resets to a
        // harmless no-op), keeping the index consistent with the restored tree.
        getVcs().restoreIndexToHead(
          [taskPath, specPath, runtimeStatePath],
          ctx.projectPath,
        );
      },
    },
  );
}
