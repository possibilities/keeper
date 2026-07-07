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
// reconcile envelope, or `tooling_error` verdict allows the stop. Both branches
// share a zero-subprocess in-flight-subagent allow gate: a stop while a spawned
// subagent is still running is a legitimate await (the harness resumes the
// session on the child's completion), so the work checklist fires only at
// worker-done time — a stop with the task unfinished and NO live worker. The
// close branch adds a second zero-subprocess gate — a sanctioned typed-stop
// message (QUESTION, BLOCKED, typed errors, fatal/partial reports) — and blocks
// only a bare mid-saga stop that matches neither.

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

/** Typed-stop surfaces the close skill legitimately ends a turn on — the
 * message-pattern allow gate (the in-flight-subagent gate is the other). A marker
 * is present only because close-finalize never cleared it (it clears on all four
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

/** True when the session's Stop payload carries an in-flight subagent it
 * spawned and is awaiting — the work orchestrator's backgrounded `work:worker`,
 * or the closer's quality-auditor / close-planner. The harness resumes the
 * session on the child's completion notification, so this stop is a legitimate
 * await, not a drop. Reads the TOP-LEVEL `background_tasks` array the Stop
 * payload attaches; a parked child appears as
 * `{type:"subagent", status:"running", agent_type:"…"}`. Gates on subagent
 * PRESENCE, never array length — a bus-subscribed session always carries a
 * shell `keeper bus watch` entry, so the array is never empty. Non-throwing: any
 * shape mismatch degrades to `false` (fall through to the branch's remaining
 * gates), never an abort. */
export function childInFlight(bg: unknown): boolean {
  if (!Array.isArray(bg)) return false;
  return bg.some(
    (t) =>
      t !== null &&
      typeof t === "object" &&
      (t as Record<string, unknown>).type === "subagent" &&
      (t as Record<string, unknown>).status === "running",
  );
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

/** True when a blocked task's reason carries the `AUDIT_READY` category prefix
 * (`AUDIT_READY: …`) — the audit-gate park a flagged worker leaves after
 * committing, distinct from a terminal semantic block and from an escalated
 * `AUDIT_SEVERE`. The token is the leading `[A-Z_]+:` category, matching the
 * daemon's block-category convention, so a free-text reason with a later `:`
 * never false-matches. Pure; a non-string reason reads false. */
export function isAuditReadyReason(reason: unknown): boolean {
  if (typeof reason !== "string") return false;
  const m = reason.match(/^\s*([A-Z_]+):/);
  return m?.[1] === "AUDIT_READY";
}

/** The audit-gate resume checklist — delivered to the blocked orchestrator when
 * its task parked AUDIT_READY (a flagged worker committed and is holding for a
 * per-task audit instead of stamping done). Names the audit branch so the
 * orchestrator runs the task-scoped audit rather than treating the block as a
 * terminal stop; a deliberate human interrupt reads why it was caught and simply
 * stops again (stop_hook_active passes the second stop). */
export function auditReadyBlockReason(taskId: string): string {
  return (
    `Task ${taskId} parked AUDIT_READY: its worker committed and is holding for ` +
    "a per-task audit, not stopping. Before stopping: run the audit gate " +
    "(Phase 2b audit branch) — spawn the quality-auditor content-blind against " +
    "the task's commit set, then route clean/mild to unblock + cold-resume the " +
    "worker (it stamps its own done), or verified-severe to AUDIT_SEVERE. Never " +
    "edit, commit, or stamp done from this context."
  );
}

/** The close-branch block reason — reached only when neither allow gate fired:
 * close-finalize never returned success (the marker would be gone otherwise), the
 * last message carried no sanctioned typed stop, and no spawned subagent is
 * listed as running. It stays safe for the spawn→registry race (a child may not
 * be listed at the exact Stop instant), so it names the await case too. */
export function closeBlockReason(epicId: string): string {
  return (
    `Close of ${epicId} is mid-saga: close-finalize has not run. If you are ` +
    "awaiting a subagent you just spawned (quality-auditor or close-planner), " +
    "just end the turn — its completion notification resumes you; do NOT poll " +
    "the child transcript (TaskOutput/ToolSearch) or finalize early. Otherwise, " +
    "once the agents have returned, run " +
    `\`keeper plan close-finalize ${epicId} --project <primary_repo>\` or surface ` +
    "the typed stop verbatim. Never write or commit from this context."
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
    background_tasks?: unknown;
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
    // A backgrounded worker in flight is a legitimate await — the harness
    // resumes this session on its completion; the checklist belongs to the
    // stop that happens with NO live worker and the task unfinished. Checked
    // before reconcile so the wait path stays zero-subprocess.
    if (childInFlight(payload.background_tasks)) return;
    // Read-only live state — never trust the marker for a block. A null
    // envelope, a typed error (no `verdict` key), or `tooling_error` all fail
    // open. Terminal verdicts settle the task; `done`/`blocked` allow and the
    // stale marker is unlinked.
    const env = await runPlanCli(["reconcile", marker.task_id]);
    const verdict = env?.verdict;
    // AUDIT_READY splits the blocked arm: the worker parked for its task-scoped
    // audit — a routine gate, not a terminal stop. The orchestrator must still
    // run the audit and unblock+resume, so BLOCK the stop with the audit
    // checklist rather than allowing it and stranding the parked task. Every
    // other blocked reason (a semantic block, an escalated AUDIT_SEVERE) stays
    // terminal — allow and unlink.
    if (verdict === "blocked" && isAuditReadyReason(env?.blocked_reason)) {
      emitBlock(auditReadyBlockReason(marker.task_id));
      return;
    }
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
    // Fail-open WITH a visible signal: reconcile could not read the session-files
    // observable (git unreadable). The block still stands on the verdict, but the
    // opened observable is announced rather than passing silently.
    if (sessionDirtyCount(env) === null) {
      emitVisibleSignal(
        `plan close-out gate: session-files probe unreadable for ` +
          `${marker.task_id} — failing open on the reconcile verdict.`,
      );
    }
    emitBlock(workBlockReason(marker.task_id, String(verdict)));
    return;
  }

  if (marker.kind === "close") {
    if (!marker.epic_id) return;
    // Two zero-subprocess allow gates: an in-flight subagent the closer spawned
    // and is awaiting (the harness resumes on its completion), or a sanctioned
    // typed stop in the last message. A bare mid-saga stop matching neither
    // blocks.
    if (childInFlight(payload.background_tasks)) return;
    if (closeStopAllowed(payload.last_assistant_message)) return;
    emitBlock(closeBlockReason(marker.epic_id));
    return;
  }
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the session stop proceed.
});
