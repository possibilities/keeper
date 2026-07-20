// unblock verb — the resume mirror of block.
//
// Resumes a blocked task under lockTask: re-read runtime, error if not currently
// blocked, clear blocked_reason, and retain in_progress only while the claiming
// session remains live or lacks terminal proof. Mutates only gitignored state/, so
// it emits a readonly invocation (ZERO commits). The not-found / not-blocked
// gates use the flat emitError shape.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

import {
  hasOrderedTerminalProof,
  type OrderedTerminalProofInput,
} from "../../../../src/lifecycle-terminal-proof.ts";
import { emitReadonly } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isTaskId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { mergeTaskState } from "../models.ts";
import { resolvePlanStateContext } from "../project.ts";
import { LocalFileStateStore, loadJsonSafe, nowIso } from "../store.ts";

function claimantSessionIsLiveOrRecent(taskId: string): boolean {
  const dbPath =
    process.env.KEEPER_DB?.trim() ||
    join(userInfo().homedir, ".local", "state", "keeper", "keeper.db");
  if (!existsSync(dbPath)) {
    return false;
  }

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query(
        `WITH latest_claim AS (
           SELECT session_id, id AS mutation_event_id
             FROM events
            WHERE plan_op = 'claim' AND plan_task_id = ?
            ORDER BY id DESC
            LIMIT 1
         )
         SELECT claim.mutation_event_id AS mutationEventId, job.state,
                (SELECT MAX(tail.id)
                   FROM events tail
                  WHERE tail.session_id = claim.session_id
                    AND tail.hook_event IN (
                      'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd',
                      'Killed', 'RateLimited', 'ApiError', 'InputRequest',
                      'Notification'
                    )) AS sessionLifecycleTailEventId,
                (SELECT tail.hook_event
                   FROM events tail
                  WHERE tail.session_id = claim.session_id
                    AND tail.hook_event IN (
                      'SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd',
                      'Killed', 'RateLimited', 'ApiError', 'InputRequest',
                      'Notification'
                    )
                  ORDER BY tail.id DESC
                  LIMIT 1) AS sessionLifecycleTailHook,
                (SELECT last_event_id FROM reducer_state WHERE id = 1)
                  AS reducerCursorEventId
           FROM latest_claim claim
           LEFT JOIN jobs job ON job.job_id = claim.session_id`,
      )
      .get(taskId) as OrderedTerminalProofInput | null;

    if (row === null || row.state === null) {
      return false;
    }
    if (row.state === "working") {
      return true;
    }
    return !hasOrderedTerminalProof(row);
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

interface UnblockArgs {
  taskId: string;
  project: string | null;
  format: OutputFormat | null;
}

export function runUnblock(args: UnblockArgs): void {
  const { taskId, project, format } = args;

  if (!isTaskId(taskId)) {
    emitError(`Invalid task ID: ${taskId}`, format);
  }

  const ctx = resolvePlanStateContext(taskId, project, format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const taskPath = join(dataDir, "tasks", `${taskId}.json`);
  if (!existsSync(taskPath)) {
    emitError(`Task not found: ${taskId}`, format);
  }

  const taskDef = loadJsonSafe(taskPath) ?? {};

  let nextStatus: "in_progress" | "todo" = "todo";
  stateStore.withTaskLock(taskId, () => {
    const runtime = stateStore.loadRuntime(taskId);
    const merged = mergeTaskState(taskDef, runtime);
    const status = (merged.status as string) ?? "todo";

    if (status !== "blocked") {
      emitError(`Task ${taskId} is not blocked (status: ${status})`, format);
    }

    nextStatus = claimantSessionIsLiveOrRecent(taskId) ? "in_progress" : "todo";
    const now = nowIso();
    // Preserve the claim history exactly as block.ts keeps it — Python
    // dict.get(key, default): a present key keeps its stored value (even null);
    // only an absent key uses the default.
    const newState: Record<string, unknown> = {
      status: nextStatus,
      updated_at: now,
      blocked_reason: null,
      assignee: "assignee" in merged ? merged.assignee : null,
      claimed_at: "claimed_at" in merged ? merged.claimed_at : null,
      claim_note: "claim_note" in merged ? merged.claim_note : "",
      evidence: "evidence" in merged ? merged.evidence : null,
    };
    stateStore.saveRuntime(taskId, newState);
  });

  const pc = buildPlanInvocationReadonly("unblock", ctx.projectPath, taskId);
  emitReadonly({ task_id: taskId, status: nextStatus }, pc);
}
