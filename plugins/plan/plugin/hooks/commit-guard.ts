#!/usr/bin/env bun
// PreToolUse(Bash) commit hard-deny dispatcher.
//
// Denies `keeper commit-work` / `git commit` while a session's claimed task is
// in progress, except for two exact close-out shapes: the selected work:worker,
// or a main-context operator invoking commit-work with the claim's literal Task
// id so Keeper can mint the mechanical trailer. A generic subagent cannot turn
// itself into either shape. Fail open on internal errors (exit 0, no deny); a
// policy refusal is emitted only through the hook envelope.

import {
  emitDeny,
  readMarker,
  readStdin,
  runPlanCli,
  unlinkMarker,
} from "./lib.ts";

/** Matches `git commit` / `keeper commit-work` as a command token: at
 * start-of-string or after a shell command separator (`&&`, `;`, `||`, `|`,
 * `$(`, `(`, newline), tolerating leading `VAR=val`, `sudo`, and `env`
 * prefixes. Anchoring on a real command boundary skips quoted false positives
 * like `echo "git commit"` (the `"` is not a boundary char). A conservative
 * companion token catches wrapped spellings before the policy decision. */
const GIT_COMMIT_PATTERN =
  /(?:^|[;&|\n(]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env)[ \t]+)*git[ \t]+commit\b/;
const KEEPER_COMMIT_WORK_PATTERN =
  /(?:^|[;&|\n(]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env)[ \t]+)*keeper[ \t]+commit-work\b/;
const KEEPER_COMMIT_WORK_INVOCATION =
  /(?:^|[;&|\n(]|\$\()[ \t]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|sudo|env)[ \t]+)*keeper[ \t]+commit-work\b([^;&|\n)]*)/g;
const CONSERVATIVE_COMMIT_TOKEN =
  /(?:^|[\s'"`/])(?:git[ \t]+commit|keeper[ \t]+commit-work)\b/;

export function isCommitCommand(command: string): boolean {
  return (
    GIT_COMMIT_PATTERN.test(command) || KEEPER_COMMIT_WORK_PATTERN.test(command)
  );
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The deliberately narrow operator seam: one commit-work invocation, no raw
 * git commit, with the exact claimed Task id as its first argument. Requiring
 * the authority flag first keeps a quoted message from masquerading as it. */
export function isClaimedTaskCommitWork(
  command: string,
  taskId: string,
): boolean {
  if (GIT_COMMIT_PATTERN.test(command)) return false;
  const invocations = [...command.matchAll(KEEPER_COMMIT_WORK_INVOCATION)];
  if (invocations.length !== 1) return false;
  const escaped = regexEscape(taskId);
  const taskToken = `(?:${escaped}|"${escaped}"|'${escaped}')`;
  return new RegExp(
    `^[ \\t]+--task-id(?:[ \\t]+${taskToken}|=${taskToken})(?=[ \\t]|$)`,
  ).test(invocations[0]?.[1] ?? "");
}

function isWorkWorker(agentType: string | undefined): boolean {
  return agentType === "work:worker";
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
  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    session_id?: string;
    tool_name?: string;
    agent_id?: string;
    agent_type?: string;
    tool_input?: { command?: string };
  };

  if (payload.tool_name !== "Bash") return;
  const command = payload.tool_input?.command ?? "";
  if (!isCommitCommand(command) && !CONSERVATIVE_COMMIT_TOKEN.test(command)) {
    return;
  }

  // The generated worker role is the only subagent close-out authority;
  // agent_id alone is insufficient.
  if (payload.agent_id && isWorkWorker(payload.agent_type)) return;

  const sessionId = payload.session_id ?? "";
  const marker = await readMarker(sessionId);
  if (!marker || marker.kind !== "work" || !marker.task_id) return;

  // Only now pay for the read-only reconcile (rare: commit-pattern + marker
  // hit). Deny ONLY on a verdict that proves the task is genuinely in flight;
  // a null envelope, a typed error (no `verdict` key), `tooling_error`, or a
  // terminal done/blocked verdict all fail open. Terminal verdicts also mean
  // the marker is stale, so unlink it on the way out.
  const env = await runPlanCli(["reconcile", marker.task_id]);
  const verdict = env?.verdict;
  if (verdict === "done" || verdict === "blocked") {
    await unlinkMarker(sessionId);
    return;
  }
  if (!IN_FLIGHT_VERDICTS.has(verdict as string)) return;

  if (!payload.agent_id && isClaimedTaskCommitWork(command, marker.task_id)) {
    return;
  }

  emitDeny(
    `Refusing an unattributed commit while task ${marker.task_id} is in-flight. ` +
      `A free-form operator must invoke keeper commit-work --task-id ${marker.task_id} ` +
      "directly from the session that holds the live claim; raw git, a generic " +
      "subagent, and a mismatched or absent Task id remain denied.",
  );
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the tool call proceed.
});
