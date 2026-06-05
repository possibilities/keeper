#!/usr/bin/env bun
/**
 * `keeper show-session-files` — emit the session's on-hook dirty files grouped
 * by repo as a pretty JSON envelope.
 *
 * STUB (epic fn-715 task 1): wired into the dispatcher now; the reader logic
 * lands in task 3. `main(argv)` throws until then.
 */

export function main(_argv: string[]): never {
  throw new Error(
    "keeper show-session-files: not implemented (epic fn-715 task 3)",
  );
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}
