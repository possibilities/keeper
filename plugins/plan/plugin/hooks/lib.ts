// Shared primitives for the plan guard dispatchers (commit-guard,
// subagent-stop-guard, stop-guard). Every dispatcher reads stdin once, makes at
// most one read-only `keeper plan` call, and emits at most one JSON envelope.
//
// Fail open is the governing rule: any internal error, unparseable input, or
// missing dependency must let the agent proceed (exit 0, no block). The deny
// constrains only the agent's Bash tool, never the human's terminal.

import { homedir } from "node:os";
import { join } from "node:path";

/** Marker schema version — must track the `keeper plan` session-marker writer. */
export const SCHEMA_VERSION = 2;

/** Markers older than this are unlinked on read (matches the Python 7-day window). */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Parsed session marker. Field names are a cross-language contract with the
 * `keeper plan` session-marker writer — `kind` selects which id field is present. */
export interface Marker {
  schema_version: number;
  session_id: string;
  kind: "work" | "close";
  task_id?: string;
  epic_id?: string;
  created_at: string;
  pid?: number;
  start_time?: string | null;
}

/** Read all of stdin as text. `Bun.stdin.stream()` avoids the macOS
 * `process.stdin` buffer-until-close hang (Bun #18239). */
export async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** True when KEEPER_PLAN_GUARD_BYPASS disables all guards. Checked before any I/O. */
export function isBypassed(): boolean {
  return process.env.KEEPER_PLAN_GUARD_BYPASS === "1";
}

function sessionsDir(): string {
  // Resolve via $HOME (falling back to the OS home) so this matches the writer
  // side's home-expansion semantics, which honor a mutated $HOME.
  const home = process.env.HOME || homedir();
  return join(home, ".local", "state", "keeper", "sessions");
}

function markerPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

/** Read the marker for `sessionId`, or null:
 * unlink-and-return-null for a marker older than 7 days or an unparseable /
 * non-object file; swallow every filesystem error (fail open). */
export async function readMarker(sessionId: string): Promise<Marker | null> {
  if (!sessionId) return null;
  const path = markerPath(sessionId);
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const stat = await file.stat();
    if (Date.now() - stat.mtimeMs > STALE_AFTER_MS) {
      await unlinkQuiet(path);
      return null;
    }
    const record = JSON.parse(await file.text());
    if (
      record === null ||
      typeof record !== "object" ||
      Array.isArray(record)
    ) {
      await unlinkQuiet(path);
      return null;
    }
    return record as Marker;
  } catch {
    return null;
  }
}

async function unlinkQuiet(path: string): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch {
    // Unlink is best-effort; a failure must never propagate.
  }
}

/** Unlink the marker for `sessionId` — best-effort, never throws. Guards call
 * this once live state proves the marker stale (task done/blocked/gone). */
export async function unlinkMarker(sessionId: string): Promise<void> {
  if (!sessionId) return;
  await unlinkQuiet(markerPath(sessionId));
}

/** Run `keeper plan <args>` read-only and return its last-line JSON envelope, or
 * null on any failure (binary missing, non-zero exit, timeout, malformed JSON).
 * Null is the fail-open signal — callers must allow when they get it. */
export async function runPlanCli(
  args: string[],
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  try {
    const proc = Bun.spawn(["keeper", "plan", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const out = await new Response(proc.stdout).text();
    const lines = out
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return null;
    const parsed = JSON.parse(lastLine);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Run `keeper prompt <args>` and return its last-line JSON envelope, or null
 * on any failure (binary missing, non-zero exit, timeout, malformed JSON).
 * Mirrors runPlanCli but targets the generated-file guard's `check-generated`
 * envelope — callers read `marked` / `message` off the returned object. Null is
 * the fail-open signal: the generated-file hooks must allow the action whenever
 * a write/read could not be classified. */
export async function runKeeperPrompt(
  args: string[],
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  try {
    const proc = Bun.spawn(["keeper", "prompt", ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: timeoutMs,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const out = await new Response(proc.stdout).text();
    const lines = out
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return null;
    const parsed = JSON.parse(lastLine);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The close-out gate's observable, read off a reconcile envelope's
 * `dirty_session_files`: a non-negative COUNT when the probe read git, `null`
 * when git was unreadable (the fail-open marker the gate announces), or
 * `undefined` when the field is absent (an older envelope / typed error /
 * null envelope — treated as unknown, never a block). Any other shape degrades
 * to `undefined`. Shared by the Stop + SubagentStop guards. */
export function sessionDirtyCount(
  env: Record<string, unknown> | null,
): number | null | undefined {
  if (env === null) return undefined;
  const value = env.dirty_session_files;
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

/** Emit a PreToolUse deny envelope. The top-level `decision` field is
 * deprecated on PreToolUse — the hookSpecificOutput shape is canonical. */
export function emitDeny(reason: string): void {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/** Emit a PostToolUse additionalContext envelope. Non-blocking: surfaces a
 * heads-up note to the agent without gating the read. */
export function emitAdditionalContext(message: string): void {
  emit({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: message,
    },
  });
}

/** Emit a Stop / SubagentStop block decision. The reason is delivered to the
 * blocked agent as its next instruction. */
export function emitBlock(reason: string): void {
  emit({ decision: "block", reason });
}

/** Write a one-line visible signal to STDERR (never stdout — stdout carries the
 * single decision envelope). Used when a gate FAILS OPEN on an unreadable
 * observable: the open is announced in the hook log rather than passing
 * silently. Best-effort and never affects the exit code. */
export function emitVisibleSignal(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
    // Diagnostics are best-effort — a failed stderr write must never propagate.
  }
}

/** Write exactly one JSON object to stdout. The sole stdout writer in the
 * dispatcher path — diagnostics go to stderr, never here. */
export function emit(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
