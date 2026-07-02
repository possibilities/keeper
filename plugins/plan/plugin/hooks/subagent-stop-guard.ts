#!/usr/bin/env bun
// SubagentStop worker guard dispatcher — the FIRST-CHANCE resume engine.
//
// Fires inside a worker subagent the moment it stops, BEFORE the Task result
// exists. A worker that stopped in a non-done, non-BLOCKED, genuinely in-flight
// state gets exactly one corrective block carrying the matching Phase 2b nudge;
// every other outcome (typed escalation, terminal verdict, tooling error,
// unresolvable task id, a prior block-continuation) passes through. The work
// skill's Phase 2b reconcile-switch stays the authoritative fallback — it sees
// only post-guard outcomes — so this guard must leave each one consumable there.
//
// Fail open is absolute: every uncertain branch allows. Trapping a legitimately
// stopping worker wastes a round at best and burns the 8-block cap at worst.

import {
  emitBlock,
  emitVisibleSignal,
  isBypassed,
  readMarker,
  readStdin,
  runPlanCli,
  sessionDirtyCount,
  unlinkMarker,
} from "./lib.ts";

/** A `BLOCKED:` typed escalation anywhere as a line start (multiline) outranks
 * reconcile — reconcile cannot tell a deliberate escalation from a silent drop,
 * so the worker's own typed return wins. */
export const BLOCKED_PATTERN = /^\s*BLOCKED:/m;

/** A `TASK_ID: <id>` line in the spawn prompt — the transcript fallback when no
 * work marker is on disk (cross-session / hook-only resume). Captures the id
 * token (no surrounding whitespace). */
const TASK_ID_LINE = /^\s*TASK_ID:\s*(\S+)\s*$/m;

/** Cap the transcript read so a runaway file never blows the dispatcher budget;
 * the spawn prompt's TASK_ID line sits in the first user message, well within
 * this window. */
const TRANSCRIPT_READ_LIMIT = 256 * 1024;

/** Per-verdict resume nudges — verbatim from the work skill's Phase 2b switch
 * (template/skills/work.md.tmpl). `null` means "never block on this verdict":
 * a `not_started` worker is the orchestrator's call to make, never a trap, and
 * the terminal/fail-open verdicts are handled before this map is consulted. */
export const VERDICT_NUDGE: Record<string, (taskId: string) => string | null> =
  {
    in_progress_committed: (taskId) =>
      `Source commit landed for ${taskId} — run keeper plan done ${taskId} --summary now.`,
    in_progress_uncommitted: (taskId) =>
      `Resume ${taskId}: finish implementation, run tests within your two-full-pass budget, keeper commit-work, keeper plan done.`,
    state_uncommitted: (taskId) =>
      `Re-run keeper plan done ${taskId} --summary to land the state commit.`,
    not_started: () => null,
  };

/** Pull the spawn prompt's `TASK_ID:` value out of the transcript's first user
 * message. Defensive on every axis: missing path, missing/huge file, a content
 * field that is a string OR a list of blocks, no TASK_ID line → null (allow). */
export async function taskIdFromTranscript(
  path: unknown,
): Promise<string | null> {
  if (typeof path !== "string" || !path) return null;
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    // Read a bounded prefix only — the spawn prompt is the first record.
    const slice = file.slice(0, TRANSCRIPT_READ_LIMIT);
    const text = await slice.text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // A truncated trailing line from the byte-bounded read — stop scanning.
        break;
      }
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as { type?: unknown; message?: unknown };
      if (record.type !== "user") continue;
      const content = (record.message as { content?: unknown } | undefined)
        ?.content;
      const found = extractTaskId(content);
      if (found) return found;
      // First user message inspected; the spawn prompt is here or nowhere.
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Match `TASK_ID:` against a transcript message `content`, which is either a
 * plain string or a list of content blocks (`{type:"text", text}`). */
export function extractTaskId(content: unknown): string | null {
  if (typeof content === "string") {
    return TASK_ID_LINE.exec(content)?.[1] ?? null;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block !== null &&
        typeof block === "object" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        const match = TASK_ID_LINE.exec((block as { text: string }).text);
        if (match) return match[1];
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (isBypassed()) return;

  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    session_id?: string;
    stop_hook_active?: boolean;
    last_assistant_message?: string;
    agent_transcript_path?: string;
  };

  // Block-once policy: a prior Stop-hook continuation set this. Blocking again
  // burns the 8-block cap, so always pass through.
  if (payload.stop_hook_active) return;

  // Typed escalation outranks reconcile — a worker that returned `BLOCKED:`
  // chose to stop; never trap it.
  if (
    typeof payload.last_assistant_message === "string" &&
    BLOCKED_PATTERN.test(payload.last_assistant_message)
  ) {
    return;
  }

  // Resolve the task id: session marker (kind work) first, transcript spawn
  // prompt as the cross-session fallback. No id → allow.
  const sessionId = payload.session_id ?? "";
  const marker = await readMarker(sessionId);
  let taskId: string | null = null;
  if (marker && marker.kind === "work" && marker.task_id) {
    taskId = marker.task_id;
  } else {
    taskId = await taskIdFromTranscript(payload.agent_transcript_path);
  }
  if (!taskId) return;

  // Read-only live state — never trust the marker for a block. A null envelope,
  // a typed error (no `verdict` key), or `tooling_error` all fail open.
  const env = await runPlanCli(["reconcile", taskId]);
  const verdict = env?.verdict;
  const dirty = sessionDirtyCount(env);

  // Terminal verdicts: the task is settled. `done` also retires the marker.
  if (verdict === "done") {
    await unlinkMarker(sessionId);
    return;
  }
  if (verdict === "blocked") return;

  // Fail-open WITH a visible signal: reconcile could not read the session-files
  // observable (git unreadable). The gate still decides on the verdict, but the
  // open is announced rather than passing silently.
  if (dirty === null) {
    emitVisibleSignal(
      `plan close-out gate: session-files probe unreadable for ${taskId} — ` +
        "failing open on the reconcile verdict.",
    );
  }

  // Observable-driven refinement: a source commit landed (in_progress_committed)
  // but the tree still carries undischarged files — the "run keeper plan done"
  // nudge would strand them, so fire the finish-and-commit nudge instead.
  const effectiveVerdict =
    verdict === "in_progress_committed" &&
    typeof dirty === "number" &&
    dirty > 0
      ? "in_progress_uncommitted"
      : (verdict as string);

  const nudgeFor = VERDICT_NUDGE[effectiveVerdict];
  if (!nudgeFor) return; // unknown / tooling_error / null → fail open.
  const reason = nudgeFor(taskId);
  if (reason === null) return; // not_started → never trap.

  emitBlock(reason);
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the subagent stop proceed.
});
