#!/usr/bin/env bun
/**
 * `keeper session-state` — emit the current session's git context (branch,
 * head sha, porcelain status) plus its on-hook dirty file list as a pretty
 * JSON envelope.
 *
 * STUB (epic fn-715 task 1): wired into the dispatcher now; the reader logic
 * lands in task 3. `main(argv)` throws until then.
 */

export function main(_argv: string[]): never {
  throw new Error("keeper session-state: not implemented (epic fn-715 task 3)");
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}
