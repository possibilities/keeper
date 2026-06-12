#!/usr/bin/env bun
// PreToolUse(Bash) commit hard-deny dispatcher.
//
// Denies a MAIN-context `keeper commit-work` / `git commit` while the session's
// claimed task is in_progress: the orchestrator never commits — it resumes the
// worker. Worker-context calls (agent_id present) always pass; that check is
// load-bearing and precedes everything but the bypass/tool gate. Fail open on
// every path (exit 0, no deny) — a false deny against the worker bricks the
// whole work loop.

import {
  emitDeny,
  isBypassed,
  readMarker,
  readStdin,
  runPlanctl,
  unlinkMarker,
} from "./lib.ts";

/** Matches `git commit` / `keeper commit-work` as a command token: at
 * start-of-string or after a shell command separator (`&&`, `;`, `||`, `|`,
 * `$(`, `(`, newline), tolerating leading `VAR=val`, `sudo`, and `env`
 * prefixes. Anchoring on a real command boundary skips quoted false positives
 * like `echo "git commit"` (the `"` is not a boundary char). The documented
 * gap is `sh -c '...'` payloads, which carry the command inside a quoted
 * string the parser never enters. */
const COMMIT_PATTERN =
  /(?:^|[;&|\n(]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env)[ \t]+)*(?:git[ \t]+commit|keeper[ \t]+commit-work)\b/;

export function isCommitCommand(command: string): boolean {
  return COMMIT_PATTERN.test(command);
}

/** Reconcile verdicts that prove the marker's task is genuinely mid-flight —
 * the only states that justify a deny. `tooling_error` is deliberately absent
 * (fail open), and the terminal `done`/`blocked` verdicts are handled before
 * this set is consulted. */
const IN_FLIGHT_VERDICTS = new Set([
  "in_progress_committed",
  "in_progress_uncommitted",
  "state_uncommitted",
  "not_started",
]);

async function main(): Promise<void> {
  if (isBypassed()) return;

  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    session_id?: string;
    tool_name?: string;
    agent_id?: string;
    tool_input?: { command?: string };
  };

  if (payload.tool_name !== "Bash") return;
  // Load-bearing: a worker (subagent) call MUST never be denied. `agent_id` is
  // the canonical subagent discriminant — present means worker context. Only a
  // truly-absent field counts as main context (an empty string is not present).
  if (payload.agent_id) return;

  const command = payload.tool_input?.command ?? "";
  if (!isCommitCommand(command)) return;

  const sessionId = payload.session_id ?? "";
  const marker = await readMarker(sessionId);
  if (!marker || marker.kind !== "work" || !marker.task_id) return;

  // Only now pay for the read-only reconcile (rare: commit-pattern + marker
  // hit). Deny ONLY on a verdict that proves the task is genuinely in flight;
  // a null envelope, a typed error (no `verdict` key), `tooling_error`, or a
  // terminal done/blocked verdict all fail open. Terminal verdicts also mean
  // the marker is stale, so unlink it on the way out.
  const env = await runPlanctl(["reconcile", marker.task_id]);
  const verdict = env?.verdict;
  if (verdict === "done" || verdict === "blocked") {
    await unlinkMarker(sessionId);
    return;
  }
  if (!IN_FLIGHT_VERDICTS.has(verdict as string)) return;

  emitDeny(
    `Refusing to commit from the orchestrator's main context: task ${marker.task_id} ` +
      "is in-flight. Resume the worker — the orchestrator never commits. " +
      "Set PLANCTL_GUARD_BYPASS=1 to override as a human.",
  );
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the tool call proceed.
});
