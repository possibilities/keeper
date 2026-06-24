/**
 * cwd-confirm gate — warn + confirm unless cwd is a project dir exactly two
 * path components below the home directory. Good: `~/code/foo`. Warn: `~/code`
 * (too shallow), `/tmp`, `/` (outside home), any deeper project subdir. A 1:1
 * port of `_check_cwd_in_project_root`.
 *
 * Uses the shell's logical `$PWD` (not the kernel-resolved cwd) so a symlinked
 * root is judged by the path the human typed. The keystroke read is injected
 * (the termios raw read in production) so this is testable.
 */

import { homedir } from "node:os";
import { relative } from "node:path";

/** Depth of `cwd` below `home`, or 0 when `cwd` is not under `home`. */
function depthBelowHome(home: string, cwd: string): number {
  const rel = relative(home, cwd);
  // Outside home → relative path starts with ".." or is absolute.
  if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) {
    return 0;
  }
  return rel.split("/").filter((part) => part.length > 0).length;
}

/**
 * Warn + confirm unless cwd is a project dir two levels under home. On a warn,
 * reads one keystroke via `readChar`; anything but `y`/`Y` exits 1 via `exit`.
 * `write` is the stdout sink (defaults to process.stdout). Returns normally
 * when the check passes or the human confirms.
 */
export function checkCwdInProjectRoot(
  actionLog: string[],
  readChar: () => string,
  exit: (code: number) => never = (code) => process.exit(code),
  write: (s: string) => void = (s) => process.stdout.write(s),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const home = homedir();
  const cwd = env.PWD || process.cwd();
  const depth = depthBelowHome(home, cwd);

  if (depth === 2) {
    actionLog.push(`CWD is a project dir under home: ${cwd}`);
    return;
  }

  write(
    `Warning: ${cwd} is not a project directory two levels under ${home}\n`,
  );
  write("Continue? [y/N] ");
  const ch = readChar();
  write(`${ch}\n`);
  if (ch.toLowerCase() !== "y") {
    exit(1);
  }
  actionLog.push(`Human confirmed running outside a project dir: ${cwd}`);
}
