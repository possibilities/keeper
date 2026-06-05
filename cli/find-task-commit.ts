#!/usr/bin/env bun
/**
 * `keeper find-task-commit <task-id>` — emit the commit(s) carrying a matching
 * `Task: <task-id>` trailer as a pretty JSON envelope (planctl consumes this).
 *
 * STUB (epic fn-715 task 1): wired into the dispatcher now; the reader logic
 * lands in task 3. `main(argv)` throws until then.
 */

export function main(_argv: string[]): never {
  throw new Error(
    "keeper find-task-commit: not implemented (epic fn-715 task 3)",
  );
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}
