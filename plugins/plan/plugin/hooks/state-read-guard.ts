#!/usr/bin/env bun

// PreToolUse(Read|Write|Edit|Bash) content-blindness guard.
//
// Advisory context hygiene, not a security boundary: mechanically enforces
// what the depth fold and gate rewrite made true — a marker-active work/close
// orchestrator has no legitimate tool access to the out-of-band briefs/audits
// state trees. Denies via the hook envelope (permissionDecision deny — never a
// non-zero exit) when ALL of: the session carries no agent_id (subagent access
// — worker, auditor, close-planner — always passes, mirroring commit-guard's
// discriminant), a work/close marker is active for the session, and the
// target realpath-resolves under `.keeper/state/briefs` or
// `.keeper/state/audits`. A Bash command naming those trees is a best-effort
// companion check, following commit-guard's command-inspection precedent.
//
// Fail open on every path (exit 0, no deny): an unreadable payload, a missing
// marker, or a realpath error all allow the tool call through.

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { emitDeny, isBypassed, readMarker, readStdin } from "./lib.ts";

/** Matches a resolved path with a `.keeper/state/briefs` or
 * `.keeper/state/audits` component, tolerating either path separator. */
const STATE_TREE_PATTERN =
  /(?:^|[\\/])\.keeper[\\/]state[\\/](?:briefs|audits)(?:[\\/]|$)/;

/** True when `filePath` (resolved against `cwd` when relative) realpath-
 * resolves under the briefs or audits state trees. Falls back to the
 * syntactically-resolved (unresolved-symlink) path when realpath throws — a
 * Write target that does not exist yet is the common case, and every other
 * realpath failure must fail open rather than throw. */
export function isProtectedStatePath(filePath: string, cwd: string): boolean {
  if (!filePath) return false;
  const absolute = isAbsolute(filePath)
    ? filePath
    : resolve(cwd || process.cwd(), filePath);
  let resolved = absolute;
  try {
    resolved = realpathSync(absolute);
  } catch {
    // Missing file / unresolvable symlink — check the unresolved path.
  }
  return STATE_TREE_PATTERN.test(resolved);
}

/** Best-effort Bash vector: a command naming the briefs/audits state trees as
 * a `.keeper/state/(briefs|audits)` token. Mirrors commit-guard's
 * command-inspection precedent — the documented gap is any command that hides
 * the path inside an indirection the token scan never sees (e.g. a variable
 * expansion or a quoted `sh -c` payload). */
const STATE_TREE_TOKEN = /\.keeper[\\/]state[\\/](?:briefs|audits)\b/;

export function commandTouchesStateTree(command: string): boolean {
  return STATE_TREE_TOKEN.test(command);
}

async function main(): Promise<void> {
  if (isBypassed()) return;

  const raw = await readStdin();
  const payload = JSON.parse(raw) as {
    session_id?: string;
    tool_name?: string;
    agent_id?: string;
    cwd?: string;
    tool_input?: { file_path?: string; command?: string };
  };

  // Load-bearing: a subagent (worker, auditor, close-planner) MUST never be
  // denied — those roles legitimately read briefs and artifacts. Only a
  // truly-absent field counts as main context.
  if (payload.agent_id) return;

  const toolName = payload.tool_name;
  const isFileTool =
    toolName === "Read" || toolName === "Write" || toolName === "Edit";
  if (!isFileTool && toolName !== "Bash") return;

  const sessionId = payload.session_id ?? "";
  const marker = await readMarker(sessionId);
  if (!marker || (marker.kind !== "work" && marker.kind !== "close")) return;

  if (toolName === "Bash") {
    const command = payload.tool_input?.command ?? "";
    if (!command || !commandTouchesStateTree(command)) return;
  } else {
    const filePath = payload.tool_input?.file_path ?? "";
    if (!filePath) return;
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    if (!isProtectedStatePath(filePath, cwd)) return;
  }

  emitDeny(
    `Refusing ${toolName} access to out-of-band audit/brief state from the ` +
      "orchestrator's main context: coordination stays envelope/ref-only. " +
      "Set KEEPER_PLAN_GUARD_BYPASS=1 to override as a human.",
  );
}

main().catch(() => {
  // Fail open: any dispatcher-internal error must let the tool call proceed.
});
