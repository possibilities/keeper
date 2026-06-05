#!/usr/bin/env bun
/**
 * `keeper commit-work` — stage session-attributed dirty files, run the lint
 * matrix, commit with a `Task:`/`Session-Id:` trailer set, and push.
 *
 * STUB (epic fn-715 task 1): the dispatcher wiring + foundation primitives
 * (`src/commit-work/{git-exec,flock,attribution,session-id}.ts`) land first so
 * the full implementation in task 2 touches only this module. `main(argv)`
 * throws until then.
 */

export function main(_argv: string[]): never {
  throw new Error("keeper commit-work: not implemented (epic fn-715 task 2)");
}

if (import.meta.main) {
  void main(Bun.argv.slice(3));
}
