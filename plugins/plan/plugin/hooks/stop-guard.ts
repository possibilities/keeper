#!/usr/bin/env bun
// Stop checklist guard dispatcher — the AUTHORITATIVE-FALLBACK stop gate.
//
// Fires on EVERY session stop machine-wide (the plugin is always loaded), so the
// no-marker path must stay file-stat cheap: bypass or a missing marker for this
// session short-circuits to exit 0 with zero subprocess spawns, before any
// transcript read or `keeper plan` call. A claimed-but-unfinished work session, or a
// close session that never finalized, gets exactly one corrective block carrying
// a resume checklist; every other outcome passes through.
//
// Fail open is absolute: any internal error, unparseable stdin, null/typed-error
// reconcile envelope, or `tooling_error` verdict allows the stop. The close
// branch is deliberately lenient — it errs toward allowing the close skill's own
// legitimate halt states (QUESTION, BLOCKED, typed errors, fatal/partial
// reports) rather than fighting them.

import {
  emitBlock,
  isBypassed,
  readMarker,
  readStdin,
  runPlanCli,
  unlinkMarker,
} from "./lib.ts";

/** Typed-stop surfaces the close skill legitimately ends a turn on. A marker is
 * present only because close-finalize never cleared it (it clears on all four
 * outcomes), so any of these in the last message means the closer stopped on a
 * sanctioned halt, not a mid-saga drop — allow. Patterns are derived verbatim
 * from skills/close/SKILL.md:
 *  - `^\s*BLOCKED:` (multiline) — the Phase 2 transient-failure escalation.
 *  - `QUESTION:` — the Phase 3 close-planner judgement-call relay.
 *  - `{"success": false` — a surfaced typed-error envelope (preflight/finalize).
 *  - "Halted `"        — the fatal-halt report format.
 *  - "Partial follow-up" — the partial_followup outcome surface. */
export const CLOSE_ALLOW_PATTERNS: RegExp[] = [
  /^\s*BLOCKED:/m,
  /QUESTION:/,
  /\{"success":\s*false/,
  /Halted `/,
  /Partial follow-up/,
];

/** True when the last assistant message carries a sanctioned close stop. */
export function closeStopAllowed(message: unknown): boolean {
  if (typeof message !== "string" || !message) return false;
  return CLOSE_ALLOW_PATTERNS.some((pattern) => pattern.test(message));
}

/** The work-branch resume checklist — delivered to the blocked orchestrator as
 * its next instruction. Names the verdict so a deliberate human interrupt can
 * read why it was caught and simply stop again (stop_hook_active passes the
 * second stop). */
export function workBlockReason(taskId: string, verdict: string): string {
  return (
    `Task ${taskId} is not finished (verdict: ${verdict}). Before stopping: ` +
    "is the task stamped done? Are the worker's session files committed? " +
    "Resume the worker (warm SendMessage to the pinned worker_agent_id, or " +
    `cold \`keeper plan worker resume ${taskId}\`) — never edit or commit from ` +
    "this context."
  );
}

/** The close-branch mid-saga block reason — close-finalize never returned
 * success (the marker would be gone otherwise), and the last message carried no
 * sanctioned typed stop. */
export function closeBlockReason(epicId: string): string {
  return (
    `Close of ${epicId} is mid-saga: close-finalize has not run. Either run ` +
    `\`keeper plan close-finalize ${epicId} --project <primary_repo>\` (after the ` +
    "agents returned) or surface the typed stop verbatim. Never write or " +
    "commit from this context."
  );
}

async function main(): Promise<void> {
  // Bypass is checked before any I/O — a human override must cost nothing.
  if (isBypassed()) return;

  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    session_id?: string;
    stop_hook_active?: boolean;
    last_assistant_message?: string;
  };

  // Block-once policy: a prior Stop-hook continuation set this. Blocking again
  // burns the 8-block cap, so always pass through.
  if (payload.stop_hook_active) return;

  // Hot path: no marker for this session → allow with zero subprocess spawns.
  // This is the common case on every stop of every session machine-wide.
  const sessionId = payload.session_id ?? "";
  const marker = await readMarker(sessionId);
  if (!marker) return;

  if (marker.kind === "work") {
    if (!marker.task_id) return;
    // Read-only live state — never trust the marker for a block. A null
    // envelope, a typed error (no `verdict` key), or `tooling_error` all fail
    // open. Terminal verdicts settle the task; `done`/`blocked` allow and the
    // stale marker is unlinked.
    const env = await runPlanCli(["reconcile", marker.task_id]);
    const verdict = env?.verdict;
    if (verdict === "done" || verdict === "blocked") {
      await unlinkMarker(sessionId);
      return;
    }
    if (
      verdict === undefined ||
      verdict === null ||
      verdict === "tooling_error"
    ) {
      return; // fail open.
    }
    emitBlock(workBlockReason(marker.task_id, String(verdict)));
    return;
  }

  if (marker.kind === "close") {
    if (!marker.epic_id) return;
    // Lenient: a sanctioned typed stop in the last message means the closer
    // halted legitimately — allow. Only a bare mid-saga stop blocks.
    if (closeStopAllowed(payload.last_assistant_message)) return;
    emitBlock(closeBlockReason(marker.epic_id));
    return;
  }
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the session stop proceed.
});
