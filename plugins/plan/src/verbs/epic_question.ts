// epic-question verb — stamp (or clear) an epic-level parked question so a
// closer waiting on a human judgement is BOARD-VISIBLE instead of parked only
// in an unwatched tmux pane.
//
// Writes the gitignored per-epic runtime overlay
// (`<state>/epics/<epic_id>.state.json`), keyed on `question`. The daemon
// plan-worker folds the overlay into the `epics` projection (mirroring the
// task-level runtime_status flow) and `keeper status` renders it as a
// needs-human signal. Like `block`, it mutates only gitignored state/, so it
// emits a readonly invocation (ZERO commits) and no RPC is involved — the plan
// CLI IS the plan write path.
//
// Resolves the STATE-bearing context via resolvePlanStateContext, so a stamp
// from a worktree lane flips PRIMARY's overlay (never the lane, where the
// gitignored overlay never lives).

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitReadonly } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { resolvePlanStateContext } from "../project.ts";
import { LocalFileStateStore, nowIso } from "../store.ts";

/** Upper bound on the stored question text so the projection stays lean (the
 * daemon folds this onto the deterministic-replayed epics row). A longer body
 * is a hard usage error at the verb, never silently truncated. */
export const EPIC_QUESTION_MAX_CHARS = 2000;

interface EpicQuestionArgs {
  epicId: string;
  question: string | null;
  clear: boolean;
  project: string | null;
  format: OutputFormat | null;
}

export function runEpicQuestion(args: EpicQuestionArgs): void {
  const { epicId, question, clear, project, format } = args;

  if (!isEpicId(epicId)) {
    emitError(`Invalid epic ID: ${epicId}`, format);
  }

  // Exactly one of {set, clear}. A set needs a non-empty question; a clear
  // takes no text.
  if (clear && question !== null) {
    emitError("Pass either a question or --clear, not both", format);
  }
  if (!clear && (question === null || question.trim().length === 0)) {
    emitError("A question is required (or pass --clear)", format);
  }
  if (
    !clear &&
    question !== null &&
    question.length > EPIC_QUESTION_MAX_CHARS
  ) {
    emitError(
      `Question exceeds ${EPIC_QUESTION_MAX_CHARS} characters (${question.length}); shorten it`,
      format,
    );
  }

  const ctx = resolvePlanStateContext(epicId, project, format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const nextQuestion = clear ? null : question;

  stateStore.withEpicLock(epicId, () => {
    // Preserve any other overlay fields; only the question + its stamp move.
    const runtime = stateStore.loadEpicRuntime(epicId) ?? {};
    const newState: Record<string, unknown> = {
      ...runtime,
      question: nextQuestion,
      updated_at: nowIso(),
    };
    stateStore.saveEpicRuntime(epicId, newState);
  });

  const pc = buildPlanInvocationReadonly(
    "epic-question",
    ctx.projectPath,
    epicId,
  );
  emitReadonly({ epic_id: epicId, question: nextQuestion }, pc);
}
