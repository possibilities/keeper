// Shared primitives for the planctl guard dispatchers (commit-guard,
// subagent-stop-guard, stop-guard). Every dispatcher reads stdin once, makes at
// most one read-only planctl call, and emits at most one JSON envelope.
//
// Fail open is the governing rule: any internal error, unparseable input, or
// missing dependency must let the agent proceed (exit 0, no block). The deny
// constrains only the agent's Bash tool, never the human's terminal.

import { homedir } from "node:os";
import { join } from "node:path";

/** Marker schema version — must track planctl/session_markers.py::SCHEMA_VERSION. */
export const SCHEMA_VERSION = 1;

/** Markers older than this are unlinked on read (matches the Python 7-day window). */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Parsed session marker. Field names are a cross-language contract with
 * planctl/session_markers.py — `kind` selects which id field is present. */
export interface Marker {
  schema_version: number;
  session_id: string;
  kind: "work" | "close";
  task_id?: string;
  epic_id?: string;
  created_at: string;
}

/** Read all of stdin as text. `Bun.stdin.stream()` avoids the macOS
 * `process.stdin` buffer-until-close hang (Bun #18239). */
export async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** True when PLANCTL_GUARD_BYPASS disables all guards. Checked before any I/O. */
export function isBypassed(): boolean {
  return process.env.PLANCTL_GUARD_BYPASS === "1";
}

function sessionsDir(): string {
  // Resolve via $HOME (falling back to the OS home) so this matches the Python
  // side's `Path("~/...").expanduser()` semantics, which honor a mutated $HOME.
  const home = process.env.HOME || homedir();
  return join(home, ".local", "state", "planctl", "sessions");
}

function markerPath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

/** Read the marker for `sessionId`, or null. Mirrors the Python read side:
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

/** Run `planctl <args>` read-only and return its last-line JSON envelope, or
 * null on any failure (binary missing, non-zero exit, timeout, malformed JSON).
 * Null is the fail-open signal — callers must allow when they get it. */
export async function runPlanctl(
  args: string[],
  timeoutMs = 5000,
): Promise<Record<string, unknown> | null> {
  try {
    const proc = Bun.spawn(["planctl", ...args], {
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

/** Emit a Stop / SubagentStop block decision. The reason is delivered to the
 * blocked agent as its next instruction. */
export function emitBlock(reason: string): void {
  emit({ decision: "block", reason });
}

/** Write exactly one JSON object to stdout. The sole stdout writer in the
 * dispatcher path — diagnostics go to stderr, never here. */
export function emit(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
