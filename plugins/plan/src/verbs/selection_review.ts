// selection-review verb — stamp (or clear) an epic-level selection-review
// record so a close-time selection audit's verdict summary is BOARD-VISIBLE as
// a display-only needs-human signal.
//
// Writes the gitignored per-epic runtime overlay
// (`<state>/epics/<epic_id>.state.json`), keyed on `selection_review`. The
// daemon plan-worker folds the overlay into the `epics` projection (mirroring
// the parked-`question` flow) and `keeper status` renders it. Like
// `epic-question`, it mutates only gitignored state/, so it emits a readonly
// invocation (ZERO commits) and no RPC is involved — the plan CLI IS the plan
// write path.
//
// Resolves the STATE-bearing context via resolvePlanStateContext, so a stamp
// from a worktree lane flips PRIMARY's overlay (never the lane, where the
// gitignored overlay never lives). Mirrors epic_question end to end.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { emitReadonly } from "../emit.ts";
import { emitError, type OutputFormat } from "../format.ts";
import { isEpicId } from "../ids.ts";
import { buildPlanInvocationReadonly } from "../invocation.ts";
import { resolvePlanStateContext } from "../project.ts";
import { LocalFileStateStore, nowIso } from "../store.ts";

/** Upper bound on the stored review payload so the projection stays lean (the
 * daemon folds this onto the deterministic-replayed epics row). The payload is
 * a small verdict-counts summary + reviewed-at stamp, never a diff or prose. A
 * longer body is a hard usage error at the verb, never silently truncated. */
export const SELECTION_REVIEW_MAX_CHARS = 4000;

interface SelectionReviewArgs {
  epicId: string;
  /** The JSON payload to store, or null when clearing. */
  payload: string | null;
  clear: boolean;
  project: string | null;
  format: OutputFormat | null;
}

export function runSelectionReview(args: SelectionReviewArgs): void {
  const { epicId, payload, clear, project, format } = args;

  if (!isEpicId(epicId)) {
    emitError(`Invalid epic ID: ${epicId}`, format);
  }

  // Exactly one of {set, clear}. A set needs a non-empty payload; a clear takes
  // no payload.
  if (clear && payload !== null) {
    emitError("Pass either --set <json> or --clear, not both", format);
  }
  if (!clear && (payload === null || payload.trim().length === 0)) {
    emitError("A --set <json> payload is required (or pass --clear)", format);
  }
  if (!clear && payload !== null) {
    if (payload.length > SELECTION_REVIEW_MAX_CHARS) {
      emitError(
        `Payload exceeds ${SELECTION_REVIEW_MAX_CHARS} characters (${payload.length}); shorten it`,
        format,
      );
    }
    // The payload is a JSON document — reject a malformed one at the write
    // boundary rather than storing garbage the fold would later drop to null.
    try {
      JSON.parse(payload);
    } catch {
      emitError("--set payload must be valid JSON", format);
    }
  }

  const ctx = resolvePlanStateContext(epicId, project, format);
  const dataDir = ctx.dataDir;
  const stateStore = new LocalFileStateStore(ctx.stateDir);

  const epicPath = join(dataDir, "epics", `${epicId}.json`);
  if (!existsSync(epicPath)) {
    emitError(`Epic not found: ${epicId}`, format);
  }

  const nextReview = clear ? null : payload;

  stateStore.withEpicLock(epicId, () => {
    // Preserve any other overlay fields (e.g. a parked `question`); only the
    // selection_review + its stamp move.
    const runtime = stateStore.loadEpicRuntime(epicId) ?? {};
    const newState: Record<string, unknown> = {
      ...runtime,
      selection_review: nextReview,
      updated_at: nowIso(),
    };
    stateStore.saveEpicRuntime(epicId, newState);
  });

  const pc = buildPlanInvocationReadonly(
    "selection-review",
    ctx.projectPath,
    epicId,
  );
  emitReadonly({ epic_id: epicId, selection_review: nextReview }, pc);
}
