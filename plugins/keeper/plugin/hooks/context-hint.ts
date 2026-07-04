#!/usr/bin/env bun
/**
 * SessionStart glossary hint. Points a vanilla session at the repo's typed
 * vocabulary home before it starts using or coining domain terms.
 *
 * When the session's repo root carries a NON-EMPTY `CONTEXT.md`, emit ONE line
 * of `additionalContext` naming it with a read-when trigger. Absent, empty,
 * unreadable, or a non-git cwd → emit nothing. ALWAYS exits 0: a SessionStart
 * hook that fails non-zero can fail-closed the human's session, so every path
 * (including a thrown read) swallows to a silent exit 0.
 *
 * Dep-free node-only — `node:fs` + `node:path`, no subprocess, no keeper
 * imports — so it stays trivially readable and cheap on the cold-start budget.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The session cwd: the stdin payload's `cwd` (authoritative, the same field the
 * events-writer trusts) with a `process.cwd()` fallback when stdin is
 * absent/unparseable. Reading fd 0 synchronously is fine — the hook payload is
 * a small piped JSON blob the harness closes after writing.
 */
function sessionCwd(): string {
  try {
    const raw = readFileSync(0, "utf8");
    const data = JSON.parse(raw) as { cwd?: unknown };
    if (typeof data.cwd === "string" && data.cwd.length > 0) {
      return data.cwd;
    }
  } catch {
    // No / unparseable stdin — fall through to the process cwd.
  }
  return process.cwd();
}

/**
 * Nearest ancestor of `start` (inclusive) that holds a `.git` entry — a
 * directory in a normal checkout, a FILE in a linked worktree — or null when
 * none exists (a non-git cwd). A pure fs walk, never a `git` fork.
 */
function repoRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function main(): void {
  const root = repoRoot(sessionCwd());
  if (root === null) {
    return; // non-git cwd → nothing
  }

  let body: string;
  try {
    body = readFileSync(join(root, "CONTEXT.md"), "utf8");
  } catch {
    return; // absent or unreadable → nothing
  }
  if (body.trim().length === 0) {
    return; // present-but-empty → nothing
  }

  const message =
    "This repo defines its terms in CONTEXT.md — read it before using or " +
    "introducing domain terms.";
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: message,
      },
    })}\n`,
  );
}

try {
  main();
} catch {
  // Always exit 0: a SessionStart hook that fails non-zero can fail-closed the
  // human's session. Emit nothing on any unexpected error.
}
